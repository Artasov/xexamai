use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{redirect::Policy, Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{ipc::Channel, State, WebviewWindow};
use tokio::sync::{watch, Mutex};

use crate::activity::ActivityGate;
use crate::auth::is_supported_backend_domain;
use crate::auth_session::AuthSessionState;
use crate::config::ConfigState;
use crate::secret_store::{ProviderSecret, SecretStore};

const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ERROR_BYTES: usize = 64 * 1024;
const MAX_ENTITLEMENT_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProxyRequest {
    pub request_id: String,
    pub provider: String,
    pub operation: String,
    #[serde(default)]
    pub model: Option<String>,
    #[specta(type = specta_typescript::Unknown)]
    pub body: Value,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Default)]
pub struct ProviderProxyState {
    next_generation: AtomicU64,
    active: Mutex<HashMap<String, (u64, watch::Sender<bool>)>>,
}

impl ProviderProxyState {
    pub fn new() -> Self {
        Self::default()
    }

    async fn register(&self, request_id: &str) -> Result<(u64, watch::Receiver<bool>), String> {
        validate_request_id(request_id)?;
        let mut active = self.active.lock().await;
        if active.len() >= 32 && !active.contains_key(request_id) {
            return Err("Too many provider requests are active".to_string());
        }
        if let Some((_, previous)) = active.remove(request_id) {
            let _ = previous.send(true);
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let (sender, receiver) = watch::channel(false);
        active.insert(request_id.to_string(), (generation, sender));
        Ok((generation, receiver))
    }

    async fn finish(&self, request_id: &str, generation: u64) {
        let mut active = self.active.lock().await;
        if active
            .get(request_id)
            .is_some_and(|(current, _)| *current == generation)
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

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderProxyResponse {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelTestRequest {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModelTestResult {
    pub available: bool,
    pub status: u16,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProviderStreamEvent {
    Headers {
        status: u16,
        content_type: Option<String>,
    },
    Chunk {
        data: Vec<u8>,
    },
    Done,
    Error {
        message: String,
    },
}

struct PreparedRequest {
    provider: ProviderSecret,
    method: Method,
    url: String,
    body: Vec<u8>,
    timeout: Duration,
    required_entitlement: Option<&'static str>,
}

#[tauri::command]
#[specta::specta]
pub async fn provider_proxy_request(
    window: WebviewWindow,
    secrets: State<'_, Arc<SecretStore>>,
    proxy_state: State<'_, Arc<ProviderProxyState>>,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    sessions: State<'_, Arc<AuthSessionState>>,
    request: ProviderProxyRequest,
) -> Result<ProviderProxyResponse, String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let request_id = request.request_id.clone();
    let prepared = prepare_request(request, false)?;
    if let Some(feature) = prepared.required_entitlement {
        require_entitlement(config.inner(), sessions.inner(), secrets.inner(), feature).await?;
    }
    let (generation, mut cancellation) = proxy_state.register(&request_id).await?;
    let operation = async {
        let response = send(prepared, secrets.inner().clone()).await?;
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(ToOwned::to_owned);
        let bytes = collect_bounded(response, MAX_RESPONSE_BYTES).await?;
        let body =
            String::from_utf8(bytes).map_err(|_| "Provider returned invalid UTF-8".to_string())?;
        Ok(ProviderProxyResponse {
            status: status.as_u16(),
            content_type,
            body,
        })
    };
    let result = tokio::select! {
        result = operation => result,
        _ = wait_for_cancellation(&mut cancellation) => Err("Provider request was cancelled".to_string()),
    };
    proxy_state.finish(&request_id, generation).await;
    result
}

#[tauri::command]
#[specta::specta]
#[allow(clippy::too_many_arguments)] // Tauri injects each managed state separately.
pub async fn provider_proxy_stream(
    window: WebviewWindow,
    secrets: State<'_, Arc<SecretStore>>,
    proxy_state: State<'_, Arc<ProviderProxyState>>,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    sessions: State<'_, Arc<AuthSessionState>>,
    request: ProviderProxyRequest,
    on_event: Channel<ProviderStreamEvent>,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let request_id = request.request_id.clone();
    let prepared = prepare_request(request, true)?;
    if let Some(feature) = prepared.required_entitlement {
        require_entitlement(config.inner(), sessions.inner(), secrets.inner(), feature).await?;
    }
    let (generation, mut cancellation) = proxy_state.register(&request_id).await?;
    let operation = stream_response(prepared, secrets.inner().clone(), &on_event);
    let result = tokio::select! {
        result = operation => result,
        _ = wait_for_cancellation(&mut cancellation) => Err("Provider request was cancelled".to_string()),
    };
    proxy_state.finish(&request_id, generation).await;
    result
}

async fn stream_response(
    prepared: PreparedRequest,
    secrets: Arc<SecretStore>,
    on_event: &Channel<ProviderStreamEvent>,
) -> Result<(), String> {
    let response = send(prepared, secrets).await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    on_event
        .send(ProviderStreamEvent::Headers {
            status: status.as_u16(),
            content_type,
        })
        .map_err(|_| "Provider stream receiver is unavailable".to_string())?;

    if !status.is_success() {
        let bytes = collect_bounded(response, MAX_ERROR_BYTES).await?;
        let _ = on_event.send(ProviderStreamEvent::Chunk { data: bytes });
        let _ = on_event.send(ProviderStreamEvent::Done);
        return Ok(());
    }

    let mut received = 0usize;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Provider stream failed: {error}"))?;
        received = received
            .checked_add(chunk.len())
            .ok_or_else(|| "Provider response is too large".to_string())?;
        if received > MAX_RESPONSE_BYTES {
            let _ = on_event.send(ProviderStreamEvent::Error {
                message: "Provider response is too large".to_string(),
            });
            return Ok(());
        }
        on_event
            .send(ProviderStreamEvent::Chunk {
                data: chunk.to_vec(),
            })
            .map_err(|_| "Provider stream receiver is unavailable".to_string())?;
    }
    let _ = on_event.send(ProviderStreamEvent::Done);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn provider_proxy_cancel(
    window: WebviewWindow,
    proxy_state: State<'_, Arc<ProviderProxyState>>,
    request_id: String,
) -> Result<(), String> {
    ensure_main_window(&window)?;
    proxy_state.cancel(&request_id).await
}

/// Performs a read-only model lookup. It verifies the stored credential and
/// selected model without spending generation/transcription quota or exposing
/// the credential to the renderer.
#[tauri::command]
#[specta::specta]
pub async fn provider_test_model(
    window: WebviewWindow,
    secrets: State<'_, Arc<SecretStore>>,
    activity: State<'_, Arc<ActivityGate>>,
    request: ProviderModelTestRequest,
) -> Result<ProviderModelTestResult, String> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let provider = ProviderSecret::parse(&request.provider)?;
    let model = validated_model(Some(&request.model))?;
    let url = match provider {
        ProviderSecret::OpenAi => format!("https://api.openai.com/v1/models/{model}"),
        ProviderSecret::Google => {
            format!("https://generativelanguage.googleapis.com/v1beta/models/{model}")
        }
    };
    let response = send(
        PreparedRequest {
            provider,
            method: Method::GET,
            url,
            body: Vec::new(),
            timeout: Duration::from_secs(15),
            required_entitlement: None,
        },
        secrets.inner().clone(),
    )
    .await?;
    let status = response.status().as_u16();
    let (available, message) = match status {
        200 => (true, format!("{model} is available")),
        401 | 403 => (false, "The stored API key was rejected".to_string()),
        404 => (false, format!("{model} is not available for this account")),
        429 => (
            false,
            "The provider accepted the request but rate limit or quota was reached".to_string(),
        ),
        code => (false, format!("Provider model check failed (HTTP {code})")),
    };
    Ok(ProviderModelTestResult {
        available,
        status,
        message,
    })
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Command is not available to this window".to_string())
    }
}

fn validate_request_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid provider request id".to_string());
    }
    Ok(())
}

async fn wait_for_cancellation(receiver: &mut watch::Receiver<bool>) {
    while !*receiver.borrow_and_update() {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

fn prepare_request(
    request: ProviderProxyRequest,
    streaming_command: bool,
) -> Result<PreparedRequest, String> {
    let provider = ProviderSecret::parse(&request.provider)?;
    let (method, url, operation_is_streaming, required_entitlement) = match (
        provider,
        request.operation.as_str(),
    ) {
        (ProviderSecret::OpenAi, "chatCompletions") => (
            Method::POST,
            "https://api.openai.com/v1/chat/completions".to_string(),
            body_requests_streaming(&request.body),
            None,
        ),
        (ProviderSecret::OpenAi, "responses") => (
            Method::POST,
            "https://api.openai.com/v1/responses".to_string(),
            body_requests_streaming(&request.body),
            None,
        ),
        (ProviderSecret::OpenAi, "screenChatCompletions") => (
            Method::POST,
            "https://api.openai.com/v1/chat/completions".to_string(),
            false,
            Some("screen_processing"),
        ),
        (ProviderSecret::Google, "generateContent") => {
            let model = validated_model(request.model.as_deref())?;
            (
                Method::POST,
                format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                ),
                false,
                None,
            )
        }
        (ProviderSecret::Google, "streamGenerateContent") => {
            let model = validated_model(request.model.as_deref())?;
            (
                Method::POST,
                format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
                ),
                true,
                None,
            )
        }
        (ProviderSecret::Google, "screenGenerateContent") => {
            let model = validated_model(request.model.as_deref())?;
            (
                Method::POST,
                format!(
                    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
                ),
                false,
                Some("screen_processing"),
            )
        }
        _ => return Err("Unsupported provider operation".to_string()),
    };
    let contains_image = body_contains_image(&request.body);
    if required_entitlement.is_some() != contains_image {
        return Err(if contains_image {
            "Image requests require the typed screen operation".to_string()
        } else {
            "Screen operation is missing an image".to_string()
        });
    }
    if operation_is_streaming != streaming_command {
        return Err(if operation_is_streaming {
            "Streaming provider operation requires provider_proxy_stream".to_string()
        } else {
            "Non-streaming provider operation requires provider_proxy_request".to_string()
        });
    }
    let body = serde_json::to_vec(&request.body)
        .map_err(|error| format!("Invalid provider request body: {error}"))?;
    if body.len() > MAX_REQUEST_BYTES {
        return Err("Provider request body is too large".to_string());
    }
    let timeout_ms = request.timeout_ms.unwrap_or(150_000).clamp(1_000, 300_000);
    Ok(PreparedRequest {
        provider,
        method,
        url,
        body,
        timeout: Duration::from_millis(timeout_ms),
        required_entitlement,
    })
}

#[derive(Deserialize)]
struct EntitlementResponse {
    allowed: bool,
}

async fn require_entitlement(
    config: &ConfigState,
    sessions: &AuthSessionState,
    secrets: &SecretStore,
    feature: &str,
) -> Result<(), String> {
    if feature != "screen_processing" {
        return Err("Unsupported entitlement".to_string());
    }
    let domain = config.get().await.backend_domain;
    if !is_supported_backend_domain(&domain) {
        return Err("Unsupported entitlement backend".to_string());
    }
    let mut access = sessions
        .access_token_for_domain(&domain)
        .await
        .ok_or_else(|| "Authentication is required for this feature".to_string())?;
    let mut response = send_entitlement_request(&domain, feature, &access).await?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        access = sessions
            .refresh_if_access_is_stale(secrets, &domain, &access)
            .await?
            .access;
        response = send_entitlement_request(&domain, feature, &access).await?;
    }
    let status = response.status();
    let body = collect_bounded(response, MAX_ENTITLEMENT_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "Entitlement check failed with HTTP {}",
            status.as_u16()
        ));
    }
    let entitlement: EntitlementResponse = serde_json::from_slice(&body)
        .map_err(|_| "Entitlement server returned an invalid response".to_string())?;
    if !entitlement.allowed {
        return Err("Screen processing is not available for this account".to_string());
    }
    Ok(())
}

