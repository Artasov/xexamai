use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[cfg(target_os = "windows")]
use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;
use url::Url;

use crate::constants::{
    UPDATE_CHECK_INTERVAL_SECS, UPDATE_INITIAL_CHECK_DELAY_SECS, UPDATE_MANIFEST_URL,
};

const UPDATE_AVAILABLE_EVENT: &str = "update-available";
const UPDATE_PROGRESS_EVENT: &str = "update-download-progress";
const UPDATE_STARTED_EVENT: &str = "update-started";
const UPDATE_ERROR_EVENT: &str = "update-error";
const UPDATE_REQUEST_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateManifest {
    version: String,
    #[serde(default, alias = "sha256_hash")]
    sha256_hash: Option<String>,
    #[serde(default, alias = "url", alias = "download_url")]
    file: Option<String>,
    #[serde(default)]
    files: HashMap<String, UpdateFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFile {
    #[serde(default, alias = "url", alias = "download_url")]
    file: Option<String>,
    #[serde(default, alias = "sha256", alias = "sha256_hash")]
    sha256_hash: Option<String>,
    #[serde(default, alias = "filename")]
    name: Option<String>,
}

#[derive(Debug, Clone)]
struct UpdateCandidate {
    version: String,
    file_url: String,
    file_name: String,
    expected_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub update_available: bool,
    pub version: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateAvailablePayload {
    version: String,
    current_version: String,
    file_name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateProgressPayload {
    percent: u64,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateStartedPayload {
    version: String,
    file_name: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UpdateErrorPayload {
    message: String,
}

#[tauri::command]
pub(crate) async fn check_app_update(app: AppHandle) -> std::result::Result<UpdateCheckResult, String> {
    log::info!(target: "update", "Manual update check requested");
    check_for_updates(&app, true)
        .await
        .map_err(|error| {
            log::error!(target: "update", "Manual update check failed: {error}");
            error.to_string()
        })
}

pub(crate) fn start_update_poll(app: AppHandle) {
    log::info!(
        target: "update",
        "Starting update poll: initial_delay={}s interval={}s",
        UPDATE_INITIAL_CHECK_DELAY_SECS,
        UPDATE_CHECK_INTERVAL_SECS
    );
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(UPDATE_INITIAL_CHECK_DELAY_SECS)).await;
        loop {
            if let Err(error) = check_for_updates(&app, false).await {
                eprintln!("[update] check failed: {error}");
            }
            tokio::time::sleep(Duration::from_secs(UPDATE_CHECK_INTERVAL_SECS)).await;
        }
    });
}

async fn check_for_updates(app: &AppHandle, emit_manifest_errors: bool) -> Result<UpdateCheckResult> {
    if cfg!(debug_assertions) && std::env::var("XEXAMAI_ENABLE_DEBUG_UPDATER").is_err() {
        log::debug!(
            target: "update",
            "Skipping update check in debug build without XEXAMAI_ENABLE_DEBUG_UPDATER"
        );
        return Ok(UpdateCheckResult {
            update_available: false,
            version: None,
        });
    }

    let manifest_url = resolve_manifest_url();
    log::info!(target: "update", "Checking updates: manifest_url={manifest_url}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(UPDATE_REQUEST_TIMEOUT_SECS))
        .build()?;
    let manifest = match load_manifest(&client, &manifest_url).await {
        Ok(Some(manifest)) => manifest,
        Ok(None) => {
            return Ok(UpdateCheckResult {
                update_available: false,
                version: None,
            });
        }
        Err(error) => {
            if emit_manifest_errors {
                emit_update_error(app, error.to_string());
            }
            return Err(error);
        }
    };

    let current_version = app.package_info().version.to_string();
    log::info!(
        target: "update",
        "Update manifest loaded: current_version={} latest_version={}",
        current_version,
        manifest.version
    );
    if !is_newer_version(&manifest.version, &current_version) {
        log::info!(target: "update", "No update available");
        return Ok(UpdateCheckResult {
            update_available: false,
            version: Some(manifest.version),
        });
    }

    let candidate = match select_update_candidate(&manifest, &manifest_url) {
        Ok(candidate) => candidate,
        Err(error) => {
            emit_update_error(app, error.to_string());
            return Ok(UpdateCheckResult {
                update_available: true,
                version: Some(manifest.version),
            });
        }
    };

    let _ = app.emit(
        UPDATE_AVAILABLE_EVENT,
        UpdateAvailablePayload {
            version: candidate.version.clone(),
            current_version,
            file_name: candidate.file_name.clone(),
        },
    );
    log::info!(
        target: "update",
        "Update available: version={} file={} url={}",
        candidate.version,
        candidate.file_name,
        candidate.file_url
    );

    let installer_path = update_download_path(app, &candidate)?;
    if let Err(error) = download_with_progress(app, &client, &candidate.file_url, &installer_path).await {
        emit_update_error(app, error.to_string());
        let _ = fs::remove_file(&installer_path);
        return Ok(UpdateCheckResult {
            update_available: true,
            version: Some(candidate.version),
        });
    }

    if let Err(error) = verify_hash(&installer_path, &candidate.expected_hash) {
        emit_update_error(app, error.to_string());
        let _ = fs::remove_file(&installer_path);
        return Ok(UpdateCheckResult {
            update_available: true,
            version: Some(candidate.version),
        });
    }
    log::info!(
        target: "update",
        "Update hash verified: file={}",
        installer_path.to_string_lossy()
    );

    let _ = app.emit(
        UPDATE_STARTED_EVENT,
        UpdateStartedPayload {
            version: candidate.version.clone(),
            file_name: candidate.file_name.clone(),
        },
    );

    if let Err(error) = install_update(&installer_path).await {
        emit_update_error(app, error.to_string());
        return Ok(UpdateCheckResult {
            update_available: true,
            version: Some(candidate.version),
        });
    }

    Ok(UpdateCheckResult {
        update_available: true,
        version: Some(candidate.version),
    })
}

fn resolve_manifest_url() -> String {
    std::env::var("XEXAMAI_UPDATE_MANIFEST_URL")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| UPDATE_MANIFEST_URL.to_string())
}

async fn load_manifest(client: &reqwest::Client, manifest_url: &str) -> Result<Option<UpdateManifest>> {
    log::info!(target: "update", "Requesting update manifest");
    let response = client
        .get(manifest_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .with_context(|| format!("Failed to request update manifest: {manifest_url}"))?;

    let status = response.status();
    log::info!(target: "update", "Update manifest response status: {status}");
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(anyhow!(
            "Failed to load update manifest: HTTP {}",
            status.as_u16()
        ));
    }

    Ok(Some(response.json::<UpdateManifest>().await?))
}

fn select_update_candidate(manifest: &UpdateManifest, manifest_url: &str) -> Result<UpdateCandidate> {
    let platform_key = current_platform_key();
    log::info!(
        target: "update",
        "Selecting update candidate: platform={} manifest_files={}",
        platform_key,
        manifest.files.len()
    );
    let selected = manifest.files.get(platform_key);
    let raw_file = selected
        .and_then(|file| file.file.as_deref())
        .or(manifest.file.as_deref())
        .ok_or_else(|| anyhow!("Update manifest does not contain a file for {platform_key}"))?;
    let expected_hash = selected
        .and_then(|file| file.sha256_hash.as_deref())
        .or(manifest.sha256_hash.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("Update manifest does not contain sha256 for {platform_key}"))?
        .to_lowercase();
    let file_url = absolutize_update_url(raw_file, manifest_url)?;
    let file_name = selected
        .and_then(|file| file.name.as_deref())
        .map(sanitize_file_name)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| file_name_from_url(&file_url, &manifest.version));

    Ok(UpdateCandidate {
        version: normalize_version(&manifest.version),
        file_url,
        file_name,
        expected_hash,
    })
}

fn current_platform_key() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "windows"
    }
    #[cfg(target_os = "macos")]
    {
        "macos"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "unknown"
    }
}

