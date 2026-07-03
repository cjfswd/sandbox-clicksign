# Prazo de assinatura (deadline_at) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir configurar o prazo de assinatura (`deadline_at`) de um envelope na Clicksign, por lote inteiro (propagando pra todos os documentos) com override individual por documento, mostrando o prazo padrão de 30 dias quando em branco.

**Architecture:** O prazo é persistido junto com cada item (igual `signer`/`delivery`), passado por toda a cadeia existente (App.vue → validation → session → process-item → clicksign) até `createEnvelope`, sem introduzir nenhum conceito novo de camada — só um campo a mais em estruturas já existentes.

**Tech Stack:** TypeScript, Vue 3 (`<script setup>`), Rust/Tauri (`tauri-plugin-sql`), SQLite.

## Global Constraints

- Comentários em `native/*.ts` usam bloco `/** */`; comentários em `App.vue` (dentro do `<script setup>`) usam `//`.
- `deadline_at` omitido no `POST /envelopes` faz a Clicksign aplicar 30 dias a partir da criação — confirmado empiricamente contra o sandbox real (envelope criado em `2026-07-03T18:43:44-03:00` recebeu `deadline_at: 2026-08-02T18:43:44.529-03:00`). Não regredir esse comportamento quando o campo fica vazio.
- Toda mudança precisa passar `cd desktop-tauri && npm run typecheck` (zero erros) e `cd desktop-tauri/src-tauri && cargo check` (zero erros) quando aplicável.
- Módulos que importam `@tauri-apps/plugin-sql`/`@tauri-apps/plugin-http` (`repository.ts`, `clicksign.ts`, `session.ts`, `App.vue`) não são testáveis via Vitest puro — verificação é manual, real, dentro de `npx tauri dev`, seguindo o mesmo padrão já usado no resto deste projeto (nunca substituir evidência real por raciocínio sobre "o que deveria acontecer").
- Mudar de ambiente (sandbox/produção) nunca mistura dados — irrelevante para esta feature (não mexe em `session.ts`), mas nenhuma mudança deve tocar `CLICKSIGN_BASE_URLS`/isolamento de banco.

---

### Task 1: Migration v3 — coluna `deadline_at` no Rust

**Files:**
- Modify: `desktop-tauri/src-tauri/src/lib.rs`

**Interfaces:**
- Produces: coluna `items.deadline_at TEXT` (nulável), disponível para `repository.ts` (Task 3) usar via `ItemRow`.

- [ ] **Step 1: Adicionar a migration v3**

Em `desktop-tauri/src-tauri/src/lib.rs`, adicionar a constante logo depois de `ADD_CLICKSIGN_STATUS_SQL` e trocar `batch_migrations`:

```rust
/// Migration v3: prazo de assinatura (deadline_at) configurável pelo
/// usuário — null quando não informado, e a Clicksign aplica o próprio
/// padrão de 30 dias a partir da criação do envelope nesse caso.
const ADD_DEADLINE_AT_SQL: &str = r#"
ALTER TABLE items ADD COLUMN deadline_at TEXT;
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
        Migration {
            version: 3,
            description: "add_deadline_at",
            sql: ADD_DEADLINE_AT_SQL,
            kind: MigrationKind::Up,
        },
    ]
}
```

- [ ] **Step 2: Verificar que compila**

Run: `cd desktop-tauri/src-tauri && cargo check` (se `cargo` não estiver no PATH: `export PATH="$HOME/.cargo/bin:$PATH"` antes)
Expected: `Finished` sem erros.

- [ ] **Step 3: Verificação manual — banco existente (v2 → v3)**

Este projeto já tem um `sandbox/batches.db` real (v1/v2) de sessões anteriores. Com processos limpos (`tasklist | grep -i -E "app.exe|cargo.exe"`, matar qualquer um encontrado), rodar `npx tauri dev` a partir de `desktop-tauri/` e confirmar no log que o app sobe sem erro de migration. Fechar o app (`taskkill //F //IM app.exe`) e confirmar via `tasklist` que não sobrou processo.

- [ ] **Step 4: Commit**

```bash
git add desktop-tauri/src-tauri/src/lib.rs
git commit -m "feat(desktop-tauri): migration v3 — coluna deadline_at em items"
```

---

### Task 2: `clicksign.ts` — `createEnvelope` aceita `deadlineAt`

**Files:**
- Modify: `desktop-tauri/src/native/clicksign.ts:134-142`

**Interfaces:**
- Consumes: nenhum novo (usa `EnvelopeAttributes` já existente).
- Produces: `createEnvelope(name: string, deadlineAt?: string): Promise<JsonApiResource<EnvelopeAttributes>>` — usado por `process-item.ts` (Task 4).

