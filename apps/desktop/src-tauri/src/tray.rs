// Tray icon and its menu.
//
// The tray is the app's persistent surface: it is how a closed-to-tray session
// is brought back, and how the user quits. Quitting from the tray is explicit so
// there is no way to lose a running session by accident.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Runtime,
};

fn show_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Atomic", true, None::<&str>)?;
    let new_chat = MenuItem::with_id(app, "new-chat", "New Chat", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Atomic", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &new_chat, &settings, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Atomic")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "new-chat" => {
                show_main(app);
                emit_navigation(app, "new-chat");
            }
            "settings" => {
                show_main(app);
                emit_navigation(app, "settings");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles the window, which is what a desktop user expects.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let visible = app
                    .get_webview_window("main")
                    .and_then(|window| window.is_visible().ok())
                    .unwrap_or(false);
                if visible {
                    let _ = app.get_webview_window("main").map(|w| w.hide());
                } else {
                    show_main(app);
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

/// Ask the webview to navigate. The UI owns routing, not the tray.
fn emit_navigation<R: Runtime>(app: &AppHandle<R>, target: &str) {
    use tauri::Emitter;
    let _ = app.emit("atomic:navigate", target);
}