fn absolutize_update_url(raw_file: &str, manifest_url: &str) -> Result<String> {
    if raw_file.starts_with("http://") || raw_file.starts_with("https://") {
        return Ok(raw_file.to_string());
    }
    let base = Url::parse(manifest_url)?;
    Ok(base.join(raw_file)?.to_string())
}

fn file_name_from_url(file_url: &str, version: &str) -> String {
    Url::parse(file_url)
        .ok()
        .and_then(|url| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
                .map(sanitize_file_name)
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            let extension = if cfg!(target_os = "windows") {
                "exe"
            } else if cfg!(target_os = "macos") {
                "dmg"
            } else {
                "AppImage"
            };
            format!("xexamai-{}.{}", normalize_version(version), extension)
        })
}

fn sanitize_file_name(value: &str) -> String {
    value
        .chars()
        .filter(|ch| *ch != '/' && *ch != '\\' && *ch != ':' && *ch != '*' && *ch != '?' && *ch != '"' && *ch != '<' && *ch != '>' && *ch != '|')
        .collect::<String>()
        .trim()
        .to_string()
}

fn update_download_path(app: &AppHandle, candidate: &UpdateCandidate) -> Result<PathBuf> {
    let mut dir = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    dir.push("updates");
    dir.push(&candidate.version);
    fs::create_dir_all(&dir)?;
    Ok(dir.join(&candidate.file_name))
}

