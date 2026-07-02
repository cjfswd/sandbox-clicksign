// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Ponto de entrada do binário — toda a lógica mora em lib.rs (app_lib::run),
/// separado assim para permitir alvos mobile via mobile_entry_point.
fn main() {
  app_lib::run();
}
