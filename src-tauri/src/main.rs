#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod activity;
mod app_log;
mod audio;
mod auth;
mod auth_session;
mod config;
mod constants;
mod google_live;
mod hotkeys;
mod ipc_contract;
mod local_speech;
mod oauth;
mod ollama;
mod provider_proxy;
mod secret_store;
mod transcription;
mod tray;
mod types;
mod update;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use activity::{ActivityGate, RendererActivityLeases};
use audio::AudioManager;
use auth::AuthQueue;
use auth_session::AuthSessionState;
use config::ConfigState;
use constants::{
    DEFAULT_WINDOW_HEIGHT, DEFAULT_WINDOW_MIN_HEIGHT, DEFAULT_WINDOW_MIN_WIDTH,
    DEFAULT_WINDOW_WIDTH,
};
use hotkeys::HotkeyManager;
use local_speech::FastWhisperManager;
use once_cell::sync::Lazy;
use secret_store::{ProviderSecret, SecretStore};
use tauri::LogicalSize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;
use tray::set_tray_visible;
use types::{AppConfig, AuthDeepLinkPayload, FastWhisperStatus, JsonValue};

static PENDING_DEEP_LINKS: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));

#[derive(Default)]
struct ShutdownState {
    requested: AtomicBool,
    completed: AtomicBool,
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Command is not available to this window".to_string())
    }
}

#[derive(Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct PublicAppConfig {
    #[serde(flatten)]
    config: AppConfig,
    has_openai_api_key: bool,
    has_google_api_key: bool,
}

async fn public_config(
    config: &AppConfig,
    secrets: &SecretStore,
) -> Result<PublicAppConfig, String> {
    let has_openai = secrets
        .get_provider_secret(ProviderSecret::OpenAi)
        .await?
        .is_some_and(|value| !value.trim().is_empty());
    let has_google = secrets
        .get_provider_secret(ProviderSecret::Google)
        .await?
        .is_some_and(|value| !value.trim().is_empty());
    Ok(PublicAppConfig {
        config: config.clone(),
        has_openai_api_key: has_openai,
        has_google_api_key: has_google,
    })
}

async fn apply_secret_patch(
    payload: &mut serde_json::Value,
    secrets: &SecretStore,
) -> Result<(), String> {
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "Config update must be an object".to_string())?;
    for (field, provider) in [
        ("openaiApiKey", ProviderSecret::OpenAi),
        ("googleApiKey", ProviderSecret::Google),
    ] {
        let Some(value) = object.remove(field) else {
            continue;
        };
        let value = match value {
            serde_json::Value::Null => String::new(),
            serde_json::Value::String(value) if value.len() <= 32 * 1024 => value,
            _ => return Err(format!("Invalid {field} value")),
        };
        secrets.set_provider_secret(provider, value.trim()).await?;
    }
    object.remove("hasOpenaiApiKey");
    object.remove("hasGoogleApiKey");
    Ok(())
}