- [ ] **Step 1: Modificar `createEnvelope`**

Trocar (linhas 134-142 atuais):

```ts
  /** Cria o envelope (contêiner do lote de assinatura) em estado 'draft'. */
  async createEnvelope(name: string): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'POST',
      '/api/v3/envelopes',
      { data: { type: 'envelopes', attributes: { name } } },
    );
    return result.data;
  }
```

Por:

```ts
  /**
   * Cria o envelope (contêiner do lote de assinatura) em estado 'draft'.
   * `deadlineAt`, quando informado, é uma string ISO 8601 completa; quando
   * omitido, a Clicksign aplica o próprio padrão de 30 dias a partir da
   * criação (confirmado empiricamente contra o sandbox real).
   */
  async createEnvelope(
    name: string,
    deadlineAt?: string,
  ): Promise<JsonApiResource<EnvelopeAttributes>> {
    const result = await this.request<JsonApiDocument<JsonApiResource<EnvelopeAttributes>>>(
      'POST',
      '/api/v3/envelopes',
      {
        data: {
          type: 'envelopes',
          attributes: deadlineAt === undefined ? { name } : { name, deadline_at: deadlineAt },
        },
      },
    );
    return result.data;
  }
```

- [ ] **Step 2: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 3: Verificação manual — confirmar o formato aceito pela Clicksign (real, sandbox)**

Este passo empiricamente confirma qual formato de string a API aceita —
**não assuma, teste de verdade**. O projeto já tem um `.env` na raiz do
repo com `CLICKSIGN_ACCESS_TOKEN` (não imprima o valor do token em
nenhum momento — nem no terminal, nem em arquivos de log; use-o só via
variável de ambiente):

```bash
cd C:/Users/Usuario/sandbox-clicksign
set -a; source .env; set +a
curl -s -X POST "https://sandbox.clicksign.com/api/v3/envelopes" \
  -H "Authorization: $CLICKSIGN_ACCESS_TOKEN" \
  -H "Accept: application/vnd.api+json" \
  -H "Content-Type: application/vnd.api+json" \
  -d '{"data":{"type":"envelopes","attributes":{"name":"teste-formato-deadline","deadline_at":"2026-08-15T23:59:59.999Z"}}}'
```

Confira o campo `deadline_at` na resposta:
- Se a Clicksign aceitar o formato UTC `Z` e devolver algo equivalente a
  `2026-08-15T23:59:59.999Z` (ou o mesmo instante convertido para outro
  fuso, mas representando a mesma data/hora) — o formato `Z` funciona,
  não precisa de nenhuma conversão extra além do que já está no plano.
- Se a Clicksign responder com erro (400/422) rejeitando o formato — repita
  o teste usando um formato com offset explícito de fuso horário, ex.:
  `"2026-08-15T23:59:59-03:00"`, e documente no relatório qual dos dois
  formatos foi aceito. Se for necessário o formato com offset, ajuste a
  função `toDeadlineIso` que a Task 6 (App.vue) vai criar para gerar esse
  formato em vez de `Z` — deixe essa observação clara no relatório desta
  task para quem for implementar a Task 6.

- [ ] **Step 4: Commit**

```bash
git add desktop-tauri/src/native/clicksign.ts
git commit -m "feat(desktop-tauri): createEnvelope aceita deadlineAt opcional"
```

---

### Task 3: `batch.ts` + `repository.ts` — persistir `deadlineAt` no item

**Files:**
- Modify: `desktop-tauri/src/native/batch.ts:20-34`
- Modify: `desktop-tauri/src/native/repository.ts` (`BatchItemInput`, `ItemRow`, `createBatch`, `rowToItem`)
- Test: `desktop-tauri/src/native/batch.test.ts` (arquivo já existe — adicionar um teste)

**Interfaces:**
- Produces: `BaseItem.deadlineAt: string | null` (todo `BatchItem` passa a ter esse campo); `BatchItemInput.deadlineAt?: string` — usado por `process-item.ts` (Task 4) e `App.vue`/`validation.ts` (Task 6).

- [ ] **Step 1: Escrever o teste que falha**

Em `desktop-tauri/src/native/batch.test.ts`, adicionar (mantendo os testes existentes):

