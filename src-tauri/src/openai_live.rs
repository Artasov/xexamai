use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION as WS_AUTHORIZATION;
use tokio_tungstenite::tungstenite::{Error as WebSocketError, Message};
use uuid::Uuid;

use crate::activity::ActivityGate;
use crate::secret_store::{ProviderSecret, SecretStore};
use crate::types::normalize_translation_language;

pub const OPENAI_LIVE_TRANSCRIBE_MODEL: &str = "gpt-live-transcribe";
pub const OPENAI_REALTIME_TRANSLATE_MODEL: &str = "gpt-realtime-translate";
const OPENAI_CLIENT_SECRETS_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";
const OPENAI_TRANSLATION_WEBSOCKET_URL: &str =
    "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
const OPENAI_TRANSLATION_MESSAGE_EVENT: &str = "openai-translation-message";
const MAX_TRANSLATION_AUDIO_BASE64_BYTES: usize = 1_500_000;

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiLiveCapability {
    supported: bool,
    configured: bool,
    model: &'static str,
    reason: Option<&'static str>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiLiveToken {
    token: String,
    model: &'static str,
}

#[derive(Debug, Deserialize)]
struct OpenAiClientSecretResponse {
    value: String,
}

#[derive(Default)]
pub struct OpenAiTranslationState {
    active: Mutex<Option<OpenAiTranslationSession>>,
    generation: AtomicU64,
}

struct OpenAiTranslationSession {
    id: Uuid,
    commands: mpsc::Sender<OpenAiTranslationCommand>,
}

enum OpenAiTranslationCommand {
    Audio(String),
    Close(oneshot::Sender<()>),
}

#[tauri::command]
#[specta::specta]
pub async fn openai_live_capability(
    secrets: State<'_, Arc<SecretStore>>,
) -> Result<OpenAiLiveCapability, String> {
    let configured = secrets.has_provider_secret(ProviderSecret::OpenAi).await;
    Ok(OpenAiLiveCapability {
        supported: true,
        configured,
        model: OPENAI_LIVE_TRANSCRIBE_MODEL,
        reason: (!configured).then_some("Add an OpenAI API key in AI settings."),
    })
}

/// Exchanges the long-lived OpenAI key held by the OS credential store for a
/// short-lived client secret bound to a transcription-only Realtime session.
/// The renderer never receives the provider API key.
#[tauri::command]
#[specta::specta]
pub async fn openai_live_create_token(
    activity: State<'_, Arc<ActivityGate>>,
    secrets: State<'_, Arc<SecretStore>>,
) -> Result<OpenAiLiveToken, String> {
    let _activity = activity.try_begin_work()?;
    let api_key = secrets
        .get_provider_secret(ProviderSecret::OpenAi)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenAI API key is not configured".to_string())?;

    let token = request_client_secret(
        &api_key,
        OPENAI_CLIENT_SECRETS_URL,
        &client_secret_request_body(),
        "transcription",
    )
    .await?;

    Ok(OpenAiLiveToken {
        token,
        model: OPENAI_LIVE_TRANSCRIBE_MODEL,
    })
}

