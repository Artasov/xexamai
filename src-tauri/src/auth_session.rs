use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{State, WebviewWindow};
use tokio::sync::{watch, Mutex};

use crate::activity::ActivityGate;
use crate::auth::is_supported_backend_domain;
use crate::config::ConfigState;
use crate::secret_store::SecretStore;
use crate::types::{AuthSessionCapability, AuthTokensPayload};

const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_AUTH_RESPONSE_BYTES: usize = 1024 * 1024;
const AUTH_HTTP_ERROR_PREFIX: &str = "Authentication request failed with HTTP ";

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthCommandError {
    pub code: String,
    pub status: Option<u16>,
    pub retryable: bool,
    pub message: String,
}

impl From<String> for AuthCommandError {
    fn from(message: String) -> Self {
        if let Some(status) = message
            .strip_prefix(AUTH_HTTP_ERROR_PREFIX)
            .and_then(|value| value.parse::<u16>().ok())
        {
            return Self {
                code: "auth_http_error".to_string(),
                status: Some(status),
                retryable: status >= 500 || status == 408 || status == 429,
                message,
            };
        }
        if message == "Authentication operation was superseded" {
            return Self {
                code: "auth_superseded".to_string(),
                status: None,
                retryable: true,
                message,
            };
        }
        if message == "No refresh token is available" {
            return Self {
                code: "auth_session_missing".to_string(),
                status: Some(401),
                retryable: false,
                message,
            };
        }
        let retryable = message.starts_with("Login request failed:")
            || message.starts_with("Token refresh request failed:")
            || message.starts_with("Desktop OAuth exchange failed:");
        Self {
            code: if retryable {
                "auth_network_error".to_string()
            } else {
                "auth_internal_error".to_string()
            },
            status: None,
            retryable,
            message,
        }
    }
}

pub struct AuthSessionState {
    epoch: AtomicU64,
    mutation_gate: Mutex<()>,
    refresh_gate: Mutex<()>,
    epoch_tx: watch::Sender<u64>,
    access_by_domain: Mutex<HashMap<String, String>>,
}

impl AuthSessionState {
    pub fn new() -> Self {
        let (epoch_tx, _) = watch::channel(0);
        Self {
            epoch: AtomicU64::new(0),
            mutation_gate: Mutex::new(()),
            refresh_gate: Mutex::new(()),
            epoch_tx,
            access_by_domain: Mutex::new(HashMap::new()),
        }
    }

    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    pub async fn cancel_pending_operations(&self) {
        // Invalidate immediately, then wait for a mutation that may currently
        // be restoring the credential-store value it observed before writing.
        self.bump_epoch();
        let _guard = self.mutation_gate.lock().await;
    }

    fn bump_epoch(&self) -> u64 {
        let next = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let _ = self.epoch_tx.send(next);
        next
    }

