/**
 * Persistência do lote via @tauri-apps/plugin-sql (SQLite embutido no
 * app.exe via sqlx/Rust — sem processo separado). Porta de
 * src/infra/repository.ts (node:sqlite): mesma tabela, mesmo comportamento,
 * mas toda a API é assíncrona (IPC) em vez de síncrona.
 *
 * O claim atômico (`UPDATE ... RETURNING *`) usa `db.select()` em vez de
 * `db.execute()` — RETURNING produz linhas, e só `select()` as devolve.
 * Validado contra sqlx-sqlite 0.8.6 (bundle recente, suporta RETURNING
 * desde SQLite 3.35).
 */
import Database from '@tauri-apps/plugin-sql';
import type {
  Batch,
  BatchItem,
  ClicksignStatus,
  Delivery,
  DoneItem,
  FailedItem,
  PendingItem,
  ProcessingItem,
} from './batch.ts';
import { resetForRetry } from './batch.ts';
import { buildBatchIdsQuery, type HistoryFilter } from './history-query.ts';

/** O que é preciso para criar um item — sem id/status/retryCount, que o repositório preenche. */
export interface BatchItemInput {
  filename: string;
  signer: { name: string; email?: string; phoneNumber?: string };
  delivery: Delivery;
}

/** Forma exata de uma linha da tabela `items` (nomes de coluna, snake_case). */
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
  clicksign_status: string | null;
  clicksign_status_checked_at: string | null;
}

export class BatchRepository {
  /** `db` é a conexão sqlx aberta por load(); uma instância de BatchRepository = uma conexão = um ambiente. */
  private constructor(private readonly db: Database) {}

  /** `sqlitePath` deve bater com um dos caminhos registrados em add_migrations no lib.rs. */
  static async load(sqlitePath: 'sandbox/batches.db' | 'producao/batches.db'): Promise<BatchRepository> {
    const db = await Database.load(`sqlite:${sqlitePath}`);
    return new BatchRepository(db);
  }

  /** Fecha a conexão SQLite (chamado ao trocar de ambiente ou encerrar a sessão). */
  async close(): Promise<void> {
    await this.db.close();
  }

  /** Insere o lote e todos os itens numa transação — ou tudo entra, ou nada entra. */
  async createBatch(items: BatchItemInput[]): Promise<Batch> {
    const batchId = crypto.randomUUID();
    const createdAt = new Date().toISOString();

    await this.db.execute('BEGIN');
    try {
      await this.db.execute('INSERT INTO batches (id, created_at) VALUES ($1, $2)', [batchId, createdAt]);
      let seq = 0;
      for (const item of items) {
        await this.db.execute(
          `INSERT INTO items (id, batch_id, seq, filename, signer_name, signer_email, signer_phone, delivery)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            crypto.randomUUID(),
            batchId,
            seq++,
            item.filename,
            item.signer.name,
            item.signer.email ?? null,
            item.signer.phoneNumber ?? null,
            item.delivery,
          ],
        );
      }
      await this.db.execute('COMMIT');
    } catch (error) {
      await this.db.execute('ROLLBACK');
      throw error;
    }

    const batch = await this.getBatch(batchId);
    if (!batch) throw new Error(`Lote recém-criado ${batchId} não encontrado`);
    return batch;
  }

  /** Lê o lote e seus itens (em ordem de criação); null se o id não existir. */
  async getBatch(batchId: string): Promise<Batch | null> {
    const batchRows = await this.db.select<Array<{ id: string; created_at: string }>>(
      'SELECT id, created_at FROM batches WHERE id = $1',
      [batchId],
    );
    const batchRow = batchRows[0];
    if (!batchRow) return null;

    const rows = await this.db.select<ItemRow[]>('SELECT * FROM items WHERE batch_id = $1 ORDER BY seq', [
      batchId,
    ]);

    return {
      id: batchRow.id,
      createdAt: batchRow.created_at,
      items: rows.map(rowToItem),
    };
  }

  /** Transição atômica pending → processing do item mais antigo da fila. */
  async claimNextPending(): Promise<ProcessingItem | null> {
    const rows = await this.db.select<ItemRow[]>(
      `UPDATE items SET status = 'processing'
       WHERE id = (SELECT id FROM items WHERE status = 'pending' ORDER BY rowid LIMIT 1)
       RETURNING *`,
    );
    const row = rows[0];
    if (!row) return null;
    const item = rowToItem(row);
    if (item.status !== 'processing') throw new Error('claim retornou item fora de processing');
    return item;
  }

  /** Grava o resultado final do item (done com dados da Clicksign, ou failed com a mensagem de erro). */
  async saveItemResult(item: DoneItem | FailedItem): Promise<void> {
    if (item.status === 'done') {
      await this.db.execute(
        `UPDATE items SET status = 'done', envelope_id = $1, signer_id = $2, sign_url = $3, error_message = NULL
         WHERE id = $4`,
        [item.envelopeId, item.signerId, item.signUrl, item.id],
      );
      return;
    }
    await this.db.execute(`UPDATE items SET status = 'failed', error_message = $1 WHERE id = $2`, [
      item.errorMessage,
      item.id,
    ]);
  }

  /** Boot: itens presos em processing (crash anterior) voltam para a fila. */
  async reclaimStale(): Promise<number> {
    const result = await this.db.execute(`UPDATE items SET status = 'pending' WHERE status = 'processing'`);
    return result.rowsAffected;
  }

  /** Busca o item, valida a transição (via resetForRetry) e grava o novo estado 'pending'. */
  async resetItemForRetry(batchId: string, itemId: string): Promise<PendingItem> {
    const rows = await this.db.select<ItemRow[]>('SELECT * FROM items WHERE id = $1 AND batch_id = $2', [
      itemId,
      batchId,
    ]);
    const row = rows[0];
    if (!row) throw new Error(`Item ${itemId} não encontrado no lote ${batchId}`);

    const retried = resetForRetry(rowToItem(row)); // valida transição (só failed)
    await this.db.execute(
      `UPDATE items SET status = 'pending', retry_count = $1, error_message = NULL WHERE id = $2`,
      [retried.retryCount, itemId],
    );
    return retried;
  }

  /**
   * Histórico filtrado, paginado por LOTE — usa buildBatchIdsQuery pra
   * achar os batch_id que batem com o filtro, depois reaproveita getBatch
   * pra montar cada lote completo (todos os itens, mesmo que só um tenha
   * batido no filtro).
   */
  async listBatches(filter: HistoryFilter, limit: number, offset: number): Promise<Batch[]> {
    const { sql, params } = buildBatchIdsQuery(filter, limit, offset);
    const batchRows = await this.db.select<Array<{ id: string; created_at: string }>>(sql, params);
    const batches = await Promise.all(batchRows.map((row) => this.getBatch(row.id)));
    return batches.filter((b): b is Batch => b !== null);
  }

  /** Grava o resultado de uma checagem manual de status na Clicksign (ver session.ts refreshItemStatus). */
  async updateClicksignStatus(itemId: string, status: ClicksignStatus): Promise<void> {
    const checkedAt = new Date().toISOString();
    await this.db.execute(
      'UPDATE items SET clicksign_status = $1, clicksign_status_checked_at = $2 WHERE id = $3',
      [status, checkedAt, itemId],
    );
  }
}

/** Converte uma linha crua do SQLite (snake_case, tipos opcionais) para o BatchItem tipado do domínio. */
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
    clicksignStatus: (row.clicksign_status as ClicksignStatus | null) ?? null,
    clicksignStatusCheckedAt: row.clicksign_status_checked_at ?? null,
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
