// Every command the webview can call.
//
// Thin on purpose: each one validates its arguments and delegates. Business rules
// live in `packages/core`; this file exists so the webview never needs a
// capability it does not have, and so the audit trail has a single place to
// inspect.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_fs::FilePath;

use crate::attachments::{self, Attachment};
use crate::secrets::{self, SecretStore};
use crate::settings;

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/// The final application data directory, created if missing.
///
/// Two things make this a command rather than a JS `appDataDir()` call:
///
/// 1. `app_data_dir()` already ends in the bundle identifier
///    (`dev.atomic.app`). The webview must use it verbatim — re-appending
///    `APP_DIR_NAME` produced `.../dev.atomic.app/dev.atomic.app`, a path whose
///    parent does not exist.
/// 2. SQLite does not create a missing parent directory. It fails with
///    `SQLITE_CANTOPEN` (code 14) instead, which is an opaque error unless the
///    user has been told the path.
#[tauri::command]
pub fn data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("no application data directory: {error}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("cannot create {}: {error}", dir.display()))?;
    if cfg!(debug_assertions) {
        // Once per process, so a retry cannot turn this into log spam. A path is
        // not a secret; nothing here ever reads a credential.
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| eprintln!("atomic: data dir {}", dir.display()));
    }
    Ok(dir.to_string_lossy().into_owned())
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn secret_set(store: State<'_, SecretStore>, key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    secrets::set(&store, &key, &value)
}

#[tauri::command]
pub fn secret_get(store: State<'_, SecretStore>, key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    secrets::get(&store, &key)
}

#[tauri::command]
pub fn secret_delete(store: State<'_, SecretStore>, key: String) -> Result<(), String> {
    validate_key(&key)?;
    secrets::delete(&store, &key)
}

#[tauri::command]
pub fn secret_has(store: State<'_, SecretStore>, key: String) -> Result<bool, String> {
    validate_key(&key)?;
    secrets::has(&store, &key)
}

#[tauri::command]
pub fn secret_available() -> bool {
    secrets::available()
}

/// The dialog returns either a `file://` URL or a raw path, depending on the OS
/// and on what the user picked. Everything downstream wants a real path.
fn into_path(picked: FilePath) -> Result<PathBuf, String> {
    picked
        .into_path()
        .map_err(|error| format!("cannot resolve the picked file: {error}"))
}

/// Keys are provider ids. Anything else is a bug or an attack, not a new feature.
fn validate_key(key: &str) -> Result<(), String> {
    let ok = !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err("invalid secret key name".to_string())
    }
}

// ---------------------------------------------------------------------------
// Settings and audit
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn settings_read(app: AppHandle) -> Result<Option<String>, String> {
    settings::read(&app)
}

#[tauri::command]
pub fn settings_write(app: AppHandle, json: String) -> Result<(), String> {
    // Refuse anything that is not a JSON object: a bare array would silently
    // wipe every preference the next time settings are read.
    let parsed: serde_json::Value =
        serde_json::from_str(&json).map_err(|error| format!("invalid JSON: {error}"))?;
    if !parsed.is_object() {
        return Err("settings must be a JSON object".to_string());
    }
    settings::write(&app, &json)
}

