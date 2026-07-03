# Histórico persistente de lotes + atualização de status Clicksign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar uma seção "Histórico" ao app desktop que mostra todos os lotes já enviados (não só o da sessão atual), com busca/filtro que alcança todo o banco, e um botão de atualização (por item ou em lote) que consulta a Clicksign para saber se o documento foi assinado ou se o envelope foi cancelado/deletado.

**Architecture:** Nova coluna `clicksign_status` na tabela `items` (migration v2), uma função pura de mapeamento do status do envelope da Clicksign, uma função pura de montagem de query SQL filtrada, e a wiring de tudo isso através de `BatchRepository` → `BatchSession` → `App.vue`. Sem mudança na arquitetura existente (SQLite via plugin-sql, rede via plugin-http, tudo no processo do app, sem sidecar).

**Tech Stack:** TypeScript, Vue 3 (`<script setup>`), Vitest, Rust/Tauri (`tauri-plugin-sql`), SQLite.

## Global Constraints

- Sandbox e produção usam bancos separados (`sandbox/batches.db`, `producao/batches.db`) — nunca misturar dados dos dois ambientes; toda query roda dentro da conexão já isolada por ambiente.
- `clicksign_status` é independente do `status` interno do pipeline de envio (pending/processing/done/failed) — nunca sobrescrever um pelo outro.
- Nenhuma checagem de status automática/periódica — só sob demanda, via botão clicado pelo usuário.
- Comentários em `native/*.ts` usam bloco `/** */`; comentários em `App.vue` (dentro do `<script setup>`) usam `//` — ver commit `34701f5`.
- Toda mudança precisa passar `npm run typecheck` (vue-tsc) e, para o lado Rust, `cargo check` dentro de `desktop-tauri/src-tauri`.
- Módulos que importam `@tauri-apps/plugin-sql`/`@tauri-apps/plugin-http` (repository.ts, clicksign.ts, session.ts) não são testáveis via Vitest puro — verificação é manual, dentro de `npx tauri dev` real, seguindo o mesmo padrão já usado nas Fases 1-7 da migração (ver `MIGRATION-PLAN.md`).

---

### Task 1: `ClicksignStatus` e campos novos em `batch.ts`

**Files:**
- Modify: `desktop-tauri/src/native/batch.ts`
- Test: `desktop-tauri/src/native/batch.test.ts` (novo arquivo)

**Interfaces:**
- Produces: `ClicksignStatus = 'pending' | 'signed' | 'canceled'` (exportado); `BaseItem` ganha `clicksignStatus: ClicksignStatus | null` e `clicksignStatusCheckedAt: string | null`; nova função `applyClicksignStatus(item: BatchItem, status: ClicksignStatus, checkedAtIso: string): BatchItem`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `desktop-tauri/src/native/batch.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { applyClicksignStatus, complete, startProcessing } from './batch.ts';
import type { PendingItem } from './batch.ts';

function pendingItem(): PendingItem {
  return {
    id: 'item-1',
    batchId: 'batch-1',
    filename: 'contrato.pdf',
    signer: { name: 'Ana Silva', email: 'ana@example.com' },
    delivery: 'link',
    retryCount: 0,
    status: 'pending',
    clicksignStatus: null,
    clicksignStatusCheckedAt: null,
  };
}

describe('applyClicksignStatus', () => {
  it('grava status e timestamp de checagem, preservando os outros campos do item', () => {
    const processing = startProcessing(pendingItem());
    const done = complete(processing, {
      envelopeId: 'env-1',
      signerId: 'signer-1',
      signUrl: 'https://sandbox.clicksign.com/notarial/widget/signatures/signer-1/redirect',
    });

    const updated = applyClicksignStatus(done, 'signed', '2026-07-03T12:00:00.000Z');

    expect(updated.clicksignStatus).toBe('signed');
    expect(updated.clicksignStatusCheckedAt).toBe('2026-07-03T12:00:00.000Z');
    expect(updated.id).toBe('item-1');
    expect(updated.status).toBe('done');
  });

  it('funciona em qualquer status do item (não é uma transição de pipeline)', () => {
    const updated = applyClicksignStatus(pendingItem(), 'pending', '2026-07-03T12:00:00.000Z');
    expect(updated.status).toBe('pending');
    expect(updated.clicksignStatus).toBe('pending');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd desktop-tauri && npx vitest run src/native/batch.test.ts`
Expected: FAIL — `applyClicksignStatus` não existe, e `pendingItem()`/os tipos não compilam (faltam os campos novos em `BaseItem`).

- [ ] **Step 3: Implementar**

Em `desktop-tauri/src/native/batch.ts`, modificar `BaseItem` e adicionar o tipo/função novos:

```ts
/** Status da assinatura confirmado na Clicksign — independente do status do pipeline de envio (pending/processing/done/failed). null até a primeira checagem manual (botão "Atualizar"). */
export type ClicksignStatus = 'pending' | 'signed' | 'canceled';

/** Campos comuns a todo item, independente do status atual. */
interface BaseItem {
  /** UUID gerado no repositório ao criar o lote. */
  id: string;
  batchId: string;
  filename: string;
  signer: Signer;
  delivery: Delivery;
  /** Quantas vezes já foi reenviado via resetForRetry; começa em 0. */
  retryCount: number;
  /** null até alguém clicar em "Atualizar" no histórico. */
  clicksignStatus: ClicksignStatus | null;
  /** Timestamp ISO da última checagem; null se nunca checado. */
  clicksignStatusCheckedAt: string | null;
}
```

(As interfaces `PendingItem`/`ProcessingItem`/`DoneItem`/`FailedItem` continuam iguais — herdam os campos novos via `extends BaseItem`.)

Adicionar ao final do arquivo, depois de `resetForRetry`:

```ts
/** Grava o resultado de uma checagem manual de status na Clicksign — não é uma transição de pipeline, funciona em qualquer status do item. */
export function applyClicksignStatus(
  item: BatchItem,
  status: ClicksignStatus,
  checkedAtIso: string,
): BatchItem {
  return { ...item, clicksignStatus: status, clicksignStatusCheckedAt: checkedAtIso };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `cd desktop-tauri && npx vitest run src/native/batch.test.ts`
Expected: PASS (2 testes)

- [ ] **Step 5: Rodar o typecheck do projeto inteiro**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros — isso vai apontar todo lugar que cria um `BatchItem`/`DoneItem`/etc. sem os campos novos (ver Task 5, `repository.ts`, que é corrigido lá).

Nota: o typecheck **vai falhar** neste ponto porque `repository.ts` (`rowToItem`) ainda não popula os campos novos — isso é esperado e corrigido na Task 5. Confirme que o único erro reportado é em `repository.ts`/`rowToItem` antes de prosseguir.

- [ ] **Step 6: Commit**

```bash
git add desktop-tauri/src/native/batch.ts desktop-tauri/src/native/batch.test.ts
git commit -m "feat(desktop-tauri): ClicksignStatus e applyClicksignStatus em batch.ts"
```

---

### Task 2: `mapEnvelopeStatus` — mapeamento do status do envelope

**Files:**
- Create: `desktop-tauri/src/native/clicksign-status.ts`
- Test: `desktop-tauri/src/native/clicksign-status.test.ts`

**Interfaces:**
- Consumes: `ClicksignStatus` (Task 1, de `./batch.ts`); `EnvelopeAttributes['status']` (de `./clicksign.ts`, já existe: `'draft' | 'running' | 'canceled' | 'closed'`).
- Produces: `mapEnvelopeStatus(envelopeStatus: EnvelopeAttributes['status'] | null): ClicksignStatus`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `desktop-tauri/src/native/clicksign-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mapEnvelopeStatus } from './clicksign-status.ts';

