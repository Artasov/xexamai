use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::constants::{OAUTH_APP_NAME, OAUTH_SCHEME};
use crate::types::{AuthDeepLinkPayload, AuthTokensPayload};

#[derive(Default)]
pub struct AuthQueue {
    pending: Mutex<Vec<AuthDeepLinkPayload>>,
    states: Mutex<HashMap<String, String>>,
}

impl AuthQueue {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            states: Mutex::new(HashMap::new()),
        }
    }

    pub async fn start_state(&self, provider: &str) -> String {
        let provider_key = provider.trim().to_lowercase();
        let state = Uuid::new_v4().simple().to_string();
        self.states.lock().await.insert(provider_key, state.clone());
        log::info!(target: "auth", "OAuth state created: provider={}", provider);
        state
    }

    pub async fn enqueue(&self, payload: AuthDeepLinkPayload) {
        self.pending.lock().await.push(payload);
    }

    pub async fn drain(&self) -> Vec<AuthDeepLinkPayload> {
        let mut guard = self.pending.lock().await;
        let drained = guard.clone();
        guard.clear();
        drained
    }

    async fn take_expected_state(&self, provider: &str) -> Option<String> {
        self.states
            .lock()
            .await
            .remove(&provider.trim().to_lowercase())
    }

    async fn validate_state(
        &self,
        provider: &str,
        received_state: Option<&str>,
    ) -> Result<(), String> {
        let expected = self.take_expected_state(provider).await;
        match (expected, received_state) {
            (Some(expected_state), Some(value)) if value == expected_state => Ok(()),
            _ => Err("Invalid OAuth state".to_string()),
        }
    }
}

pub async fn handle_deep_link(app: AppHandle, queue: Arc<AuthQueue>, url: String) {
    log::info!(target: "auth", "Deep link received");
    if let Some(payload) = parse_auth_payload(&url) {
        let payload = match validate_payload_state(queue.clone(), payload).await {
            Ok(payload) => payload,
            Err(payload) => payload,
        };
        match &payload {
            AuthDeepLinkPayload::Success { provider, .. } => {
                log::info!(target: "auth", "OAuth deep link success payload: provider={provider}");
            }
            AuthDeepLinkPayload::Error {
                provider, error, ..
            } => {
                log::warn!(
                    target: "auth",
                    "OAuth deep link error payload: provider={} error={}",
                    provider,
                    error
                );
            }
        }
        queue.enqueue(payload.clone()).await;
        let _ = app.emit("auth:deep-link", payload);
    } else {
        log::warn!(target: "auth", "Deep link ignored: not an auth callback");
    }
}

async fn validate_payload_state(
    queue: Arc<AuthQueue>,
    payload: AuthDeepLinkPayload,
) -> Result<AuthDeepLinkPayload, AuthDeepLinkPayload> {
    let (provider, state) = match &payload {
        AuthDeepLinkPayload::Success {
            provider, state, ..
        } => (provider.clone(), state.clone()),
        AuthDeepLinkPayload::Error {
            provider, state, ..
        } => (provider.clone(), state.clone()),
    };
    if let Err(error) = queue.validate_state(&provider, state.as_deref()).await {
        log::warn!(
            target: "auth",
            "OAuth state validation failed: provider={} error={}",
            provider,
            error
        );
        return Err(AuthDeepLinkPayload::Error {
            provider,
            error,
            state,
        });
    }
    log::info!(target: "auth", "OAuth state validated: provider={provider}");
    Ok(payload)
}

fn parse_auth_payload(url: &str) -> Option<AuthDeepLinkPayload> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != OAUTH_SCHEME {
        log::warn!(
            target: "auth",
            "Deep link scheme mismatch: scheme={}",
            parsed.scheme()
        );
        return None;
    }
    if parsed.host_str() != Some("auth") {
        log::warn!(
            target: "auth",
            "Deep link host mismatch: host={:?}",
            parsed.host_str()
        );
        return None;
    }
    if !parsed.path().starts_with("/callback") {
        log::warn!(target: "auth", "Deep link path mismatch: path={}", parsed.path());
        return None;
    }
    let payload = parsed
        .query_pairs()
        .find(|(key, _)| key == "payload")
        .map(|(_, value)| value.into_owned())?;
    let decoded = urlencoding::decode(&payload).ok()?.into_owned();
    let data: serde_json::Value = serde_json::from_str(&decoded).ok()?;
    let provider = data
        .get("provider")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown")
        .to_string();
    let app_name = data
        .get("app")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let state = data
        .get("state")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if app_name != OAUTH_APP_NAME {
        return Some(AuthDeepLinkPayload::Error {
            provider,
            error: "Invalid OAuth payload".into(),
            state,
        });
    }
    if let Some(error) = data.get("error").and_then(|value| value.as_str()) {
        if !error.trim().is_empty() {
            return Some(AuthDeepLinkPayload::Error {
                provider,
                error: error.to_string(),
                state,
            });
        }
    }
    let tokens = data.get("tokens")?.as_object()?;
    let access = tokens
        .get("access")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    if let Some(access_token) = access {
        let refresh = tokens
            .get("refresh")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string());
        return Some(AuthDeepLinkPayload::Success {
            provider,
            tokens: AuthTokensPayload {
                access: access_token,
                refresh,
            },
            state,
            user: data.get("user").cloned(),
        });
    }
    Some(AuthDeepLinkPayload::Error {
        provider,
        error: "Missing access token".into(),
        state,
    })
}
