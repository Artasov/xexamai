use std::env;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::{Map, Value};
use tauri::{AppHandle, Manager};
use tokio::fs;
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
        let mut path = base_dir.clone();
        path.push(CONFIG_FILE_NAME);

        let config = if Path::new(&path).exists() {
            let bytes = fs::read(&path).await?;
            let contents = String::from_utf8(bytes)
                .map_err(|error| anyhow!("Invalid UTF-8 in config: {error}"))?;
            let mut config: AppConfig = serde_json::from_str(&contents).unwrap_or_default();
            hydrate_from_env(&mut config);
            config.normalize();
            config
        } else {
            let mut config = AppConfig::default();
            hydrate_from_env(&mut config);
            config.normalize();
            let serialized = serde_json::to_string_pretty(&config)?;
            fs::write(&path, serialized).await?;
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

    async fn persist(&self, state: &AppConfig) -> Result<()> {
        let serialized = serde_json::to_string_pretty(state).context("serialize config")?;
        fs::write(&self.path, serialized).await.context("write config")
    }
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
