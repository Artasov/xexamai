use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::State;

use crate::activity::ActivityGate;
use crate::secret_store::{ProviderSecret, SecretStore};

pub const OPENAI_LIVE_TRANSCRIBE_MODEL: &str = "gpt-live-transcribe";
const OPENAI_CLIENT_SECRETS_URL: &str = "https://api.openai.com/v1/realtime/client_secrets";

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
        .post(OPENAI_CLIENT_SECRETS_URL)
        .headers(headers)
        .json(&client_secret_request_body())
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
                "OpenAI API key is invalid or cannot access Realtime transcription".to_string()
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

    Ok(OpenAiLiveToken {
        token: token.value,
        model: OPENAI_LIVE_TRANSCRIBE_MODEL,
    })
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
}