async fn send_entitlement_request(
    domain: &str,
    feature: &str,
    access: &str,
) -> Result<reqwest::Response, String> {
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Failed to initialize entitlement client: {error}"))?;
    client
        .get(format!(
            "https://{domain}/api/v1/me/entitlements/{feature}/"
        ))
        .bearer_auth(access)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| format!("Entitlement check failed: {error}"))
}

async fn send(
    request: PreparedRequest,
    secrets: Arc<SecretStore>,
) -> Result<reqwest::Response, String> {
    let key = secrets
        .get_provider_secret(request.provider)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Provider API key is not configured".to_string())?;
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(request.timeout.min(Duration::from_secs(15)))
        .timeout(request.timeout)
        .build()
        .map_err(|error| format!("Failed to initialize provider client: {error}"))?;
    let mut outgoing = client
        .request(request.method, request.url)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/event-stream",
        )
        .body(request.body);
    outgoing = match request.provider {
        ProviderSecret::OpenAi => outgoing.bearer_auth(key),
        ProviderSecret::Google => outgoing.header("x-goog-api-key", key),
    };
    outgoing
        .send()
        .await
        .map_err(|error| format!("Provider request failed: {error}"))
}

async fn collect_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| format!("Failed to read provider response: {error}"))?;
        if output.len().saturating_add(chunk.len()) > limit {
            return Err("Provider response is too large".to_string());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn validated_model(model: Option<&str>) -> Result<&str, String> {
    let model = model.unwrap_or_default().trim();
    if model.is_empty()
        || model.len() > 128
        || !model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err("Invalid provider model".to_string());
    }
    Ok(model)
}

