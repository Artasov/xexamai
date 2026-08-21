use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::activity::ActivityGate;
use crate::auth_session::AuthSessionState;
use crate::config::ConfigState;
use crate::constants::{BACKEND_DOMAIN_COM, BACKEND_DOMAIN_RU, OAUTH_APP_NAME, OAUTH_SCHEME};
use crate::secret_store::SecretStore;
use crate::types::AuthDeepLinkPayload;

const OAUTH_ATTEMPT_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_CALLBACKS: usize = 8;
const MAX_DEEP_LINK_LEN: usize = 64 * 1024;
const MAX_STATE_LEN: usize = 256;
const MAX_EXCHANGE_CODE_LEN: usize = 512;
const MAX_ERROR_LEN: usize = 512;

struct OAuthAttempt {
    provider: String,
    state: String,
    backend_domain: String,
    code_verifier: String,
    created_at: Instant,
}

#[derive(Debug, Clone)]
pub struct OAuthStartAttempt {
    pub state: String,
    pub code_challenge: String,
}

#[derive(Default)]
struct DeliveryState {
    renderer_ready: bool,
    pending: Vec<AuthDeepLinkPayload>,
}

#[derive(Default)]
pub struct AuthQueue {
    delivery: Mutex<DeliveryState>,
    attempts: Mutex<HashMap<String, OAuthAttempt>>,
}

impl AuthQueue {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn start_attempt(&self, provider: &str, backend_domain: &str) -> OAuthStartAttempt {
        let provider_key = normalize_provider(provider).unwrap_or_default().to_string();
        let state = Uuid::new_v4().simple().to_string();
        let (code_verifier, code_challenge) = generate_pkce_pair();
        let mut attempts = self.attempts.lock().await;
        prune_expired_attempts(&mut attempts);
        if attempts.len() >= 16 {
            if let Some(oldest) = attempts
                .iter()
                .min_by_key(|(_, attempt)| attempt.created_at)
                .map(|(state, _)| state.clone())
            {
                attempts.remove(&oldest);
            }
        }
        attempts.insert(
            state.clone(),
            OAuthAttempt {
                provider: provider_key,
                state: state.clone(),
                backend_domain: backend_domain.to_string(),
                code_verifier,
                created_at: Instant::now(),
            },
        );
        log::info!(target: "auth", "OAuth attempt created: provider={provider}");
        OAuthStartAttempt {
            state,
            code_challenge,
        }
    }

    pub async fn cancel_state(&self, state: &str) {
        self.attempts.lock().await.remove(state);
    }

    pub async fn cancel_all(&self) {
        self.attempts.lock().await.clear();
        let mut delivery = self.delivery.lock().await;
        delivery.pending.clear();
    }

    pub async fn mark_renderer_ready_and_drain(&self) -> Vec<AuthDeepLinkPayload> {
        let mut delivery = self.delivery.lock().await;
        delivery.renderer_ready = true;
        std::mem::take(&mut delivery.pending)
    }

    pub async fn mark_renderer_not_ready(&self) {
        self.delivery.lock().await.renderer_ready = false;
    }

    async fn queue_or_should_emit(&self, payload: AuthDeepLinkPayload) -> bool {
        let mut delivery = self.delivery.lock().await;
        if delivery.renderer_ready {
            return true;
        }
        enqueue_bounded(&mut delivery.pending, payload);
        false
    }

    async fn requeue_after_emit_failure(&self, payload: AuthDeepLinkPayload) {
        let mut delivery = self.delivery.lock().await;
        delivery.renderer_ready = false;
        enqueue_bounded(&mut delivery.pending, payload);
    }

    async fn validate_and_consume_state(
        &self,
        provider: &str,
        received_state: &str,
    ) -> Result<OAuthAttempt, &'static str> {
        let provider = normalize_provider(provider).ok_or("Unsupported OAuth provider")?;
        let mut attempts = self.attempts.lock().await;
        prune_expired_attempts(&mut attempts);
        let Some(attempt) = attempts.get(received_state) else {
            return Err("No pending OAuth attempt");
        };
        if attempt.provider != provider || !constant_time_eq(&attempt.state, received_state) {
            // An attacker-controlled callback must not consume the legitimate attempt.
            return Err("Invalid OAuth state");
        }
        attempts
            .remove(received_state)
            .ok_or("No pending OAuth attempt")
    }
}

