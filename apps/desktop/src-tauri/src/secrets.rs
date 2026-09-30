// The OS keychain.
//
// One rule: a provider API key lives here and nowhere else. It is never written
// to SQLite, never returned in a settings blob, and never included in an error
// message. The webview can ask whether a key exists and can set or clear one, but
// reading a value back is only used to put it in an Authorization header.

use keyring::{Entry, Error as KeyringError};

/// Tauri state wrapper so the keyring entry list survives across commands.
pub struct SecretStore {
    service: String,
}

impl SecretStore {
    pub fn new() -> Self {
        Self {
            service: "dev.atomic.app".to_string(),
        }
    }

    fn entry(&self, key: &str) -> Result<Entry, String> {
        Entry::new(&self.service, key).map_err(|error| describe(&error))
    }
}

impl Default for SecretStore {
    fn default() -> Self {
        Self::new()
    }
}

pub fn get(store: &SecretStore, key: &str) -> Result<Option<String>, String> {
    let entry = store.entry(key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        // "Absent" is a normal state, not an error the UI should see.
        Err(KeyringError::NoEntry) => Ok(None),
        Err(error) => Err(describe(&error)),
    }
}

pub fn set(store: &SecretStore, key: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return delete(store, key);
    }
    store
        .entry(key)?
        .set_password(value)
        .map_err(|error| describe(&error))
}

pub fn delete(store: &SecretStore, key: &str) -> Result<(), String> {
    match store.entry(key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(describe(&error)),
    }
}

pub fn has(store: &SecretStore, key: &str) -> Result<bool, String> {
    Ok(get(store, key)?.is_some())
}

/// Probe the platform credential store without writing anything.
pub fn available() -> bool {
    match Entry::new("dev.atomic.app", "atomic-probe") {
        Ok(entry) => {
            // Reading is the only reliable availability test across all three
            // backends; a miss is a success for our purposes.
            matches!(entry.get_password(), Ok(_) | Err(KeyringError::NoEntry))
        }
        Err(_) => false,
    }
}

/// Never echo the keyring's own message for a failure that could quote a value.
fn describe(error: &KeyringError) -> String {
    match error {
        KeyringError::NoEntry => "No credential stored.".to_string(),
        KeyringError::PlatformFailure(_) => {
            "The system credential store is unavailable.".to_string()
        }
        _ => "The system credential store rejected the request.".to_string(),
    }
}
