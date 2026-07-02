# Plano: eliminar o sidecar Node, tudo dentro do `app.exe`

**Branch:** `feat/desktop-tauri-no-sidecar`
**Status:** planejamento — nenhum código portado ainda

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

### Fase 1 — Persistência
- Adiciona `@tauri-apps/plugin-sql` (JS) + `tauri-plugin-sql` (Rust, feature `sqlite`)
- Cria o schema (mesma tabela `batches`/`items` de `src/infra/repository.ts`)
  via migration do plugin
- Porta `BatchRepository` para `desktop-tauri/src/native/repository.ts` —
  **toda API vira `async`** (plugin-sql é IPC, não é síncrono como `node:sqlite`)
- **Risco a verificar:** o `UPDATE ... RETURNING *` que faz o claim atômico
  do próximo item pendente depende de suporte a `RETURNING` no SQLite
  embutido no `sqlx` — testar isso primeiro, é o ponto mais arriscado da Fase 1
- Teste: script isolado dentro do app real (Tauri não roda fora do runtime)
  criando/lendo/reclamando itens, comparando com o comportamento do
  `repository.test.ts` original

### Fase 2 — Rede
- Adiciona `@tauri-apps/plugin-http`
- Porta `ClicksignClient` para `desktop-tauri/src/native/clicksign.ts`,
  trocando `fetch` global pelo `fetch` do plugin
- Copia `rate-limiter.ts` e `throttled-clicksign.ts` sem alteração de lógica
- Teste: uma chamada real ao sandbox da Clicksign de dentro do app rodando
  (`tauri dev`), confirmando que não há erro de CORS e que os headers
  `X-Rate-Limit-*` continuam chegando

### Fase 3 — Pipeline de processamento
- Porta `process-item.ts` (lógica pura, só ajusta imports)

### Fase 4 — Fila
- `QueueWorker` vira um composable: mesmo loop claim→processa→grava,
  agora `async` fim a fim sobre o repositório da Fase 1

### Fase 5 — PDFs
- `pdf-store.ts` portado para `@tauri-apps/plugin-fs` (grava/lê/remove por
  `item_id` em `app_data_dir()/<env>/pdfs/`)

### Fase 6 — Integração no App.vue
- Troca `api-client.ts` (chamadas HTTP pro sidecar) pelas chamadas diretas
  aos módulos novos
- Remove o uso de `invoke('start_sidecar', ...)`

### Fase 7 — Comparação lado a lado
Checklist a rodar nas duas versões (branch `main` com sidecar vs esta
branch) antes de remover qualquer coisa:
- [ ] Conectar com token válido → selo de ambiente correto
- [ ] Lote de 1 item, delivery=link → link real, cópia funciona
- [ ] Lote de 3+ itens variados (link/email/whatsapp) → todos concluem
- [ ] Item com erro proposital (nome com número) → falha isolada, resto continua
- [ ] Retry de item falho → conclui
- [ ] **Fechar o app no meio de um lote grande, reabrir → retomada automática**
      (o ponto mais arriscado — sem isso funcionando igual, a migração não
      está pronta)
- [ ] Trocar sandbox↔produção → dados continuam isolados por ambiente
- [ ] Consumo de memória do processo único vs (app + sidecar) somados

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
