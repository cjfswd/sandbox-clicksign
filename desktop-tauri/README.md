# HealthMais Assinaturas — Desktop (Tauri)

App desktop Windows para envio em lote de documentos para assinatura via
Clicksign. **A batch API vem embutida no próprio `.exe`** — o usuário final
não instala nem inicia nada além do instalador; só configura o token de
acesso da Clicksign.

## Arquitetura: sidecar

A batch API (`../src`, Node.js + Hono + SQLite) é compilada como executável
autossuficiente via [Single Executable Applications do Node 24](https://nodejs.org/api/single-executable-applications.html)
e embutida no bundle do Tauri como [sidecar](https://tauri.app/develop/sidecar/):
o app Rust sobe/derruba esse processo sozinho, escutando só em
`127.0.0.1:4317`, autenticado com uma chave interna fixa (não é segredo real —
é defesa em profundidade, já que o processo só é acessível localmente e é
iniciado pelo próprio app; ver `INTERNAL_API_KEY` em `src-tauri/src/lib.rs`).

```
┌─────────────────────────────┐
│  app.exe (Tauri + Vue)      │
│  ┌────────────────────────┐ │
│  │ Webview: UI             │ │ ← usuário só vê isto
│  └───────────┬────────────┘ │
│              │ http://127.0.0.1:4317
│  ┌───────────▼────────────┐ │
│  │ batch-api.exe (sidecar) │ │ ← Node SEA, spawnado pelo Rust
│  │ SQLite + Clicksign      │ │
│  └────────────────────────┘ │
└─────────────────────────────┘
```

O usuário só configura o **token da Clicksign** e o **ambiente** (Sandbox/
Produção) — isso é persistido via `@tauri-apps/plugin-store` e, nas próximas
aberturas, o app sobe o sidecar sozinho sem pedir nada de novo.

## "Memória" do app (persistência)

- **Token da Clicksign + ambiente**: `%APPDATA%\com.healthmais.assinaturas\config.json` (plugin-store)
- **Lotes, itens e links (SQLite)**: `%APPDATA%\com.healthmais.assinaturas\batches.db`
- **PDFs em processamento**: `%APPDATA%\com.healthmais.assinaturas\pdfs\`

Esse caminho vem de `app.path().app_data_dir()` (Rust), passado ao sidecar
via env var `DATA_DIR` — fixo por instalação do Windows, independente de
onde o `.exe` é executado. Sobrevive a reinícios do app; se o processo cair
no meio de um lote, o próximo boot retoma os itens presos automaticamente
(mesmo mecanismo testado na batch API standalone).

## Build

Pré-requisitos: Node 24, Rust + MSVC Build Tools + LLVM (ver
[`../desktop/README.md`](../desktop/README.md) para instalar o toolchain),
`mt.exe` do Windows SDK no PATH.

```bash
npm install

# 1. Compila a batch API como .exe e copia para src-tauri/binaries/
#    (rodar de novo sempre que o código em ../src mudar)
npm run prepare-sidecar

# 2. Compila o app Tauri (gera instalador .msi e .exe em src-tauri/target/*/bundle/)
npx tauri build
```

O binário do sidecar (`src-tauri/binaries/*.exe`, ~90 MB — inclui um runtime
Node inteiro) não é versionado no git; sempre gerado por `prepare-sidecar`
antes do build do Tauri.

## Desenvolvimento

```bash
npm run prepare-sidecar   # uma vez, ou após mudar a batch API
npx tauri dev              # hot-reload do Vue; o sidecar sobe junto
```

## Por que sidecar em vez de Perry

Ver [`../.specify/backlog/spec-2026-07-01-desktop-batch-app.md`](../.specify/backlog/spec-2026-07-01-desktop-batch-app.md)
para o histórico da decisão de framework (Perry avaliado e descartado por
bugs de plataforma no `perry/ui` Win32 ainda sem release oficial do fix).