/// Opens the dedicated translation WebSocket from the native process. Unlike
/// the browser WebSocket API, this transport can send the required Bearer
/// header while keeping the permanent provider key inside the OS keyring.
#[tauri::command]
#[specta::specta]
pub async fn openai_translation_start(
    app: AppHandle,
    activity: State<'_, Arc<ActivityGate>>,
    secrets: State<'_, Arc<SecretStore>>,
    state: State<'_, Arc<OpenAiTranslationState>>,
    target_language: String,
) -> Result<(), String> {
    let _activity = activity.try_begin_work()?;
    let target_language = normalize_translation_language(&target_language)
        .ok_or_else(|| "Unsupported realtime translation language".to_string())?;
    // Invalidate every older setup attempt before awaiting network I/O. This
    // lets Stop (or a newer Start) supersede a slow connection without making
    // the caller wait for all setup timeouts to expire.
    let generation = state
        .generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    stop_translation_session(&state).await;
    let api_key = secrets
        .get_provider_secret(ProviderSecret::OpenAi)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "OpenAI API key is not configured".to_string())?;

    let mut request = OPENAI_TRANSLATION_WEBSOCKET_URL
        .into_client_request()
        .map_err(|_| "Could not initialize OpenAI Realtime translation".to_string())?;
    request.headers_mut().insert(
        WS_AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
            .map_err(|_| "OpenAI API key has an invalid format".to_string())?,
    );
    drop(api_key);

    let connection = tokio::time::timeout(
        Duration::from_secs(15),
        tokio_tungstenite::connect_async(request),
    );
    tokio::pin!(connection);
    let connection = tokio::select! {
        result = &mut connection => result,
        _ = wait_for_translation_superseded(state.inner(), generation) => {
            return Err("OpenAI translation setup was superseded".to_string());
        }
    };
    let (mut socket, _) = connection
        .map_err(|_| "OpenAI Realtime translation connection timed out".to_string())?
        .map_err(translation_connect_error)?;

    ensure_translation_generation(&state, generation, &mut socket).await?;

    wait_for_current_translation_event(state.inner(), generation, &mut socket, "session.created")
        .await?;
    socket
        .send(Message::Text(
            translation_session_update(&target_language)
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| format!("Could not configure OpenAI translation: {error}"))?;
    wait_for_current_translation_event(state.inner(), generation, &mut socket, "session.updated")
        .await?;

    let id = Uuid::new_v4();
    let (commands, receiver) = mpsc::channel(32);
    {
        let mut active = state.active.lock().await;
        if state.generation.load(Ordering::Acquire) != generation {
            drop(active);
            let _ = socket.close(None).await;
            return Err("OpenAI translation setup was superseded".to_string());
        }
        *active = Some(OpenAiTranslationSession { id, commands });
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn(run_translation_session(app, state, id, socket, receiver));
    log::info!(
        "OpenAI Realtime translation connected: model={} target_language={}",
        OPENAI_REALTIME_TRANSLATE_MODEL,
        target_language
    );
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn openai_translation_send_audio(
    state: State<'_, Arc<OpenAiTranslationState>>,
    data: String,
) -> Result<(), String> {
    if data.is_empty() || data.len() > MAX_TRANSLATION_AUDIO_BASE64_BYTES {
        return Err("Invalid OpenAI translation audio chunk".to_string());
    }
    let commands = state
        .active
        .lock()
        .await
        .as_ref()
        .map(|session| session.commands.clone())
        .ok_or_else(|| "OpenAI translation is not connected".to_string())?;
    commands
        .send(OpenAiTranslationCommand::Audio(data))
        .await
        .map_err(|_| "OpenAI translation connection is closed".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn openai_translation_stop(
    state: State<'_, Arc<OpenAiTranslationState>>,
) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::AcqRel);
    stop_translation_session(&state).await;
    Ok(())
}

async fn ensure_translation_generation<S>(
    state: &OpenAiTranslationState,
    expected: u64,
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    if state.generation.load(Ordering::Acquire) == expected {
        return Ok(());
    }
    let _ = socket.close(None).await;
    Err("OpenAI translation setup was superseded".to_string())
}

async fn wait_for_translation_superseded(state: &OpenAiTranslationState, expected: u64) {
    loop {
        if state.generation.load(Ordering::Acquire) != expected {
            return;
        }
        // Setup is short-lived and happens only when recording starts or the
        // translation language changes. A small bounded poll keeps Stop and a
        // replacement Start responsive without maintaining another task or
        // risking a lost notification between an atomic check and registration.
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn wait_for_current_translation_event<S>(
    state: &OpenAiTranslationState,
    expected_generation: u64,
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_type: &str,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // Keep the event wait and supersession wait in one select so a stopped
    // setup does not hold the renderer lifecycle queue for the full provider
    // timeout. The inner scope releases the mutable socket borrow before the
    // generation helper closes it.
    let event_result = {
        let event = wait_for_translation_event(socket, expected_type);
        tokio::pin!(event);
        tokio::select! {
            result = &mut event => Some(result),
            _ = wait_for_translation_superseded(state, expected_generation) => None,
        }
    };
    if let Some(result) = event_result {
        result?;
    }
    ensure_translation_generation(state, expected_generation, socket).await
}

async fn stop_translation_session(state: &OpenAiTranslationState) {
    let session = state.active.lock().await.take();
    let Some(session) = session else { return };
    let (finished_tx, finished_rx) = oneshot::channel();
    if session
        .commands
        .send(OpenAiTranslationCommand::Close(finished_tx))
        .await
        .is_ok()
    {
        // The worker itself bounds final-event draining to three seconds. Give
        // it a small cleanup margin so a replacement session cannot overlap
        // with late events from the previous socket.
        let _ = tokio::time::timeout(Duration::from_secs(4), finished_rx).await;
    }
}

async fn wait_for_translation_event<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    expected_type: &str,
) -> Result<(), String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let frame = socket
                .next()
                .await
                .ok_or_else(|| "OpenAI closed the translation connection during setup".to_string())?
                .map_err(|error| format!("OpenAI translation setup failed: {error}"))?;
            let Some(event) = decode_translation_frame(frame)? else {
                continue;
            };
            if let Some(message) = translation_server_error(&event) {
                return Err(format!(
                    "OpenAI rejected the translation session: {message}"
                ));
            }
            if event.get("type").and_then(Value::as_str) == Some(expected_type) {
                return Ok(());
            }
        }
    })
    .await
    .map_err(|_| format!("OpenAI did not confirm {expected_type}"))?
}

