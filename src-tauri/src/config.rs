use std::env;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;

use crate::constants::{CONFIG_DIR_NAME, CONFIG_FILE_NAME};
use crate::types::AppConfig;

#[derive(Debug)]
pub struct ConfigState {
    inner: RwLock<AppConfig>,
    path: PathBuf,
}

impl ConfigState {
    pub async fn initialize(app: &AppHandle) -> Result<Self> {
        let mut base_dir = app
            .path()
            .app_config_dir()
            .map_err(|error| anyhow!("Не удалось определить директорию конфигурации: {error}"))?;
        base_dir.push(CONFIG_DIR_NAME);
        if !base_dir.exists() {
            fs::create_dir_all(&base_dir).await?;
        }
        if let Err(error) = sanitize_existing_corrupt_artifacts(&base_dir).await {
            // A stale diagnostic file must never prevent the application from
            // starting. Sanitization is retried on every initialization.
            log::warn!(target: "config", "Could not sanitize a legacy corrupt config artifact: {error}");
        }
        let mut path = base_dir.clone();
        path.push(CONFIG_FILE_NAME);

        let config = if Path::new(&path).exists() {
            match read_config(&path).await {
                Ok(config) => config,
                Err(primary_error) => {
                    let backup_path = backup_path(&path);
                    match read_config(&backup_path).await {
                        Ok(config) => {
                            log::warn!(
                                target: "config",
                                "Primary config is invalid; recovered from backup: {primary_error}"
                            );
                            persist_config(&path, &config).await?;
                            config
                        }
                        Err(backup_error) => {
                            log::error!(
                                target: "config",
                                "Config recovery failed; preserving corrupt input and using defaults: primary={primary_error}; backup={backup_error}"
                            );
                            preserve_corrupt_config(&path).await?;
                            let mut config = AppConfig::default();
                            hydrate_from_env(&mut config);
                            config.normalize();
                            persist_config(&path, &config).await?;
                            config
                        }
                    }
                }
            }
        } else {
            let mut config = AppConfig::default();
            hydrate_from_env(&mut config);
            config.normalize();
            persist_config(&path, &config).await?;
            config
        };

        Ok(Self {
            inner: RwLock::new(config),
            path,
        })
    }

    pub async fn get(&self) -> AppConfig {
        self.inner.read().await.clone()
    }

    pub async fn path(&self) -> PathBuf {
        self.path.clone()
    }

    pub async fn directory(&self) -> PathBuf {
        self.path
            .parent()
            .map(|dir| dir.to_path_buf())
            .unwrap_or_else(|| self.path.clone())
    }

    pub async fn update(&self, partial: Value) -> Result<AppConfig> {
        let mut guard = self.inner.write().await;
        let mut current = serde_json::to_value(&*guard)?;
        merge_values(&mut current, partial);
        let mut next: AppConfig = serde_json::from_value(current)?;
        hydrate_from_env(&mut next);
        next.normalize();
        self.persist(&next).await?;
        *guard = next.clone();
        Ok(next)
    }

    pub async fn reset(&self) -> Result<AppConfig> {
        let mut config = AppConfig::default();
        hydrate_from_env(&mut config);
        config.normalize();
        self.persist(&config).await?;
        *self.inner.write().await = config.clone();
        Ok(config)
    }

    pub async fn clear_legacy_secrets(&self) -> Result<()> {
        let mut guard = self.inner.write().await;
        if guard.openai_api_key.is_none() && guard.google_api_key.is_none() {
            return Ok(());
        }
        guard.openai_api_key = None;
        guard.google_api_key = None;
        self.persist(&guard).await
    }

    async fn persist(&self, state: &AppConfig) -> Result<()> {
        persist_config(&self.path, state).await
    }
}

async fn read_config(path: &Path) -> Result<AppConfig> {
    let bytes = fs::read(path)
        .await
        .with_context(|| format!("read config {}", path.display()))?;
    let contents = String::from_utf8(bytes)
        .map_err(|error| anyhow!("Invalid UTF-8 in {}: {error}", path.display()))?;
    let mut config: AppConfig = serde_json::from_str(&contents)
        .with_context(|| format!("parse config {}", path.display()))?;
    hydrate_from_env(&mut config);
    config.normalize();
    Ok(config)
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension("json.tmp")
}

