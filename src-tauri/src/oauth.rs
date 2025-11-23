use anyhow::Result;

use crate::constants::{OAUTH_APP_NAME, SITE_BASE_URL};

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
    std::env::var(key).ok().filter(|value| !value.trim().is_empty())
}

pub fn build_oauth_start_url(provider: &str) -> Result<String> {
    let provider_lower = provider.to_lowercase();
    let key = format!("OAUTH_PROVIDER_URL_{}", provider_lower.to_uppercase());
    if let Some(override_url) = env(&key) {
        return Ok(override_url);
    }
    let base = normalize_base(env("OAUTH_START_BASE_URL"))
        .or_else(|| normalize_base(env("OAUTH_SITE_URL")))
        .or_else(|| normalize_base(env("OAUTH_BASE_URL")))
        .or_else(|| normalize_base(env("APP_BASE_URL")))
        .unwrap_or_else(|| SITE_BASE_URL.to_string());
    let mut url = url::Url::parse(&base)?;
    url.set_path(&format!("/auth/oauth/{}/start", provider_lower));
    url.set_query(Some(&format!("app_auth={}", OAUTH_APP_NAME)));
    Ok(url.to_string())
}