```ts
it('preserva deadlineAt através de startProcessing/complete', () => {
  const pending: PendingItem = {
    id: 'item-1',
    batchId: 'batch-1',
    filename: 'contrato.pdf',
    signer: { name: 'Ana Silva', email: 'ana@example.com' },
    delivery: 'link',
    retryCount: 0,
    clicksignStatus: null,
    clicksignStatusCheckedAt: null,
    deadlineAt: '2026-08-15T23:59:59.999Z',
    status: 'pending',
  };
  const processing = startProcessing(pending);
  const done = complete(processing, {
    envelopeId: 'env-1',
    signerId: 'signer-1',
    signUrl: 'https://sandbox.clicksign.com/notarial/widget/signatures/signer-1/redirect',
  });
  expect(done.deadlineAt).toBe('2026-08-15T23:59:59.999Z');
});
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd desktop-tauri && npx vitest run src/native/batch.test.ts`
Expected: FAIL — `deadlineAt` não existe em `BaseItem`, o objeto literal `pending` não compila contra o tipo `PendingItem`.

- [ ] **Step 3: Implementar em `batch.ts`**

Em `desktop-tauri/src/native/batch.ts`, adicionar o campo em `BaseItem` (depois de `clicksignStatusCheckedAt`):

```ts
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
  /** Prazo de assinatura (ISO 8601 completo) enviado no createEnvelope; null = a Clicksign aplica o próprio padrão de 30 dias. */
  deadlineAt: string | null;
}
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `cd desktop-tauri && npx vitest run src/native/batch.test.ts`
Expected: FAIL ainda — `deadlineAt` agora existe em `BaseItem`, mas `repository.ts` (que constrói objetos `BatchItem`) ainda não popula esse campo, então o typecheck do projeto (não deste arquivo de teste) vai reclamar. O teste do vitest em si (`batch.test.ts`) já deve passar nesse ponto porque o objeto literal `pending` no teste já inclui `deadlineAt` manualmente. Confirme rodando o teste isolado:

Run: `cd desktop-tauri && npx vitest run src/native/batch.test.ts`
Expected: PASS (o teste específico deste arquivo passa; o typecheck geral do projeto só fica limpo depois do Step 5 abaixo, em `repository.ts`).

- [ ] **Step 5: Atualizar `repository.ts`**

Adicionar `deadlineAt?: string` em `BatchItemInput` (depois de `delivery`):

```ts
/** O que é preciso para criar um item — sem id/status/retryCount, que o repositório preenche. */
export interface BatchItemInput {
  filename: string;
  signer: { name: string; email?: string; phoneNumber?: string };
  delivery: Delivery;
  deadlineAt?: string;
}
```

Adicionar `deadline_at: string | null` em `ItemRow` (depois de `clicksign_status_checked_at`):

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
  deadline_at: string | null;
}
```

Em `createBatch`, trocar o INSERT de `items` (dentro do `for (const item of items)`) para incluir a coluna nova:

```ts
        await this.db.execute(
          `INSERT INTO items (id, batch_id, seq, filename, signer_name, signer_email, signer_phone, delivery, deadline_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            crypto.randomUUID(),
            batchId,
            seq++,
            item.filename,
            item.signer.name,
            item.signer.email ?? null,
            item.signer.phoneNumber ?? null,
            item.delivery,
            item.deadlineAt ?? null,
          ],
        );
```

Em `rowToItem`, adicionar `deadlineAt` ao objeto `base` (depois de `clicksignStatusCheckedAt`):

```ts
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
    deadlineAt: row.deadline_at ?? null,
  };
  // resto do switch continua idêntico — não mude nada dentro dele
```

- [ ] **Step 6: Rodar o teste e o typecheck do projeto inteiro**

Run: `cd desktop-tauri && npx vitest run src/native/batch.test.ts`
Expected: PASS (3 testes no total no arquivo)

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 7: Commit**

```bash
git add desktop-tauri/src/native/batch.ts desktop-tauri/src/native/batch.test.ts desktop-tauri/src/native/repository.ts
git commit -m "feat(desktop-tauri): persiste deadlineAt no item (batch.ts + repository.ts)"
```

---

### Task 4: `process-item.ts` — passar `deadlineAt` pro `createEnvelope`

**Files:**
- Modify: `desktop-tauri/src/native/process-item.ts:85`

**Interfaces:**
- Consumes: `ProcessingItem.deadlineAt` (Task 3); `ClicksignClient.createEnvelope(name, deadlineAt?)` (Task 2).

- [ ] **Step 1: Modificar a chamada de `createEnvelope`**

Trocar a linha:

```ts
  const envelope = await clicksign.run((c) => c.createEnvelope(item.filename));
```

Por:

```ts
  const envelope = await clicksign.run((c) => c.createEnvelope(item.filename, item.deadlineAt ?? undefined));
```

- [ ] **Step 2: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add desktop-tauri/src/native/process-item.ts
git commit -m "feat(desktop-tauri): processItem passa deadlineAt pro createEnvelope"
```