async fn run_translation_session<S>(
    app: AppHandle,
    state: Arc<OpenAiTranslationState>,
    id: Uuid,
    mut socket: tokio_tungstenite::WebSocketStream<S>,
    mut commands: mpsc::Receiver<OpenAiTranslationCommand>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let mut close_waiter: Option<oneshot::Sender<()>> = None;
    loop {
        tokio::select! {
            command = commands.recv() => {
                match command {
                    Some(OpenAiTranslationCommand::Audio(audio)) => {
                        let payload = json!({
                            "type": "session.input_audio_buffer.append",
                            "audio": audio,
                        });
                        if let Err(error) = socket.send(Message::Text(payload.to_string().into())).await {
                            emit_translation_error(&app, format!("OpenAI translation audio send failed: {error}"));
                            break;
                        }
                    }
                    Some(OpenAiTranslationCommand::Close(waiter)) => {
                        close_waiter = Some(waiter);
                        if socket
                            .send(Message::Text(json!({"type": "session.close"}).to_string().into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        // Once close is requested there can be no more audio.
                        // Drain the provider's final transcript, but keep the
                        // native task bounded if the server never acknowledges
                        // session.close.
                        drain_translation_close(&app, &mut socket).await;
                        break;
                    }
                    None => break,
                }
            }
            frame = socket.next() => {
                let frame = match frame {
                    Some(Ok(frame)) => frame,
                    Some(Err(error)) => {
                        emit_translation_error(&app, format!("OpenAI translation connection failed: {error}"));
                        break;
                    }
                    None => {
                        emit_translation_error(
                            &app,
                            "OpenAI translation connection closed unexpectedly".to_string(),
                        );
                        break;
                    }
                };
                let event = match decode_translation_frame(frame) {
                    Ok(Some(event)) => event,
                    Ok(None) => continue,
                    Err(error) => {
                        emit_translation_error(&app, error);
                        continue;
                    }
                };
                if forward_translation_event(&app, &event) {
                    break;
                }
            }
        }
    }
    let _ = socket.close(None).await;
    if let Some(waiter) = close_waiter {
        let _ = waiter.send(());
    }
    let mut active = state.active.lock().await;
    if active.as_ref().map(|session| session.id) == Some(id) {
        active.take();
    }
}

fn translation_session_update(target_language: &str) -> Value {
    json!({
        "type": "session.update",
        "session": {
            "audio": {
                "output": {
                    "language": target_language
                }
            }
        }
    })
}

async fn drain_translation_close<S>(
    app: &AppHandle,
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let result = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let frame = match socket.next().await {
                Some(Ok(frame)) => frame,
                Some(Err(error)) => {
                    log::debug!("OpenAI translation close drain ended: {error}");
                    return;
                }
                None => return,
            };
            let event = match decode_translation_frame(frame) {
                Ok(Some(event)) => event,
                Ok(None) => continue,
                Err(error) => {
                    log::debug!(
                        "OpenAI translation close drain returned an invalid event: {error}"
                    );
                    continue;
                }
            };
            if forward_translation_event(app, &event) {
                return;
            }
        }
    })
    .await;
    if result.is_err() {
        log::debug!("OpenAI translation close drain timed out");
    }
}

