mod config;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            match config::ensure_env_file(app.handle()) {
                Ok(path) => {
                    println!("[config] Environment file: {}", path.display());
                    match config::read_app_env(app.handle()) {
                        Ok(env) if env.missing_keys.is_empty() => {
                            println!("[config] Required keys are configured.");
                        }
                        Ok(env) => {
                            eprintln!(
                                "[config] Missing required keys: {}",
                                env.missing_keys.join(", ")
                            );
                        }
                        Err(error) => {
                            eprintln!("[config] Could not read environment file: {error}");
                        }
                    }
                }
                Err(error) => {
                    eprintln!("[config] Could not prepare environment file: {error}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![config::get_app_env])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
