/**
 * Persistência do lote sobre node:sqlite (built-in do Node 24).
 * Single writer: transições de estado só acontecem via worker/handlers,
 * nunca concorrentes dentro do mesmo processo.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Batch, BatchItem, DoneItem, FailedItem, PendingItem, ProcessingItem, Delivery } from '../domain/batch.ts';
import { resetForRetry } from '../domain/batch.ts';
import type { BatchItemInput } from '../domain/validation.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL,
  filename TEXT NOT NULL,
  signer_name TEXT NOT NULL,
  signer_email TEXT,
  signer_phone TEXT,
  delivery TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  envelope_id TEXT,
  signer_id TEXT,
  sign_url TEXT,
  error_message TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_batch ON items(batch_id);
`;

interface ItemRow {
  id: string;
  batch_id: string;
  filename: string;
  signer_name: string;
  signer_email: string | null;
  signer_phone: string | null;
  delivery: string;
  status: string;
  retry_count: number;
  envelope_id: string | null;
  signer_id: string | null;
  sign_url: string | null;
  error_message: string | null;
}

export class BatchRepository {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createBatch(items: BatchItemInput[]): Batch {
    const batchId = randomUUID();
    const createdAt = new Date().toISOString();

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('INSERT INTO batches (id, created_at) VALUES (?, ?)')
        .run(batchId, createdAt);
      const insertItem = this.db.prepare(
        `INSERT INTO items (id, batch_id, seq, filename, signer_name, signer_email, signer_phone, delivery)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      items.forEach((item, seq) => {
        insertItem.run(
          randomUUID(),
          batchId,
          seq,
          item.filename,
          item.signer.name,
          item.signer.email ?? null,
          item.signer.phoneNumber ?? null,
          item.delivery,
        );
      });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }

    const batch = this.getBatch(batchId);
    if (!batch) throw new Error(`Lote recém-criado ${batchId} não encontrado`);
    return batch;
  }

  getBatch(batchId: string): Batch | null {
    const batchRow = this.db
      .prepare('SELECT id, created_at FROM batches WHERE id = ?')
      .get(batchId) as { id: string; created_at: string } | undefined;
    if (!batchRow) return null;

    const rows = this.db
      .prepare('SELECT * FROM items WHERE batch_id = ? ORDER BY seq')
      .all(batchId) as unknown as ItemRow[];

    return {
      id: batchRow.id,
      createdAt: batchRow.created_at,
      items: rows.map(rowToItem),
    };
  }

  /** Transição atômica pending → processing do item mais antigo da fila. */
  claimNextPending(): ProcessingItem | null {
    const row = this.db
      .prepare(
        `UPDATE items SET status = 'processing'
         WHERE id = (SELECT id FROM items WHERE status = 'pending' ORDER BY rowid LIMIT 1)
         RETURNING *`,
      )
      .get() as unknown as ItemRow | undefined;
    if (!row) return null;
    const item = rowToItem(row);
    if (item.status !== 'processing') throw new Error('claim retornou item fora de processing');
    return item;
  }

  saveItemResult(item: DoneItem | FailedItem): void {
    if (item.status === 'done') {
      this.db
        .prepare(
          `UPDATE items SET status = 'done', envelope_id = ?, signer_id = ?, sign_url = ?, error_message = NULL
           WHERE id = ?`,
        )
        .run(item.envelopeId, item.signerId, item.signUrl, item.id);
      return;
    }
    this.db
      .prepare(`UPDATE items SET status = 'failed', error_message = ? WHERE id = ?`)
      .run(item.errorMessage, item.id);
  }

  /** Boot: itens presos em processing (crash anterior) voltam para a fila. */
  reclaimStale(): number {
    const result = this.db
      .prepare(`UPDATE items SET status = 'pending' WHERE status = 'processing'`)
      .run();
    return Number(result.changes);
  }

  resetItemForRetry(batchId: string, itemId: string): PendingItem {
    const row = this.db
      .prepare('SELECT * FROM items WHERE id = ? AND batch_id = ?')
      .get(itemId, batchId) as unknown as ItemRow | undefined;
    if (!row) throw new Error(`Item ${itemId} não encontrado no lote ${batchId}`);

    const retried = resetForRetry(rowToItem(row)); // valida transição (só failed)
    this.db
      .prepare(
        `UPDATE items SET status = 'pending', retry_count = ?, error_message = NULL WHERE id = ?`,
      )
      .run(retried.retryCount, itemId);
    return retried;
  }
}

function rowToItem(row: ItemRow): BatchItem {
  const base = {
    id: row.id,
    batchId: row.batch_id,
    filename: row.filename,
    signer: {
      name: row.signer_name,
      email: row.signer_email ?? undefined,
      phoneNumber: row.signer_phone ?? undefined,
    },
    delivery: row.delivery as Delivery,
    retryCount: row.retry_count,
  };

  switch (row.status) {
    case 'pending':
      return { ...base, status: 'pending' };
    case 'processing':
      return { ...base, status: 'processing' };
    case 'done':
      if (!row.envelope_id || !row.signer_id || !row.sign_url) {
        throw new Error(`Item ${row.id} está done mas sem dados da Clicksign`);
      }
      return {
        ...base,
        status: 'done',
        envelopeId: row.envelope_id,
        signerId: row.signer_id,
        signUrl: row.sign_url,
      };
    case 'failed':
      return { ...base, status: 'failed', errorMessage: row.error_message ?? 'erro desconhecido' };
    default:
      throw new Error(`Status desconhecido no banco: ${row.status}`);
  }
}