---

### Task 5: `validation.ts` — `BatchItemPayload` ganha `deadlineAt`

**Files:**
- Modify: `desktop-tauri/src/validation.ts:8-13`

**Interfaces:**
- Produces: `BatchItemPayload.deadlineAt?: string` — usado por `App.vue` (Task 6) ao montar o payload de envio.

- [ ] **Step 1: Adicionar o campo**

Trocar:

```ts
export interface BatchItemPayload {
  filename: string;
  contentBase64: string;
  signer: { name: string; email?: string; phoneNumber?: string };
  delivery: Delivery;
}
```

Por:

```ts
export interface BatchItemPayload {
  filename: string;
  contentBase64: string;
  signer: { name: string; email?: string; phoneNumber?: string };
  delivery: Delivery;
  deadlineAt?: string;
}
```

Nenhuma regra de validação nova é necessária — `deadlineAt` é opcional e
qualquer formato malformado já vira um erro tratado normalmente pelo
pipeline de envio (a Clicksign rejeita e o item vira `failed`, mesmo
caminho de erro de sempre).

- [ ] **Step 2: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
git add desktop-tauri/src/validation.ts
git commit -m "feat(desktop-tauri): BatchItemPayload ganha deadlineAt opcional"
```

---

### Task 6: `App.vue` — campo de prazo por lote e por documento

**Files:**
- Modify: `desktop-tauri/src/App.vue`

**Interfaces:**
- Consumes: `Draft.deadlineAt` (novo campo desta task); `BatchItemPayload.deadlineAt` (Task 5); `BatchItemInput.deadlineAt` (Task 3, via `session.createBatch`).

- [ ] **Step 1: Adicionar `deadlineAt` ao `Draft` e estado do prazo do lote**

Na interface `Draft` (depois de `delivery: Delivery;`):

```ts
  // Prazo de assinatura deste documento (YYYY-MM-DD, do <input type="date">); vazio = usa o padrão de 30 dias da Clicksign.
  deadlineAt: string;
```

Depois da declaração de `DELIVERY_LABELS`, adicionar:

```ts
// Prazo aplicado a todo novo PDF adicionado e, quando alterado, a todos os drafts já na tela.
const batchDeadline = ref('');

// Converte a data (YYYY-MM-DD) escolhida pro formato ISO 8601 completo que createEnvelope espera — fim do dia, já que um prazo "até" essa data deve valer o dia inteiro.
function toDeadlineIso(dateOnly: string): string | undefined {
  return dateOnly ? `${dateOnly}T23:59:59.999Z` : undefined;
}

// Calcula e formata o prazo padrão que a Clicksign aplica (30 dias a partir de agora), pra mostrar quando o campo está vazio.
function defaultDeadlineLabel(): string {
  const date = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  return `${date.toLocaleDateString('pt-BR')} · 30 dias, padrão da Clicksign`;
}

// Aplica o prazo do lote a todos os drafts atuais — mudar o campo do lote muda todos os documentos.
function onBatchDeadlineChange(): void {
  for (const draft of drafts.value) draft.deadlineAt = batchDeadline.value;
}
```

- [ ] **Step 2: Popular `deadlineAt` ao adicionar PDFs**

Em `addPdfs`, no objeto empurrado em `drafts.value.push({...})`, adicionar o campo (depois de `delivery: 'link',`), herdando o prazo do lote já definido:

```ts
      delivery: 'link',
      deadlineAt: batchDeadline.value,
```

- [ ] **Step 3: Incluir `deadlineAt` no payload de envio**

Em `buildPayload`, incluir o campo convertido no objeto retornado (depois de `delivery: d.delivery,`):

```ts
function buildPayload(): BatchItemPayload[] {
  return drafts.value.map((d) => ({
    filename: d.filename,
    contentBase64: toBase64(d.bytes),
    signer: {
      name: d.name.trim(),
      email: d.email.trim() || undefined,
      phoneNumber: d.phone.replace(/\D/g, '') || undefined,
    },
    delivery: d.delivery,
    deadlineAt: toDeadlineIso(d.deadlineAt),
  }));
}
```

Em `sendBatch`, a linha que monta `items` a partir do `payload` precisa incluir `deadlineAt` na desestruturação:

```ts
    const items = payload.map(({ filename, signer, delivery, deadlineAt }) => ({
      filename,
      signer,
      delivery,
      deadlineAt,
    }));
