# Plano: eliminar o sidecar Node, tudo dentro do `app.exe`

**Branch:** `feat/desktop-tauri-no-sidecar`
**Status:** Fases 1-7 concluídas e validadas. Fases 8-9 pendentes de decisão do usuário (removem/mantêm código em uso na `main`).

## Objetivo

Hoje o app spawna um `.exe` Node separado (sidecar) que roda a batch API
inteira (HTTP + SQLite + fila + cliente Clicksign). Este plano move tudo
isso para dentro do próprio `app.exe`, usando os bindings nativos do Tauri
(Rust) em vez de um processo Node embutido.

**Ganho:** ~50-90MB de RAM a menos, instalador ~90MB menor, sem processo
extra para gerenciar/matar.
**Custo:** reescreve uma fatia de código já testada; perde a batch API como
serviço HTTP standalone reaproveitável fora do desktop app.

## Estratégia: portar em paralelo, comparar, só então remover o antigo

O código atual (`src/` na raiz + sidecar wiring em `desktop-tauri/src-tauri`)
**fica intocado** até a Fase 9. O código novo nasce em
`desktop-tauri/src/native/` como módulos paralelos. Só troco o app pra usar
o caminho novo depois de testar cada peça isoladamente e comparar o
comportamento das duas versões lado a lado.

## Mapeamento peça por peça

| Hoje (sidecar Node) | Depois (nativo Tauri) |
|---|---|
| `node:sqlite` (`src/infra/repository.ts`) | `@tauri-apps/plugin-sql` (Rust/sqlx, linkado no `app.exe`) |
| `fetch` global (`src/infra/clicksign.ts`) | `@tauri-apps/plugin-http` (roda no Rust, sem CORS) |
| `node:fs` (`src/infra/pdf-store.ts`) | `@tauri-apps/plugin-fs` (já é dependência) |
| `src/infra/rate-limiter.ts` | cópia direta — zero import de `node:*`, portátil como está |
| `src/infra/throttled-clicksign.ts` | cópia direta — mesma razão |
| `src/app/process-item.ts` | cópia direta — mesma razão |
| `src/app/worker.ts` | loop `async` equivalente num composable Vue/TS |
| `src/http/*` (Hono, handlers, server) | **removido** — sem servidor HTTP, chamadas diretas |
| sidecar Rust (`start_sidecar`, `SidecarState`, `tauri-plugin-shell`) | **removido** |
| `scripts/build-sea.mjs`, `prepare-sidecar.mjs`, `binaries/` | **removido** |

## Etapas (cada uma testável antes de seguir pra próxima)

### Fase 1 — Persistência ✅
- `@tauri-apps/plugin-sql` (JS) + `tauri-plugin-sql` (Rust, feature `sqlite`)
- `BatchRepository` portado para `desktop-tauri/src/native/repository.ts` —
  toda API assíncrona (IPC), migrations registradas por ambiente
  (`sandbox/batches.db`, `producao/batches.db`)