fn forward_translation_event(app: &AppHandle, event: &Value) -> bool {
    let event_type = event
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if matches!(
        event_type,
        "session.input_transcript.delta"
            | "session.output_transcript.delta"
            | "session.input_transcript.completed"
            | "session.output_transcript.completed"
            | "error"
            | "session.closed"
    ) {
        let _ = app.emit(OPENAI_TRANSLATION_MESSAGE_EVENT, event);
    }
    event_type == "session.closed"
}

fn decode_translation_frame(frame: Message) -> Result<Option<Value>, String> {
    let bytes = match frame {
        Message::Text(text) => {
            return serde_json::from_str(text.as_ref())
                .map(Some)
                .map_err(|_| "OpenAI returned an unreadable translation event".to_string())
        }
        Message::Binary(bytes) => bytes,
        Message::Close(_) => return Err("OpenAI closed the translation connection".to_string()),
        Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => return Ok(None),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "OpenAI returned an unreadable translation event".to_string())
}

fn translation_server_error(event: &Value) -> Option<String> {
    (event.get("type").and_then(Value::as_str) == Some("error")).then(|| {
        event
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("unknown OpenAI translation error")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    })
}

fn translation_connect_error(error: WebSocketError) -> String {
    match error {
        WebSocketError::Http(response) if matches!(response.status().as_u16(), 401 | 403) => {
            "OpenAI API key is invalid or cannot access Realtime translation".to_string()
        }
        WebSocketError::Http(response) if response.status().as_u16() == 429 => {
            "OpenAI Realtime translation rate limit or quota was reached".to_string()
        }
        WebSocketError::Http(response) => format!(
            "OpenAI Realtime translation connection failed (HTTP {})",
            response.status().as_u16()
        ),
        other => format!("Could not reach OpenAI Realtime translation: {other}"),
    }
}

fn emit_translation_error(app: &AppHandle, message: String) {
    log::warn!("{message}");
    let _ = app.emit(
        OPENAI_TRANSLATION_MESSAGE_EVENT,
        json!({
            "type": "error",
            "error": {"message": message},
        }),
    );
}

async fn request_client_secret(
    api_key: &str,
    endpoint: &str,
    body: &Value,
    capability: &str,
) -> Result<String, String> {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
            .map_err(|_| "OpenAI API key has an invalid format".to_string())?,
    );

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Failed to initialize OpenAI Realtime: {error}"))?;

    let response = client
        .post(endpoint)
        .headers(headers)
        .json(body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "OpenAI Realtime token request timed out".to_string()
            } else {
                "Could not reach the OpenAI Realtime token service".to_string()
            }
        })?;

    let status = response.status();
    let response_body = response
        .bytes()
        .await
        .map_err(|_| "OpenAI returned an unreadable token response".to_string())?;
    if !status.is_success() {
        let detail = openai_error_message(&response_body);
        log::warn!(
            "OpenAI Realtime token request failed: status={} detail={}",
            status,
            detail.as_deref().unwrap_or("unavailable")
        );
        return Err(match (status.as_u16(), detail) {
            (401 | 403, _) => {
                format!("OpenAI API key is invalid or cannot access Realtime {capability}")
            }
            (429, _) => "OpenAI Realtime rate limit or quota was reached".to_string(),
            (code, Some(detail)) => {
                format!("OpenAI Realtime token request failed (HTTP {code}): {detail}")
            }
            (code, None) => format!("OpenAI Realtime token request failed (HTTP {code})"),
        });
    }

    let token: OpenAiClientSecretResponse = serde_json::from_slice(&response_body)
        .map_err(|_| "OpenAI returned an invalid token response".to_string())?;
    if token.value.trim().is_empty() {
        return Err("OpenAI returned an empty temporary token".to_string());
    }

    Ok(token.value)
}