    fn commit_epoch(&self, expected_epoch: u64) -> Result<u64, String> {
        let next_epoch = expected_epoch.saturating_add(1);
        self.epoch
            .compare_exchange(
                expected_epoch,
                next_epoch,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .map_err(|_| "Authentication operation was superseded".to_string())?;
        let _ = self.epoch_tx.send(next_epoch);
        Ok(next_epoch)
    }

    pub async fn replace_tokens(
        &self,
        secrets: &SecretStore,
        backend_domain: &str,
        tokens: &AuthTokensPayload,
    ) -> Result<u64, String> {
        let expected_epoch = self.bump_epoch();
        self.store_tokens_if_current(secrets, backend_domain, expected_epoch, tokens)
            .await
            .map(|(epoch, _)| epoch)
    }

    async fn replace_tokens_if_current(
        &self,
        secrets: &SecretStore,
        backend_domain: &str,
        expected_epoch: u64,
        tokens: &AuthTokensPayload,
    ) -> Result<AuthSessionCapability, String> {
        self.store_tokens_if_current(secrets, backend_domain, expected_epoch, tokens)
            .await
            .map(|(_, capability)| capability)
    }

    async fn store_tokens_if_current(
        &self,
        secrets: &SecretStore,
        backend_domain: &str,
        expected_epoch: u64,
        tokens: &AuthTokensPayload,
    ) -> Result<(u64, AuthSessionCapability), String> {
        let _guard = self.mutation_gate.lock().await;
        if self.epoch() != expected_epoch {
            return Err("Authentication operation was superseded".to_string());
        }
        let refresh = required_refresh(tokens)?;
        let previous_refresh = secrets.get_auth_refresh(backend_domain).await?;
        if self.epoch() != expected_epoch {
            return Err("Authentication operation was superseded".to_string());
        }
        secrets.set_auth_refresh(backend_domain, refresh).await?;
        let mut access_by_domain = self.access_by_domain.lock().await;
        let committed_epoch = match self.commit_epoch(expected_epoch) {
            Ok(epoch) => epoch,
            Err(error) => {
                drop(access_by_domain);
                let restore_result = match previous_refresh {
                    Some(previous) => secrets.set_auth_refresh(backend_domain, &previous).await,
                    None => secrets.clear_auth_tokens(backend_domain).await,
                };
                if let Err(restore_error) = restore_result {
                    log::error!(
                        target: "auth",
                        "Could not restore the credential store after a superseded auth operation: {restore_error}"
                    );
                }
                return Err(error);
            }
        };
        access_by_domain.insert(backend_domain.to_string(), tokens.access.clone());
        Ok((
            committed_epoch,
            AuthSessionCapability {
                access: tokens.access.clone(),
            },
        ))
    }

    pub async fn clear_domain(
        &self,
        secrets: &SecretStore,
        backend_domain: &str,
    ) -> Result<(), String> {
        // Invalidate network operations immediately, before waiting for the keyring.
        self.bump_epoch();
        let _guard = self.mutation_gate.lock().await;
        self.access_by_domain.lock().await.remove(backend_domain);
        secrets.clear_auth_tokens(backend_domain).await
    }

    async fn access_capability(&self, backend_domain: &str) -> Option<AuthSessionCapability> {
        self.access_by_domain
            .lock()
            .await
            .get(backend_domain)
            .cloned()
            .map(|access| AuthSessionCapability { access })
    }

    pub(crate) async fn access_token_for_domain(&self, backend_domain: &str) -> Option<String> {
        self.access_by_domain
            .lock()
            .await
            .get(backend_domain)
            .cloned()
    }

    pub(crate) async fn refresh_if_access_is_stale(
        &self,
        secrets: &SecretStore,
        backend_domain: &str,
        stale_access: &str,
    ) -> Result<AuthSessionCapability, String> {
        let _refresh_guard = self.refresh_gate.lock().await;
        if let Some(current) = self.access_capability(backend_domain).await {
            if current.access != stale_access {
                return Ok(current);
            }
        }
        refresh_session_locked(secrets, self, backend_domain).await
    }

    pub async fn exchange_desktop_oauth_code(
        &self,
        secrets: &SecretStore,
        backend_domain: &str,
        provider: &str,
        state: &str,
        code: &str,
        code_verifier: &str,
    ) -> Result<AuthSessionCapability, String> {
        validate_desktop_exchange(provider, state, code, code_verifier)?;
        let expected_epoch = self.epoch();
        let mut epoch_changes = self.epoch_tx.subscribe();
        let request = async {
            let response = auth_client()?
                .post(auth_endpoint(
                    backend_domain,
                    "/auth/oauth/desktop/exchange/",
                )?)
                .json(&serde_json::json!({
                    "app": "xexamai",
                    "provider": provider,
                    "state": state,
                    "code": code,
                    "code_verifier": code_verifier,
                }))
                .send()
                .await
                .map_err(|error| format!("Desktop OAuth exchange failed: {error}"))?;
            parse_token_response(response).await
        };
        let response = tokio::select! {
            response = request => response?,
            _ = wait_for_epoch_change(&mut epoch_changes, expected_epoch) => {
                return Err("Authentication operation was superseded".to_string());
            }
        };
        let tokens = AuthTokensPayload {
            access: response.access,
            refresh: Some(
                response
                    .refresh
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        "Desktop OAuth exchange response is missing a refresh token".to_string()
                    })?,
            ),
        };
        validate_tokens(&tokens)?;
        self.replace_tokens_if_current(secrets, backend_domain, expected_epoch, &tokens)
            .await
    }
}

