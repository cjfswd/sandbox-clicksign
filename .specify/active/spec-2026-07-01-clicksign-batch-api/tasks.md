# Tasks — spec-2026-07-01-clicksign-batch-api

**Spec:** [spec.md](./spec.md) · **Plan:** [plan.md](./plan.md)
**Convenção de worktree:** `spec-2026-07-01-clicksign-batch-api-task-NNN`
**Convenção de commit:** `feat(batch-api): <descrição> — task-NNN`

---

## Grafo de dependências

```
task-001 (bootstrap projeto)
    ├──────────────┐
task-002 (domain)  task-004 (rate limiter)
    ├──────┬───────┤       │
task-003   task-005   task-006
(contrato/ (repo+pdf  (throttled
validação)  store)     client)
    │          │           │
    │          │      task-007 (pipeline do item)
    │          │           │
task-009 ←─────┤      task-008 (worker) ←── task-005
(http)         │           │
    └──────────┴───→ task-010 (bootstrap + integração sandbox)
```

| Nível | Tasks paralelas entre si |
|-------|--------------------------|
| 1 | task-001 |
| 2 | task-002, task-004 |
| 3 | task-003, task-005, task-006 |
| 4 | task-007, task-009 |
| 5 | task-008 |
| 6 | task-010 |

---

## task-001 — Bootstrap do projeto

**Status:** done · **Depende de:** — · **Nível:** 1

**O que fazer:** Transformar o projeto em base implementável: `git init` + commit inicial
do estado atual; instalar dependências (`hono`, `@hono/node-server`, `@ts-rest/core`,
`zod`, `vitest` como dev); criar a estrutura de pastas do plan (`contracts/`,
`src/domain`, `src/infra`, `src/app`, `src/http`); mover `src/clicksign.ts` →
`src/infra/clicksign.ts` e `src/sample-pdf.ts` → `src/infra/sample-pdf.ts`, corrigindo
os imports dos scripts CLI existentes; configurar script `npm test` (vitest).

**Done quando:**
- [ ] Repositório git com commit inicial
- [ ] `npm run typecheck` passa
- [ ] `npm test` roda (zero testes é aceitável aqui)
- [ ] Scripts `npm run create` e `npm run status` continuam funcionando

**Arquivos:** `package.json`, `tsconfig.json`, moves em `src/`, `vitest.config.ts`

---

## task-002 — Domínio: estados e transições do lote

**Status:** done · **Depende de:** task-001 · **Nível:** 2

**O que fazer (TDD):** Criar `src/domain/batch.ts` com os tipos `Batch`, `BatchItem`
(discriminated union por `status: pending | processing | done | failed`), `Delivery`
(`email | whatsapp | link`) e as funções puras de transição
(`startProcessing`, `complete(signUrl)`, `fail(error)`, `resetForRetry`). Transições
inválidas (ex.: `done → processing`) lançam erro. Sem IO.

**Done quando:**
- [ ] Testes de transição cobrindo caminhos válidos e inválidos passam
- [ ] `retry_count` incrementa em `resetForRetry` e zera em `complete`
- [ ] Typecheck passa

**Arquivos:** `src/domain/batch.ts`, `src/domain/batch.test.ts`

---

## task-003 — Contrato ts-rest e validação de lote

**Status:** done · **Depende de:** task-002 · **Nível:** 3 · **Paralela com:** 005, 006

**O que fazer (TDD):** Criar `contracts/batch-contract.ts` (ts-rest + Zod):
`POST /batches`, `GET /batches/:id`, `POST /batches/:id/items/:itemId/retry`, com
schemas de request/response. Criar `src/domain/validation.ts` com as regras por item
(critério 4 da spec): signer com nome; `delivery=email ⇒ email` válido;
`delivery=whatsapp ⇒ phone_number`; base64 decodável; magic bytes `%PDF`; ≤ 10 MB
decodificado. A validação retorna **todos** os erros do lote (por índice de item),
não só o primeiro.

**Done quando:**
- [ ] Testes de validação com casos válidos e cada regra violada passam
- [ ] Erro de validação identifica o índice do item e o campo
- [ ] Typecheck passa

**Arquivos:** `contracts/batch-contract.ts`, `src/domain/validation.ts`, `src/domain/validation.test.ts`

---

## task-004 — Rate limiter (token bucket)

**Status:** done · **Depende de:** task-001 · **Nível:** 2 · **Paralela com:** 002

