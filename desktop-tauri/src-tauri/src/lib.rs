use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

// Schema portado de src/infra/repository.ts, registrado como migration do
// plugin-sql. WAL explícito (paridade com o node:sqlite original) — sem
// isso, escritas concorrentes no mesmo arquivo têm mais chance de
// SQLITE_BUSY.
const SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;
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
"#;

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

/// Monta o app Tauri: registra os plugins nativos (SQLite, HTTP, FS, clipboard,
/// dialog, store, opener), garante as pastas sandbox/producao, e sobe a janela.
/// Chamado por `main.rs` — não há nenhum `#[tauri::command]`/IPC customizado:
/// toda a lógica de negócio roda no lado TS (native/), falando com os plugins
/// diretamente via `@tauri-apps/plugin-*`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:sandbox/batches.db", batch_migrations())
                .add_migrations("sqlite:producao/batches.db", batch_migrations())
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // SQLite não cria diretórios pai sozinho (CANTOPEN); os dois
            // ambientes precisam existir ANTES de qualquer Database.load().
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(data_dir.join("sandbox"))?;
            std::fs::create_dir_all(data_dir.join("producao"))?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