describe('mapEnvelopeStatus', () => {
  it('mapeia closed (todos assinaram) para signed', () => {
    expect(mapEnvelopeStatus('closed')).toBe('signed');
  });

  it('mapeia canceled para canceled', () => {
    expect(mapEnvelopeStatus('canceled')).toBe('canceled');
  });

  it('mapeia running (ainda faltam assinaturas) para pending', () => {
    expect(mapEnvelopeStatus('running')).toBe('pending');
  });

  it('mapeia draft para pending (não deveria acontecer, mas não é erro)', () => {
    expect(mapEnvelopeStatus('draft')).toBe('pending');
  });

  it('mapeia null (GET voltou 404 — envelope não existe mais) para canceled', () => {
    expect(mapEnvelopeStatus(null)).toBe('canceled');
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd desktop-tauri && npx vitest run src/native/clicksign-status.test.ts`
Expected: FAIL — o módulo `./clicksign-status.ts` não existe.

- [ ] **Step 3: Implementar**

Criar `desktop-tauri/src/native/clicksign-status.ts`:

```ts
/**
 * Mapeamento do status do envelope na Clicksign para o ClicksignStatus que
 * o app guarda e mostra no histórico (ver batch.ts). Um GET de envelope que
 * volta 404 significa que o envelope foi cancelado/deletado na Clicksign —
 * chame esta função com `null` nesse caso.
 */
import type { ClicksignStatus } from './batch.ts';
import type { EnvelopeAttributes } from './clicksign.ts';

export function mapEnvelopeStatus(envelopeStatus: EnvelopeAttributes['status'] | null): ClicksignStatus {
  if (envelopeStatus === null) return 'canceled';
  switch (envelopeStatus) {
    case 'closed':
      return 'signed';
    case 'canceled':
      return 'canceled';
    case 'running':
    case 'draft':
      return 'pending';
  }
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `cd desktop-tauri && npx vitest run src/native/clicksign-status.test.ts`
Expected: PASS (5 testes)

- [ ] **Step 5: Commit**

```bash
git add desktop-tauri/src/native/clicksign-status.ts desktop-tauri/src/native/clicksign-status.test.ts
git commit -m "feat(desktop-tauri): mapEnvelopeStatus — status da Clicksign para ClicksignStatus"
```

---

### Task 3: `buildBatchIdsQuery` — montagem da query de histórico filtrado

**Files:**
- Create: `desktop-tauri/src/native/history-query.ts`
- Test: `desktop-tauri/src/native/history-query.test.ts`

**Interfaces:**
- Produces: `HistoryFilter` (interface: `{ search?: string; status?: 'pending' | 'signed' | 'canceled' | 'failed'; dateFrom?: string; dateTo?: string }`); `buildBatchIdsQuery(filter: HistoryFilter, limit: number, offset: number): { sql: string; params: unknown[] }`.

Este módulo é **puro** (zero import de `@tauri-apps/plugin-sql`) — só monta a string SQL e os parâmetros; quem executa é `BatchRepository` (Task 5).

- [ ] **Step 1: Escrever o teste que falha**

Criar `desktop-tauri/src/native/history-query.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildBatchIdsQuery } from './history-query.ts';

describe('buildBatchIdsQuery', () => {
  it('sem filtro nenhum, só paginação', () => {
    const { sql, params } = buildBatchIdsQuery({}, 20, 0);
    expect(sql).toContain('ORDER BY b.created_at DESC');
    expect(sql).toContain('LIMIT ? OFFSET ?');
    expect(sql).not.toContain('WHERE');
    expect(params).toEqual([20, 0]);
  });

  it('busca por texto usa LIKE em signer_name e filename', () => {
    const { sql, params } = buildBatchIdsQuery({ search: 'ana' }, 20, 0);
    expect(sql).toContain('i.signer_name LIKE ?');
    expect(sql).toContain('i.filename LIKE ?');
    expect(params).toEqual(['%ana%', '%ana%', 20, 0]);
  });

  it("status 'failed' filtra por items.status", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'failed' }, 20, 0);
    expect(sql).toContain('i.status = ?');
    expect(params).toEqual(['failed', 20, 0]);
  });

  it("status 'pending' casa clicksign_status='pending' OU nulo (nunca checado)", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'pending' }, 20, 0);
    expect(sql).toContain('(i.clicksign_status = ? OR i.clicksign_status IS NULL)');
    expect(params).toEqual(['pending', 20, 0]);
  });

  it("status 'signed' filtra clicksign_status diretamente", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'signed' }, 20, 0);
    expect(sql).toContain('i.clicksign_status = ?');
    expect(params).toEqual(['signed', 20, 0]);
  });

  it("status 'canceled' filtra clicksign_status diretamente", () => {
    const { sql, params } = buildBatchIdsQuery({ status: 'canceled' }, 20, 0);
    expect(sql).toContain('i.clicksign_status = ?');
    expect(params).toEqual(['canceled', 20, 0]);
  });

  it('intervalo de datas filtra created_at do lote', () => {
    const { sql, params } = buildBatchIdsQuery({ dateFrom: '2026-01-01', dateTo: '2026-01-31' }, 20, 0);
    expect(sql).toContain('b.created_at >= ?');
    expect(sql).toContain('b.created_at <= ?');
    expect(params).toEqual(['2026-01-01', '2026-01-31', 20, 0]);
  });

  it('combina busca + status + datas juntos, na mesma ordem', () => {
    const { params } = buildBatchIdsQuery(
      { search: 'joão', status: 'signed', dateFrom: '2026-01-01', dateTo: '2026-01-31' },
      10,
      5,
    );
    expect(params).toEqual(['%joão%', '%joão%', 'signed', '2026-01-01', '2026-01-31', 10, 5]);
  });

  it('lotes/offset vão sempre por último, depois de todos os filtros', () => {
    const { params } = buildBatchIdsQuery({ search: 'x' }, 7, 3);
    expect(params.at(-2)).toBe(7);
    expect(params.at(-1)).toBe(3);
  });
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd desktop-tauri && npx vitest run src/native/history-query.test.ts`
Expected: FAIL — o módulo `./history-query.ts` não existe.

- [ ] **Step 3: Implementar**

Criar `desktop-tauri/src/native/history-query.ts`:

```ts
/**
 * Montagem pura da query SQL do histórico de lotes — sem nenhum import de
 * @tauri-apps/plugin-sql, testável sem banco de verdade. Quem executa é
 * BatchRepository.listBatches.
 */

export interface HistoryFilter {
  /** Busca livre por nome do signatário OU nome do arquivo. */
  search?: string;
  status?: 'pending' | 'signed' | 'canceled' | 'failed';
  /** Data ISO — filtra batches.created_at >= dateFrom. */
  dateFrom?: string;
  /** Data ISO — filtra batches.created_at <= dateTo. */
  dateTo?: string;
}

/**
 * Acha os `batch_id` que têm ao menos um item batendo com o filtro,
 * paginado por LOTE (não por item) — mostra o lote inteiro quando qualquer
 * item dele casa com o filtro.
 */
export function buildBatchIdsQuery(
  filter: HistoryFilter,
  limit: number,
  offset: number,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.search) {
    conditions.push('(i.signer_name LIKE ? OR i.filename LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }
  if (filter.status === 'failed') {
    conditions.push('i.status = ?');
    params.push('failed');
  } else if (filter.status === 'pending') {
    conditions.push('(i.clicksign_status = ? OR i.clicksign_status IS NULL)');
    params.push('pending');
  } else if (filter.status === 'signed' || filter.status === 'canceled') {
    conditions.push('i.clicksign_status = ?');
    params.push(filter.status);
  }
  if (filter.dateFrom) {
    conditions.push('b.created_at >= ?');
    params.push(filter.dateFrom);
  }
  if (filter.dateTo) {
    conditions.push('b.created_at <= ?');
    params.push(filter.dateTo);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = [
    'SELECT DISTINCT b.id, b.created_at',
    'FROM batches b',
    'JOIN items i ON i.batch_id = b.id',
    where,
    'ORDER BY b.created_at DESC',
    'LIMIT ? OFFSET ?',
  ]
    .filter(Boolean)
    .join('\n');
  params.push(limit, offset);

  return { sql, params };
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `cd desktop-tauri && npx vitest run src/native/history-query.test.ts`
Expected: PASS (9 testes)

- [ ] **Step 5: Commit**

```bash
git add desktop-tauri/src/native/history-query.ts desktop-tauri/src/native/history-query.test.ts
git commit -m "feat(desktop-tauri): buildBatchIdsQuery — filtro de histórico, testável sem banco"
```

---

### Task 4: Migration v2 — colunas `clicksign_status` no Rust

**Files:**
- Modify: `desktop-tauri/src-tauri/src/lib.rs:1-42`

**Interfaces:**
- Consumes: nenhum (mudança isolada no schema).
- Produces: colunas `items.clicksign_status TEXT` e `items.clicksign_status_checked_at TEXT`, disponíveis para `repository.ts` (Task 5) usar via `ItemRow`.

- [ ] **Step 1: Adicionar a migration v2**

Em `desktop-tauri/src-tauri/src/lib.rs`, adicionar a constante logo depois de `SCHEMA_SQL` e trocar `batch_migrations`:

```rust
/// Migration v2: campos para status de assinatura confirmado na Clicksign,
/// preenchidos só quando o usuário clica em "Atualizar" no histórico — não
/// existiam na v1 porque a checagem manual de status é uma feature nova.
const ADD_CLICKSIGN_STATUS_SQL: &str = r#"
ALTER TABLE items ADD COLUMN clicksign_status TEXT;
ALTER TABLE items ADD COLUMN clicksign_status_checked_at TEXT;
"#;

/// Migrations registradas nos dois bancos (sandbox e producao) — ver Builder abaixo.
fn batch_migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create_batches_and_items",
            sql: SCHEMA_SQL,
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "add_clicksign_status",
            sql: ADD_CLICKSIGN_STATUS_SQL,
            kind: MigrationKind::Up,
        },
    ]
}
```

- [ ] **Step 2: Verificar que compila**

Run: `cd desktop-tauri/src-tauri && cargo check`
Expected: `Finished` sem erros.

- [ ] **Step 3: Verificação manual — banco novo (sem dados anteriores)**

Apagar a pasta de dados de teste (só se for um perfil de teste, não o real do usuário):

Run: `powershell -Command "Remove-Item -Recurse -Force '$env:APPDATA\com.healthmais.assinaturas\sandbox' -ErrorAction SilentlyContinue"`

Depois: `cd desktop-tauri && npx tauri dev`

Expected: app abre normalmente, sem erro de migration no log (`tauri_plugin_log`/console). Feche o app depois de confirmar.

- [ ] **Step 4: Verificação manual — banco EXISTENTE (migrando de v1 para v2)**

Se já existir um `sandbox/batches.db` de uma sessão anterior desta migração (com lotes reais gravados), abrir o app de novo com `npx tauri dev` e confirmar:
1. O app abre sem erro.
2. Um lote enviado ANTES desta mudança ainda aparece corretamente (via `getBatch`, testável enviando um lote novo e comparando, ou inspecionando o arquivo `.db` com uma ferramenta como DB Browser for SQLite).
3. As colunas novas existem: abrir o arquivo `%APPDATA%\com.healthmais.assinaturas\sandbox\batches.db` com `sqlite3` (se disponível) ou DB Browser e rodar `PRAGMA table_info(items);` — deve listar `clicksign_status` e `clicksign_status_checked_at`.

- [ ] **Step 5: Commit**

```bash
git add desktop-tauri/src-tauri/src/lib.rs
git commit -m "feat(desktop-tauri): migration v2 — colunas clicksign_status em items"
```

---

### Task 5: `repository.ts` — `listBatches`, `updateClicksignStatus`, `rowToItem` atualizado

**Files:**
- Modify: `desktop-tauri/src/native/repository.ts`

**Interfaces:**
- Consumes: `ClicksignStatus`/`applyClicksignStatus` (Task 1, `./batch.ts`); `HistoryFilter`/`buildBatchIdsQuery` (Task 3, `./history-query.ts`); colunas `clicksign_status`/`clicksign_status_checked_at` (Task 4).
- Produces: `BatchRepository.listBatches(filter: HistoryFilter, limit: number, offset: number): Promise<Batch[]>`; `BatchRepository.updateClicksignStatus(itemId: string, status: ClicksignStatus): Promise<void>` — usados por `session.ts` (Task 6).

- [ ] **Step 1: Atualizar `ItemRow` e `rowToItem`**

Em `desktop-tauri/src/native/repository.ts`, adicionar os dois campos novos em `ItemRow` (depois de `error_message`):

```ts
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
```

E popular no `rowToItem` — trocar a montagem de `base` para incluir os dois campos:

```ts
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
    // ... resto do switch continua idêntico
```

(Não mude nada dentro do `switch` — `...base` já propaga os campos novos para todo branch.)

Atualizar o import no topo do arquivo:

```ts
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
```

- [ ] **Step 2: Verificar que o typecheck do projeto passa agora**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros — este é o erro que ficou pendente da Task 1, Step 5; deve estar resolvido agora.

- [ ] **Step 3: Adicionar `listBatches` e `updateClicksignStatus`**

No final da classe `BatchRepository`, antes do fechamento (`}` que fecha a classe, logo depois de `resetItemForRetry`):

```ts
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
```

- [ ] **Step 4: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 5: Verificação manual — `listBatches` contra um banco real**

Com `npx tauri dev` rodando e conectado ao sandbox, envie 2-3 lotes de teste (reaproveitando `contrato-e2e.pdf`, como nos testes anteriores desta migração) com nomes de signatário diferentes. Depois, abra o DevTools do webview (F12 dentro do app, se disponível em dev) ou adicione um `console.log` temporário em `session.ts` chamando:

```ts
console.log(await repo.listBatches({}, 20, 0));
console.log(await repo.listBatches({ search: 'nome-de-um-signatario-de-teste' }, 20, 0));
```

Confirme que:
1. Sem filtro, todos os lotes enviados aparecem, mais recente primeiro.
2. Com `search`, só os lotes que têm um item com aquele nome aparecem, mas com **todos** os itens do lote (não só o que bateu).

Remova o `console.log` temporário antes de prosseguir.

- [ ] **Step 6: Commit**

```bash
git add desktop-tauri/src/native/repository.ts
git commit -m "feat(desktop-tauri): listBatches e updateClicksignStatus no repositório"
```

---

### Task 6: `session.ts` — `listHistory` e `refreshItemStatus`

**Files:**
- Modify: `desktop-tauri/src/native/session.ts`

**Interfaces:**
- Consumes: `repo.listBatches`/`repo.updateClicksignStatus` (Task 5); `mapEnvelopeStatus` (Task 2); `HistoryFilter` (Task 3); `ClicksignStatus` (Task 1); `throttled.run` e `ClicksignError` (já existentes em `clicksign.ts`/`throttled-clicksign.ts`).
- Produces: `BatchSession.listHistory(filter, limit, offset): Promise<Batch[]>`; `BatchSession.refreshItemStatus(batchId, itemId): Promise<ClicksignStatus>` — usados por `App.vue` (Task 7).

- [ ] **Step 1: Atualizar imports e a interface `BatchSession`**

No topo de `desktop-tauri/src/native/session.ts`:

```ts
import { BatchRepository, type BatchItemInput } from './repository.ts';
import type { Batch, ClicksignStatus } from './batch.ts';
import type { HistoryFilter } from './history-query.ts';
import { mapEnvelopeStatus } from './clicksign-status.ts';
import { PdfStore } from './pdf-store.ts';
import { ClicksignClient, ClicksignError } from './clicksign.ts';
import { ThrottledClicksign } from './throttled-clicksign.ts';
import { TokenBucket } from './rate-limiter.ts';
import { QueueWorker } from './worker.ts';
import { processItem } from './process-item.ts';
```

Na interface `BatchSession`, adicionar depois de `retryItem`:

```ts
  /** Histórico de lotes já enviados, filtrado e paginado (ver history-query.ts). */
  listHistory(filter: HistoryFilter, limit: number, offset: number): Promise<Batch[]>;
  /** Consulta a Clicksign pro status real de assinatura de um item já `done` e persiste o resultado. */
  refreshItemStatus(batchId: string, itemId: string): Promise<ClicksignStatus>;
```

- [ ] **Step 2: Implementar os dois métodos no objeto devolvido por `startSession`**

Depois de `retryItem` (antes de `testConnection`):

```ts
    listHistory(filter, limit, offset) {
      return repo.listBatches(filter, limit, offset);
    },

    async refreshItemStatus(batchId, itemId) {
      const batch = await repo.getBatch(batchId);
      const item = batch?.items.find((i) => i.id === itemId);
      if (!item) throw new Error(`Item ${itemId} não encontrado no lote ${batchId}`);
      if (item.status !== 'done') {
        throw new Error('Item sem envelope criado — nada para checar na Clicksign ainda.');
      }

      let envelopeStatus: Awaited<ReturnType<typeof client.getEnvelope>>['attributes']['status'] | null;
      try {
        const envelope = await throttled.run((c) => c.getEnvelope(item.envelopeId));
        envelopeStatus = envelope.attributes.status;
      } catch (error) {
        if (error instanceof ClicksignError && error.status === 404) {
          envelopeStatus = null;
        } else {
          throw error;
        }
      }

      const clicksignStatus = mapEnvelopeStatus(envelopeStatus);
      await repo.updateClicksignStatus(itemId, clicksignStatus);
      return clicksignStatus;
    },
```

- [ ] **Step 3: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 4: Verificação manual — contra o sandbox real**

Com `npx tauri dev` rodando:
1. Envie um item novo (delivery "Somente link"), confirme que fica `done` com link.
2. Abra o link no navegador e assine manualmente o documento de teste no widget.
3. Chame `session.refreshItemStatus(batchId, itemId)` (via `console.log` temporário, mesmo esquema da Task 5) e confirme que devolve `'signed'`.
4. Para o caso "cancelado/deletado": crie outro item, e cancele o envelope pela interface web da Clicksign (sandbox) ou aceite testar só o mapeamento de 404 via teste unitário da Task 2 caso cancelar manualmente não seja prático nesse momento — documente no commit qual dos dois foi feito.
5. Remova o `console.log` temporário antes de prosseguir.

- [ ] **Step 5: Commit**

```bash
git add desktop-tauri/src/native/session.ts
git commit -m "feat(desktop-tauri): listHistory e refreshItemStatus na sessão"
```

---

### Task 7: `App.vue` — seção "Histórico"

**Files:**
- Modify: `desktop-tauri/src/App.vue`

**Interfaces:**
- Consumes: `session.listHistory`/`session.refreshItemStatus`/`session.retryItem` (Task 6); `Batch`/`BatchItem`/`ClicksignStatus` (`./native/batch.ts`); `HistoryFilter` (`./native/history-query.ts`).

- [ ] **Step 1: Adicionar imports e estado do histórico**

No `<script setup>`, atualizar o import de tipos:

```ts
import type { Batch, BatchItem, ClicksignStatus, Delivery } from './native/batch';
import type { HistoryFilter } from './native/history-query';
```

Depois do bloco de estado existente (`pollTimer`), adicionar:

```ts
const HISTORY_PAGE_SIZE = 20;

// Rótulos exibidos no select de status do filtro de histórico.
const HISTORY_STATUS_LABELS: Record<NonNullable<HistoryFilter['status']>, string> = {
  pending: 'Pendente',
  signed: 'Assinado',
  canceled: 'Cancelado ou deletado',
  failed: 'Falhou',
};

// Filtro atual da busca de histórico.
const historySearch = ref('');
const historyStatus = ref<'' | NonNullable<HistoryFilter['status']>>('');
const historyDateFrom = ref('');
const historyDateTo = ref('');

// Lotes carregados na tela (acumula a cada "Carregar mais").
const historyBatches = ref<Batch[]>([]);
const historyOffset = ref(0);
const historyHasMore = ref(true);
const historyLoading = ref(false);
const historyStatusMessage = ref('');

function currentHistoryFilter(): HistoryFilter {
  return {
    search: historySearch.value.trim() || undefined,
    status: historyStatus.value || undefined,
    dateFrom: historyDateFrom.value || undefined,
    dateTo: historyDateTo.value || undefined,
  };
}
```

- [ ] **Step 2: Adicionar as funções de carregar/filtrar histórico**

Depois de `statusClass` (fim do bloco de funções existentes), adicionar:

```ts
// Recarrega o histórico do zero com o filtro atual — chamado ao clicar "Buscar" ou ao abrir a seção pela primeira vez.
async function loadHistory(): Promise<void> {
  if (!session) return;
  historyLoading.value = true;
  historyOffset.value = 0;
  try {
    const batches = await session.listHistory(currentHistoryFilter(), HISTORY_PAGE_SIZE, 0);
    historyBatches.value = batches;
    historyOffset.value = batches.length;
    historyHasMore.value = batches.length === HISTORY_PAGE_SIZE;
    historyStatusMessage.value = batches.length === 0 ? 'Nenhum lote encontrado.' : '';
  } catch (error) {
    historyStatusMessage.value = `Erro ao carregar histórico: ${String(error)}`;
  } finally {
    historyLoading.value = false;
  }
}

// Busca a próxima página de lotes com o filtro atual, sem limpar o que já está na tela.
async function loadMoreHistory(): Promise<void> {
  if (!session || historyLoading.value) return;
  historyLoading.value = true;
  try {
    const batches = await session.listHistory(currentHistoryFilter(), HISTORY_PAGE_SIZE, historyOffset.value);
    historyBatches.value.push(...batches);
    historyOffset.value += batches.length;
    historyHasMore.value = batches.length === HISTORY_PAGE_SIZE;
  } catch (error) {
    historyStatusMessage.value = `Erro ao carregar mais itens: ${String(error)}`;
  } finally {
    historyLoading.value = false;
  }
}

// Atualiza o status de um único item do histórico, in-place no array reativo.
async function refreshHistoryItem(batch: Batch, item: BatchItem): Promise<void> {
  if (!session) return;
  try {
    const status = await session.refreshItemStatus(batch.id, item.id);
    applyHistoryItemStatus(batch.id, item.id, status);
  } catch (error) {
    historyStatusMessage.value = `Falha ao atualizar "${item.filename}": ${String(error)}`;
  }
}

// Roda refreshHistoryItem para todo item 'done' carregado na tela agora (não o histórico inteiro).
async function refreshAllLoadedHistory(): Promise<void> {
  if (!session) return;
  const targets = historyBatches.value.flatMap((batch) =>
    batch.items.filter((item) => item.status === 'done').map((item) => ({ batch, item })),
  );
  historyStatusMessage.value = `Atualizando ${targets.length} documento(s)...`;
  const results = await Promise.allSettled(targets.map(({ batch, item }) => refreshHistoryItem(batch, item)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  historyStatusMessage.value =
    failed === 0 ? `${targets.length} documento(s) atualizados.` : `${failed} de ${targets.length} falharam.`;
}

// Reenfileira um item que falhou num lote antigo — o worker processa em segundo plano; recarregue o histórico depois para ver o resultado.
async function retryHistoryItem(batch: Batch, item: BatchItem): Promise<void> {
  if (!session) return;
  try {
    await session.retryItem(batch.id, item.id);
    historyStatusMessage.value = `"${item.filename}" reenviado — clique em "Buscar" novamente em alguns segundos para ver o resultado.`;
  } catch (error) {
    historyStatusMessage.value = `Falha ao reenviar "${item.filename}": ${String(error)}`;
  }
}

function applyHistoryItemStatus(batchId: string, itemId: string, status: ClicksignStatus): void {
  const batch = historyBatches.value.find((b) => b.id === batchId);
  const item = batch?.items.find((i) => i.id === itemId);
  if (item) {
    item.clicksignStatus = status;
    item.clicksignStatusCheckedAt = new Date().toISOString();
  }
}

function clicksignStatusLabel(item: BatchItem): string {
  if (item.status !== 'done') return '';
  switch (item.clicksignStatus) {
    case 'signed':
      return 'Assinado ✓';
    case 'canceled':
      return 'Cancelado/deletado na Clicksign';
    case 'pending':
      return 'Pendente de assinatura';
    default:
      return 'Status não verificado';
  }
}

// Abre uma URL de assinatura no navegador padrão do sistema (sem tratamento de erro — cada chamador decide onde mostrar a falha).
async function openSignUrl(url: string): Promise<void> {
  await openUrl(url);
}

// Abre o link de um item do histórico, mostrando erro na mensagem de status da seção.
async function openHistoryLink(url: string): Promise<void> {
  try {
    await openSignUrl(url);
  } catch (error) {
    historyStatusMessage.value = `Falha ao abrir o link: ${String(error)}`;
  }
}
```

Trocar a implementação de `openLink` (já existente, do lote atual) para reaproveitar `openSignUrl` em vez de chamar `openUrl` direto:

```ts
// Abre o link do draft atual, mostrando erro no próprio card (actionError).
async function openLink(draft: Draft): Promise<void> {
  if (!draft.signUrl) return;
  draft.actionError = null;
  try {
    await openSignUrl(draft.signUrl);
  } catch (error) {
    draft.actionError = `Falha ao abrir o link no navegador: ${String(error)}`;
  }
}
```

- [ ] **Step 3: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 4: Adicionar a seção no template**

No `<template>`, depois do `<footer>` que fecha o lote atual (mas ainda dentro da `<div class="min-h-screen ...">`), adicionar:

```html
    <section class="mt-8 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-sm font-bold">Histórico</h2>
        <button
          class="rounded bg-slate-100 px-3 py-1 text-xs font-medium hover:bg-slate-200"
          :disabled="historyLoading"
          @click="refreshAllLoadedHistory"
        >
          Atualizar tudo
        </button>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-2">
        <input
          v-model="historySearch"
          type="text"
          placeholder="Buscar por signatário ou arquivo"
          class="w-56 rounded border border-slate-300 px-2 py-1 text-sm"
        />
        <select v-model="historyStatus" class="rounded border border-slate-300 px-2 py-1 text-sm">
          <option value="">Todos os status</option>
          <option v-for="(label, value) in HISTORY_STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
        <input v-model="historyDateFrom" type="date" class="rounded border border-slate-300 px-2 py-1 text-sm" />
        <input v-model="historyDateTo" type="date" class="rounded border border-slate-300 px-2 py-1 text-sm" />
        <button
          class="rounded bg-slate-100 px-3 py-1 text-sm font-medium hover:bg-slate-200"
          @click="loadHistory"
        >
          Buscar
        </button>
      </div>

      <p v-if="historyStatusMessage" class="mb-2 text-xs text-slate-500">{{ historyStatusMessage }}</p>

      <div v-for="batch in historyBatches" :key="batch.id" class="mb-4">
        <p class="mb-1 text-xs font-semibold text-slate-600">
          Lote de {{ new Date(batch.createdAt).toLocaleString('pt-BR') }} — {{ batch.items.length }} documento(s)
        </p>
        <div class="space-y-2">
          <div
            v-for="item in batch.items"
            :key="item.id"
            class="rounded border border-slate-200 p-2 text-sm"
          >
            <div class="flex items-center gap-2">
              <span class="font-medium">📄 {{ item.filename }}</span>
              <span class="text-xs text-slate-500">{{ item.signer.name }}</span>
              <span class="text-xs">{{ clicksignStatusLabel(item) }}</span>
              <button
                v-if="item.status === 'done'"
                class="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
                @click="refreshHistoryItem(batch, item)"
              >
                Atualizar status
              </button>
              <button
                v-if="item.status === 'failed'"
                class="ml-auto rounded bg-slate-100 px-2 py-0.5 text-xs hover:bg-slate-200"
                @click="retryHistoryItem(batch, item)"
              >
                Tentar de novo
              </button>
            </div>
            <p v-if="item.status === 'done'" class="mt-1 break-all text-xs text-blue-600 underline">
              <a href="#" @click.prevent="openHistoryLink(item.signUrl!)">{{ item.signUrl }}</a>
            </p>
            <p v-if="item.status === 'failed'" class="mt-1 text-xs text-red-600">{{ item.errorMessage }}</p>
          </div>
        </div>
      </div>

      <button
        v-if="historyHasMore && historyBatches.length > 0"
        class="mt-2 w-full rounded bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-100"
        :disabled="historyLoading"
        @click="loadMoreHistory"
      >
        Carregar mais
      </button>
    </section>
```

`item.signUrl!` é seguro porque o elemento pai já está atrás de `v-if="item.status === 'done'"` — o TS não estreita automaticamente dentro de expressões de template, por isso o `!` explícito.

- [ ] **Step 5: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 6: Carregar o histórico automaticamente após conectar**

Em `saveAndConnect`, depois da linha `connStatus.value = await session.testConnection();`, adicionar:

```ts
    if (connStatus.value === 'ok') await loadHistory();
```

- [ ] **Step 7: Verificação manual — screenshot real**

Com `npx tauri dev` rodando (matando processos órfãos antes, `tasklist | grep app.exe`):
1. Conectar no sandbox com um token que já tenha lotes enviados de sessões anteriores desta migração.
2. Tirar screenshot (`screenshot-window.ps1`, mesmo script já usado nesta sessão) e confirmar que a seção "Histórico" aparece com os lotes antigos, cada um com sua data.
3. Digitar um nome de signatário conhecido no campo de busca, clicar "Buscar", confirmar que só os lotes com aquele nome aparecem (lote inteiro, não só o item).
4. Clicar "Atualizar status" num item `done` antigo, confirmar visualmente que o rótulo muda (ex.: para "Status não verificado" → algum dos três estados, dependendo do que a Clicksign realmente reportar).
5. Se houver algum item `failed` no histórico, clicar "Tentar de novo", confirmar a mensagem de "reenviado" e, depois de alguns segundos, clicar "Buscar" de novo e confirmar que o item mudou de status.
6. Fechar o app pelo X, confirmar via `tasklist` que não sobrou processo órfão.

- [ ] **Step 8: Commit**

```bash
git add desktop-tauri/src/App.vue
git commit -m "feat(desktop-tauri): seção Histórico — busca, filtro, atualização de status e retry"
```

---

## Verificação final

- [ ] `cd desktop-tauri && npm run typecheck` — sem erros
- [ ] `cd desktop-tauri && npx vitest run` — todos os testes passam (batch.test.ts, clicksign-status.test.ts, history-query.test.ts)
- [ ] `cd desktop-tauri/src-tauri && cargo check` — sem erros
- [ ] Walkthrough manual completo (Task 7, Step 8) feito e confirmado
- [ ] Atualizar `desktop-tauri/REFERENCE.md` com os módulos novos (`clicksign-status.ts`, `history-query.ts`, os campos/métodos novos de `batch.ts`/`repository.ts`/`session.ts`, e a seção "Histórico" do `App.vue`) — seguir o mesmo formato de tabela já usado no resto do documento.
