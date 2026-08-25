use anyhow::{anyhow, Result};
use base64::Engine as _;
use futures_util::StreamExt;
use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::State;
use tokio::process::Command;
use tokio::sync::{watch, Mutex};
use tokio::time::{timeout, Instant};

use crate::activity::ActivityGate;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const LIST_JSON_FLAG: &str = "--json";
const OLLAMA_CHAT_URL: &str = "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_CANCELLATION_TOMBSTONE_TTL: Duration = Duration::from_secs(30);
const MAX_OLLAMA_CANCELLATION_TOMBSTONES: usize = 128;

#[derive(Default)]
struct OllamaStreamRequests {
    active: HashMap<String, (u64, watch::Sender<bool>)>,
    cancelled_before_start: HashMap<String, Instant>,
}

#[derive(Default)]
struct OllamaStreamCancellationState {
    next_generation: AtomicU64,
    requests: Mutex<OllamaStreamRequests>,
}

impl OllamaStreamCancellationState {
    async fn register(&self, request_id: &str) -> Result<(u64, watch::Receiver<bool>), String> {
        let mut requests = self.requests.lock().await;
        Self::prune_tombstones(&mut requests);
        if requests.cancelled_before_start.contains_key(request_id) {
            return Err("Ollama request was cancelled before it started".to_string());
        }
        if let Some((_, previous)) = requests.active.remove(request_id) {
            let _ = previous.send(true);
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = watch::channel(false);
        requests
            .active
            .insert(request_id.to_string(), (generation, sender));
        Ok((generation, receiver))
    }

    async fn finish(&self, request_id: &str, generation: u64) {
        let mut requests = self.requests.lock().await;
        if requests
            .active
            .get(request_id)
            .is_some_and(|(current, _)| *current == generation)
        {
            requests.active.remove(request_id);
        }
    }

    async fn cancel(&self, request_id: &str) {
        let mut requests = self.requests.lock().await;
        Self::prune_tombstones(&mut requests);
        if let Some((_, sender)) = requests.active.remove(request_id) {
            let _ = sender.send(true);
        }
        requests
            .cancelled_before_start
            .insert(request_id.to_string(), Instant::now());
        Self::enforce_tombstone_limit(&mut requests);
    }

    fn prune_tombstones(requests: &mut OllamaStreamRequests) {
        let now = Instant::now();
        requests
            .cancelled_before_start
            .retain(|_, created| now.duration_since(*created) < OLLAMA_CANCELLATION_TOMBSTONE_TTL);
    }

    fn enforce_tombstone_limit(requests: &mut OllamaStreamRequests) {
        while requests.cancelled_before_start.len() > MAX_OLLAMA_CANCELLATION_TOMBSTONES {
            let Some(oldest) = requests
                .cancelled_before_start
                .iter()
                .min_by_key(|(_, created)| **created)
                .map(|(request_id, _)| request_id.clone())
            else {
                break;
            };
            requests.cancelled_before_start.remove(&oldest);
        }
    }
}

static STREAM_CANCELLATIONS: Lazy<OllamaStreamCancellationState> =
    Lazy::new(OllamaStreamCancellationState::default);

#[derive(Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum OllamaStreamEvent {
    Chunk { data_base64: String },
    Done,
}

