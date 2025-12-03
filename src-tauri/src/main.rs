#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod auth;
mod config;
mod constants;
mod hotkeys;
mod local_speech;
mod audio;
mod oauth;
mod ollama;
mod tray;
mod transcription;
mod types;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use auth::AuthQueue;
use config::ConfigState;
use constants::{
    DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_MIN_HEIGHT, DEFAULT_WINDOW_MIN_WIDTH, DEFAULT_WINDOW_WIDTH,
};
use hotkeys::HotkeyManager;
use local_speech::FastWhisperManager;
use audio::AudioManager;
use once_cell::sync::Lazy;
use tauri::LogicalSize;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use types::{AppConfig, AuthDeepLinkPayload, FastWhisperStatus};
use tray::set_tray_visible;

static PENDING_DEEP_LINKS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

#[tauri::command]
async fn config_get(state: State<'_, Arc<ConfigState>>) -> Result<AppConfig, String> {
    Ok(state.get().await)
}

#[tauri::command]
async fn config_update(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
    hotkeys: State<'_, Arc<HotkeyManager>>,
    payload: serde_json::Value,
) -> Result<AppConfig, String> {
    let apply_window_size = payload.get("windowWidth").is_some() || payload.get("windowHeight").is_some();
    let updated = state
        .update(payload)
        .await
        .map_err(|error| error.to_string())?;
    app.emit("config:updated", &updated)
        .map_err(|error| error.to_string())?;
    handle_config_effects(&app, &updated, hotkeys.inner().clone(), apply_window_size);
    Ok(updated)
}

#[tauri::command]
async fn config_reset(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
    hotkeys: State<'_, Arc<HotkeyManager>>,
) -> Result<AppConfig, String> {
    let updated = state
        .reset()
        .await
        .map_err(|error| error.to_string())?;
    app.emit("config:updated", &updated)
        .map_err(|error| error.to_string())?;
    handle_config_effects(&app, &updated, hotkeys.inner().clone(), true);
    Ok(updated)
}

#[tauri::command]
async fn config_path(state: State<'_, Arc<ConfigState>>) -> Result<String, String> {
    Ok(state.path().await.to_string_lossy().to_string())
}

