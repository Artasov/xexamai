use crate::activity::ActivityGate;
use crate::config::ConfigState;
use crate::local_speech::FastWhisperManager;
use crate::secret_store::{ProviderSecret, SecretStore};
use crate::types::AppConfig;
use anyhow::{anyhow, Result};
use base64::Engine as _;
use chrono::Local;
use futures_util::StreamExt;
use reqwest::{multipart, redirect::Policy};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::fs;
use tokio::sync::{watch, Mutex};

const MAX_AUDIO_BYTES: usize = 64 * 1024 * 1024;
const MAX_TRANSCRIPTION_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ACTIVE_TRANSCRIPTIONS: usize = 16;

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct TranscriptionRequest {
    #[serde(default)]
    pub request_id: Option<String>,
    pub mode: String, // "api", "local", "google"
    #[serde(default)]
    pub model: Option<String>,
    pub audio_data: Vec<u8>,
    pub mime_type: String,
    pub filename: String,
    #[serde(default)]
    pub prompt: Option<String>,
}

#[derive(Default)]
pub struct TranscriptionCancellationState {
    next_generation: AtomicU64,
    active: Mutex<HashMap<String, (u64, watch::Sender<bool>)>>,
}

impl TranscriptionCancellationState {
    async fn register(&self, request_id: &str) -> Result<(u64, watch::Receiver<bool>), String> {
        validate_request_id(request_id)?;
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = watch::channel(false);
        let mut active = self.active.lock().await;
        if active.len() >= MAX_ACTIVE_TRANSCRIPTIONS && !active.contains_key(request_id) {
            return Err("Too many transcriptions are active".to_string());
        }
        if let Some((_, previous)) = active.insert(request_id.to_string(), (generation, sender)) {
            let _ = previous.send(true);
        }
        Ok((generation, receiver))
    }

    async fn finish(&self, request_id: &str, generation: u64) {
        let mut active = self.active.lock().await;
        if active
            .get(request_id)
            .is_some_and(|(value, _)| *value == generation)
        {
            active.remove(request_id);
        }
    }

    async fn cancel(&self, request_id: &str) -> Result<(), String> {
        validate_request_id(request_id)?;
        if let Some((_, sender)) = self.active.lock().await.remove(request_id) {
            let _ = sender.send(true);
        }
        Ok(())
    }
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct TranscriptionResponse {
    pub text: String,
}

async fn save_audio_debug(
    app: &AppHandle,
    audio_data: &[u8],
    mode: &str,
    filename: &str,
    save_files: bool,
) {
    if !save_files {
        return;
    }

    if let Ok(mut debug_dir) = app.path().app_local_data_dir() {
        debug_dir.push("transcription_debug");
        if fs::create_dir_all(&debug_dir).await.is_err() {
            return;
        }

        let timestamp = Local::now().format("%Y%m%d_%H%M%S_%3f");
        let debug_filename = format!("{}_{}_{}", timestamp, mode, filename);
        let debug_path = debug_dir.join(&debug_filename);

        if let Err(e) = fs::write(&debug_path, audio_data).await {
            eprintln!("[transcription] Failed to save diagnostic audio: {e}");
        } else {
            let path_str = debug_path.to_string_lossy().to_string();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ =
                    fs::set_permissions(&debug_path, std::fs::Permissions::from_mode(0o600)).await;
            }
            eprintln!(
                "[transcription] Saved diagnostic audio ({} bytes)",
                audio_data.len()
            );
            let _ = app.emit_to(
                "main",
                "transcription:debug:saved",
                serde_json::json!({
                    "path": path_str,
                    "size": audio_data.len(),
                    "mode": mode,
                    "filename": filename
                }),
            );
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn transcribe_audio(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
    cancellations: State<'_, Arc<TranscriptionCancellationState>>,
    activity: State<'_, Arc<ActivityGate>>,
    request: TranscriptionRequest,
) -> Result<TranscriptionResponse, String> {
    if window.label() != "main" {
        return Err("Command is not available to this window".to_string());
    }
    let _activity = activity.try_begin_work()?;
    validate_transcription_request(&request)?;
    let request_id = request.request_id.clone();
    let operation = async move {
        let config = state.get().await;
        save_audio_debug(
            &app,
            &request.audio_data,
            &request.mode,
            &request.filename,
            config.save_recorder_files,
        )
        .await;

        match request.mode.as_str() {
            "api" => {
                let key = required_provider_key(secrets.inner(), ProviderSecret::OpenAi).await?;
                transcribe_openai(request, key)
                    .await
                    .map_err(|e| e.to_string())
            }
            "local" => transcribe_local(request, &config)
                .await
                .map_err(|e| e.to_string()),
            "google" => {
                let key = required_provider_key(secrets.inner(), ProviderSecret::Google).await?;
                transcribe_google(request, key)
                    .await
                    .map_err(|e| e.to_string())
            }
            _ => Err(format!("Unknown transcription mode: {}", request.mode)),
        }
    };

    let Some(request_id) = request_id else {
        return operation.await;
    };
    let (generation, mut receiver) = cancellations.register(&request_id).await?;
    let result = tokio::select! {
        result = operation => result,
        _ = wait_for_cancel(&mut receiver) => Err("Transcription was cancelled".to_string()),
    };
    cancellations.finish(&request_id, generation).await;
    result
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_transcription(
    window: WebviewWindow,
    cancellations: State<'_, Arc<TranscriptionCancellationState>>,
    request_id: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Command is not available to this window".to_string());
    }
    cancellations.cancel(&request_id).await
}

fn validate_request_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid transcription request id".to_string());
    }
    Ok(())
}

fn validate_transcription_request(request: &TranscriptionRequest) -> Result<(), String> {
    if !matches!(request.mode.as_str(), "api" | "local" | "google") {
        return Err("Unsupported transcription mode".to_string());
    }
    if request.audio_data.is_empty() || request.audio_data.len() > MAX_AUDIO_BYTES {
        return Err("Invalid transcription audio size".to_string());
    }
    if request.filename.is_empty()
        || request.filename.len() > 128
        || request.filename.contains("..")
        || !request
            .filename
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("Invalid transcription filename".to_string());
    }
    if request.mime_type.len() > 128
        || !request
            .mime_type
            .get(..6)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("audio/"))
        || !request
            .mime_type
            .bytes()
            .all(|byte| byte.is_ascii_graphic() || byte == b' ')
    {
        return Err("Invalid transcription MIME type".to_string());
    }
    if let Some(model) = request.model.as_deref() {
        if model.is_empty()
            || model.len() > 128
            || !model
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err("Invalid transcription model".to_string());
        }
    }
    if request
        .prompt
        .as_ref()
        .is_some_and(|prompt| prompt.len() > 16 * 1024)
    {
        return Err("Transcription prompt is too large".to_string());
    }
    Ok(())
}