```

- [ ] **Step 4: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 5: Adicionar os campos no template**

No template, adicionar o campo de prazo do lote na barra de ações (depois do botão "Copiar todos os links", antes do `<span>` do contador):

```html
      <button class="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium hover:bg-slate-200" @click="copyAllLinks">
        {{ justCopiedAll ? 'Copiado ✓' : 'Copiar todos os links' }}
      </button>
      <label class="flex items-center gap-1 text-xs text-slate-600">
        Prazo do lote:
        <input
          v-model="batchDeadline"
          type="date"
          class="rounded border border-slate-300 px-2 py-1 text-sm"
          @change="onBatchDeadlineChange"
        />
      </label>
      <span class="ml-auto text-xs text-slate-500">Documentos no lote: {{ drafts.length }}</span>
```

(repare que `<span class="ml-auto ...">` já existia — só adicionar o `<label>` novo antes dele, sem duplicar o `ml-auto`.)

Dentro do `v-for` de cada draft, no `<div class="flex flex-wrap gap-2">` que já tem nome/e-mail/telefone/select, adicionar o campo de prazo individual e o rótulo do padrão (depois do `<select v-model="draft.delivery">...</select>`):

```html
          <select v-model="draft.delivery" class="rounded border border-slate-300 px-2 py-1 text-sm">
            <option v-for="(label, value) in DELIVERY_LABELS" :key="value" :value="value">{{ label }}</option>
          </select>
          <input
            v-model="draft.deadlineAt"
            type="date"
            class="rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <span v-if="!draft.deadlineAt" class="self-center text-xs text-slate-400">
            {{ defaultDeadlineLabel() }}
          </span>
```

- [ ] **Step 6: Verificar que compila**

Run: `cd desktop-tauri && npm run typecheck`
Expected: sem erros.

- [ ] **Step 7: Verificação manual real — screenshot + envio real ao sandbox**

Matar processos órfãos (`tasklist | grep -i -E "app.exe|cargo.exe"`, matar se houver). Lançar `npx tauri dev` em segundo plano, aguardar build (poll do log, não dormir cegamente). Usando o mesmo tipo de script PowerShell de captura de tela já usado neste projeto (GDI `CopyFromScreen` via `Get-Process`/`GetWindowRect`, ou Windows UI Automation se cliques em coordenadas simples não alcançarem os `<input>` do WebView2 — já necessário numa correção anterior neste mesmo branch):

1. Adicionar um PDF de teste (reaproveitar `desktop-tauri/contrato-e2e.pdf`, já usado nos testes anteriores deste projeto).
2. Preencher o campo "Prazo do lote" com uma data futura (ex.: um mês à frente de hoje) e confirmar via screenshot que o campo de prazo daquele documento na lista foi preenchido junto.
3. Adicionar um segundo PDF **depois** de definir o prazo do lote e confirmar que ele já nasce com o mesmo prazo (não vazio).
4. Limpar o campo de prazo de um dos documentos individualmente e confirmar que o rótulo "DD/MM/AAAA · 30 dias, padrão da Clicksign" aparece só naquela linha, calculado corretamente (30 dias a partir de hoje).
5. Preencher nome + telefone do documento com prazo customizado e enviar o lote de verdade.
6. Depois de concluído, confirmar o prazo realmente aplicado consultando o envelope real — reaproveitar a técnica de teste direto por `curl` da Task 2 (fazer um GET no envelope usando o `envelopeId`, que aparece no histórico ou pode ser obtido via um `console.log` temporário removido depois) e conferir que o `deadline_at` retornado bate com a data escolhida na UI.
7. Fechar o app (`taskkill //F //IM app.exe`), confirmar via `tasklist` que não sobrou processo.

- [ ] **Step 8: Commit**

```bash
git add desktop-tauri/src/App.vue
git commit -m "feat(desktop-tauri): campo de prazo de assinatura por lote e por documento"
```

---

## Verificação final

- [ ] `cd desktop-tauri && npm run typecheck` — sem erros
- [ ] `cd desktop-tauri && npx vitest run` — todos os testes passam (deve incluir o teste novo de `deadlineAt` em `batch.test.ts`, total esperado 17 testes: os 16 já existentes + 1 novo)
- [ ] `cd desktop-tauri/src-tauri && cargo check` — sem erros
- [ ] Walkthrough manual completo (Task 6, Step 7) feito e confirmado com evidência real (screenshot + prazo confirmado via GET no envelope real)
- [ ] Atualizar `desktop-tauri/REFERENCE.md` com os campos/métodos novos (`createEnvelope` com `deadlineAt`, `BaseItem.deadlineAt`, `BatchItemInput.deadlineAt`, a migration v3, e os campos novos do `App.vue`) — seguir o mesmo formato de tabela já usado no resto do documento.
