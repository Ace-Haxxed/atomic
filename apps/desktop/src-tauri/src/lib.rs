// Atomic — native shell.
//
// Responsibilities kept here on purpose: anything that needs an OS credential,
// the filesystem, a window, or a global shortcut. The agent runtime itself lives
// in TypeScript (`packages/core`) and never crosses this boundary except through
// the commands below.

mod attachments;
mod checkpoint_commands;
mod commands;
mod folder_commands;
mod fs_commands;
mod process_commands;
mod secrets;
mod settings;
mod tray;
mod workspace;

use std::sync::Mutex;

#[cfg(target_os = "macos")]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::{Manager, WindowEvent};

use crate::secrets::SecretStore;

/// Set when the user asks the window to close into the tray instead of quitting.
static CLOSE_TO_TRAY: Mutex<bool> = Mutex::new(true);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // A second launch must focus the running window, never start a rival process
    // that would fight over the SQLite file and the global shortcut.
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            show_main_window(&window);
        }
    }));

    let app = builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        // The webview is subject to CORS, and neither https://opencode.ai nor
        // https://models.dev send Access-Control-Allow-Origin. This plugin
        // rewrites webview fetch/XHR to a custom protocol that Rust serves, so
        // model calls work from `tauri://localhost` without a proxy. It also
        // preserves streaming, which a request/response command would not.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(SecretStore::new())
        .setup(|app| {
            install_menu(app.handle())?;
            tray::build(app.handle())?;
            // The window is created hidden so the user never sees an empty frame.
            if let Some(window) = app.get_webview_window("main") {
                show_main_window(&window);
            } else {
                eprintln!("atomic: no main window in tauri.conf.json");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if close_to_tray() {
                    // Keep running in the tray instead of destroying the session.
                    api.prevent_close();
                    // A hide that fails would strand an invisible process holding
                    // the database lock, so close for real instead.
                    if window.hide().is_err() {
                        eprintln!("atomic: hide failed, closing window");
                    }
                }
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new-chat" => emit_navigation(app, "new-chat"),
            "settings" => emit_navigation(app, "settings"),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            commands::data_dir,
            checkpoint_commands::checkpoint_save,
            checkpoint_commands::checkpoint_list,
            checkpoint_commands::checkpoint_restore,
            checkpoint_commands::checkpoint_discard,
            fs_commands::fs_read,
            fs_commands::fs_write,
            fs_commands::fs_list,
            fs_commands::fs_glob,
            fs_commands::fs_grep,
            folder_commands::check_folder,
            process_commands::process_run,
            process_commands::git_run,
            process_commands::git_is_repository,
            process_commands::git_default_branch,
            commands::secret_set,
            commands::secret_get,
            commands::secret_delete,
            commands::secret_has,
            commands::secret_available,
            commands::settings_read,
            commands::settings_write,
            commands::audit_append,
            commands::window_show,
            commands::window_hide,
            commands::window_minimize_to_tray,
            commands::window_set_close_to_tray,
            commands::window_is_visible,
            commands::shortcut_register,
            commands::shortcut_unregister_all,
            commands::app_relaunch,
            commands::pick_folder,
            commands::pick_files,
            commands::attach_from_base64,
            commands::env_provider_key_presence,
            commands::env_provider_key_read,
            commands::reveal_path,
            commands::read_project_memory,
            commands::navigate,
            commands::version,
        ])
        .run(tauri::generate_context!());

    if let Err(error) = app {
        // A panic here means no window at all, so say it on stderr where the
        // bundler's log capture can find it.
        eprintln!("atomic: failed to start: {error}");
        std::process::exit(1);
    }
}

/// Exposed for the tray module, which lives in its own file for readability.
pub(crate) fn close_to_tray() -> bool {
    CLOSE_TO_TRAY.lock().map(|value| *value).unwrap_or(true)
}

pub(crate) fn set_close_to_tray(value: bool) {
    if let Ok(mut guard) = CLOSE_TO_TRAY.lock() {
        *guard = value;
    }
}

/// The macOS menu bar.
///
/// The standard edit items are not decoration: without them, Cmd+C and Cmd+V do
/// nothing inside the chat composer, because a webview has no menu of its own.
#[cfg(target_os = "macos")]
fn install_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    let new_chat = MenuItem::with_id(app, "new-chat", "New Chat", true, Some("CmdOrCtrl+N"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;

    let menu = Menu::with_items(
        app,
        &[
            &PredefinedMenuItem::about(app, Some("Atomic"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &new_chat,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::close_window(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    app.set_menu(menu)?;
    app.set_on_menu_event(|_app, _event| {});
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn install_menu<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    Ok(())
}

fn emit_navigation<R: tauri::Runtime>(app: &tauri::AppHandle<R>, target: &str) {
    use tauri::Emitter;
    let _ = app.emit("atomic:navigate", target);
}

/// Reveal the window and focus it, reporting rather than swallowing a failure.
///
/// Used by startup, by a second launch, and by the tray, so the diagnostics
/// belong in one place.
fn show_main_window<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    for (what, result) in [
        ("show", window.show()),
        ("unminimize", window.unminimize()),
        ("focus", window.set_focus()),
    ] {
        if let Err(error) = result {
            eprintln!("atomic: window {what} failed: {error}");
        }
    }
}
