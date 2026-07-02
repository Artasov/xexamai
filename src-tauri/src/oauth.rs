use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::constants::{
    BACKEND_DOMAIN_RU, DEFAULT_BACKEND_DOMAIN, OAUTH_APP_NAME, OAUTH_SCHEME, SITE_BASE_URL,
};

const AUTH_METHODS_TIMEOUT_MS: u64 = 10_000;
const SUPPORTED_OAUTH_PROVIDERS: &[&str] = &["google", "github", "discord", "yandex"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthMethods {
    #[serde(alias = "country_code")]
    pub country_code: String,
    #[serde(alias = "country_known")]
    pub country_known: bool,
    #[serde(
        default,
        rename = "allowedOAuthProviders",
        alias = "allowed_oauth_providers",
        alias = "allowedOauthProviders"
    )]
    pub allowed_oauth_providers: Vec<String>,
    #[serde(alias = "email_password_allowed")]
    pub email_password_allowed: bool,
    #[serde(default, alias = "allowed_email_domains")]
    pub allowed_email_domains: Vec<String>,
}

fn normalize_base(input: Option<String>) -> Option<String> {
    let raw = input?.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let mut url = url::Url::parse(&raw).ok()?;
    let trimmed_path = url.path().trim_end_matches('/').to_string();
    url.set_path(&trimmed_path);
    url.set_query(None);
    url.set_fragment(None);
    Some(url.to_string().trim_end_matches('/').to_string())
}

fn env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn resolve_site_base_by_domain(backend_domain: Option<&str>) -> String {
    let resolved_domain = if backend_domain == Some(BACKEND_DOMAIN_RU) {
        BACKEND_DOMAIN_RU
    } else {
        DEFAULT_BACKEND_DOMAIN
    };
    format!("https://{resolved_domain}")
}

fn resolve_auth_api_base(backend_domain: Option<&str>) -> String {
    normalize_base(env("XEXAMAI_AUTH_API_BASE_URL"))
        .or_else(|| normalize_base(env("XEXAMAI_API_BASE_URL")))
        .or_else(|| normalize_base(env("API_BASE_URL")))
        .unwrap_or_else(|| format!("{}/api/v1", resolve_site_base_by_domain(backend_domain)))
}

fn normalize_provider(provider: &str) -> String {
    provider.trim().to_lowercase()
}

pub fn is_supported_provider(provider: &str) -> bool {
    let normalized = normalize_provider(provider);
    SUPPORTED_OAUTH_PROVIDERS.contains(&normalized.as_str())
}

pub fn provider_is_allowed(methods: &AuthMethods, provider: &str) -> bool {
    let normalized = normalize_provider(provider);
    methods
        .allowed_oauth_providers
        .iter()
        .any(|candidate| normalize_provider(candidate) == normalized)
}

fn normalize_auth_methods(mut methods: AuthMethods) -> AuthMethods {
    methods.allowed_oauth_providers = methods
        .allowed_oauth_providers
        .into_iter()
        .map(|provider| normalize_provider(&provider))
        .filter(|provider| is_supported_provider(provider))
        .collect();
    methods.allowed_email_domains = methods
        .allowed_email_domains
        .into_iter()
        .map(|domain| domain.trim().to_lowercase())
        .filter(|domain| !domain.is_empty())
        .collect();
    methods
}

pub async fn load_auth_methods(backend_domain: Option<&str>) -> Result<AuthMethods> {
    let base = resolve_auth_api_base(backend_domain);
    let url = format!("{}/auth/methods/", base.trim_end_matches('/'));
    log::info!(
        target: "auth",
        "Loading auth methods: url={} backend_domain={:?}",
        url,
        backend_domain
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(AUTH_METHODS_TIMEOUT_MS))
        .build()?;
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await?;
    let status = response.status();
    log::info!(target: "auth", "Auth methods response status: {}", status);

    if !status.is_success() {
        log::warn!(target: "auth", "Auth methods request failed: HTTP {}", status.as_u16());
        return Err(anyhow!(
            "Failed to load auth methods: HTTP {}",
            status.as_u16()
        ));
    }

    let methods = response.json::<AuthMethods>().await?;
    let methods = normalize_auth_methods(methods);
    log::info!(
        target: "auth",
        "Auth methods loaded: country={} known={} providers={:?} email_allowed={} email_domains={}",
        methods.country_code,
        methods.country_known,
        methods.allowed_oauth_providers,
        methods.email_password_allowed,
        methods.allowed_email_domains.len()
    );
    Ok(methods)
}

fn desktop_oauth_redirect_uri() -> String {
    format!("{OAUTH_SCHEME}://auth/callback")
}

fn with_desktop_oauth_query(mut url: url::Url, state: &str) -> String {
    let existing_query: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(key, _)| key != "app_auth" && key != "redirect_uri" && key != "state")
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    let redirect_uri = desktop_oauth_redirect_uri();
    url.set_query(None);
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in existing_query {
            query.append_pair(&key, &value);
        }
        query.append_pair("app_auth", OAUTH_APP_NAME);
        query.append_pair("redirect_uri", &redirect_uri);
        query.append_pair("state", state);
    }
    url.to_string()
}

pub fn build_oauth_start_url(
    provider: &str,
    backend_domain: Option<&str>,
    state: &str,
) -> Result<String> {
    let provider_lower = provider.to_lowercase();
    let key = format!("OAUTH_PROVIDER_URL_{}", provider_lower.to_uppercase());
    if let Some(override_url) = env(&key) {
        let url = with_desktop_oauth_query(
            url::Url::parse(&override_url)?,
            state,
        );
        log::info!(
            target: "auth",
            "Built OAuth start URL from provider override: provider={} key={} redirect_uri={}",
            provider_lower,
            key,
            desktop_oauth_redirect_uri()
        );
        return Ok(url);
    }
    let base = normalize_base(env("OAUTH_START_BASE_URL"))
        .or_else(|| normalize_base(env("OAUTH_SITE_URL")))
        .or_else(|| normalize_base(env("OAUTH_BASE_URL")))
        .or_else(|| normalize_base(env("APP_BASE_URL")))
        .unwrap_or_else(|| {
            if backend_domain.is_some() {
                resolve_site_base_by_domain(backend_domain)
            } else {
                SITE_BASE_URL.to_string()
            }
        });
    let mut url = url::Url::parse(&base)?;
    url.set_path(&format!("/auth/oauth/{}/start", provider_lower));
    let result = with_desktop_oauth_query(url, state);
    log::info!(
        target: "auth",
        "Built OAuth start URL: provider={} base={} redirect_uri={}",
        provider_lower,
        base,
        desktop_oauth_redirect_uri()
    );
    Ok(result)
}
