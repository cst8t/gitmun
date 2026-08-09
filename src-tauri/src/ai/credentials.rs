use keyring::{Entry, Error as KeyringError};

use super::AiError;

const CREDENTIAL_SERVICE: &str = "com.cst8t.gitmun.ai";
const LEGACY_CREDENTIAL_USER: &str = "api-key";

pub(crate) trait AiCredentialStore: Send + Sync {
    fn read_api_key(&self, scope: &str) -> Result<Option<String>, AiError>;
    fn set_api_key(&self, scope: &str, api_key: &str) -> Result<(), AiError>;
    fn clear_api_key(&self, scope: &str) -> Result<(), AiError>;
    fn read_legacy_api_key(&self) -> Result<Option<String>, AiError>;
    fn clear_legacy_api_key(&self) -> Result<(), AiError>;
}

#[derive(Debug, Default)]
pub(crate) struct KeyringAiCredentialStore;

impl KeyringAiCredentialStore {
    fn entry(&self, scope: &str) -> Result<Entry, AiError> {
        let credential_user = format!("api-key-{:x}", md5::compute(scope));
        Entry::new(CREDENTIAL_SERVICE, &credential_user)
            .map_err(|_| AiError::new("credentialStoreUnavailable"))
    }

    fn legacy_entry(&self) -> Result<Entry, AiError> {
        Entry::new(CREDENTIAL_SERVICE, LEGACY_CREDENTIAL_USER)
            .map_err(|_| AiError::new("credentialStoreUnavailable"))
    }

    fn read_entry(entry: Entry) -> Result<Option<String>, AiError> {
        match entry.get_password() {
            Ok(key) if !key.trim().is_empty() => Ok(Some(key)),
            Ok(_) | Err(KeyringError::NoEntry) => Ok(None),
            Err(_) => Err(AiError::new("credentialStoreUnavailable")),
        }
    }

    fn clear_entry(entry: Entry) -> Result<(), AiError> {
        match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(_) => Err(AiError::new("credentialStoreUnavailable")),
        }
    }
}

impl AiCredentialStore for KeyringAiCredentialStore {
    fn read_api_key(&self, scope: &str) -> Result<Option<String>, AiError> {
        Self::read_entry(self.entry(scope)?)
    }

    fn set_api_key(&self, scope: &str, api_key: &str) -> Result<(), AiError> {
        self.entry(scope)?
            .set_password(api_key)
            .map_err(|_| AiError::new("credentialStoreUnavailable"))
    }

    fn clear_api_key(&self, scope: &str) -> Result<(), AiError> {
        Self::clear_entry(self.entry(scope)?)
    }

    fn read_legacy_api_key(&self) -> Result<Option<String>, AiError> {
        Self::read_entry(self.legacy_entry()?)
    }

    fn clear_legacy_api_key(&self) -> Result<(), AiError> {
        Self::clear_entry(self.legacy_entry()?)
    }
}
