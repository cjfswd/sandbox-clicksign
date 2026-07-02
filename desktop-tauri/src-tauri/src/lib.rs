use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};
use tauri_plugin_sql::{Migration, MigrationKind};

// --- Fase 1 da migração (feat/desktop-tauri-no-sidecar): schema portado de
// src/infra/repository.ts, agora registrado como migration do plugin-sql.
// Convive com o sidecar Node por enquanto — nada aqui é usado pelo app
// ainda, só está sendo validado isoladamente (ver MIGRATION-PLAN.md).
const SCHEMA_SQL: &str = r#"
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

fn batch_migrations() -> Vec<Migration> {
    vec![Migration {
        version: 1,
        description: "create_batches_and_items",
        sql: SCHEMA_SQL,
        kind: MigrationKind::Up,
    }]
}

/// Porta e chave interna compartilhadas com o frontend (src/api-client.ts).
/// Não é um segredo real: a batch API só escuta em 127.0.0.1, iniciada e
/// encerrada pelo próprio app — é defesa em profundidade, não um limite de
/// confiança (mesmo padrão de `API_KEY` da spec, agora interno).
const INTERNAL_PORT: &str = "4317";
const INTERNAL_API_KEY: &str = "hm-desktop-internal-9f2a71c4-e8b0-4d5f";

#[derive(Default)]
struct SidecarState(Mutex<Option<CommandChild>>);

fn kill_existing(state: &SidecarState) {
    if let Some(child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[tauri::command]
async fn start_sidecar(
    app: tauri::AppHandle,
    state: State<'_, SidecarState>,
    clicksign_token: String,
    clicksign_base_url: String,
    clicksign_env: String,
) -> Result<(), String> {
    kill_existing(&state);

    // Sandbox e produção NUNCA compartilham banco/PDFs — evita misturar
    // lotes de teste com envios reais. Valida contra allowlist (o valor
    // vira componente de path).
    if clicksign_env != "sandbox" && clicksign_env != "producao" {
        return Err(format!("Ambiente inválido: {clicksign_env}"));
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Não foi possível resolver o diretório de dados do app: {e}"))?
        .join(&clicksign_env);
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("Não foi possível criar o diretório de dados: {e}"))?;

    let command = app
        .shell()
        .sidecar("batch-api")
        .map_err(|e| format!("Sidecar batch-api não encontrado: {e}"))?
        .envs([
            ("API_KEY", INTERNAL_API_KEY.to_string()),
            ("PORT", INTERNAL_PORT.to_string()),
            ("CLICKSIGN_ACCESS_TOKEN", clicksign_token),
            ("CLICKSIGN_BASE_URL", clicksign_base_url),
            ("DATA_DIR", data_dir.to_string_lossy().into_owned()),
        ]);

    let (mut rx, child) = command.spawn().map_err(|e| format!("Falha ao iniciar a batch API: {e}"))?;
    *state.0.lock().unwrap() = Some(child);

    // Repassa a saída do processo para o log do Tauri — único jeito de
    // depurar a batch API embutida, já que ela não tem janela própria.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => log::info!("[batch-api] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Stderr(line) => log::warn!("[batch-api] {}", String::from_utf8_lossy(&line)),
                CommandEvent::Error(err) => log::error!("[batch-api] erro: {err}"),
                CommandEvent::Terminated(status) => {
                    log::warn!("[batch-api] processo encerrado: {:?}", status);
                }
                _ => {}
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn internal_api_config() -> serde_json::Value {
    serde_json::json!({ "baseUrl": format!("http://127.0.0.1:{INTERNAL_PORT}"), "apiKey": INTERNAL_API_KEY })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:sandbox/batches.db", batch_migrations())
                .add_migrations("sqlite:producao/batches.db", batch_migrations())
                .build(),
        )
        .plugin(tauri_plugin_http::init())
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![start_sidecar, internal_api_config])
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Fecha a batch API embutida junto com o app — senão fica um
            // processo Node órfão rodando depois de fechar a janela.
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                let state = app_handle.state::<SidecarState>();
                kill_existing(&state);
            }
        });
}