async fn download_with_progress(
    app: &AppHandle,
    client: &reqwest::Client,
    file_url: &str,
    dest: &Path,
) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }

    log::info!(
        target: "update",
        "Downloading update: url={} dest={}",
        file_url,
        dest.to_string_lossy()
    );
    let response = client
        .get(file_url)
        .send()
        .await
        .with_context(|| format!("Failed to download update: {file_url}"))?;
    let status = response.status();
    log::info!(target: "update", "Update download response status: {status}");
    if !status.is_success() {
        return Err(anyhow!(
            "Failed to download update: HTTP {}",
            status.as_u16()
        ));
    }

    let total = response.content_length();
    let mut file = tokio::fs::File::create(dest).await?;
    let mut downloaded = 0u64;
    let mut last_percent = 0u64;
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;

        let percent = total
            .filter(|value| *value > 0)
            .map(|value| ((downloaded as f64 / value as f64) * 100.0).round() as u64)
            .unwrap_or(0)
            .min(100);
        if percent > last_percent || total.is_none() {
            let _ = app.emit(
                UPDATE_PROGRESS_EVENT,
                UpdateProgressPayload {
                    percent,
                    downloaded_bytes: downloaded,
                    total_bytes: total,
                },
            );
            last_percent = percent;
        }
    }

    file.flush().await?;
    let _ = app.emit(
        UPDATE_PROGRESS_EVENT,
        UpdateProgressPayload {
            percent: 100,
            downloaded_bytes: downloaded,
            total_bytes: total,
        },
    );
    Ok(())
}

fn verify_hash(path: &Path, expected_hash: &str) -> Result<()> {
    let hash = sha256_hex_file(path)?;
    if hash != expected_hash {
        log::error!(
            target: "update",
            "Update hash mismatch: expected={} actual={}",
            expected_hash,
            hash
        );
        return Err(anyhow!("Downloaded update hash does not match the manifest"));
    }
    Ok(())
}

fn sha256_hex_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn normalize_version(value: &str) -> String {
    value.trim().trim_start_matches('v').to_string()
}

fn is_newer_version(latest: &str, current: &str) -> bool {
    let latest_normalized = normalize_version(latest);
    let current_normalized = normalize_version(current);
    if latest_normalized == current_normalized {
        return false;
    }

    match (
        parse_version_numbers(&latest_normalized),
        parse_version_numbers(&current_normalized),
    ) {
        (Some(latest_numbers), Some(current_numbers)) => latest_numbers > current_numbers,
        _ => true,
    }
}

fn parse_version_numbers(value: &str) -> Option<Vec<u64>> {
    let core = value.split(|ch| ch == '-' || ch == '+').next()?;
    let mut numbers = Vec::new();
    for part in core.split('.') {
        let digits = part
            .chars()
            .take_while(|ch| ch.is_ascii_digit())
            .collect::<String>();
        if digits.is_empty() {
            return None;
        }
        numbers.push(digits.parse::<u64>().ok()?);
    }
    while numbers.len() < 3 {
        numbers.push(0);
    }
    Some(numbers)
}

fn emit_update_error(app: &AppHandle, message: String) {
    log::error!(target: "update", "Update error: {message}");
    let _ = app.emit(UPDATE_ERROR_EVENT, UpdateErrorPayload { message });
}

#[cfg(target_os = "windows")]
async fn install_update(installer: &Path) -> Result<()> {
    log::info!(
        target: "update",
        "Installing update on Windows: installer={}",
        installer.to_string_lossy()
    );
    let current_pid = std::process::id();
    let mut base = std::env::temp_dir();
    base.push("xexamai-updater");
    fs::create_dir_all(&base)?;
    let script_path = base.join("xexamai-update.bat");
    let installer_ext = installer
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();

    let content = format!(
        "@echo off\r\n\
setlocal\r\n\
set \"INSTALLER={}\"\r\n\
set \"INSTALLER_EXT={}\"\r\n\
set \"APP_PID={}\"\r\n\
:wait_app_exit\r\n\
tasklist /FI \"PID eq %APP_PID%\" 2>NUL | find \"%APP_PID%\" >NUL\r\n\
if not errorlevel 1 (\r\n\
  timeout /t 1 /nobreak >nul\r\n\
  goto wait_app_exit\r\n\
)\r\n\
if /I \"%INSTALLER_EXT%\"==\"msi\" (\r\n\
  start \"\" /wait msiexec /i \"%INSTALLER%\" /qn /norestart\r\n\
) else (\r\n\
  start \"\" /wait \"%INSTALLER%\" /S\r\n\
)\r\n\
exit /b %errorlevel%\r\n",
        installer.display(),
        installer_ext,
        current_pid,
    );
    fs::write(&script_path, content)?;

    let mut command = Command::new("cmd");
    command.args(["/C", script_path.to_string_lossy().as_ref()]);
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;

    std::process::exit(0);
}

#[cfg(not(target_os = "windows"))]
async fn install_update(installer: &Path) -> Result<()> {
    log::warn!(
        target: "update",
        "Automatic install is not supported on this platform: installer={}",
        installer.to_string_lossy()
    );
    Err(anyhow!(
        "Automatic installation is currently supported only on Windows. Downloaded update: {}",
        installer.display()
    ))
}
