use serde::{Deserialize, Serialize};

use crate::constants::{BACKEND_DOMAIN_COM, BACKEND_DOMAIN_RU};
const KEYRING_SERVICE: &str = "xlartas-xexamai";
const OPENAI_ACCOUNT: &str = "provider.openai.api-key";
const GOOGLE_ACCOUNT: &str = "provider.google.api-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderSecret {
    OpenAi,
    Google,
}

impl ProviderSecret {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value.trim().to_ascii_lowercase().as_str() {
            "openai" => Ok(Self::OpenAi),
            "google" => Ok(Self::Google),
            _ => Err("Unsupported secret provider".to_string()),
        }
    }

    fn account(self) -> &'static str {
        match self {
            Self::OpenAi => OPENAI_ACCOUNT,
            Self::Google => GOOGLE_ACCOUNT,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredAuthSession {
    // Read only for migration from builds that persisted the complete pair.
    // New writes never serialize an access token.
    #[serde(default, skip_serializing)]
    access: Option<String>,
    #[serde(default)]
    refresh: Option<String>,
}

#[derive(Debug, Default)]
pub struct SecretStore;

impl SecretStore {
    pub fn new() -> Self {
        Self
    }

    pub async fn get_provider_secret(
        &self,
        provider: ProviderSecret,
    ) -> Result<Option<String>, String> {
        read_secret(provider.account()).await
    }

    pub async fn set_provider_secret(
        &self,
        provider: ProviderSecret,
        value: &str,
    ) -> Result<(), String> {
        write_secret(provider.account(), value).await
    }

    pub async fn has_provider_secret(&self, provider: ProviderSecret) -> bool {
        self.get_provider_secret(provider)
            .await
            .ok()
            .flatten()
            .is_some_and(|value| !value.trim().is_empty())
    }

    pub async fn get_auth_refresh(&self, backend_domain: &str) -> Result<Option<String>, String> {
        let account = auth_account(backend_domain)?;
        let Some(serialized) = read_secret(&account).await? else {
            return Ok(None);
        };
        let stored: StoredAuthSession = serde_json::from_str(&serialized)
            .map_err(|_| "Stored authentication session is invalid".to_string())?;
        let refresh = stored.refresh.filter(|value| !value.trim().is_empty());
        if stored.access.is_some() {
            // Migrate legacy keyring entries immediately so access tokens are never
            // retained at rest after the first read by the hardened build.
            if let Some(value) = refresh.as_deref() {
                self.set_auth_refresh(backend_domain, value).await?;
            } else {
                delete_secret(&account).await?;
            }
        }
        Ok(refresh)
    }

    pub async fn set_auth_refresh(
        &self,
        backend_domain: &str,
        refresh: &str,
    ) -> Result<(), String> {
        if refresh.trim().is_empty() || refresh.len() > 24 * 1024 {
            return Err("Refresh token is invalid".to_string());
        }
        let account = auth_account(backend_domain)?;
        let serialized = serde_json::to_string(&StoredAuthSession {
            access: None,
            refresh: Some(refresh.to_string()),
        })
        .map_err(|error| format!("Failed to serialize authentication session: {error}"))?;
        write_secret(&account, &serialized).await
    }

    pub async fn clear_auth_tokens(&self, backend_domain: &str) -> Result<(), String> {
        let account = auth_account(backend_domain)?;
        delete_secret(&account).await
    }
}

fn auth_account(backend_domain: &str) -> Result<String, String> {
    let domain = normalize_backend_domain(backend_domain)?;
    Ok(format!("auth.tokens.{domain}"))
}

fn normalize_backend_domain(value: &str) -> Result<&'static str, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        BACKEND_DOMAIN_COM => Ok(BACKEND_DOMAIN_COM),
        BACKEND_DOMAIN_RU => Ok(BACKEND_DOMAIN_RU),
        _ => Err("Unsupported backend domain".to_string()),
    }
}

async fn read_secret(account: &str) -> Result<Option<String>, String> {
    let account = account.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|error| format!("Credential store is unavailable: {error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("Failed to read credential: {error}")),
        }
    })
    .await
    .map_err(|error| format!("Credential task failed: {error}"))?
}

async fn write_secret(account: &str, value: &str) -> Result<(), String> {
    if value.trim().is_empty() {
        return delete_secret(account).await;
    }
    let account = account.to_string();
    let value = value.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|error| format!("Credential store is unavailable: {error}"))?;
        entry
            .set_password(&value)
            .map_err(|error| format!("Failed to store credential: {error}"))
    })
    .await
    .map_err(|error| format!("Credential task failed: {error}"))?
}

async fn delete_secret(account: &str) -> Result<(), String> {
    let account = account.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let entry = keyring::Entry::new(KEYRING_SERVICE, &account)
            .map_err(|error| format!("Credential store is unavailable: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Failed to delete credential: {error}")),
        }
    })
    .await
    .map_err(|error| format!("Credential task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_accounts_are_scoped_to_supported_domains() {
        assert_eq!(
            auth_account(BACKEND_DOMAIN_COM).unwrap(),
            "auth.tokens.xlartas.com"
        );
        assert_eq!(
            auth_account(BACKEND_DOMAIN_RU).unwrap(),
            "auth.tokens.xlartas.ru"
        );
        assert!(auth_account("attacker.example").is_err());
    }

    #[test]
    fn provider_names_are_strict() {
        assert_eq!(
            ProviderSecret::parse("OpenAI").unwrap(),
            ProviderSecret::OpenAi
        );
        assert_eq!(
            ProviderSecret::parse("google").unwrap(),
            ProviderSecret::Google
        );
        assert!(ProviderSecret::parse("openai-backup").is_err());
    }

    #[test]
    fn persisted_auth_session_never_serializes_access_token() {
        let session = StoredAuthSession {
            access: Some("legacy-access-token".to_string()),
            refresh: Some("refresh-token".to_string()),
        };
        let serialized = serde_json::to_string(&session).unwrap();
        assert!(!serialized.contains("legacy-access-token"));
        assert!(!serialized.contains("access"));
        assert!(serialized.contains("refresh-token"));
    }
}
