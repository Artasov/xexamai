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

    if !response.status().is_success() {
        let status = response.status();
        return Err(match status.as_u16() {
            400 => "Google Live rejected the selected model or session settings".to_string(),
            401 | 403 => "Google API key is invalid or does not have Live API access".to_string(),
            429 => "Google Live rate limit or quota was reached".to_string(),
            code => format!("Google Live token request failed (HTTP {code})"),
        });
    }

    let token: GoogleAuthTokenResponse = response
        .json()
        .await
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
        "liveConnectConstraints": {
            "model": format!("models/{GOOGLE_LIVE_MODEL}"),
            "config": {
                "responseModalities": ["AUDIO"],
                "inputAudioTranscription": {}
            }
        }
    })
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
            body["liveConnectConstraints"]["model"],
            "models/gemini-3.1-flash-live-preview"
        );
        assert_eq!(
            body["liveConnectConstraints"]["config"]["responseModalities"][0],
            "AUDIO"
        );
        assert!(body["liveConnectConstraints"]["config"]["inputAudioTranscription"].is_object());
        assert_eq!(body["expireTime"], "expiry");
        assert_eq!(body["newSessionExpireTime"], "new-session-expiry");
    }
}