#[derive(Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthLoginResult {
    pub access: String,
    #[specta(type = specta_typescript::Unknown)]
    pub user: Value,
}

#[derive(Deserialize)]
struct BackendTokenResponse {
    access: String,
    #[serde(default)]
    refresh: Option<String>,
    #[serde(default)]
    user: Option<Value>,
}

#[tauri::command]
#[specta::specta]
pub async fn auth_session_bootstrap(
    window: WebviewWindow,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
    sessions: State<'_, Arc<AuthSessionState>>,
) -> Result<Option<AuthSessionCapability>, AuthCommandError> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let domain = config.get().await.backend_domain;
    if let Some(capability) = sessions.access_capability(&domain).await {
        return Ok(Some(capability));
    }
    if secrets.get_auth_refresh(&domain).await?.is_none() {
        return Ok(None);
    }
    refresh_session(secrets.inner(), sessions.inner(), &domain)
        .await
        .map(Some)
        .map_err(Into::into)
}

#[tauri::command]
#[specta::specta]
pub async fn auth_session_import_legacy(
    window: WebviewWindow,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
    sessions: State<'_, Arc<AuthSessionState>>,
    tokens: AuthTokensPayload,
) -> Result<AuthSessionCapability, AuthCommandError> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    validate_tokens(&tokens)?;
    let domain = config.get().await.backend_domain;
    sessions
        .replace_tokens(secrets.inner(), &domain, &tokens)
        .await?;
    Ok(AuthSessionCapability {
        access: tokens.access,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn auth_session_login(
    window: WebviewWindow,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
    sessions: State<'_, Arc<AuthSessionState>>,
    email: String,
    password: String,
) -> Result<AuthLoginResult, AuthCommandError> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let email = email.trim();
    if email.is_empty() || email.len() > 320 || password.is_empty() || password.len() > 4_096 {
        return Err("Invalid login credentials".to_string().into());
    }
    let domain = config.get().await.backend_domain;
    let expected_epoch = sessions.epoch();
    let mut epoch_changes = sessions.epoch_tx.subscribe();
    let login_request = async {
        let response = auth_client()?
            .post(auth_endpoint(&domain, "/auth/login/")?)
            .json(&serde_json::json!({"email": email, "password": password}))
            .send()
            .await
            .map_err(|error| format!("Login request failed: {error}"))?;
        parse_token_response(response).await
    };
    let response = tokio::select! {
        response = login_request => response?,
        _ = wait_for_epoch_change(&mut epoch_changes, expected_epoch) => {
            return Err("Authentication operation was superseded".to_string().into());
        }
    };
    let user = response
        .user
        .ok_or_else(|| "Login response is missing the user profile".to_string())?;
    let tokens = AuthTokensPayload {
        access: response.access,
        refresh: Some(
            response
                .refresh
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "Login response is missing a refresh token".to_string())?,
        ),
    };
    validate_tokens(&tokens)?;
    let capability = sessions
        .replace_tokens_if_current(secrets.inner(), &domain, expected_epoch, &tokens)
        .await?;
    Ok(AuthLoginResult {
        access: capability.access,
        user,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn auth_session_refresh(
    window: WebviewWindow,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
    sessions: State<'_, Arc<AuthSessionState>>,
) -> Result<AuthSessionCapability, AuthCommandError> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let domain = config.get().await.backend_domain;
    refresh_session(secrets.inner(), sessions.inner(), &domain)
        .await
        .map_err(Into::into)
}

#[tauri::command]
#[specta::specta]
pub async fn auth_session_logout(
    window: WebviewWindow,
    activity: State<'_, Arc<ActivityGate>>,
    config: State<'_, Arc<ConfigState>>,
    secrets: State<'_, Arc<SecretStore>>,
    sessions: State<'_, Arc<AuthSessionState>>,
) -> Result<(), AuthCommandError> {
    ensure_main_window(&window)?;
    let _activity = activity.try_begin_work()?;
    let domain = config.get().await.backend_domain;
    let refresh_result = secrets.get_auth_refresh(&domain).await;
    let refresh = refresh_result.as_ref().ok().and_then(|value| value.clone());
    // Always attempt local invalidation even when the credential-store read used
    // for remote revocation failed.
    let clear_result = sessions.clear_domain(secrets.inner(), &domain).await;

    // Local logout is immediate and authoritative for the desktop. Server-side
    // family revocation is best effort so a network outage cannot trap the user in
    // an authenticated UI, while a reachable backend invalidates the refresh token.
    if let Some(refresh) = refresh {
        let endpoint = auth_endpoint(&domain, "/auth/logout/")?;
        if let Ok(client) = auth_client() {
            let request = client
                .post(endpoint)
                .json(&serde_json::json!({"refresh": refresh}))
                .send();
            let _ = tokio::time::timeout(Duration::from_secs(5), request).await;
        }
    }
    clear_result?;
    refresh_result.map(|_| ())?;
    Ok(())
}

async fn refresh_session(
    secrets: &SecretStore,
    sessions: &AuthSessionState,
    domain: &str,
) -> Result<AuthSessionCapability, String> {
    let _refresh_guard = sessions.refresh_gate.lock().await;
    refresh_session_locked(secrets, sessions, domain).await
}

async fn refresh_session_locked(
    secrets: &SecretStore,
    sessions: &AuthSessionState,
    domain: &str,
) -> Result<AuthSessionCapability, String> {
    let expected_epoch = sessions.epoch();
    let refresh = secrets
        .get_auth_refresh(domain)
        .await?
        .ok_or_else(|| "No refresh token is available".to_string())?;
    if sessions.epoch() != expected_epoch {
        return Err("Authentication operation was superseded".to_string());
    }
    let mut epoch_changes = sessions.epoch_tx.subscribe();
    let refresh_request = async {
        let response = auth_client()?
            .post(auth_endpoint(domain, "/auth/refresh/")?)
            .json(&serde_json::json!({"refresh": refresh}))
            .send()
            .await
            .map_err(|error| format!("Token refresh request failed: {error}"))?;
        parse_token_response(response).await
    };
    let response = tokio::select! {
        response = refresh_request => response?,
        _ = wait_for_epoch_change(&mut epoch_changes, expected_epoch) => {
            return Err("Authentication operation was superseded".to_string());
        }
    };
    let tokens = AuthTokensPayload {
        access: response.access,
        // The backend currently rotates refresh tokens. Never combine a new access
        // token with an older refresh token from a possibly different session.
        refresh: Some(
            response
                .refresh
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    "Refresh response is missing the rotated refresh token".to_string()
                })?,
        ),
    };
    validate_tokens(&tokens)?;
    sessions
        .replace_tokens_if_current(secrets, domain, expected_epoch, &tokens)
        .await
}

fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Command is not available to this window".to_string())
    }
}

fn auth_endpoint(domain: &str, path: &str) -> Result<String, String> {
    if !is_supported_backend_domain(domain)
        || !matches!(
            path,
            "/auth/login/" | "/auth/refresh/" | "/auth/logout/" | "/auth/oauth/desktop/exchange/"
        )
    {
        return Err("Unsupported authentication endpoint".to_string());
    }
    Ok(format!("https://{domain}/api/v1{path}"))
}

fn validate_desktop_exchange(
    provider: &str,
    state: &str,
    code: &str,
    code_verifier: &str,
) -> Result<(), String> {
    let valid_provider = matches!(provider, "google" | "github" | "discord" | "yandex");
    let valid_opaque = |value: &str, minimum: usize, maximum: usize| {
        (minimum..=maximum).contains(&value.len())
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    };
    if !valid_provider
        || !valid_opaque(state, 16, 256)
        || !valid_opaque(code, 32, 512)
        || !valid_opaque(code_verifier, 43, 128)
    {
        return Err("Invalid desktop OAuth exchange".to_string());
    }
    Ok(())
}

fn auth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(AUTH_TIMEOUT)
        .build()
        .map_err(|error| format!("Failed to initialize authentication client: {error}"))
}

async fn wait_for_epoch_change(receiver: &mut watch::Receiver<u64>, expected: u64) {
    while *receiver.borrow_and_update() == expected {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

async fn parse_token_response(response: reqwest::Response) -> Result<BackendTokenResponse, String> {
    let status = response.status();
    let bytes = collect_bounded(response, MAX_AUTH_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!("{AUTH_HTTP_ERROR_PREFIX}{}", status.as_u16()));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Authentication server returned an invalid response".to_string())
}

async fn collect_bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Failed to read authentication response: {error}"))?;
        if output.len().saturating_add(chunk.len()) > limit {
            return Err("Authentication response is too large".to_string());
        }
        output.extend_from_slice(&chunk);
    }
    Ok(output)
}