fn client_secret_request_body() -> Value {
    json!({
        "expires_after": {
            "anchor": "created_at",
            "seconds": 60
        },
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {
                        "type": "audio/pcm",
                        "rate": 24_000
                    },
                    "noise_reduction": {
                        "type": "far_field"
                    },
                    "transcription": {
                        "model": OPENAI_LIVE_TRANSCRIBE_MODEL,
                        "delay": "medium"
                    },
                    // gpt-live-transcribe emits deltas while audio is appended,
                    // but does not support server VAD. Turns are committed by
                    // the client when recording stops.
                    "turn_detection": null
                }
            }
        }
    })
}

fn openai_error_message(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let raw = value
        .get("error")
        .and_then(|error| error.get("message"))
        .and_then(Value::as_str)?;
    let normalized = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return None;
    }
    Some(normalized.chars().take(320).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_secret_is_scoped_to_multilingual_transcription() {
        let body = client_secret_request_body();
        assert_eq!(body["session"]["type"], "transcription");
        assert_eq!(
            body["session"]["audio"]["input"]["transcription"]["model"],
            OPENAI_LIVE_TRANSCRIBE_MODEL
        );
        assert_eq!(body["session"]["audio"]["input"]["format"]["rate"], 24_000);
        assert_eq!(
            body["session"]["audio"]["input"]["noise_reduction"]["type"],
            "far_field"
        );
        assert_eq!(
            body["session"]["audio"]["input"]["transcription"]["delay"],
            "medium"
        );
        assert!(body["session"]["audio"]["input"]["turn_detection"].is_null());
        let transcription = &body["session"]["audio"]["input"]["transcription"];
        assert!(transcription.get("language").is_none());
        assert!(transcription.get("languages").is_none());
    }

    #[test]
    fn extracts_bounded_openai_error_message() {
        let body = br#"{"error":{"message":" Invalid   session "}}"#;
        assert_eq!(
            openai_error_message(body).as_deref(),
            Some("Invalid session")
        );
        assert!(openai_error_message(b"not json").is_none());
    }

    #[test]
    fn translation_session_update_requests_source_and_translated_transcripts() {
        let body = translation_session_update("ru");
        assert_eq!(body["type"], "session.update");
        assert_eq!(body["session"]["audio"]["output"]["language"], "ru");
        assert!(body["session"]["audio"].get("input").is_none());
    }

    #[tokio::test]
    async fn translation_setup_observes_supersession_promptly() {
        let state = Arc::new(OpenAiTranslationState::default());
        let generation = state.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let waiting_state = state.clone();
        let waiter = tokio::spawn(async move {
            wait_for_translation_superseded(&waiting_state, generation).await;
        });

        state.generation.fetch_add(1, Ordering::AcqRel);

        tokio::time::timeout(Duration::from_millis(200), waiter)
            .await
            .expect("superseded setup should wake without provider timeout")
            .expect("supersession waiter should not panic");
    }

    #[tokio::test]
    #[ignore = "manual live check; requires the user's saved OpenAI key and network access"]
    async fn live_translation_websocket_handshake() {
        let api_key = keyring::Entry::new("xlartas-xexamai", "provider.openai.api-key")
            .expect("open keyring entry")
            .get_password()
            .expect("read saved OpenAI key");
        let mut request = OPENAI_TRANSLATION_WEBSOCKET_URL
            .into_client_request()
            .expect("build translation request");
        request.headers_mut().insert(
            WS_AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", api_key.trim()))
                .expect("valid authorization header"),
        );
        drop(api_key);

        let (mut socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .expect("translation WebSocket timeout")
        .map_err(translation_connect_error)
        .expect("translation WebSocket connection");
        wait_for_translation_event(&mut socket, "session.created")
            .await
            .expect("session.created");
        socket
            .send(Message::Text(
                translation_session_update("en").to_string().into(),
            ))
            .await
            .expect("send session.update");
        wait_for_translation_event(&mut socket, "session.updated")
            .await
            .expect("session.updated");
        socket
            .send(Message::Text(
                json!({"type": "session.close"}).to_string().into(),
            ))
            .await
            .expect("send session.close");
        wait_for_translation_event(&mut socket, "session.closed")
            .await
            .expect("session.closed");
    }
}
