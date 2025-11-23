use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::constants::{OAUTH_APP_NAME, OAUTH_SCHEME};
use crate::types::{AuthDeepLinkPayload, AuthTokensPayload};

#[derive(Default)]
pub struct AuthQueue {
    pending: Mutex<Vec<AuthDeepLinkPayload>>,
}

impl AuthQueue {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
        }
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
}

pub async fn handle_deep_link(app: AppHandle, queue: Arc<AuthQueue>, url: String) {
    if let Some(payload) = parse_auth_payload(&url) {
        queue.enqueue(payload.clone()).await;
        let _ = app.emit("auth:deep-link", payload);
    }
}

fn parse_auth_payload(url: &str) -> Option<AuthDeepLinkPayload> {
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != OAUTH_SCHEME {
        return None;
    }
    if parsed.host_str() != Some("auth") {
        return None;
    }
    if !parsed.path().starts_with("/callback") {
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
    if app_name != OAUTH_APP_NAME {
        return Some(AuthDeepLinkPayload::Error {
            provider,
            error: "Invalid OAuth payload".into(),
        });
    }
    if let Some(error) = data.get("error").and_then(|value| value.as_str()) {
        if !error.trim().is_empty() {
            return Some(AuthDeepLinkPayload::Error {
                provider,
                error: error.to_string(),
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
            user: data.get("user").cloned(),
        });
    }
    Some(AuthDeepLinkPayload::Error {
        provider,
        error: "Missing access token".into(),
    })
}