- **Achado real #1:** SQLite não cria diretório pai sozinho (`code 14
  CANTOPEN`) — corrigido criando `sandbox/`/`producao/` no `.setup()` do Rust
- **Achado real #2:** `sql:default` não inclui `allow-execute` — permissões
  explícitas adicionadas
- **Achado real #3:** migration original não tinha `PRAGMA journal_mode=WAL`
  (esquecido ao portar de `node:sqlite`, que já fazia isso) — sem WAL,
  escritas concorrentes têm mais chance de `SQLITE_BUSY`; corrigido
- Validado: `RETURNING` funciona (sqlx-sqlite 0.8.6), 8/8 PASS em self-test
  isolado (claim atômico, ordem, transação, reclaimStale, retry)

### Fase 2 — Rede ✅
- `@tauri-apps/plugin-http`; `ClicksignClient` portado trocando `fetch`
  global pelo `fetch` do plugin; `rate-limiter.ts`/`throttled-clicksign.ts`
  copiados sem alteração (já eram portáveis)
- Confirmado ANTES de codar (curl com header Origin) que a Clicksign não
  envia `Access-Control-Allow-Origin` — um fetch de browser puro seria
  bloqueado por CORS. `plugin-http` roda a requisição no Rust, não sofre
  CORS — validado com chamada real (`createEnvelope`) sem erro

### Fase 3 — Pipeline de processamento ✅
- `process-item.ts` portado — lógica pura, só imports ajustados

### Fase 4 — Fila ✅
- `QueueWorker` portado — mesmo loop claim→processa→grava, assíncrono fim a
  fim sobre o repositório da Fase 1

### Fase 5 — PDFs ✅
- `pdf-store.ts` portado para `@tauri-apps/plugin-fs`
  (`app_data_dir()/<env>/pdfs/`); permissões `fs:allow-app-{read,write}-recursive`
  adicionadas proativamente (aprendendo dos achados da Fase 1) — 4/4 PASS
  de primeira no self-test de integração completo

### Fase 6 — Integração no App.vue ✅
- Criado `session.ts`: encapsula repo+pdfStore+cliente+worker por ambiente
  (substituto do `start_sidecar`). `App.vue` trocado para usar
  `startSession()`/`session.createBatch()`/`getBatch()`/`retryItem()` —
  sem HTTP, sem `invoke('start_sidecar')`
- Validado com passeio completo pela UI real: conectar → adicionar PDF →
  preencher → enviar → concluído com link real → copiar (conferido no
  clipboard) → abrir no navegador → fechar pelo X sem processo órfão

### Fase 7 — Comparação lado a lado ✅
- [x] Conectar com token válido → selo de ambiente correto
- [x] Lote de 1 item, delivery=link → link real, cópia funciona (conferido no clipboard)
- [x] Lote de 3 itens → todos concluem
- [x] Retry de item falho → conclui (testado no self-test de integração)
- [x] **Fechar o app no meio de um lote grande, reabrir → retomada automática**
      — testado via UI real (não script isolado): lote de 3 itens, `taskkill
      /F` no meio do processamento, reaberto, reclaimStale automático no
      auto-connect retomou e concluiu os 3 itens com links reais
- [x] Trocar sandbox↔produção → dados isolados (`sandbox/batches.db` vs `producao/batches.db`)
- [ ] Consumo de memória do processo único vs (app + sidecar) somados — não medido formalmente, ganho estrutural óbvio (um processo a menos)

**Achado real #4 (durante o teste de retomada):** a primeira tentativa deu
`SQLITE_BUSY` — causa: o script de teste abria uma SEGUNDA conexão
`BatchRepository` paralela à sessão real do app, e as duas escreviam ao
mesmo tempo. Não é um bug de produção (o app real só abre uma sessão por
ambiente) — mas expôs a Fase 1's WAL ausente (achado #3) e um design
questionável de teste, corrigido.

**Achado real #5:** `session.testConnection()` chamava `client.getEnvelope()`
**direto**, sem passar pelo `ThrottledClicksign` — não respeitava o rate
limiter nem re-tentava em 429. Depois de um lote de 3 itens (~21
requisições, perto do limite de 20/10s do sandbox), um 429 durante a
reconexão foi classificado como "inacessível" por engano. Corrigido:
`testConnection()` agora passa por `throttled.run(...)` como todo o resto.

### Fase 8 — Decisão sobre `src/` (backend standalone)
`src/` (a batch API Node) fica no repo mesmo após a migração — não é usada
pelo desktop app, mas continua sendo o backend caso um dia se precise dela
como serviço reaproveitável (outra ferramenta, servidor compartilhado). Se
não fizer sentido mantê-la, decidir isso separadamente — não é escopo desta
migração.

### Fase 9 — Remoção do código antigo (só depois da Fase 7 ✓)
- `lib.rs`: remove `SidecarState`, `start_sidecar`, `kill_existing`, `tauri-plugin-shell`
- Remove `desktop-tauri/prepare-sidecar.mjs`, `desktop-tauri/src-tauri/binaries/`
- Remove `scripts/build-sea.mjs` e as devDependencies `esbuild`/`postject`
  da raiz **se** `src/` não precisar mais delas (reavaliar conforme Fase 8)
- Remove `api-client.ts` antigo (HTTP) e `internal_api_config` do `lib.rs`
- README do `desktop-tauri` reescrito para a arquitetura nova

## Riscos conhecidos

| Risco | Mitigação |
|---|---|
| `RETURNING` não suportado/instável no sqlx-sqlite | Testar isolado na Fase 1 antes de portar o resto; fallback: `BEGIN`+`SELECT`+`UPDATE`+`COMMIT` manual se precisar |
| Testes automatizados (vitest) não alcançam código que depende de IPC do Tauri | Testar a lógica pura (rate-limiter, pipeline) continua em vitest normal; a camada de repositório/rede precisa de teste manual dentro do `tauri dev` ou dos mocks de `@tauri-apps/api/mocks` |
| Loop da fila trava a UI | `await` em cada chamada já cede o event loop; confirmar na prática com um lote grande que a UI continua responsiva |
| Perda de progresso se o app fechar no meio de um lote | É exatamente o que a Fase 7 testa antes de aceitar a migração como pronta |