async fn wait_for_cancel(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

async fn required_provider_key(
    secrets: &SecretStore,
    provider: ProviderSecret,
) -> Result<String, String> {
    secrets
        .get_provider_secret(provider)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Provider API key is not configured".to_string())
}

async fn transcribe_openai(
    request: TranscriptionRequest,
    api_key: String,
) -> Result<TranscriptionResponse> {
    let model = request.model.unwrap_or_else(|| "whisper-1".to_string());

    let url = "https://api.openai.com/v1/audio/transcriptions";

    let form = if let Some(prompt) = request.prompt {
        multipart::Form::new()
            .text("model", model)
            .text("prompt", prompt)
            .part(
                "file",
                multipart::Part::bytes(request.audio_data)
                    .file_name(request.filename)
                    .mime_str(&request.mime_type)?,
            )
    } else {
        multipart::Form::new().text("model", model).part(
            "file",
            multipart::Part::bytes(request.audio_data)
                .file_name(request.filename)
                .mime_str(&request.mime_type)?,
        )
    };

    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(300))
        .build()?;

    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .multipart(form)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("OpenAI API error (HTTP {})", status.as_u16()));
    }

    let data: serde_json::Value = serde_json::from_slice(
        &collect_response_bounded(response, MAX_TRANSCRIPTION_RESPONSE_BYTES).await?,
    )?;
    let text = data
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("No text field in response"))?
        .to_string();

    Ok(TranscriptionResponse { text })
}

fn normalize_local_device(configured: &str) -> &'static str {
    match configured.trim().to_ascii_lowercase().as_str() {
        "cpu" => "cpu",
        "cuda" | "gpu" => "cuda",
        // fast-fast-whisper currently supports cpu/cuda/auto. Metal is not a
        // valid server value, so use its portable device detection instead.
        _ => "auto",
    }
}