fn generate_pkce_pair() -> (String, String) {
    let mut entropy = [0_u8; 32];
    OsRng.fill_bytes(&mut entropy);
    let verifier = URL_SAFE_NO_PAD.encode(entropy);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

fn enqueue_bounded(pending: &mut Vec<AuthDeepLinkPayload>, payload: AuthDeepLinkPayload) {
    if pending.len() == MAX_PENDING_CALLBACKS {
        pending.remove(0);
    }
    pending.push(payload);
}

fn prune_expired_attempts(attempts: &mut HashMap<String, OAuthAttempt>) {
    attempts.retain(|_, attempt| attempt.created_at.elapsed() <= OAUTH_ATTEMPT_TTL);
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    let length = left.len().max(right.len());
    for index in 0..length {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

pub async fn handle_deep_link(app: AppHandle, queue: Arc<AuthQueue>, url: String) {
    log::info!(target: "auth", "Deep link received");
    let Some(activity) = app.try_state::<Arc<ActivityGate>>() else {
        log::error!(target: "auth", "OAuth callback rejected: activity gate is unavailable");
        return;
    };
    let Ok(_activity) = activity.try_begin_work() else {
        // Do not consume the one-time state while an installer owns the app.
        log::warn!(target: "auth", "OAuth callback deferred: update installation is active");
        return;
    };
    let Some(parsed) = parse_auth_payload(&url) else {
        log::warn!(target: "auth", "Deep link ignored: invalid auth callback");
        return;
    };
    let (provider, state) = payload_provider_and_state(&parsed.payload);
    let provider = provider.to_string();
    let state = state.to_string();
    let Ok(attempt) = queue.validate_and_consume_state(&provider, &state).await else {
        // Never forward an invalid callback as an auth error: doing so would let a
        // foreign deep link log the current user out or replace the visible error.
        log::warn!(target: "auth", "OAuth callback rejected: provider={provider}");
        return;
    };
    let Some(config) = app.try_state::<Arc<ConfigState>>() else {
        log::error!(target: "auth", "OAuth callback rejected: config state is unavailable");
        return;
    };
    if config.get().await.backend_domain != attempt.backend_domain {
        log::warn!(target: "auth", "OAuth callback rejected after backend domain changed");
        return;
    }
    let mut payload = parsed.payload;
    if let Some(code) = parsed.code.as_deref() {
        let Some(secrets) = app.try_state::<Arc<SecretStore>>() else {
            log::error!(target: "auth", "OAuth callback rejected: credential store is unavailable");
            return;
        };
        let Some(sessions) = app.try_state::<Arc<AuthSessionState>>() else {
            log::error!(target: "auth", "OAuth callback rejected: session state is unavailable");
            return;
        };
        if sessions
            .exchange_desktop_oauth_code(
                secrets.inner(),
                &attempt.backend_domain,
                &provider,
                &state,
                code,
                &attempt.code_verifier,
            )
            .await
            .is_err()
        {
            log::error!(target: "auth", "OAuth callback rejected: session exchange failed");
            payload = AuthDeepLinkPayload::Error {
                provider: provider.clone(),
                error: "OAuth session exchange failed".to_string(),
                state: Some(state.clone()),
            };
        }
    }

    match &payload {
        AuthDeepLinkPayload::Success { provider, .. } => {
            log::info!(target: "auth", "OAuth callback accepted: provider={provider}");
        }
        AuthDeepLinkPayload::Error { provider, .. } => {
            log::warn!(target: "auth", "OAuth callback returned an error: provider={provider}");
        }
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }

    if !queue.queue_or_should_emit(payload.clone()).await {
        return;
    }
    if app
        .emit_to("main", "auth:deep-link", payload.clone())
        .is_err()
    {
        queue.requeue_after_emit_failure(payload).await;
    }
}

fn payload_provider_and_state(payload: &AuthDeepLinkPayload) -> (&str, &str) {
    match payload {
        AuthDeepLinkPayload::Success {
            provider, state, ..
        }
        | AuthDeepLinkPayload::Error {
            provider, state, ..
        } => (provider, state.as_deref().unwrap_or_default()),
    }
}

fn normalize_provider(value: &str) -> Option<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "google" => Some("google"),
        "github" => Some("github"),
        "discord" => Some("discord"),
        "yandex" => Some("yandex"),
        _ => None,
    }
}

struct ParsedAuthPayload {
    payload: AuthDeepLinkPayload,
    code: Option<String>,
}

fn parse_auth_payload(url: &str) -> Option<ParsedAuthPayload> {
    if url.len() > MAX_DEEP_LINK_LEN {
        return None;
    }
    let parsed = url::Url::parse(url).ok()?;
    if parsed.scheme() != OAUTH_SCHEME
        || parsed.host_str() != Some("auth")
        || parsed.path() != "/callback"
        || parsed.fragment().is_some()
    {
        return None;
    }
    let mut payload_values = parsed
        .query_pairs()
        .filter(|(key, _)| key == "payload")
        .map(|(_, value)| value.into_owned());
    let payload = payload_values.next()?;
    if payload_values.next().is_some() {
        return None;
    }
    let data: serde_json::Value = serde_json::from_str(&payload).ok()?;
    let object = data.as_object()?;
    if object.get("app")?.as_str()? != OAUTH_APP_NAME {
        return None;
    }
    let provider = normalize_provider(object.get("provider")?.as_str()?)?.to_string();
    let state = bounded_opaque(object.get("state")?.as_str()?, 16, MAX_STATE_LEN)?;
    let state = Some(state.to_string());

    if let Some(error) = object.get("error").and_then(|value| value.as_str()) {
        let error = error.trim();
        if !error.is_empty() {
            return Some(ParsedAuthPayload {
                payload: AuthDeepLinkPayload::Error {
                    provider,
                    error: error.chars().take(MAX_ERROR_LEN).collect(),
                    state,
                },
                code: None,
            });
        }
    }

    // Tokens are deliberately forbidden in custom-protocol URIs. Only the
    // short-lived, one-time backend exchange code may cross this boundary.
    if object.contains_key("tokens") {
        return None;
    }
    let code = bounded_opaque(object.get("code")?.as_str()?, 32, MAX_EXCHANGE_CODE_LEN)?;
    Some(ParsedAuthPayload {
        payload: AuthDeepLinkPayload::Success {
            provider,
            state,
            // The profile is loaded over the authenticated API. Do not transport
            // callback PII through global application events.
            user: None,
        },
        code: Some(code.to_string()),
    })
}

fn bounded_opaque(value: &str, min_len: usize, max_len: usize) -> Option<&str> {
    let value = value.trim();
    (value.len() >= min_len
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')))
    .then_some(value)
}

pub fn is_supported_backend_domain(value: &str) -> bool {
    matches!(value, BACKEND_DOMAIN_COM | BACKEND_DOMAIN_RU)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn callback(provider: &str, state: &str) -> String {
        let payload = serde_json::json!({
            "app": "xexamai",
            "provider": provider,
            "state": state,
            "code": "one_time_code_0123456789abcdef0123456789"
        });
        let encoded: String =
            url::form_urlencoded::byte_serialize(payload.to_string().as_bytes()).collect();
        format!("xexamai://auth/callback?payload={encoded}")
    }

    #[test]
    fn one_time_code_callback_shape_is_accepted_and_redacted() {
        let parsed =
            parse_auth_payload(&callback("google", "0123456789abcdef0123456789abcdef")).unwrap();
        match parsed.payload {
            AuthDeepLinkPayload::Success {
                provider,
                state,
                user,
            } => {
                assert_eq!(provider, "google");
                assert_eq!(
                    parsed.code.as_deref(),
                    Some("one_time_code_0123456789abcdef0123456789")
                );
                assert_eq!(state.as_deref(), Some("0123456789abcdef0123456789abcdef"));
                assert!(user.is_none());
            }
            _ => panic!("expected success payload"),
        }
    }

    #[test]
    fn legacy_token_callback_is_rejected() {
        let payload = serde_json::json!({
            "app": "xexamai",
            "provider": "google",
            "state": "0123456789abcdef0123456789abcdef",
            "tokens": {"access": "access-token", "refresh": "refresh-token"}
        });
        let encoded: String =
            url::form_urlencoded::byte_serialize(payload.to_string().as_bytes()).collect();
        assert!(
            parse_auth_payload(&format!("xexamai://auth/callback?payload={encoded}")).is_none()
        );
    }

    #[test]
    fn generated_pkce_pair_is_rfc7636_s256() {
        let (verifier, challenge) = generate_pkce_pair();
        assert_eq!(verifier.len(), 43);
        assert_eq!(challenge.len(), 43);
        assert!(verifier
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')));
        assert_eq!(
            challenge,
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
        );
    }

    #[test]
    fn callback_path_and_size_are_exact() {
        let state = "0123456789abcdef0123456789abcdef";
        assert!(parse_auth_payload(&callback("github", state)).is_some());
        assert!(parse_auth_payload(
            &callback("github", state).replace("/callback?", "/callback/extra?")
        )
        .is_none());
        assert!(parse_auth_payload(&"x".repeat(MAX_DEEP_LINK_LEN + 1)).is_none());
    }

    #[tokio::test]
    async fn invalid_state_does_not_consume_valid_attempt() {
        let queue = AuthQueue::new();
        let attempt = queue.start_attempt("google", BACKEND_DOMAIN_COM).await;
        assert!(queue
            .validate_and_consume_state("google", "attacker-state")
            .await
            .is_err());
        assert!(queue
            .validate_and_consume_state("google", &attempt.state)
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn state_can_be_used_only_once() {
        let queue = AuthQueue::new();
        let attempt = queue.start_attempt("github", BACKEND_DOMAIN_RU).await;
        assert!(queue
            .validate_and_consume_state("github", &attempt.state)
            .await
            .is_ok());
        assert!(queue
            .validate_and_consume_state("github", &attempt.state)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn parallel_attempts_for_the_same_provider_are_independent() {
        let queue = AuthQueue::new();
        let first = queue.start_attempt("google", BACKEND_DOMAIN_COM).await;
        let second = queue.start_attempt("google", BACKEND_DOMAIN_COM).await;
        assert_ne!(first.state, second.state);
        assert!(queue
            .validate_and_consume_state("google", &second.state)
            .await
            .is_ok());
        assert!(queue
            .validate_and_consume_state("google", &first.state)
            .await
            .is_ok());
    }
}
