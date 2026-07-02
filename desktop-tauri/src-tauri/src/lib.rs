use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

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
) -> Result<(), String> {
    kill_existing(&state);

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Não foi possível resolver o diretório de dados do app: {e}"))?;
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