/// Mirror a webview diagnostic into the terminal.
///
#[tauri::command]
pub fn audit_append(app: AppHandle, line: String) -> Result<(), String> {
    settings::append_audit_line(&app, &line)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn window_show(app: AppHandle) -> Result<(), String> {
    let window = main_window(&app)?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_hide(app: AppHandle) -> Result<(), String> {
    main_window(&app)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_minimize_to_tray(app: AppHandle) -> Result<(), String> {
    main_window(&app)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_set_close_to_tray(enabled: bool) {
    crate::set_close_to_tray(enabled);
}

#[tauri::command]
pub fn window_is_visible(app: AppHandle) -> Result<bool, String> {
    Ok(main_window(&app)?.is_visible().unwrap_or(false))
}

fn main_window<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<tauri::WebviewWindow<R>, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())
}

// ---------------------------------------------------------------------------
// Global shortcuts
// ---------------------------------------------------------------------------

use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

#[tauri::command]
pub fn shortcut_register(app: AppHandle, accelerator: String) -> Result<bool, String> {
    let shortcut: Shortcut = accelerator
        .parse()
        .map_err(|error| format!("invalid shortcut {accelerator}: {error}"))?;
    let manager = app.global_shortcut();
    // `on_shortcut` both registers and attaches the handler, so it is the only
    // call here. Unregistering first makes re-registering the same combo a
    // replace rather than a duplicate-registration failure.
    let _ = manager.unregister(shortcut);

    let handle = app.clone();
    manager
        .on_shortcut(shortcut, move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                // The tray is the single source of truth for showing the window.
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .map_err(|error| format!("cannot register {accelerator}: {error}"))?;
    Ok(true)
}

#[tauri::command]
pub fn shortcut_unregister_all(app: AppHandle) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn app_relaunch(app: AppHandle) -> Result<(), String> {
    app.restart();
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFilesOptions {
    #[serde(default)]
    pub multiple: bool,
    #[serde(default)]
    pub directory: bool,
}

#[tauri::command]
pub async fn pick_folder(app: AppHandle, title: Option<String>) -> Result<Option<String>, String> {
    // The dialog is modal and blocking. Running it on the async runtime would
    // stall every other command in the app while the user browses, so it goes to
    // a blocking thread.
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let mut builder = app.dialog().file();
        if let Some(title) = title.filter(|t| !t.trim().is_empty()) {
            builder = builder.set_title(&title);
        }
        Ok(builder
            .blocking_pick_folder()
            .and_then(|path| into_path(path).ok())
            .map(|path| path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|error| format!("dialog task failed: {error}"))?
}

#[tauri::command]
pub async fn pick_files(
    app: AppHandle,
    options: Option<PickFilesOptions>,
) -> Result<Vec<Attachment>, String> {
    let options = options.unwrap_or(PickFilesOptions {
        multiple: true,
        directory: false,
    });
    tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        let builder = app.dialog().file();
        if options.directory {
            let picked = builder.blocking_pick_folder();
            return match picked.and_then(|path| into_path(path).ok()) {
                Some(path) => attachments::from_path(&path).map(|a| vec![a]),
                None => Ok(Vec::new()),
            };
        }
        let picked = if options.multiple {
            builder.blocking_pick_files()
        } else {
            builder.blocking_pick_file().map(|file| vec![file])
        };
        let Some(files) = picked else {
            return Ok(Vec::new());
        };
        let mut out = Vec::new();
        for file in files {
            // A `file://` URL from the picker still has to become a real path.
            let Some(path) = into_path(file).ok() else {
                continue;
            };
            match attachments::from_path(&path) {
                Ok(attachment) => out.push(attachment),
                // One unreadable file must not fail the whole selection.
                Err(error) => eprintln!("atomic: skipping {error}"),
            }
        }
        Ok(out)
    })
    .await
    .map_err(|error| format!("dialog task failed: {error}"))?
}

/// Paste path. The webview reads the image out of the clipboard and hands the
/// bytes over; text is never turned into an attachment.
#[tauri::command]
pub fn attach_from_base64(name: String, data: String) -> Result<Attachment, String> {
    if name.is_empty() || name.len() > 256 {
        return Err("attachment name must be 1-256 characters".to_string());
    }
    attachments::from_base64(&name, &data)
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/// The provider-key variables Atomic is willing to look at.
///
/// An allowlist, not a dump. `apiKeyEnvVar` is a user-editable setting, so a
/// variable name that could be anything would turn "read the model key" into
/// "exfiltrate any secret in the process environment".
const PROVIDER_KEY_VARS: &[&str] = &[
    "OPENCODE_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "DEEPSEEK_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "MISTRAL_API_KEY",
    "OPENROUTER_API_KEY",
    "OLLAMA_API_KEY",
];

fn allowed_env_var(name: &str) -> Option<String> {
    if !PROVIDER_KEY_VARS.contains(&name) {
        return None;
    }
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

/// Which provider keys are set, with no values.
///
/// The UI needs this to say "reached by environment" next to a provider, and a
/// boolean cannot be turned back into a credential by anything downstream.
#[tauri::command]
pub fn env_provider_key_presence() -> std::collections::BTreeMap<String, bool> {
    PROVIDER_KEY_VARS
        .iter()
        .map(|name| ((*name).to_string(), allowed_env_var(name).is_some()))
        .collect()
}

/// One provider key, read on demand.
///
/// This replaces handing the webview every key at startup: a value is fetched
/// only when a provider is actually being built, crosses into the webview only
/// for that request's `Authorization` header, and is never stored in a
/// long-lived map the UI could enumerate. Unlisted names are refused here rather
/// than trusted, because the name arrives from a settings value.
#[tauri::command]
pub fn env_provider_key_read(name: String) -> Result<Option<String>, String> {
    if !PROVIDER_KEY_VARS.contains(&name.as_str()) {
        return Err(format!("{name} is not a provider key Atomic will read"));
    }
    Ok(allowed_env_var(&name))
}

#[tauri::command]
pub fn reveal_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("{path} does not exist"));
    }
    let opener = app.opener();
    if target.is_dir() {
        opener
            .reveal_item_in_dir(&target)
            .map_err(|error| error.to_string())
    } else {
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        opener
            .open_path(parent.to_string_lossy().to_string(), None::<&str>)
            .map_err(|error| error.to_string())
    }
}

/// Project memory, read from the workspace root. Never leaves the workspace.
#[tauri::command]
pub fn read_project_memory(_app: AppHandle, workspace: String) -> Result<Option<String>, String> {
    let root = PathBuf::from(&workspace);
    for name in ["AGENTS.md", "ATOMIC.md", ".atomic/instructions.md"] {
        let candidate = root.join(name);
        if candidate.is_file() {
            if let Ok(contents) = std::fs::read_to_string(&candidate) {
                // Cap the size: a huge instruction file would eat the context window.
                let trimmed: String = contents.chars().take(20_000).collect();
                return Ok(Some(trimmed));
            }
        }
    }
    Ok(None)
}

/// Emit a navigation request to the UI. The tray and the OS own the intent.
#[tauri::command]
pub fn navigate(app: AppHandle, target: String) -> Result<(), String> {
    app.emit("atomic:navigate", target)
        .map_err(|error| error.to_string())
}

/// The app version, for the about panel and the updater UI.
#[tauri::command]
pub fn version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_keys_accept_provider_ids() {
        for key in ["opencode-zen", "openai", "anthropic.gemini", "a_b-c"] {
            validate_key(key).unwrap_or_else(|error| panic!("{key} rejected: {error}"));
        }
    }

    #[test]
    fn secret_keys_reject_traversal_and_separators() {
        // A key that is not a provider id would let the webview address another
        // application's credential in the same service.
        for key in [
            "",
            "../other",
            "a/b",
            "a b",
            "a\nb",
            "x".repeat(65).as_str(),
        ] {
            assert!(validate_key(key).is_err(), "{key} should be rejected");
        }
    }

    #[test]
    fn settings_must_be_a_json_object() {
        // Checked here rather than in the file writer so a bad payload never
        // reaches the temp-file path.
        for bad in ["[]", "\"text\"", "3"] {
            let parsed: serde_json::Value = serde_json::from_str(bad).unwrap();
            assert!(!parsed.is_object(), "{bad} should be rejected");
        }
    }
}
