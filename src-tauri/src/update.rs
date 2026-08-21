use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::{
    audio::AudioManager,
    constants::{UPDATE_CHECK_INTERVAL_SECS, UPDATE_INITIAL_CHECK_DELAY_SECS},
};

const UPDATE_AVAILABLE_EVENT: &str = "update-available";
const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";
const UPDATE_STARTED_EVENT: &str = "update-started";
const UPDATE_ERROR_EVENT: &str = "update-error";
const UPDATE_REQUEST_TIMEOUT_SECS: u64 = 60;
const UPDATE_DOWNLOAD_TIMEOUT_SECS: u64 = 30 * 60;
const UPDATE_BASE_URL: &str =
    "https://s3.twcstorage.ru/324718a4-2cc5dd7a-917b-4e82-87c5-b9d5f8de16ba/xexamai";

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub target: String,
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub version: Option<String>,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
    pub target: Option<String>,
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateProgressPayload {
    percent: u64,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStartedPayload {
    version: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateErrorPayload {
    message: String,
}

#[derive(Default)]
struct PendingUpdate {
    update: Option<Update>,
    bytes: Option<Vec<u8>>,
    metadata: Option<UpdateMetadata>,
}

/// Serializes updater operations and owns the verified update artifact.
/// `Update::download` verifies the configured Ed25519/minisign signature
/// before returning bytes that can be passed to the platform installer.
pub struct UpdateManager {
    operation: AsyncMutex<()>,
    pending: Mutex<PendingUpdate>,
}

impl Default for UpdateManager {
    fn default() -> Self {
        Self {
            operation: AsyncMutex::new(()),
            pending: Mutex::new(PendingUpdate::default()),
        }
    }
}

fn updater_enabled() -> bool {
    !cfg!(debug_assertions) || std::env::var_os("XEXAMAI_ENABLE_DEBUG_UPDATER").is_some()
}

fn emit_to_main<T: Clone + Serialize>(app: &AppHandle, event: &str, payload: T) {
    if let Err(error) = app.emit_to("main", event, payload) {
        log::warn!(target: "update", "Failed to emit {event}: {error}");
    }
}

fn emit_update_error(app: &AppHandle, error: impl std::fmt::Display) {
    let message = error.to_string();
    log::error!(target: "update", "Update error: {message}");
    emit_to_main(app, UPDATE_ERROR_EVENT, UpdateErrorPayload { message });
}

fn metadata_from_update(update: &Update, downloaded: bool) -> UpdateMetadata {
    UpdateMetadata {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
        target: update.target.clone(),
        downloaded,
    }
}

fn result_from_metadata(
    current_version: String,
    metadata: Option<&UpdateMetadata>,
) -> UpdateCheckResult {
    UpdateCheckResult {
        update_available: metadata.is_some(),
        version: metadata.map(|value| value.version.clone()),
        current_version,
        notes: metadata.and_then(|value| value.notes.clone()),
        date: metadata.and_then(|value| value.date.clone()),
        target: metadata.map(|value| value.target.clone()),
        downloaded: metadata.is_some_and(|value| value.downloaded),
    }
}

fn channel_manifest_url(is_prerelease: bool) -> Result<url::Url, String> {
    let manifest = if is_prerelease {
        "latest-beta.json"
    } else {
        "latest.json"
    };
    url::Url::parse(&format!("{UPDATE_BASE_URL}/{manifest}"))
        .map_err(|error| format!("Invalid updater endpoint: {error}"))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn check_app_update(
    app: AppHandle,
    manager: State<'_, UpdateManager>,
) -> Result<UpdateCheckResult, String> {
    check_for_updates(&app, manager.inner(), true).await
}

async fn check_for_updates(
    app: &AppHandle,
    manager: &UpdateManager,
    report_error: bool,
) -> Result<UpdateCheckResult, String> {
    if !updater_enabled() {
        let current_version = app.package_info().version.to_string();
        return Ok(result_from_metadata(current_version, None));
    }

    let _operation = manager.operation.lock().await;
    let current_version = app.package_info().version.to_string();
    log::info!(target: "update", "Checking for a signed application update");

    let endpoint = channel_manifest_url(!app.package_info().version.pre.is_empty())?;
    let check_result = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(UPDATE_REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await;

    let update = match check_result {
        Ok(update) => update,
        Err(error) => {
            if report_error {
                emit_update_error(app, &error);
            } else {
                log::warn!(target: "update", "Background update check failed: {error}");
            }
            return Err(error.to_string());
        }
    };

    let Some(mut update) = update else {
        let mut pending = manager
            .pending
            .lock()
            .map_err(|_| "Updater state is poisoned")?;
        *pending = PendingUpdate::default();
        return Ok(result_from_metadata(current_version, None));
    };

    // Manifest checks should fail quickly, but signed desktop installers can be
    // hundreds of megabytes. The plugin copies its request timeout onto Update,
    // so replace the short check timeout before retaining the download handle.
    update.timeout = Some(Duration::from_secs(UPDATE_DOWNLOAD_TIMEOUT_SECS));

    let mut pending = manager
        .pending
        .lock()
        .map_err(|_| "Updater state is poisoned")?;
    let preserve_download = pending
        .metadata
        .as_ref()
        .is_some_and(|metadata| metadata.version == update.version)
        && pending.bytes.is_some();
    let metadata = metadata_from_update(&update, preserve_download);
    if !preserve_download {
        pending.bytes = None;
    }
    pending.update = Some(update);
    pending.metadata = Some(metadata.clone());
    drop(pending);

    log::info!(
        target: "update",
        "Signed update is available: current={} next={} target={}",
        metadata.current_version,
        metadata.version,
        metadata.target
    );
    emit_to_main(app, UPDATE_AVAILABLE_EVENT, metadata.clone());
    Ok(result_from_metadata(current_version, Some(&metadata)))
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn download_app_update(
    app: AppHandle,
    manager: State<'_, UpdateManager>,
) -> Result<UpdateMetadata, String> {
    let _operation = manager.operation.lock().await;

    let (update, existing_metadata, already_downloaded) = {
        let pending = manager
            .pending
            .lock()
            .map_err(|_| "Updater state is poisoned")?;
        (
            pending.update.clone().ok_or_else(|| {
                "There is no pending update. Check for updates first.".to_string()
            })?,
            pending.metadata.clone(),
            pending.bytes.is_some(),
        )
    };

    if already_downloaded {
        return existing_metadata
            .ok_or_else(|| "Downloaded update metadata is missing".to_string());
    }

    let downloaded_bytes = Arc::new(AtomicU64::new(0));
    let content_length = Arc::new(Mutex::new(None));
    let progress_app = app.clone();
    let finish_app = app.clone();
    let progress_downloaded = downloaded_bytes.clone();
    let finish_downloaded = downloaded_bytes.clone();
    let progress_total = content_length.clone();
    let finish_total = content_length.clone();
    let bytes = match update
        .download(
            move |chunk_length, total_bytes| {
                let downloaded_bytes = progress_downloaded
                    .fetch_add(chunk_length as u64, Ordering::AcqRel)
                    .saturating_add(chunk_length as u64);
                if let Ok(mut remembered_total) = progress_total.lock() {
                    *remembered_total = total_bytes;
                }
                let percent = total_bytes
                    .filter(|total| *total > 0)
                    .map(|total| downloaded_bytes.saturating_mul(100) / total)
                    .unwrap_or(0)
                    .min(100);
                emit_to_main(
                    &progress_app,
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgressPayload {
                        percent,
                        downloaded_bytes,
                        total_bytes,
                    },
                );
            },
            move || {
                log::info!(target: "update", "Signed update download verified");
                let downloaded_bytes = finish_downloaded.load(Ordering::Acquire);
                let total_bytes = finish_total.lock().ok().and_then(|value| *value);
                emit_to_main(
                    &finish_app,
                    UPDATE_PROGRESS_EVENT,
                    UpdateProgressPayload {
                        percent: 100,
                        downloaded_bytes,
                        total_bytes,
                    },
                );
            },
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            emit_update_error(&app, &error);
            return Err(error.to_string());
        }
    };

    let metadata = metadata_from_update(&update, true);
    let mut pending = manager
        .pending
        .lock()
        .map_err(|_| "Updater state is poisoned")?;
    pending.bytes = Some(bytes);
    pending.metadata = Some(metadata.clone());
    Ok(metadata)
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn install_app_update(
    app: AppHandle,
    manager: State<'_, UpdateManager>,
    audio: State<'_, Arc<AudioManager>>,
    activity: State<'_, Arc<crate::activity::ActivityGate>>,
) -> Result<(), String> {
    let _operation = manager.operation.lock().await;
    let _install_activity = activity.try_begin_install()?;
    if audio.is_active() {
        return Err("Stop the active audio capture before installing the update.".to_string());
    }
    let (update, bytes, metadata) = {
        let mut pending = manager
            .pending
            .lock()
            .map_err(|_| "Updater state is poisoned")?;
        let update = pending
            .update
            .take()
            .ok_or_else(|| "There is no pending update".to_string())?;
        let bytes = pending
            .bytes
            .take()
            .ok_or_else(|| "Download the update before installing it".to_string())?;
        let metadata = pending
            .metadata
            .take()
            .unwrap_or_else(|| metadata_from_update(&update, true));
        (update, bytes, metadata)
    };

    emit_to_main(
        &app,
        UPDATE_STARTED_EVENT,
        UpdateStartedPayload {
            version: metadata.version.clone(),
        },
    );
    log::info!(target: "update", "Installing signed update {}", metadata.version);

    if let Err(error) = update.install(&bytes) {
        let mut pending = manager
            .pending
            .lock()
            .map_err(|_| "Updater state is poisoned")?;
        pending.update = Some(update);
        pending.bytes = Some(bytes);
        pending.metadata = Some(metadata);
        emit_update_error(&app, &error);
        return Err(error.to_string());
    }

    // The Windows installers terminate the current process themselves. The
    // macOS and Linux updater implementations replace/install the bundle and
    // return, so explicitly launch the new binary instead of continuing to run
    // the old executable after a successful update.
    #[cfg(not(target_os = "windows"))]
    {
        log::info!(target: "update", "Signed update installed; restarting into the new version");
        log::logger().flush();
        app.restart();
    }

    #[cfg(target_os = "windows")]
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn discard_app_update(manager: State<'_, UpdateManager>) -> Result<(), String> {
    let _operation = manager.operation.lock().await;
    let mut pending = manager
        .pending
        .lock()
        .map_err(|_| "Updater state is poisoned")?;
    *pending = PendingUpdate::default();
    Ok(())
}

pub(crate) fn start_update_poll(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(UPDATE_INITIAL_CHECK_DELAY_SECS)).await;
        loop {
            if let Some(manager) = app.try_state::<UpdateManager>() {
                let _ = check_for_updates(&app, manager.inner(), false).await;
            }
            tokio::time::sleep(Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_update_result_contains_current_version() {
        let result = result_from_metadata("2.4.1".to_string(), None);
        assert!(!result.update_available);
        assert_eq!(result.current_version, "2.4.1");
        assert!(result.version.is_none());
        assert!(!result.downloaded);
    }

    #[test]
    fn update_result_preserves_signed_metadata() {
        let metadata = UpdateMetadata {
            version: "2.5.0".to_string(),
            current_version: "2.4.1".to_string(),
            notes: Some("Notes".to_string()),
            date: Some("2026-08-21T00:00:00Z".to_string()),
            target: "windows-x86_64".to_string(),
            downloaded: true,
        };
        let result = result_from_metadata("2.4.1".to_string(), Some(&metadata));
        assert!(result.update_available);
        assert_eq!(result.version.as_deref(), Some("2.5.0"));
        assert_eq!(result.target.as_deref(), Some("windows-x86_64"));
        assert!(result.downloaded);
    }

    #[test]
    fn prereleases_and_stable_builds_use_separate_channels() {
        assert!(channel_manifest_url(false)
            .unwrap()
            .as_str()
            .ends_with("/latest.json"));
        assert!(channel_manifest_url(true)
            .unwrap()
            .as_str()
            .ends_with("/latest-beta.json"));
    }
}
