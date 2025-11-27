use anyhow::{anyhow, Result};
use base64::Engine as _;
use reqwest::multipart;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::fs;
use chrono::Local;
use std::sync::Arc;
use crate::config::ConfigState;

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptionRequest {
    pub mode: String, // "api", "local", "google"
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub audio_data: Vec<u8>,
    pub mime_type: String,
    pub filename: String,
    pub prompt: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TranscriptionResponse {
    pub text: String,
}

async fn save_audio_debug(app: &AppHandle, audio_data: &[u8], mode: &str, filename: &str, save_files: bool) {
    if !save_files {
        return;
    }
    
    if let Ok(mut debug_dir) = app.path().app_local_data_dir() {
        debug_dir.push("transcription_debug");
        if let Err(_) = fs::create_dir_all(&debug_dir).await {
            return;
        }
        
        let timestamp = Local::now().format("%Y%m%d_%H%M%S_%3f");
        let debug_filename = format!("{}_{}_{}", timestamp, mode, filename);
        let debug_path = debug_dir.join(&debug_filename);
        
        if let Err(e) = fs::write(&debug_path, audio_data).await {
            eprintln!("[transcription] Failed to save audio file: {}", e);
        } else {
            let path_str = debug_path.to_string_lossy().to_string();
            eprintln!("[transcription] Saved audio file: {} ({} bytes)", 
                debug_path.display(), audio_data.len());
            // Emit to frontend DevTools
            let _ = app.emit("transcription:debug:saved", serde_json::json!({
                "path": path_str,
                "size": audio_data.len(),
                "mode": mode,
                "filename": filename
            }));
        }
    }
}

#[tauri::command]
pub async fn transcribe_audio(
    app: AppHandle,
    state: State<'_, Arc<ConfigState>>,
    request: TranscriptionRequest
) -> Result<TranscriptionResponse, String> {
    // Check if we should save audio files
    let config = state.get().await;
    let save_files = config.save_recorder_files;
    
    // Save audio file if enabled
    save_audio_debug(&app, &request.audio_data, &request.mode, &request.filename, save_files).await;
    
    match request.mode.as_str() {
        "api" => transcribe_openai(request).await.map_err(|e| e.to_string()),
        "local" => transcribe_local(request).await.map_err(|e| e.to_string()),
        "google" => transcribe_google(request).await.map_err(|e| e.to_string()),
        _ => Err(format!("Unknown transcription mode: {}", request.mode)),
    }
}

async fn transcribe_openai(request: TranscriptionRequest) -> Result<TranscriptionResponse> {
    let api_key = request.api_key.ok_or_else(|| anyhow!("OpenAI API key is required"))?;
    let model = request.model.unwrap_or_else(|| "whisper-1".to_string());
    
    let url = "https://api.openai.com/v1/audio/transcriptions";
    
    let form = if let Some(prompt) = request.prompt {
        multipart::Form::new()
            .text("model", model)
            .text("prompt", prompt)
            .part("file", multipart::Part::bytes(request.audio_data)
                .file_name(request.filename)
                .mime_str(&request.mime_type)?)
    } else {
        multipart::Form::new()
            .text("model", model)
            .part("file", multipart::Part::bytes(request.audio_data)
                .file_name(request.filename)
                .mime_str(&request.mime_type)?)
    };
    
    let client = reqwest::Client::builder()
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
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(anyhow!("OpenAI API error: {} - {}", status, error_text));
    }
    
    let data: serde_json::Value = response.json().await?;
    let text = data.get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("No text field in response"))?
        .to_string();
    
    Ok(TranscriptionResponse { text })
}

async fn transcribe_local(request: TranscriptionRequest) -> Result<TranscriptionResponse> {
    let model = request.model.unwrap_or_else(|| "large-v3".to_string());
    let url = format!("http://127.0.0.1:8868/v1/audio/transcriptions");
    
    let form = multipart::Form::new()
        .text("model", model)
        .part("file", multipart::Part::bytes(request.audio_data)
            .file_name(request.filename)
            .mime_str(&request.mime_type)?);
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    
    let response = client
        .post(&url)
        .multipart(form)
        .send()
        .await?;
    
    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(anyhow!("Local transcription error: {} - {}", status, error_text));
    }
    
    let data: serde_json::Value = response.json().await?;
    let text = data.get("text")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("No text field in response"))?
        .to_string();
    
    // Filter out prompt text if present
    let filtered_text = if text.to_lowercase().contains("transcribe verbatim") {
        return Err(anyhow!("Received prompt text instead of transcription"));
    } else {
        text
    };
    
    Ok(TranscriptionResponse { text: filtered_text })
}

async fn transcribe_google(request: TranscriptionRequest) -> Result<TranscriptionResponse> {
    let api_key = request.api_key.ok_or_else(|| anyhow!("Google API key is required"))?;
    let model = request.model.unwrap_or_else(|| "gemini-2.0-flash-exp".to_string());
    
    // Google Gemini transcription
    let url = format!("https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}", model, api_key);
    
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
        },
        "generationConfig": {
            "temperature": 0.0
        }
    });
    
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    
    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await?;
    
    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_else(|_| "Unknown error".to_string());
        return Err(anyhow!("Google API error: {} - {}", status, error_text));
    }
    
    let data: serde_json::Value = response.json().await?;
    
    // Extract text from Google response
    let text = data
        .get("candidates")
        .and_then(|c| c.as_array())
        .and_then(|arr| arr.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .and_then(|arr| arr.get(0))
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
    
    Ok(TranscriptionResponse { text: filtered_text })
}