**O que fazer (TDD):** Criar `src/infra/rate-limiter.ts`: token bucket com capacidade e
janela configuráveis (`acquire(): Promise<void>` que resolve quando há token). Testes
com fake timers do Vitest: N requisições imediatas até a capacidade, a N+1 aguarda a
janela, reposição gradual.

**Done quando:**
- [ ] Testes com fake timers provam que a taxa nunca excede capacidade/janela
- [ ] Typecheck passa

**Arquivos:** `src/infra/rate-limiter.ts`, `src/infra/rate-limiter.test.ts`

---

## task-005 — Repositório SQLite e armazenamento de PDFs

**Status:** done · **Depende de:** task-002 · **Nível:** 3 · **Paralela com:** 003, 006

**O que fazer (TDD):** Criar `src/infra/repository.ts` (`BatchRepository` sobre
`node:sqlite` `DatabaseSync`): schema/migração idempotente, `createBatch`, `getBatch`
(com itens e agregado de progresso), `claimNextPending` (transição atômica
pending→processing), `saveItemResult`, `reclaimStale` (processing→pending, para o boot),
`resetItemForRetry`. Criar `src/infra/pdf-store.ts`: grava base64 decodificado em
`DATA_DIR/pdfs/{item_id}.pdf`, lê para processamento, remove ao concluir.
Testes com SQLite `:memory:` e diretório temporário.

**Done quando:**
- [ ] Testes de CRUD, claim atômico, reclaim e limpeza de PDF passam
- [ ] `getBatch` reflete critério 2 (links por item quando `done`)
- [ ] Typecheck passa

**Arquivos:** `src/infra/repository.ts`, `src/infra/repository.test.ts`, `src/infra/pdf-store.ts`, `src/infra/pdf-store.test.ts`

---

## task-006 — Cliente Clicksign com vazão controlada e backoff

**Status:** done · **Depende de:** task-004 · **Nível:** 3 · **Paralela com:** 003, 005

**O que fazer (TDD):** Criar `src/infra/throttled-clicksign.ts`: wrapper do
`ClicksignClient` que (a) passa toda requisição pelo token bucket; (b) em HTTP 429,
aguarda com backoff exponencial + jitter e re-tenta (máx. configurável) sem propagar
erro (critério 8); (c) em 4xx definitivo propaga `ClicksignError`. Adicionar ao cliente
existente o método `getEnvelopeEvents(envelopeId)` (necessário para extrair o link do
evento `add_signer` — decisão 5 do plan) e `notifySigner(envelopeId, signerId, message?)`.
Testes com fetch mockado (msw ou vi.stubGlobal).

**Done quando:**
- [ ] Teste prova: 429 → retry com backoff → sucesso, sem exceção
- [ ] Teste prova: 422 → propaga erro imediatamente
- [ ] Toda chamada consome token do bucket (spy)
- [ ] Typecheck passa

**Arquivos:** `src/infra/throttled-clicksign.ts`, `src/infra/throttled-clicksign.test.ts`, `src/infra/clicksign.ts` (métodos novos)

---

## task-007 — Pipeline de processamento de um item

**Status:** done · **Depende de:** task-006, task-002 · **Nível:** 4 · **Paralela com:** 009

**O que fazer (TDD):** Criar `src/app/process-item.ts`: função que recebe um item e o
client throttled e executa envelope → documento → signatário (com `communicate_events`
derivado do `delivery`) → requisito de qualificação → requisito de autenticação
(auth = `email` para delivery email/link; `whatsapp` para delivery whatsapp) → ativação →
obtém o link do evento `add_signer` (fallback: montar string + warning) → dispara
notificação SE `delivery ≠ link` (critério 10). Retorna `{envelopeId, signerId, signUrl}`.
Testes com client mockado verificando ordem dos passos e os payloads por tipo de delivery.

**Done quando:**
- [ ] Teste por delivery (`email`, `whatsapp`, `link`) verificando `communicate_events`, auth e notificação
- [ ] Teste do fallback do link (evento sem `url`)
- [ ] Typecheck passa

**Arquivos:** `src/app/process-item.ts`, `src/app/process-item.test.ts`

---

## task-008 — Worker da fila

**Status:** done · **Depende de:** task-005, task-007 · **Nível:** 5

**O que fazer (TDD):** Criar `src/app/worker.ts`: loop sequencial que faz claim do
próximo item `pending`, roda `process-item`, grava resultado (`done` + link) ou captura
exceção e grava `failed` com mensagem (critério 7 — o loop continua). No `start()`,
executa `reclaimStale` (critério 9). `stop()` gracioso para testes. Testes com
repositório real (`:memory:`) e pipeline mockado: lote com item que falha no meio não
impede os demais; boot com item `processing` órfão reprocessa.