#[tauri::command]
#[specta::specta]
pub async fn ollama_cancel_chat(request_id: String) -> Result<(), String> {
    if request_id.trim().is_empty() {
        return Err("Request ID is required.".into());
    }
    STREAM_CANCELLATIONS.cancel(&request_id).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ollama_stream_chat(
    request_id: String,
    body: String,
    connect_timeout_ms: Option<u64>,
    idle_timeout_ms: Option<u64>,
    total_timeout_ms: Option<u64>,
    on_event: Channel<OllamaStreamEvent>,
    activity: State<'_, Arc<ActivityGate>>,
) -> Result<(), String> {
    let _activity = activity.try_begin_work()?;
    if request_id.trim().is_empty() {
        return Err("Request ID is required.".into());
    }
    let mut value: serde_json::Value =
        serde_json::from_str(&body).map_err(|error| format!("Invalid Ollama request: {error}"))?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| "Ollama request body must be an object.".to_string())?;
    object.insert("stream".into(), serde_json::Value::Bool(true));

    let connect_timeout =
        Duration::from_millis(connect_timeout_ms.unwrap_or(10_000).clamp(1_000, 60_000));
    let idle_timeout =
        Duration::from_millis(idle_timeout_ms.unwrap_or(45_000).clamp(5_000, 300_000));
    let total_timeout =
        Duration::from_millis(total_timeout_ms.unwrap_or(600_000).clamp(10_000, 3_600_000));
    let client = reqwest::Client::builder()
        .connect_timeout(connect_timeout)
        .build()
        .map_err(|error| error.to_string())?;

    let (generation, mut cancel_rx) = STREAM_CANCELLATIONS.register(&request_id).await?;

    let result = async {
        let response = tokio::select! {
            result = timeout(connect_timeout, client.post(OLLAMA_CHAT_URL).json(&value).send()) => {
                result.map_err(|_| "Ollama connection timed out.".to_string())?
                    .map_err(|error| error.to_string())?
            }
            _ = cancel_rx.changed() => return Err("Operation cancelled.".to_string()),
        };

        let status = response.status();
        if !status.is_success() {
            let message = response.text().await.unwrap_or_default();
            return Err(format!("Ollama HTTP {}: {}", status.as_u16(), message));
        }

        let deadline = Instant::now() + total_timeout;
        let mut stream = response.bytes_stream();
        loop {
            if Instant::now() >= deadline {
                return Err("Ollama generation exceeded its total timeout.".to_string());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            let next_timeout = idle_timeout.min(remaining);
            let next = tokio::select! {
                result = timeout(next_timeout, stream.next()) => {
                    result.map_err(|_| "Ollama stream became idle and was cancelled.".to_string())?
                }
                _ = cancel_rx.changed() => return Err("Operation cancelled.".to_string()),
            };
            match next {
                Some(Ok(bytes)) => {
                    if bytes.is_empty() {
                        continue;
                    }
                    on_event
                        .send(OllamaStreamEvent::Chunk {
                            data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
                        })
                        .map_err(|error| error.to_string())?;
                }
                Some(Err(error)) => return Err(error.to_string()),
                None => break,
            }
        }
        on_event
            .send(OllamaStreamEvent::Done)
            .map_err(|error| error.to_string())?;
        Ok(())
    }
    .await;

    STREAM_CANCELLATIONS.finish(&request_id, generation).await;
    result
}

fn normalize_model_name(model: &str) -> String {
    model.trim().to_lowercase()
}

async fn run_ollama_command(args: &[&str]) -> Result<std::process::Output> {
    let mut cmd = Command::new("ollama");
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await;

    match output {
        Ok(result) => Ok(result),
        Err(error) => {
            if error.kind() == io::ErrorKind::NotFound {
                Err(anyhow!(
                    "Ollama CLI is not installed or not available in PATH."
                ))
            } else {
                Err(anyhow!(error))
            }
        }
    }
}

pub async fn check_installed() -> Result<bool> {
    let mut cmd = Command::new("ollama");
    cmd.arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.status().await {
        Ok(status) => Ok(status.success()),
        Err(error) => {
            if error.kind() == io::ErrorKind::NotFound {
                Ok(false)
            } else {
                Err(anyhow!(error))
            }
        }
    }
}

pub async fn list_models() -> Result<Vec<String>> {
    let mut output = run_ollama_command(&["list", LIST_JSON_FLAG]).await?;

    if !output.status.success() {
        output = run_ollama_command(&["list"]).await?;
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("ollama list command failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_model_list(stdout.as_ref())
}

fn parse_model_list(output: &str) -> Result<Vec<String>> {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(output) {
        let mut models = Vec::new();
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                        models.push(normalize_model_name(name));
                    }
                }
            }
            serde_json::Value::Object(map) => {
                if let Some(serde_json::Value::Array(items)) = map.get("models") {
                    for item in items {
                        if let Some(name) = item.get("name").and_then(|v| v.as_str()) {
                            models.push(normalize_model_name(name));
                        }
                    }
                }
            }
            _ => {}
        }
        if !models.is_empty() {
            return Ok(models);
        }
    }

    let mut rows: Vec<&str> = output.lines().collect();
    if !rows.is_empty() && rows[0].to_ascii_lowercase().contains("name") {
        rows.remove(0);
    }

    let mut names = Vec::new();
    for line in rows {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with("NAME ") {
            continue;
        }
        if let Some(name) = trimmed.split_whitespace().next() {
            names.push(normalize_model_name(name));
        }
    }

    Ok(names)
}

pub async fn pull_model(model: &str) -> Result<()> {
    let normalized = model.trim();
    if normalized.is_empty() {
        return Err(anyhow!("Model name is required."));
    }
    let output = run_ollama_command(&["pull", normalized]).await?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(anyhow!(
            "Failed to download model {}: {}",
            model,
            stderr.trim()
        ))
    }
}

pub async fn warmup_model(model: &str) -> Result<()> {
    let normalized = model.trim();
    if normalized.is_empty() {
        return Err(anyhow!("Model name is required."));
    }
    let prompt = "Write only the numbers 1, 2, 3.";
    let output = run_ollama_command(&["run", normalized, prompt]).await?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(anyhow!(
            "Failed to warm up model {}: {}",
            model,
            stderr.trim()
        ))
    }
}

#[cfg(test)]
mod cancellation_tests {
    use super::*;

    #[tokio::test]
    async fn cancellation_before_registration_prevents_ollama_start() {
        let state = OllamaStreamCancellationState::default();
        state.cancel("cancel-before-start").await;

        let error = state.register("cancel-before-start").await.unwrap_err();

        assert!(error.contains("cancelled before it started"));
        assert!(state.register("cancel-before-start").await.is_err());
    }

    #[tokio::test]
    async fn cancelling_active_ollama_generation_blocks_late_duplicate() {
        let state = OllamaStreamCancellationState::default();
        let (_, mut cancellation) = state.register("active-then-cancelled").await.unwrap();

        state.cancel("active-then-cancelled").await;

        assert!(*cancellation.borrow_and_update());
        assert!(state.register("active-then-cancelled").await.is_err());
        assert!(state.register("active-then-cancelled").await.is_err());
    }

    #[tokio::test]
    async fn old_ollama_generation_cannot_remove_new_registration() {
        let state = OllamaStreamCancellationState::default();
        let (old_generation, mut old_cancellation) = state.register("reused-id").await.unwrap();
        let (new_generation, _) = state.register("reused-id").await.unwrap();

        assert!(*old_cancellation.borrow_and_update());
        state.finish("reused-id", old_generation).await;

        let requests = state.requests.lock().await;
        assert_eq!(
            requests
                .active
                .get("reused-id")
                .map(|(generation, _)| *generation),
            Some(new_generation),
        );
    }

    #[tokio::test]
    async fn oldest_ollama_tombstone_survives_at_exact_capacity() {
        let state = OllamaStreamCancellationState::default();
        for index in 0..MAX_OLLAMA_CANCELLATION_TOMBSTONES {
            state.cancel(&format!("cancel-{index}")).await;
        }

        assert!(state.register("cancel-0").await.is_err());
    }
}