async fn persist_config(path: &Path, state: &AppConfig) -> Result<()> {
    let serialized = serde_json::to_vec_pretty(state).context("serialize config")?;
    let temp_path = temporary_path(path);
    let backup_path = backup_path(path);

    if fs::try_exists(&temp_path).await.unwrap_or(false) {
        fs::remove_file(&temp_path)
            .await
            .with_context(|| format!("remove stale config temp {}", temp_path.display()))?;
    }

    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp_path)
        .await
        .with_context(|| format!("create config temp {}", temp_path.display()))?;
    file.write_all(&serialized)
        .await
        .context("write config temp")?;
    file.flush().await.context("flush config temp")?;
    file.sync_all().await.context("sync config temp")?;
    drop(file);

    if fs::try_exists(path).await.unwrap_or(false) {
        write_sanitized_backup(path, &backup_path).await?;
    }

    replace_file(&temp_path, path)
        .await
        .with_context(|| format!("replace config {}", path.display()))?;
    set_private_file_permissions(path).await?;
    sync_parent_directory(path).await?;
    Ok(())
}

async fn write_sanitized_backup(source: &Path, destination: &Path) -> Result<()> {
    let bytes = match fs::read(source).await {
        Ok(bytes) => bytes,
        Err(error) => {
            log::warn!(target: "config", "Could not read previous config for backup: {error}");
            return Ok(());
        }
    };
    let mut previous: AppConfig = match serde_json::from_slice(&bytes) {
        Ok(config) => config,
        Err(error) => {
            // Never copy an unparsed file: it may contain legacy plaintext keys.
            log::warn!(target: "config", "Skipping invalid previous config backup: {error}");
            return Ok(());
        }
    };
    previous.openai_api_key = None;
    previous.google_api_key = None;
    previous.normalize();
    let sanitized = serde_json::to_vec_pretty(&previous).context("serialize config backup")?;
    fs::write(destination, sanitized)
        .await
        .with_context(|| format!("write config backup {}", destination.display()))?;
    set_private_file_permissions(destination).await
}

async fn preserve_corrupt_config(path: &Path) -> Result<()> {
    if !fs::try_exists(path).await.unwrap_or(false) {
        return Ok(());
    }
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.json");
    let preserved = path.with_file_name(format!("{file_name}.corrupt-{timestamp}"));
    let size = fs::metadata(path).await?.len();
    let redacted = if size > MAX_CORRUPT_ARTIFACT_BYTES {
        "<oversized corrupt config removed>".to_string()
    } else {
        let bytes = fs::read(path)
            .await
            .with_context(|| format!("read corrupt config {}", path.display()))?;
        redact_corrupt_config(&String::from_utf8_lossy(&bytes))
    };
    fs::write(&preserved, redacted.as_bytes())
        .await
        .with_context(|| format!("write redacted corrupt config {}", preserved.display()))?;
    set_private_file_permissions(&preserved).await?;
    fs::remove_file(path)
        .await
        .with_context(|| format!("remove raw corrupt config {}", path.display()))?;
    Ok(())
}

const MAX_CORRUPT_ARTIFACT_BYTES: u64 = 1024 * 1024;

async fn sanitize_existing_corrupt_artifacts(directory: &Path) -> Result<()> {
    let mut entries = fs::read_dir(directory)
        .await
        .with_context(|| format!("scan config directory {}", directory.display()))?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(suffix) = name.strip_prefix("config.json.corrupt-") else {
            continue;
        };
        if suffix.is_empty() || !suffix.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).await?;
        if !metadata.file_type().is_file() {
            continue;
        }
        if metadata.len() > MAX_CORRUPT_ARTIFACT_BYTES {
            // Do not retain an unbounded legacy artifact that may contain plaintext
            // credentials. It is not a usable config or recovery source.
            fs::remove_file(&path)
                .await
                .with_context(|| format!("remove oversized corrupt config {}", path.display()))?;
            continue;
        }
        let bytes = fs::read(&path).await?;
        let redacted = redact_corrupt_config(&String::from_utf8_lossy(&bytes));
        fs::write(&path, redacted.as_bytes()).await?;
        set_private_file_permissions(&path).await?;
    }
    Ok(())
}

fn redact_corrupt_config(value: &str) -> String {
    crate::app_log::redact_text(value)
}

#[cfg(windows)]
async fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(
            existing_file_name: *const u16,
            new_file_name: *const u16,
            flags: u32,
        ) -> i32;
    }

    let source_wide = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination_wide = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(not(windows))]
async fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)
        .await
        .context("atomic rename")
}

#[cfg(unix)]
async fn set_private_file_permissions(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .await
        .with_context(|| format!("set private permissions on {}", path.display()))
}

#[cfg(not(unix))]
async fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
async fn sync_parent_directory(path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let directory = fs::File::open(parent)
        .await
        .with_context(|| format!("open config directory {}", parent.display()))?;
    directory.sync_all().await.context("sync config directory")
}

#[cfg(not(unix))]
async fn sync_parent_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn hydrate_from_env(config: &mut AppConfig) {
    if config
        .openai_api_key
        .as_ref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        if let Ok(value) = env::var("OPENAI_API_KEY") {
            if !value.trim().is_empty() {
                config.openai_api_key = Some(value);
            }
        }
    }

    if config
        .google_api_key
        .as_ref()
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
    {
        if let Ok(value) = env::var("GOOGLE_API_KEY") {
            if !value.trim().is_empty() {
                config.google_api_key = Some(value);
            }
        }
    }
}

fn merge_values(target: &mut Value, patch: Value) {
    match patch {
        Value::Object(patch_map) => {
            if !target.is_object() {
                *target = Value::Object(Map::new());
            }
            if let Value::Object(target_map) = target {
                for (key, value) in patch_map {
                    merge_values(target_map.entry(key).or_insert(Value::Null), value);
                }
            }
        }
        other => {
            *target = other;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_config_never_contains_legacy_provider_secrets() {
        let config = AppConfig {
            openai_api_key: Some("openai-secret".to_string()),
            google_api_key: Some("google-secret".to_string()),
            ..AppConfig::default()
        };
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("openai-secret"));
        assert!(!serialized.contains("google-secret"));
        assert!(!serialized.contains("openaiApiKey"));
        assert!(!serialized.contains("googleApiKey"));
    }

    #[test]
    fn partial_updates_preserve_unrelated_values() {
        let mut target = serde_json::json!({"windowWidth": 420, "nested": {"a": 1, "b": 2}});
        merge_values(&mut target, serde_json::json!({"nested": {"a": 3}}));
        assert_eq!(target["windowWidth"], 420);
        assert_eq!(target["nested"]["a"], 3);
        assert_eq!(target["nested"]["b"], 2);
    }

    #[test]
    fn fresh_install_defaults_to_normal_window_mode() {
        let config = AppConfig::default();
        assert!(!config.hide_app);
        assert_eq!(config.config_version, 1);
    }

    #[test]
    fn migrates_incomplete_v3_first_run_out_of_hidden_mode() {
        let mut config: AppConfig = serde_json::from_value(serde_json::json!({
            "configVersion": 0,
            "hideApp": true,
            "welcomeModalDismissed": false
        }))
        .unwrap();
        config.normalize();
        assert!(!config.hide_app);
        assert_eq!(config.config_version, 1);
    }

    #[test]
    fn preserves_existing_hidden_mode_after_onboarding() {
        let mut config: AppConfig = serde_json::from_value(serde_json::json!({
            "configVersion": 0,
            "hideApp": true,
            "welcomeModalDismissed": true
        }))
        .unwrap();
        config.normalize();
        assert!(config.hide_app);
        assert_eq!(config.config_version, 1);
    }

    #[test]
    fn corrupt_config_diagnostic_copy_redacts_legacy_keys() {
        let corrupt =
            r#"{"openaiApiKey":"sk-openai-secret","google_api_key":"google-secret", BROKEN"#;
        let redacted = redact_corrupt_config(corrupt);
        assert!(!redacted.contains("sk-openai-secret"));
        assert!(!redacted.contains("google-secret"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[tokio::test]
    async fn initialization_sanitizer_rewrites_existing_corrupt_artifacts() {
        let directory = std::env::temp_dir().join(format!(
            "xexamai-config-sanitize-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&directory).await.unwrap();
        let artifact = directory.join("config.json.corrupt-1700000000000");
        fs::write(&artifact, br#"{"openaiApiKey":"sk-legacy-secret", BROKEN"#)
            .await
            .unwrap();

        sanitize_existing_corrupt_artifacts(&directory)
            .await
            .unwrap();

        let contents = fs::read_to_string(&artifact).await.unwrap();
        assert!(!contents.contains("sk-legacy-secret"));
        assert!(contents.contains("[REDACTED]"));
        fs::remove_dir_all(&directory).await.unwrap();
    }
}
