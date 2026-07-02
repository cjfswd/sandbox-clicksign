# HealthMais Assinaturas — Desktop (Tauri)

App desktop Windows para envio em lote de documentos para assinatura via
Clicksign. **Tudo roda dentro do próprio `app.exe`** — o usuário final não
instala nem inicia nada além do instalador; só configura o token de acesso
da Clicksign.

Para a explicação de cada função/variável/constante do código, arquivo por
arquivo, veja [REFERENCE.md](REFERENCE.md).

## Arquitetura: nativa (sem processo separado)

Persistência (SQLite) e rede (chamadas à API da Clicksign) rodam
diretamente no processo Rust do Tauri, via plugins oficiais — não existe
mais um processo Node sidecar spawnado pelo app:

- [`@tauri-apps/plugin-sql`](https://v2.tauri.app/plugin/sql/) — SQLite via
  `sqlx`, linkado no próprio binário. Migrations por ambiente (uma para
  `sandbox/batches.db`, outra para `producao/batches.db`), registradas em
  `src-tauri/src/lib.rs`.
- [`@tauri-apps/plugin-http`](https://v2.tauri.app/plugin/http-client/) — um
  `fetch` que executa no Rust, não no webview. A Clicksign não envia
  `Access-Control-Allow-Origin` (confirmado com `curl -H "Origin: ..."`), um
  `fetch` de browser puro seria bloqueado por CORS; o plugin contorna isso
  rodando a requisição fora do webview.

```
┌───────────────────────────────┐
│  app.exe (Tauri + Vue)        │
│  ┌──────────────────────────┐ │
│  │ Webview: UI               │ │ ← usuário só vê isto
│  └─────────────┬─────────────┘ │
│                │ invoke() / IPC do Tauri
│  ┌─────────────▼─────────────┐ │
│  │ Rust: plugin-sql + plugin-http │ ← mesmo processo, sem sidecar
│  │ fila (worker.ts, TS)       │ │
│  └────────────────────────────┘ │
└───────────────────────────────┘
```

A lógica de negócio (fila, rate limiter, pipeline de processamento de item,
cliente Clicksign) é TypeScript puro em `src/native/`, portada da batch API
standalone (`../src`) trocando só as bordas de IO (`node:sqlite` →
plugin-sql, `fetch` global → plugin-http, `node:fs` → plugin-fs). Ela roda
no processo do webview e fala com SQLite/HTTP via IPC do Tauri — não é
lógica de UI misturada com persistência.

O usuário só configura o **token da Clicksign** e o **ambiente** (Sandbox/
Produção) — isso é persistido via `@tauri-apps/plugin-store` e, nas próximas
aberturas, o app reconecta sozinho sem pedir nada de novo.

## "Memória" do app (persistência)

- **Token da Clicksign + ambiente**: `%APPDATA%\com.healthmais.assinaturas\config.json` (plugin-store)
- **Lotes, itens e links (SQLite)**: `%APPDATA%\com.healthmais.assinaturas\<sandbox|producao>\batches.db`
- **PDFs em processamento**: `%APPDATA%\com.healthmais.assinaturas\<sandbox|producao>\pdfs\`

Sandbox e produção usam bancos e pastas de PDF **fisicamente separados** —
nunca misturam lotes de teste com envios reais. Sobrevive a reinícios do
app; se o processo cair no meio de um lote, o próximo boot retoma os itens
presos automaticamente via `reclaimStale()` (testado via `taskkill /F` no
meio de um lote real, com retomada e conclusão confirmadas).

## Build

Pré-requisitos: Node 24, Rust + MSVC Build Tools + LLVM (ver
[`../desktop/README.md`](../desktop/README.md) para instalar o toolchain),
`mt.exe` do Windows SDK no PATH.

```bash
npm install
npx tauri build   # gera instalador .msi e .exe em src-tauri/target/*/bundle/
```

Não há mais passo de "preparar sidecar" — um único binário, sem runtime
Node embutido.

## Desenvolvimento

```bash
npx tauri dev   # hot-reload do Vue
```

## Por que Tauri em vez de Perry

Ver [`../.specify/backlog/spec-2026-07-01-desktop-batch-app.md`](../.specify/backlog/spec-2026-07-01-desktop-batch-app.md)
para o histórico da decisão de framework (Perry avaliado e descartado por
bugs de plataforma no `perry/ui` Win32 ainda sem release oficial do fix).

## Por que nativo em vez de sidecar Node

A primeira versão deste app rodava a batch API inteira (HTTP + SQLite +
fila + cliente Clicksign) como um `.exe` Node separado, compilado via
[Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
e spawnado como [sidecar](https://tauri.app/develop/sidecar/) do Tauri.
Funcionava, mas custava um processo extra (~50-90MB de RAM) e um instalador
~90MB maior (runtime Node inteiro embutido) só para lógica que os plugins
nativos do Tauri já cobrem. Migrado peça por peça (ver histórico em
`MIGRATION-PLAN.md`), validado lado a lado com a versão antiga antes de
remover o sidecar — inclusive o cenário de maior risco, queda do app no meio
de um lote grande com retomada automática no relance.

A batch API standalone (`../src`) continua no repo como serviço HTTP
reaproveitável fora do desktop app (ver decisão na Fase 8 de
`MIGRATION-PLAN.md`), mas não é mais consumida por este app.