**Done quando:**
- [ ] Teste: 3 itens, o 2º falha → 1º e 3º `done`, 2º `failed` com mensagem
- [ ] Teste: item `processing` órfão no boot volta para a fila e conclui
- [ ] Typecheck passa

**Arquivos:** `src/app/worker.ts`, `src/app/worker.test.ts`

---

## task-009 — Servidor HTTP, auth e handlers

**Status:** done · **Depende de:** task-003, task-005 · **Nível:** 4 · **Paralela com:** 007

**O que fazer (TDD):** Criar `src/http/server.ts` (Hono + middleware `x-api-key`,
comparação timing-safe; 401 sem detalhes — critério 6) e `src/http/handlers.ts`
implementando o contrato: `POST /batches` valida (400 com erros por item — critério 4),
persiste e responde 201 com `batch_id` **sem processar** (critério 1); `GET /batches/:id`
retorna progresso agregado + itens com links; `POST .../retry` só para item `failed`.
Handler de erro global que **nunca** inclui `CLICKSIGN_ACCESS_TOKEN` nem headers de
requisição interna na resposta/log (critério 5 — teste dedicado forçando erro com o
token no corpo do `ClicksignError`). Testes via `app.request()` do Hono (sem porta real).

**Done quando:**
- [ ] Testes: 401 sem/erro de key; 400 com erros por item; 201 imediato; GET com links; retry só de `failed` (409 caso contrário)
- [ ] Teste do critério 5: resposta de erro não contém o token
- [ ] Typecheck passa

**Arquivos:** `src/http/server.ts`, `src/http/handlers.ts`, `src/http/server.test.ts`

---

## task-010 — Bootstrap, integração sandbox e documentação

**Status:** done · **Depende de:** task-008, task-009 · **Nível:** 6

**O que fazer:** Criar `src/index.ts` (env → db → worker → servidor; shutdown gracioso).
Teste de integração `src/integration.test.ts` contra o **sandbox real** (pulado se
`CLICKSIGN_ACCESS_TOKEN` ausente): lote de 3 itens `delivery=link` → polling até `done` →
os 3 links respondem (fetch segue redirect e não cai em `/404`). Validar empiricamente o
rate limit de notificação (risco do plan): 2 itens `delivery=email` seguidos; se o 2º
levar 429/minuto, registrar o comportamento no README. Atualizar `README.md` com os
endpoints, exemplo de payload e o runbook mínimo (envelopes órfãos, troca de ambiente).

**Done quando:**
- [ ] `node --env-file=.env src/index.ts` sobe a API funcional
- [ ] Teste de integração passa contra o sandbox (3 links válidos)
- [ ] Comportamento do rate limit de notificação documentado
- [ ] README atualizado; typecheck e suíte completa passam

**Arquivos:** `src/index.ts`, `src/integration.test.ts`, `README.md`

---

## Cobertura dos critérios de aceite

| Critério da spec | Tasks |
|------------------|-------|
| 1 — 201 imediato | 009, 010 |
| 2 — links no GET | 005, 007, 008, 010 |
| 3 — rate limit Clicksign | 004, 006 |
| 4 — 400 com erros por item | 003, 009 |
| 5 — token nunca exposto | 009 |
| 6 — 401 sem api key | 009 |
| 7 — failed isolado | 008 |
| 8 — backoff em 429 | 006 |
| 9 — retomada pós-restart | 005, 008 |
| 10 — notificação por canal | 007 |

## Comandos de execução

```bash
# Nível 1 (sequencial — base de tudo):
claude --worktree spec-2026-07-01-clicksign-batch-api-task-001

# Nível 2 (paralelas):
claude --worktree spec-2026-07-01-clicksign-batch-api-task-002
claude --worktree spec-2026-07-01-clicksign-batch-api-task-004

# Nível 3 (paralelas):
claude --worktree spec-2026-07-01-clicksign-batch-api-task-003
claude --worktree spec-2026-07-01-clicksign-batch-api-task-005
claude --worktree spec-2026-07-01-clicksign-batch-api-task-006

# Nível 4 (paralelas):
claude --worktree spec-2026-07-01-clicksign-batch-api-task-007
claude --worktree spec-2026-07-01-clicksign-batch-api-task-009

# Nível 5 e 6 (sequenciais):
claude --worktree spec-2026-07-01-clicksign-batch-api-task-008
claude --worktree spec-2026-07-01-clicksign-batch-api-task-010
```