async fn transcribe_local(
    request: TranscriptionRequest,
    config: &AppConfig,
) -> Result<TranscriptionResponse> {
    let model = request.model.unwrap_or_else(|| "large-v3".to_string());
    let url = format!("{}/v1/audio/transcriptions", FastWhisperManager::base_url());
    let device = normalize_local_device(&config.local_device);

    let form = multipart::Form::new()
        .text("model", model)
        .text("device", device)
        .part(
            "file",
            multipart::Part::bytes(request.audio_data)
                .file_name(request.filename)
                .mime_str(&request.mime_type)?,
        );

    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(300))
        .build()?;

    let response = client.post(&url).multipart(form).send().await?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!(
            "Local transcription error (HTTP {})",
            status.as_u16()
        ));
    }

    let data: serde_json::Value = serde_json::from_slice(
        &collect_response_bounded(response, MAX_TRANSCRIPTION_RESPONSE_BYTES).await?,
    )?;
    let text = data
        .get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("No text field in response"))?
        .to_string();

    // Filter out prompt text if present
    let filtered_text = if text.to_lowercase().contains("transcribe verbatim") {
        return Err(anyhow!("Received prompt text instead of transcription"));
    } else {
        text
    };

    Ok(TranscriptionResponse {
        text: filtered_text,
    })
}

async fn transcribe_google(
    request: TranscriptionRequest,
    api_key: String,
) -> Result<TranscriptionResponse> {
    let model = request
        .model
        .unwrap_or_else(|| "gemini-3.7-flash".to_string());

    // Google Gemini transcription
    if model.is_empty()
        || model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(anyhow!("Invalid Google model"));
    }
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent",
        model
    );

    let audio_data_base64 = base64::engine::general_purpose::STANDARD.encode(&request.audio_data);

    let body = serde_json::json!({
        "contents": [{
            "parts": [{
                "inline_data": {
                    "mime_type": request.mime_type,
                    "data": audio_data_base64
                }
            }]
        }],
        "systemInstruction": {
            "parts": [{
                "text": request.prompt.unwrap_or_else(|| "Transcribe verbatim in the original spoken language. Do not translate, summarise, or answer questions.".to_string())
            }]
        }
    });

    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(300))
        .build()?;

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        return Err(anyhow!("Google API error (HTTP {})", status.as_u16()));
    }

    let data: serde_json::Value = serde_json::from_slice(
        &collect_response_bounded(response, MAX_TRANSCRIPTION_RESPONSE_BYTES).await?,
    )?;

    // Extract text from Google response
    let text = data
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.first())
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.first())
        .and_then(|p| p.get("text"))
        .and_then(|t| t.as_str())
        .ok_or_else(|| anyhow!("No text in Google response"))?
        .to_string();

    // Filter out prompt text
    let filtered_text = if text.to_lowercase().contains("transcribe verbatim") {
        return Err(anyhow!("Received prompt text instead of transcription"));
    } else {
        text
    };

    Ok(TranscriptionResponse {
        text: filtered_text,
    })
}

async fn collect_response_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if output.len().saturating_add(chunk.len()) > limit {
            return Err(anyhow!("Transcription response is too large"));
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::{normalize_local_device, validate_transcription_request, TranscriptionRequest};

    #[test]
    fn normalizes_devices_to_fast_whisper_contract() {
        assert_eq!(normalize_local_device("cpu"), "cpu");
        assert_eq!(normalize_local_device("gpu"), "cuda");
        assert_eq!(normalize_local_device("CUDA"), "cuda");
        assert_eq!(normalize_local_device("metal"), "auto");
        assert_eq!(normalize_local_device("unknown"), "auto");
    }

    #[test]
    fn rejects_path_traversal_and_unbounded_transcription_inputs() {
        let valid = || TranscriptionRequest {
            request_id: Some("request-1".to_string()),
            mode: "api".to_string(),
            model: Some("gpt-4o-mini-transcribe".to_string()),
            audio_data: vec![0; 1_024],
            mime_type: "audio/webm;codecs=opus".to_string(),
            filename: "audio.webm".to_string(),
            prompt: None,
        };
        assert!(validate_transcription_request(&valid()).is_ok());

        let mut traversal = valid();
        traversal.filename = "../config.json".to_string();
        assert!(validate_transcription_request(&traversal).is_err());

        let mut invalid_mime = valid();
        invalid_mime.mime_type = "audio/wav\r\nx-api-key: stolen".to_string();
        assert!(validate_transcription_request(&invalid_mime).is_err());

        let mut oversized_prompt = valid();
        oversized_prompt.prompt = Some("x".repeat(16 * 1024 + 1));
        assert!(validate_transcription_request(&oversized_prompt).is_err());
    }
}
