// xid-keychain Tauri plugin -- reference implementation.
//
// This file is a Rust template/example, NOT part of the cargo build.
// Copy it into your app's src-tauri/src/ and register the plugin.
//
// The JS adapter (createTauriKeychainAdapter) calls three commands:
//   plugin:xid-keychain|get    { key: String }         -> Option<String>
//   plugin:xid-keychain|set    { key: String, value: String } -> ()
//   plugin:xid-keychain|delete { key: String }         -> ()
//
// This implementation uses the OS-native secret store via the
// `keyring` crate (https://crates.io/crates/keyring), which maps to:
//   macOS  -> Keychain
//   Windows -> Credential Manager
//   Linux  -> libsecret / Secret Service
//
// -------------------------------------------------------------------------
// Cargo.toml additions required:
// -------------------------------------------------------------------------
// [dependencies]
// tauri = { version = "2", features = [] }
// keyring = "2"
// serde = { version = "1", features = ["derive"] }
// serde_json = "1"
//
// [lib]
// name = "xid_keychain"
// crate-type = ["staticlib", "cdylib", "rlib"]
// -------------------------------------------------------------------------

use tauri::{command, plugin::{Builder, TauriPlugin}, Runtime};
use keyring::Entry;

// Service name used as the keychain "service" identifier.
// Change this to your app's bundle identifier for uniqueness.
const SERVICE_NAME: &str = "xid-keychain";

#[command]
fn get(key: String) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[command]
fn set(key: String, value: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[command]
fn delete(key: String) -> Result<(), String> {
    let entry = Entry::new(SERVICE_NAME, &key).map_err(|e| e.to_string())?;
    // keyring 2.x uses delete_password(); keyring 3.x renamed it to delete_credential().
    // This template targets keyring = "2" as declared in the Cargo.toml comment above.
    match entry.delete_password() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()), // idempotent delete
        Err(e) => Err(e.to_string()),
    }
}

/// Build the Tauri plugin and register all commands.
/// Call this in your tauri::Builder::default() chain.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("xid-keychain")
        .invoke_handler(tauri::generate_handler![get, set, delete])
        .build()
}