#[tauri::command]
async fn open_config_folder(
    app: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
) -> Result<(), String> {
    let dir = state.directory().await;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn auth_consume_pending(
    queue: State<'_, Arc<AuthQueue>>,
) -> Result<Vec<AuthDeepLinkPayload>, String> {
    Ok(queue.drain().await)
}

#[tauri::command]
async fn auth_start_oauth(app: tauri::AppHandle, provider: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let url = oauth::build_oauth_start_url(&provider).map_err(|error| error.to_string())?;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_speech_get_status(
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    Ok(manager.get_status().await)
}

#[tauri::command]
async fn local_speech_check_health(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    Ok(manager.check_health(&app).await)
}

#[tauri::command]
async fn local_speech_install(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    manager
        .install_and_start(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_speech_start(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    manager
        .start_existing(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_speech_restart(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    manager
        .restart(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_speech_reinstall(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    manager
        .reinstall(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_speech_stop(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    manager
        .stop(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn local_speech_check_model_downloaded(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    model: String,
) -> Result<bool, String> {
    manager
        .is_model_downloaded(&app, &model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ollama_check_installed() -> Result<bool, String> {
    crate::ollama::check_installed()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ollama_list_models() -> Result<Vec<String>, String> {
    crate::ollama::list_models()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ollama_pull_model(model: String) -> Result<(), String> {
    crate::ollama::pull_model(&model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn ollama_warmup_model(model: String) -> Result<(), String> {
    crate::ollama::warmup_model(&model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn audio_list_devices(manager: State<'_, Arc<AudioManager>>) -> Result<Vec<audio::AudioDeviceInfo>, String> {
    manager.list_devices().map_err(|e| e.to_string())
}

#[tauri::command]
async fn audio_start_capture(
    app: tauri::AppHandle,
    manager: State<'_, Arc<AudioManager>>,
    source: String,
    device_id: Option<String>,
) -> Result<(), String> {
    manager.start(app, &source, device_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn audio_stop_capture(manager: State<'_, Arc<AudioManager>>) -> Result<(), String> {
    manager.stop().map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_http_request(
    url: String,
    method: String,
    headers: serde_json::Value,
    body: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs.unwrap_or(600)))
        .build()
        .map_err(|e| e.to_string())?;

    let mut request = match method.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported method: {}", method)),
    };

    // Добавляем заголовки
    if let serde_json::Value::Object(map) = headers {
        for (key, value) in map {
            if let Some(val_str) = value.as_str() {
                request = request.header(&key, val_str);
            }
        }
    }

    // Добавляем тело запроса
    if let Some(body_str) = body {
        request = request.body(body_str);
    }

    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), text));
    }

    Ok(text)
}

fn handle_config_effects(
    app: &AppHandle,
    config: &AppConfig,
    hotkeys: Arc<HotkeyManager>,
    apply_window_size: bool,
) {
    hotkeys.apply_config(app, config);
    if let Err(error) = apply_window_preferences(app, config, apply_window_size) {
        eprintln!("[window] failed to apply preferences: {error}");
    }
}

fn apply_window_preferences(app: &AppHandle, config: &AppConfig, apply_window_size: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let scale = config.window_scale.clamp(0.5, 3.0);
        
        // Применяем размер окна БЕЗ масштабирования
        // Масштабирование контента происходит через CSS font-size на html
        if apply_window_size {
            let base_width = config
                .window_width
                .max(DEFAULT_WINDOW_MIN_WIDTH)
                .min(4000) as f64;
            let base_height = config
                .window_height
                .max(DEFAULT_WINDOW_MIN_HEIGHT)
                .min(4000) as f64;
            
            // Используем базовый размер окна без масштабирования
            window
                .set_size(LogicalSize::new(base_width, base_height))
                .map_err(|error| error.to_string())?;
            window
                .set_min_size(Some(LogicalSize::new(
                    DEFAULT_WINDOW_MIN_WIDTH as f64,
                    DEFAULT_WINDOW_MIN_HEIGHT as f64,
                )))
                .map_err(|error| error.to_string())?;
        }
        
        window
            .set_always_on_top(config.always_on_top)
            .map_err(|error| error.to_string())?;
        #[cfg(not(target_os = "linux"))]
        {
            window
                .set_skip_taskbar(config.hide_app)
                .map_err(|error| error.to_string())?;
        }
        set_tray_visible(!config.hide_app);
        
        window.show().map_err(|error| error.to_string())?;
        
        // Применяем opacity и скрытие от записи экрана (Windows) после показа окна
        #[cfg(target_os = "windows")]
        {
            // Используем таймер для применения opacity после того, как окно полностью готово
            let app_clone = app.clone();
            let opacity_value = config.window_opacity.clamp(10, 100);
            let hide_app_value = config.hide_app;
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(200));
                if let Some(w) = app_clone.get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        use windows::Win32::Foundation::HWND;
                        use windows::Win32::UI::WindowsAndMessaging::{
                            SetWindowDisplayAffinity, SetLayeredWindowAttributes, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
                            GWL_EXSTYLE, WS_EX_LAYERED, LWA_ALPHA, GetWindowLongPtrW, SetWindowLongPtrW
                        };
                        
                        let hwnd_handle = HWND(hwnd.0);
                        
                        // Применяем opacity через SetLayeredWindowAttributes
                        let alpha = ((opacity_value as f32 / 100.0) * 255.0) as u8;
                        unsafe {
                            // Устанавливаем WS_EX_LAYERED стиль
                            let ex_style = GetWindowLongPtrW(hwnd_handle, GWL_EXSTYLE);
                            let layered_flag = WS_EX_LAYERED.0 as isize;
                            SetWindowLongPtrW(hwnd_handle, GWL_EXSTYLE, ex_style | layered_flag);
                            // Устанавливаем opacity
                            let _ = SetLayeredWindowAttributes(hwnd_handle, windows::Win32::Foundation::COLORREF(0), alpha, LWA_ALPHA);
                        }
                        
                        // Применяем скрытие от записи экрана
                        unsafe {
                            if hide_app_value {
                                let _ = SetWindowDisplayAffinity(hwnd_handle, WDA_EXCLUDEFROMCAPTURE);
                            } else {
                                let _ = SetWindowDisplayAffinity(hwnd_handle, WDA_NONE);
                            }
                        }
                    }
                }
            });
        }
        
        // Применяем scale через CSS переменную и font-size на html
        // Это масштабирует все элементы, использующие rem единицы
        let scale_script = format!(
            r#"
            (function() {{
                const html = document.documentElement;
                if (!html) return;
                
                // Устанавливаем CSS переменную для масштаба
                html.style.setProperty('--app-scale', '{}');
                
                // Устанавливаем font-size на html для масштабирования через rem
                // Базовый размер 16px, умножаем на scale
                const baseFontSize = 16;
                const scaledFontSize = baseFontSize * {};
                html.style.fontSize = scaledFontSize + 'px';
            }})();
            "#,
            scale, scale
        );
        // Применяем scale после небольшой задержки
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            if let Some(w) = app_clone.get_webview_window("main") {
                let _ = w.eval(&scale_script);
            }
        });
    }
    Ok(())
}

pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        Ok(())
    } else {
        tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
            .title("XexamAI")
            .inner_size(DEFAULT_WINDOW_WIDTH as f64, DEFAULT_WINDOW_HEIGHT as f64)
            .min_inner_size(
                DEFAULT_WINDOW_MIN_WIDTH as f64,
                DEFAULT_WINDOW_MIN_HEIGHT as f64,
            )
            .decorations(false)
            .transparent(true)
            .build()
            .map_err(|error| error.to_string())?;
        if let Some(window) = app.get_webview_window("main") {
            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(url) = args.into_iter().find(|arg| arg.starts_with("xexamai://")) {
                if let Some(state) = app.try_state::<Arc<AuthQueue>>() {
                    dispatch_deep_link(app, state.inner().clone(), url);
                } else {
                    PENDING_DEEP_LINKS.lock().unwrap().push(url);
                }
            } else {
                let _ = show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let app_handle = app.handle();
            let config_state =
                Arc::new(tauri::async_runtime::block_on(ConfigState::initialize(&app_handle))?);
            let initial_config = tauri::async_runtime::block_on(config_state.get());

            let hotkeys = Arc::new(HotkeyManager::new());
            let fast_whisper = Arc::new(FastWhisperManager::new());
            let auth_queue = Arc::new(AuthQueue::new());
            let audio_manager = Arc::new(AudioManager::new());

            app.manage(config_state.clone());
            app.manage(hotkeys.clone());
            app.manage(fast_whisper.clone());
            app.manage(auth_queue.clone());
            app.manage(audio_manager.clone());

            tray::setup(&app_handle)?;
            handle_config_effects(&app_handle, &initial_config, hotkeys, true);
            flush_pending_deep_links(&app_handle, auth_queue.clone());
            setup_deep_link_listener(&app_handle, auth_queue);

            if let Some(main_window) = app.get_webview_window("main") {
                let app_handle = app_handle.clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        app_handle.exit(0);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            config_get,
            config_update,
            config_reset,
            config_path,
            open_config_folder,
            ollama_http_request,
            auth_consume_pending,
            auth_start_oauth,
            local_speech_get_status,
            local_speech_check_health,
            local_speech_install,
            local_speech_start,
            local_speech_restart,
            local_speech_reinstall,
            local_speech_stop,
            local_speech_check_model_downloaded,
            ollama_check_installed,
            ollama_list_models,
            ollama_pull_model,
            ollama_warmup_model,
            audio_list_devices,
            audio_start_capture,
            audio_stop_capture,
            transcription::transcribe_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn flush_pending_deep_links(app: &AppHandle, queue: Arc<AuthQueue>) {
    let mut pending = PENDING_DEEP_LINKS.lock().unwrap();
    for url in pending.drain(..) {
        dispatch_deep_link(app, queue.clone(), url);
    }
}

fn setup_deep_link_listener(app: &AppHandle, queue: Arc<AuthQueue>) {
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            dispatch_deep_link(app, queue.clone(), url.to_string());
        }
    }
    let queue_listener = queue.clone();
    let app_listener = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            dispatch_deep_link(&app_listener, queue_listener.clone(), url.to_string());
        }
    });
}

fn dispatch_deep_link(app: &AppHandle, queue: Arc<AuthQueue>, url: String) {
    tauri::async_runtime::spawn(auth::handle_deep_link(app.clone(), queue, url));
}