fn body_requests_streaming(body: &Value) -> bool {
    body.get("stream").and_then(Value::as_bool).unwrap_or(false)
}

fn body_contains_image(value: &Value) -> bool {
    match value {
        Value::String(value) => value
            .get(..11)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("data:image/")),
        Value::Array(values) => values.iter().any(body_contains_image),
        Value::Object(values) => {
            values.keys().any(|key| {
                key.eq_ignore_ascii_case("image_url")
                    || key.eq_ignore_ascii_case("input_image")
                    || key.eq_ignore_ascii_case("inline_data")
            }) || values.values().any(body_contains_image)
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(
        provider: &str,
        operation: &str,
        model: Option<&str>,
        body: Value,
    ) -> ProviderProxyRequest {
        ProviderProxyRequest {
            request_id: "test-request".to_string(),
            provider: provider.to_string(),
            operation: operation.to_string(),
            model: model.map(ToOwned::to_owned),
            body,
            timeout_ms: None,
        }
    }

    #[test]
    fn provider_urls_are_fixed_and_models_cannot_escape_paths() {
        let prepared = prepare_request(
            request(
                "google",
                "generateContent",
                Some("gemini-2.5-flash"),
                serde_json::json!({}),
            ),
            false,
        )
        .unwrap();
        assert_eq!(prepared.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
        assert!(prepare_request(
            request(
                "google",
                "generateContent",
                Some("../evil?key=x"),
                serde_json::json!({})
            ),
            false,
        )
        .is_err());
    }

    #[test]
    fn streaming_contract_is_not_ambiguous() {
        assert!(prepare_request(
            request(
                "openai",
                "chatCompletions",
                None,
                serde_json::json!({"stream": true})
            ),
            false,
        )
        .is_err());
        assert!(prepare_request(
            request(
                "openai",
                "chatCompletions",
                None,
                serde_json::json!({"stream": false})
            ),
            true,
        )
        .is_err());
    }

    #[test]
    fn image_payloads_require_entitled_screen_operations() {
        let openai_image = serde_json::json!({
            "messages": [{
                "role": "user",
                "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]
            }]
        });
        assert!(prepare_request(
            request("openai", "chatCompletions", None, openai_image.clone()),
            false,
        )
        .is_err());
        let prepared = prepare_request(
            request("openai", "screenChatCompletions", None, openai_image),
            false,
        )
        .unwrap();
        assert_eq!(prepared.required_entitlement, Some("screen_processing"));

        assert!(prepare_request(
            request(
                "google",
                "screenGenerateContent",
                Some("gemini-2.5-flash"),
                serde_json::json!({"contents": [{"parts": [{"text": "no image"}]}]}),
            ),
            false,
        )
        .is_err());
    }
}