fn validate_tokens(tokens: &AuthTokensPayload) -> Result<(), String> {
    if tokens.access.trim().is_empty()
        || tokens.access.len() > 24 * 1024
        || tokens
            .refresh
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 24 * 1024)
    {
        return Err("Invalid authentication token response".to_string());
    }
    Ok(())
}

fn required_refresh(tokens: &AuthTokensPayload) -> Result<&str, String> {
    tokens
        .refresh
        .as_deref()
        .filter(|value| !value.trim().is_empty() && value.len() <= 24 * 1024)
        .ok_or_else(|| "Authentication response is missing a refresh token".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{BACKEND_DOMAIN_COM, BACKEND_DOMAIN_RU};

    #[test]
    fn auth_endpoints_are_exact_and_https_only() {
        assert_eq!(
            auth_endpoint(BACKEND_DOMAIN_COM, "/auth/refresh/").unwrap(),
            "https://xlartas.com/api/v1/auth/refresh/"
        );
        assert!(auth_endpoint("localhost", "/auth/refresh/").is_err());
        assert!(auth_endpoint(BACKEND_DOMAIN_RU, "/admin/").is_err());
        assert_eq!(
            auth_endpoint(BACKEND_DOMAIN_COM, "/auth/oauth/desktop/exchange/").unwrap(),
            "https://xlartas.com/api/v1/auth/oauth/desktop/exchange/"
        );
    }

    #[test]
    fn desktop_exchange_arguments_are_bounded_and_opaque() {
        assert!(validate_desktop_exchange(
            "google",
            "0123456789abcdef0123456789abcdef",
            "code_0123456789abcdef0123456789abcdef",
            &"v".repeat(64),
        )
        .is_ok());
        assert!(validate_desktop_exchange(
            "google",
            "0123456789abcdef0123456789abcdef",
            "code with spaces that is deliberately invalid",
            &"v".repeat(64),
        )
        .is_err());
    }

    #[test]
    fn refresh_rotation_requires_complete_new_pair() {
        let missing_refresh = AuthTokensPayload {
            access: "access".to_string(),
            refresh: None,
        };
        // Structural validation is shared by transient responses; persistence has
        // the stronger `required_refresh` invariant.
        assert!(validate_tokens(&missing_refresh).is_ok());
        assert!(required_refresh(&missing_refresh).is_err());
    }

    #[test]
    fn command_errors_preserve_terminal_vs_retryable_status() {
        let unauthorized = AuthCommandError::from(format!("{AUTH_HTTP_ERROR_PREFIX}401"));
        assert_eq!(unauthorized.status, Some(401));
        assert!(!unauthorized.retryable);

        let unavailable = AuthCommandError::from(format!("{AUTH_HTTP_ERROR_PREFIX}503"));
        assert_eq!(unavailable.status, Some(503));
        assert!(unavailable.retryable);

        let network = AuthCommandError::from("Token refresh request failed: offline".to_string());
        assert_eq!(network.code, "auth_network_error");
        assert!(network.retryable);
    }

    #[tokio::test]
    async fn cancellation_prevents_a_post_await_token_commit() {
        let sessions = AuthSessionState::new();
        let expected_epoch = sessions.epoch();

        sessions.cancel_pending_operations().await;

        assert_eq!(
            sessions.commit_epoch(expected_epoch),
            Err("Authentication operation was superseded".to_string())
        );
    }
}
