use std::sync::Arc;
use std::time::Duration;

use chrono::{SecondsFormat, Utc};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::activity::ActivityGate;
use crate::secret_store::{ProviderSecret, SecretStore};

const GOOGLE_AUTH_TOKENS_URL: &str = "https://generativelanguage.googleapis.com/v1beta/auth_tokens";
pub const GOOGLE_LIVE_MODEL: &str = "gemini-3.1-flash-live-preview";

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GoogleLiveCapability {
    supported: bool,
    configured: bool,
    model: &'static str,
    reason: Option<&'static str>,
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct GoogleLiveToken {
    token: String,
    model: &'static str,
}

#[derive(Debug, Deserialize)]
struct GoogleAuthTokenResponse {
    name: String,
}

#[tauri::command]
#[specta::specta]
pub async fn google_live_capability(
    secrets: State<'_, Arc<SecretStore>>,
) -> Result<GoogleLiveCapability, String> {
    let configured = secrets.has_provider_secret(ProviderSecret::Google).await;
    Ok(GoogleLiveCapability {
        supported: true,
        configured,
        model: GOOGLE_LIVE_MODEL,
        reason: (!configured).then_some("Add a Google API key in AI settings."),
    })
}

/// Exchanges the long-lived key held by the OS credential store for a one-use,
/// model-constrained Live API token. Only the short-lived token crosses IPC.
#[tauri::command]
#[specta::specta]
pub async fn google_live_create_token(
    activity: State<'_, Arc<ActivityGate>>,
    secrets: State<'_, Arc<SecretStore>>,
) -> Result<GoogleLiveToken, String> {
    let _activity = activity.try_begin_work()?;
    let api_key = secrets
        .get_provider_secret(ProviderSecret::Google)
        .await?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "Google API key is not configured".to_string())?;

    let now = Utc::now();
    let body = token_request_body(
        (now + chrono::Duration::minutes(30)).to_rfc3339_opts(SecondsFormat::Secs, true),
        (now + chrono::Duration::minutes(1)).to_rfc3339_opts(SecondsFormat::Secs, true),
    );

    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        "x-goog-api-key",
        HeaderValue::from_str(api_key.trim())
            .map_err(|_| "Google API key has an invalid format".to_string())?,
    );

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Failed to initialize Google Live: {error}"))?;

    let response = client
        .post(GOOGLE_AUTH_TOKENS_URL)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "Google Live token request timed out".to_string()
            } else {
                "Could not reach the Google Live token service".to_string()
            }
        })?;

    let status = response.status();
    let response_body = response
        .bytes()
        .await
        .map_err(|_| "Google Live returned an unreadable token response".to_string())?;
    if !status.is_success() {
        let detail = google_error_message(&response_body);
        log::warn!(
            "Google Live token request failed: status={} detail={}",
            status,
            detail.as_deref().unwrap_or("unavailable")
        );
        return Err(match (status.as_u16(), detail) {
            (401 | 403, _) => {
                "Google API key is invalid or does not have Live API access".to_string()
            }
            (429, _) => "Google Live rate limit or quota was reached".to_string(),
            (code, Some(detail)) => {
                format!("Google Live token request failed (HTTP {code}): {detail}")
            }
            (code, None) => format!("Google Live token request failed (HTTP {code})"),
        });
    }

    let token: GoogleAuthTokenResponse = serde_json::from_slice(&response_body)
        .map_err(|_| "Google Live returned an invalid token response".to_string())?;
    if token.name.trim().is_empty() {
        return Err("Google Live returned an empty temporary token".to_string());
    }

    Ok(GoogleLiveToken {
        token: token.name,
        model: GOOGLE_LIVE_MODEL,
    })
}

fn token_request_body(expire_time: String, new_session_expire_time: String) -> Value {
    json!({
        "uses": 1,
        "expireTime": expire_time,
        "newSessionExpireTime": new_session_expire_time,
        // v1beta AuthToken now accepts the constrained setup directly. The
        // older `liveConnectConstraints` field is rejected as an unknown field.
        "bidiGenerateContentSetup": {
            "model": format!("models/{GOOGLE_LIVE_MODEL}"),
            "generationConfig": {
                "responseModalities": ["AUDIO"]
            },
            "inputAudioTranscription": {},
            "sessionResumption": {}
        }
    })
}

fn google_error_message(body: &[u8]) -> Option<String> {
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
    fn token_is_one_use_and_model_constrained() {
        assert!(GOOGLE_AUTH_TOKENS_URL.contains("/v1beta/"));
        let body = token_request_body("expiry".into(), "new-session-expiry".into());
        assert_eq!(body["uses"], 1);
        assert_eq!(
            body["bidiGenerateContentSetup"]["model"],
            "models/gemini-3.1-flash-live-preview"
        );
        assert_eq!(
            body["bidiGenerateContentSetup"]["generationConfig"]["responseModalities"][0],
            "AUDIO"
        );
        assert!(body["bidiGenerateContentSetup"]["inputAudioTranscription"].is_object());
        assert!(body["bidiGenerateContentSetup"]["sessionResumption"].is_object());
        assert_eq!(body["expireTime"], "expiry");
        assert_eq!(body["newSessionExpireTime"], "new-session-expiry");
    }

    #[test]
    fn extracts_bounded_google_error_message() {
        let body = br#"{"error":{"status":"INVALID_ARGUMENT","message":" Unknown   field "}}"#;
        assert_eq!(google_error_message(body).as_deref(), Some("Unknown field"));
        assert!(google_error_message(b"not json").is_none());
    }
}