async fn migrate_legacy_provider_secrets(
    config_state: &ConfigState,
    secrets: &SecretStore,
    config: &AppConfig,
) -> Result<(), String> {
    let has_legacy = config.openai_api_key.is_some() || config.google_api_key.is_some();
    if !has_legacy {
        return Ok(());
    }
    let mut migration_failures = 0_u8;
    if let Some(value) = config
        .openai_api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if secrets
            .set_provider_secret(ProviderSecret::OpenAi, value)
            .await
            .is_err()
        {
            migration_failures += 1;
            log::warn!(target: "config", "Could not migrate the legacy OpenAI credential");
        }
    }
    if let Some(value) = config
        .google_api_key
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        if secrets
            .set_provider_secret(ProviderSecret::Google, value)
            .await
            .is_err()
        {
            migration_failures += 1;
            log::warn!(target: "config", "Could not migrate the legacy Google credential");
        }
    }
    config_state
        .clear_legacy_secrets()
        .await
        .map_err(|error| format!("Failed to remove legacy credentials from config: {error}"))?;
    if migration_failures > 0 {
        return Err(
            "One or more legacy provider credentials could not be migrated and were removed from plaintext config"
                .to_string(),
        );
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn app_shutdown_complete(
    window: WebviewWindow,
    app: tauri::AppHandle,
    shutdown: State<'_, Arc<ShutdownState>>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    shutdown.completed.store(true, Ordering::Release);
    log::logger().flush();
    app.exit(0);
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn activity_register_session(
    window: WebviewWindow,
    leases: State<'_, Arc<RendererActivityLeases>>,
    session_id: String,
    generation: u64,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    leases.register_session(&session_id, generation).await
}

#[tauri::command]
#[specta::specta]
async fn activity_begin(
    window: WebviewWindow,
    leases: State<'_, Arc<RendererActivityLeases>>,
    session_id: String,
    label: String,
) -> Result<String, String> {
    ensure_main_window(&window)?;
    leases.begin(&session_id, label).await
}

#[tauri::command]
#[specta::specta]
async fn activity_end(
    window: WebviewWindow,
    leases: State<'_, Arc<RendererActivityLeases>>,
    session_id: String,
    lease_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    leases.end(&session_id, &lease_id).await
}

fn validate_external_url(value: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(value).map_err(|_| "Invalid external URL".to_string())?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.port().is_some()
    {
        return Err("External URL is not allowed".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "External URL is missing a host".to_string())?;
    if !matches!(
        host,
        "artasov.github.io"
            | "x.com"
            | "t.me"
            | "github.com"
            | "pump.fun"
            | "dexscreener.com"
            | "youtube.com"
            | "www.youtube.com"
            | "linkedin.com"
            | "www.linkedin.com"
            | "discord.gg"
            | "xlartas.com"
            | "www.xlartas.com"
            | "xlartas.ru"
            | "www.xlartas.ru"
    ) {
        return Err("External URL host is not allowed".to_string());
    }
    Ok(parsed)
}

#[cfg(target_os = "windows")]
static ORIGINAL_WNDPROC_BY_HWND: Lazy<Mutex<std::collections::HashMap<isize, isize>>> =
    Lazy::new(|| Mutex::new(std::collections::HashMap::new()));

#[cfg(target_os = "windows")]
fn is_resize_hit_test(hit_test_code: u16) -> bool {
    matches!(hit_test_code, 4 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn force_arrow_cursor_wndproc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, LoadCursorW, SetCursor, SetWindowLongPtrW, GWLP_WNDPROC,
        IDC_ARROW, WM_NCDESTROY, WM_SETCURSOR, WNDPROC,
    };

    if msg == WM_SETCURSOR {
        let hit_test = (lparam.0 & 0xFFFF) as u16;
        if is_resize_hit_test(hit_test) {
            if let Ok(cursor) = unsafe { LoadCursorW(None, IDC_ARROW) } {
                let _ = unsafe { SetCursor(Some(cursor)) };
            }
            return LRESULT(1);
        }
    }

    let hwnd_key = hwnd.0 as isize;
    let original_ptr = ORIGINAL_WNDPROC_BY_HWND
        .lock()
        .ok()
        .and_then(|map| map.get(&hwnd_key).copied())
        .unwrap_or(0);

    if msg == WM_NCDESTROY && original_ptr != 0 {
        let _ = unsafe { SetWindowLongPtrW(hwnd, GWLP_WNDPROC, original_ptr) };
        if let Ok(mut map) = ORIGINAL_WNDPROC_BY_HWND.lock() {
            map.remove(&hwnd_key);
        }
    }

    if original_ptr == 0 {
        return unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) };
    }

    let original_fn: unsafe extern "system" fn(
        windows::Win32::Foundation::HWND,
        u32,
        windows::Win32::Foundation::WPARAM,
        windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT = unsafe { std::mem::transmute(original_ptr) };
    let original: WNDPROC = Some(original_fn);
    unsafe { CallWindowProcW(original, hwnd, msg, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn install_force_default_cursor(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::{GetLastError, SetLastError, HWND, WIN32_ERROR};
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowLongPtrW, GWLP_WNDPROC};

    let Ok(raw_hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_hwnd.0);
    let hwnd_key = hwnd.0 as isize;

    if ORIGINAL_WNDPROC_BY_HWND
        .lock()
        .map(|map| map.contains_key(&hwnd_key))
        .unwrap_or(false)
    {
        return;
    }

    unsafe { SetLastError(WIN32_ERROR(0)) };
    let previous = unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_WNDPROC,
            force_arrow_cursor_wndproc as *const () as usize as isize,
        )
    };
    if previous == 0 {
        let error = unsafe { GetLastError() };
        if error.0 != 0 {
            eprintln!(
                "[window] failed to install cursor override hook: {}",
                error.0
            );
            return;
        }
    }

    if let Ok(mut map) = ORIGINAL_WNDPROC_BY_HWND.lock() {
        map.insert(hwnd_key, previous);
    }
}

#[tauri::command]
#[specta::specta]
async fn config_get(
    window: WebviewWindow,
    state: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
) -> Result<PublicAppConfig, String> {
    ensure_main_window(&window)?;
    public_config(&state.get().await, secrets.inner()).await
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state at the IPC boundary.
async fn config_update(
    window: WebviewWindow,
    app: tauri::AppHandle,
    activity: State<'_, Arc<ActivityGate>>,
    state: State<'_, Arc<ConfigState>>,
    hotkeys: State<'_, Arc<HotkeyManager>>,
    secrets: State<'_, Arc<SecretStore>>,
    sessions: State<'_, Arc<AuthSessionState>>,
    auth_queue: State<'_, Arc<AuthQueue>>,
    mut payload: JsonValue,
) -> Result<PublicAppConfig, String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let apply_window_size =
        payload.get("windowWidth").is_some() || payload.get("windowHeight").is_some();
    log::info!(
        target: "config",
        "config_update command: keys={:?}",
        payload
            .as_object()
            .map(|value| value.keys().cloned().collect::<Vec<_>>())
    );
    apply_secret_patch(&mut payload, secrets.inner()).await?;
    let previous_domain = state.get().await.backend_domain;
    let updated = state
        .update(payload.into_inner())
        .await
        .map_err(|error| error.to_string())?;
    if updated.backend_domain != previous_domain {
        auth_queue.cancel_all().await;
        if let Err(error) = sessions
            .clear_domain(secrets.inner(), &previous_domain)
            .await
        {
            log::warn!(target: "auth", "Failed to clear previous-domain session: {error}");
        }
        if let Err(error) = sessions
            .clear_domain(secrets.inner(), &updated.backend_domain)
            .await
        {
            log::warn!(target: "auth", "Failed to clear target-domain session: {error}");
        }
    }
    let public = public_config(&updated, secrets.inner()).await?;
    app.emit_to("main", "config:updated", &public)
        .map_err(|error| error.to_string())?;
    handle_config_effects(&app, &updated, hotkeys.inner().clone(), apply_window_size);
    Ok(public)
}

#[tauri::command]
#[specta::specta]
async fn config_reset(
    window: WebviewWindow,
    app: tauri::AppHandle,
    activity: State<'_, Arc<ActivityGate>>,
    state: State<'_, Arc<ConfigState>>,
    hotkeys: State<'_, Arc<HotkeyManager>>,
    secrets: State<'_, Arc<SecretStore>>,
) -> Result<PublicAppConfig, String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let updated = state.reset().await.map_err(|error| error.to_string())?;
    let public = public_config(&updated, secrets.inner()).await?;
    app.emit_to("main", "config:updated", &public)
        .map_err(|error| error.to_string())?;
    handle_config_effects(&app, &updated, hotkeys.inner().clone(), true);
    Ok(public)
}

#[tauri::command]
#[specta::specta]
async fn config_path(
    window: WebviewWindow,
    state: State<'_, Arc<ConfigState>>,
) -> Result<String, String> {
    ensure_main_window(&window)?;
    Ok(state.path().await.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
async fn open_config_folder(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: State<'_, Arc<ConfigState>>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let dir = state.directory().await;
    tauri_plugin_opener::OpenerExt::opener(&app)
        .open_path(dir.to_string_lossy(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn app_log_path(window: WebviewWindow) -> Result<String, String> {
    ensure_main_window(&window)?;
    app_log::current_log_path().map(|path| path.to_string_lossy().to_string())
}

#[tauri::command]
#[specta::specta]
async fn open_app_logs_folder(window: WebviewWindow, app: tauri::AppHandle) -> Result<(), String> {
    ensure_main_window(&window)?;
    use tauri_plugin_opener::OpenerExt;
    let dir = app_log::current_log_dir()?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn log_frontend(window: WebviewWindow, entry: JsonValue) -> Result<(), String> {
    ensure_main_window(&window)?;
    if !app_log::allow_frontend_log() {
        return Ok(());
    }
    let level = entry
        .get("level")
        .and_then(|value| value.as_str())
        .unwrap_or("info")
        .trim()
        .to_lowercase();
    let category = entry
        .get("category")
        .and_then(|value| value.as_str())
        .unwrap_or("renderer")
        .trim()
        .chars()
        .take(64)
        .collect::<String>();
    let message = entry
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .trim()
        .chars()
        .take(2_048)
        .collect::<String>();
    let data = app_log::redact_json(
        &entry
            .get("data")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
    );
    let data_text = if data.is_null() {
        String::new()
    } else {
        let text = serde_json::to_string(&data).unwrap_or_else(|_| "<unserializable>".to_string());
        format!(" data={}", truncate_log_value(&text, 4000))
    };
    let line = app_log::redact_text(&format!("[{category}] {message}{data_text}"));

    match level.as_str() {
        "error" => log::error!(target: "frontend", "{line}"),
        "warn" | "warning" => log::warn!(target: "frontend", "{line}"),
        "debug" => log::debug!(target: "frontend", "{line}"),
        _ => log::info!(target: "frontend", "{line}"),
    }
    Ok(())
}

fn truncate_log_value(value: &str, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value.to_string();
    }
    let truncated = value.chars().take(max_len).collect::<String>();
    format!("{truncated}...<truncated>")
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
struct DiagnosticsSnapshot {
    trace_id: String,
    app_version: String,
    os: &'static str,
    architecture: &'static str,
    backend_domain: String,
    provider: String,
    model: String,
    transcription_mode: String,
    transcription_model: String,
    audio_mode: String,
    log_preview: String,
}

#[tauri::command]
#[specta::specta]
async fn diagnostics_snapshot(
    window: WebviewWindow,
    app: tauri::AppHandle,
    config: State<'_, Arc<ConfigState>>,
) -> Result<DiagnosticsSnapshot, String> {
    ensure_main_window(&window)?;
    let config = config.get().await;
    let provider = if config.llm_host == "local" {
        "ollama"
    } else if config.llm_model.to_ascii_lowercase().contains("gemini") {
        "google"
    } else {
        "openai"
    };
    Ok(DiagnosticsSnapshot {
        trace_id: uuid::Uuid::new_v4().to_string(),
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS,
        architecture: std::env::consts::ARCH,
        backend_domain: config.backend_domain,
        provider: provider.to_string(),
        model: config.llm_model,
        transcription_mode: config.transcription_mode,
        transcription_model: config.transcription_model,
        audio_mode: config.audio_input_type,
        log_preview: app_log::redacted_tail(16 * 1024)
            .unwrap_or_else(|error| format!("<log preview unavailable: {error}>")),
    })
}

#[tauri::command]
#[specta::specta]
async fn open_external_url(
    window: WebviewWindow,
    app: tauri::AppHandle,
    url: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    use tauri_plugin_opener::OpenerExt;

    let normalized = url.trim();
    if normalized.is_empty() {
        return Err("URL is empty".to_string());
    }
    let parsed = validate_external_url(normalized)?;

    app.opener()
        .open_url(parsed.to_string(), None::<String>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn auth_consume_pending(
    window: WebviewWindow,
    queue: State<'_, Arc<AuthQueue>>,
) -> Result<Vec<AuthDeepLinkPayload>, String> {
    ensure_main_window(&window)?;
    Ok(queue.mark_renderer_ready_and_drain().await)
}

#[tauri::command]
#[specta::specta]
async fn auth_renderer_not_ready(
    window: WebviewWindow,
    queue: State<'_, Arc<AuthQueue>>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    queue.mark_renderer_not_ready().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn auth_cancel_pending(
    window: WebviewWindow,
    queue: State<'_, Arc<AuthQueue>>,
    sessions: State<'_, Arc<AuthSessionState>>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    sessions.cancel_pending_operations().await;
    queue.cancel_all().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn auth_get_methods(
    window: WebviewWindow,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
) -> Result<oauth::AuthMethods, String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let cfg = config.get().await;
    log::info!(
        target: "auth",
        "auth_get_methods command: backend_domain={}",
        cfg.backend_domain
    );
    oauth::load_auth_methods(Some(cfg.backend_domain.as_str()))
        .await
        .map_err(|error| {
            log::error!(target: "auth", "auth_get_methods failed: {error}");
            error.to_string()
        })
}

#[tauri::command]
#[specta::specta]
async fn auth_start_oauth(
    window: WebviewWindow,
    app: tauri::AppHandle,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    queue: State<'_, Arc<AuthQueue>>,
    provider: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    use tauri_plugin_opener::OpenerExt;
    let cfg = config.get().await;
    let provider = provider.trim().to_lowercase();
    log::info!(
        target: "auth",
        "auth_start_oauth command: provider={} backend_domain={}",
        provider,
        cfg.backend_domain
    );
    if !oauth::is_supported_provider(&provider) {
        log::warn!(target: "auth", "Unsupported OAuth provider requested: {provider}");
        return Err(format!("Unsupported OAuth provider: {provider}"));
    }
    let methods = oauth::load_auth_methods(Some(cfg.backend_domain.as_str()))
        .await
        .map_err(|error| {
            log::error!(target: "auth", "Failed to load auth methods before OAuth start: {error}");
            error.to_string()
        })?;
    if !oauth::provider_is_allowed(&methods, &provider) {
        log::warn!(
            target: "auth",
            "OAuth provider blocked: provider={} country={} allowed={:?}",
            provider,
            methods.country_code,
            methods.allowed_oauth_providers
        );
        return Err("OAuth provider is not available for your region".to_string());
    }
    let oauth_attempt = queue.start_attempt(&provider, &cfg.backend_domain).await;
    let url = match oauth::build_oauth_start_url_with_pkce(
        &provider,
        Some(cfg.backend_domain.as_str()),
        &oauth_attempt.state,
        &oauth_attempt.code_challenge,
    ) {
        Ok(url) => url,
        Err(error) => {
            queue.cancel_state(&oauth_attempt.state).await;
            return Err(error.to_string());
        }
    };
    log::info!(target: "auth", "Opening OAuth URL: provider={provider}");
    if let Err(error) = app.opener().open_url(url, None::<String>) {
        queue.cancel_state(&oauth_attempt.state).await;
        log::error!(target: "auth", "Failed to open OAuth URL: provider={} error={}", provider, error);
        return Err(error.to_string());
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
async fn local_speech_get_status(
    manager: State<'_, Arc<FastWhisperManager>>,
) -> Result<FastWhisperStatus, String> {
    Ok(manager.get_status().await)
}

#[tauri::command]
#[specta::specta]
async fn local_speech_check_health(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<FastWhisperStatus, String> {
    let _activity = activity.try_begin_work()?;
    Ok(manager.check_health(&app).await)
}

#[tauri::command]
#[specta::specta]
async fn local_speech_install(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<FastWhisperStatus, String> {
    let _activity = activity.try_begin_work()?;
    manager
        .install_and_start(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn local_speech_start(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<FastWhisperStatus, String> {
    let _activity = activity.try_begin_work()?;
    manager
        .start_existing(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn local_speech_restart(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<FastWhisperStatus, String> {
    let _activity = activity.try_begin_work()?;
    manager
        .restart(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn local_speech_reinstall(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<FastWhisperStatus, String> {
    let _activity = activity.try_begin_work()?;
    manager
        .reinstall(&app)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn local_speech_stop(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<FastWhisperStatus, String> {
    let _activity = activity.try_begin_work()?;
    manager.stop(&app).await.map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn local_speech_check_model_downloaded(
    app: tauri::AppHandle,
    manager: State<'_, Arc<FastWhisperManager>>,
    activity: State<'_, Arc<ActivityGate>>,
    model: String,
) -> Result<bool, String> {
    let _activity = activity.try_begin_work()?;
    manager
        .is_model_downloaded(&app, &model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn ollama_check_installed(activity: State<'_, Arc<ActivityGate>>) -> Result<bool, String> {
    let _activity = activity.try_begin_work()?;
    crate::ollama::check_installed()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn ollama_list_models(activity: State<'_, Arc<ActivityGate>>) -> Result<Vec<String>, String> {
    let _activity = activity.try_begin_work()?;
    crate::ollama::list_models()
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn ollama_pull_model(
    activity: State<'_, Arc<ActivityGate>>,
    model: String,
) -> Result<(), String> {
    let _activity = activity.try_begin_work()?;
    crate::ollama::pull_model(&model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn ollama_warmup_model(
    activity: State<'_, Arc<ActivityGate>>,
    model: String,
) -> Result<(), String> {
    let _activity = activity.try_begin_work()?;
    crate::ollama::warmup_model(&model)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
#[specta::specta]
async fn audio_list_devices(
    manager: State<'_, Arc<AudioManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<Vec<audio::AudioDeviceInfo>, String> {
    let _activity = activity.try_begin_work()?;
    manager.list_devices().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
async fn audio_start_capture(
    window: WebviewWindow,
    app: tauri::AppHandle,
    manager: State<'_, Arc<AudioManager>>,
    activity: State<'_, Arc<ActivityGate>>,
    source: String,
    device_id: Option<String>,
    on_chunk: tauri::ipc::Channel<audio::AudioChunk>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    manager
        .start(app, &source, device_id, on_chunk)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
async fn audio_stop_capture(
    manager: State<'_, Arc<AudioManager>>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<(), String> {
    let _activity = activity.try_begin_work()?;
    manager.stop().map_err(|e| e.to_string())
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

fn apply_window_preferences(
    app: &AppHandle,
    config: &AppConfig,
    apply_window_size: bool,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let scale = config.window_scale.clamp(0.5, 3.0);

        // Применяем размер окна БЕЗ масштабирования
        // Масштабирование контента происходит через CSS font-size на html
        if apply_window_size {
            let base_width = config.window_width.clamp(DEFAULT_WINDOW_MIN_WIDTH, 4000) as f64;
            let base_height = config.window_height.clamp(DEFAULT_WINDOW_MIN_HEIGHT, 4000) as f64;

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
                            GetWindowLongPtrW, SetLayeredWindowAttributes,
                            SetWindowDisplayAffinity, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
                            WDA_EXCLUDEFROMCAPTURE, WDA_NONE, WS_EX_LAYERED,
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
                            let _ = SetLayeredWindowAttributes(
                                hwnd_handle,
                                windows::Win32::Foundation::COLORREF(0),
                                alpha,
                                LWA_ALPHA,
                            );
                        }

                        // Применяем скрытие от записи экрана
                        unsafe {
                            if hide_app_value {
                                let _ =
                                    SetWindowDisplayAffinity(hwnd_handle, WDA_EXCLUDEFROMCAPTURE);
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
        #[cfg(target_os = "windows")]
        install_force_default_cursor(&window);

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
            #[cfg(target_os = "windows")]
            install_force_default_cursor(&window);

            window.show().map_err(|error| error.to_string())?;
            window.set_focus().map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}

fn main() {
    if let Err(error) = app_log::init() {
        eprintln!("App logger initialization failed: {error}");
    }
    log::info!(target: "app", "Starting XEXAMAI");
    let ipc = ipc_contract::builder();

    tauri::Builder::default()
        // Single-instance must be registered before plugins with side effects so
        // a secondary OAuth activation only forwards its deep link and exits.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Deep links contain OAuth credentials with the current backend
            // contract. Never write process arguments to logs.
            log::info!(target: "deep-link", "Single instance activation: argument_count={}", args.len());
            if let Some(url) = args.into_iter().find(|arg| arg.starts_with("xexamai://")) {
                log::info!(target: "deep-link", "Single instance received deep link");
                if let Some(state) = app.try_state::<Arc<AuthQueue>>() {
                    dispatch_deep_link(app, state.inner().clone(), url);
                } else {
                    log::warn!(target: "deep-link", "AuthQueue is not ready; queueing pending deep link");
                    if url.len() <= 64 * 1024 {
                        let mut pending = PENDING_DEEP_LINKS.lock().unwrap();
                        if pending.len() == 8 {
                            pending.remove(0);
                        }
                        pending.push(url);
                    }
                }
            } else {
                let _ = show_main_window(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_handle = app.handle();
            ensure_deep_links_registered(app_handle);
            let config_state = Arc::new(tauri::async_runtime::block_on(ConfigState::initialize(
                app_handle,
            ))?);
            let initial_config = tauri::async_runtime::block_on(config_state.get());
            let secret_store = Arc::new(SecretStore::new());
            if let Err(error) = tauri::async_runtime::block_on(migrate_legacy_provider_secrets(
                config_state.as_ref(),
                secret_store.as_ref(),
                &initial_config,
            )) {
                log::error!(target: "config", "Legacy secret migration failed: {error}");
            }
            let initial_config = tauri::async_runtime::block_on(config_state.get());
            log::info!(
                target: "app",
                "Config loaded: backend_domain={} transcription_mode={} llm_host={}",
                initial_config.backend_domain,
                initial_config.transcription_mode,
                initial_config.llm_host
            );

            let hotkeys = Arc::new(HotkeyManager::new());
            let fast_whisper = Arc::new(FastWhisperManager::new());
            let auth_queue = Arc::new(AuthQueue::new());
            let auth_sessions = Arc::new(AuthSessionState::new());
            let provider_proxy_state = Arc::new(provider_proxy::ProviderProxyState::new());
            let transcription_cancellation =
                Arc::new(transcription::TranscriptionCancellationState::default());
            let audio_manager = Arc::new(AudioManager::new());
            let activity_gate = Arc::new(ActivityGate::new());
            let renderer_activity_leases =
                Arc::new(RendererActivityLeases::new(activity_gate.clone()));
            let shutdown_state = Arc::new(ShutdownState::default());

            app.manage(config_state.clone());
            app.manage(hotkeys.clone());
            app.manage(fast_whisper.clone());
            app.manage(auth_queue.clone());
            app.manage(auth_sessions);
            app.manage(provider_proxy_state);
            app.manage(transcription_cancellation);
            app.manage(secret_store);
            app.manage(audio_manager.clone());
            app.manage(activity_gate);
            app.manage(renderer_activity_leases);
            app.manage(shutdown_state.clone());
            app.manage(update::UpdateManager::default());

            tray::setup(app_handle)?;
            handle_config_effects(app_handle, &initial_config, hotkeys, true);
            flush_pending_deep_links(app_handle, auth_queue.clone());
            setup_deep_link_listener(app_handle, auth_queue);
            update::start_update_poll(app_handle.clone());

            if let Some(main_window) = app.get_webview_window("main") {
                #[cfg(target_os = "windows")]
                install_force_default_cursor(&main_window);

                let app_handle = app_handle.clone();
                let shutdown_state = shutdown_state.clone();
                main_window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        if shutdown_state.requested.swap(true, Ordering::AcqRel) {
                            return;
                        }
                        let _ = app_handle.emit_to("main", "app:shutdown-requested", ());
                        let fallback_app = app_handle.clone();
                        let fallback_state = shutdown_state.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(3)).await;
                            if !fallback_state.completed.load(Ordering::Acquire) {
                                log::warn!(target: "app", "Renderer shutdown timed out; exiting");
                                log::logger().flush();
                                fallback_app.exit(0);
                            }
                        });
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(ipc.invoke_handler())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn flush_pending_deep_links(app: &AppHandle, queue: Arc<AuthQueue>) {
    let mut pending = PENDING_DEEP_LINKS.lock().unwrap();
    if !pending.is_empty() {
        log::info!(
            target: "deep-link",
            "Flushing pending deep links: count={}",
            pending.len()
        );
    }
    for url in pending.drain(..) {
        dispatch_deep_link(app, queue.clone(), url);
    }
}

fn setup_deep_link_listener(app: &AppHandle, queue: Arc<AuthQueue>) {
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        log::info!(
            target: "deep-link",
            "Current deep links found at startup: count={}",
            urls.len()
        );
        for url in urls {
            dispatch_deep_link(app, queue.clone(), url.to_string());
        }
    } else {
        log::info!(target: "deep-link", "No current deep link at startup");
    }
    let queue_listener = queue.clone();
    let app_listener = app.clone();
    app.deep_link().on_open_url(move |event| {
        let urls = event.urls();
        log::info!(
            target: "deep-link",
            "Deep link open event: count={}",
            urls.len()
        );
        for url in urls {
            dispatch_deep_link(&app_listener, queue_listener.clone(), url.to_string());
        }
    });
}

fn dispatch_deep_link(app: &AppHandle, queue: Arc<AuthQueue>, url: String) {
    log::info!(target: "deep-link", "Dispatching deep link to auth handler");
    tauri::async_runtime::spawn(auth::handle_deep_link(app.clone(), queue, url));
}

fn ensure_deep_links_registered(app: &AppHandle) {
    match app.deep_link().register_all() {
        Ok(()) => log::info!(target: "deep-link", "Deep link schemes registered"),
        Err(error) => {
            log::error!(target: "deep-link", "Failed to register deep link schemes: {error}");
            eprintln!("[deep-link] failed to register schemes: {error}");
        }
    }
}
