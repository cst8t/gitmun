use tauri::Manager;

/// Opens a secondary window (settings / clone / result-log).
///
/// The window is created hidden so the webview can load and React can render
/// before anything is shown to the user. The frontend calls `show_window`
/// once it is ready. If the window already exists it is simply brought to the
/// front.
///
/// Must be `async` — on Windows, `WebviewWindowBuilder::build()` deadlocks
/// when called from a synchronous command handler because the IPC handler
/// occupies the main event-loop thread that WebView2 also needs.
#[tauri::command]
pub async fn open_sub_window(
    app: tauri::AppHandle,
    label: String,
    title: String,
    path: String,
    width: f64,
    height: f64,
    resizable: bool,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let _window = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(path.clone().into()),
    )
    .title(title)
    .inner_size(width, height)
    .resizable(resizable)
    .decorations(true)
    .closable(true)
    .minimizable(true)
    .maximizable(false)
    .focused(false)
    .visible(cfg!(target_os = "windows"))
    .build()
    .map_err(|e| e.to_string())?;

    // WebView2 on Windows can fail to navigate when the window is created
    // from the backend — the WebView2 controller initialises asynchronously
    // and the initial URL set via WebviewUrl::App may be lost. Eval calls
    // are queued internally until the controller is ready, so this reliably
    // kicks off navigation once WebView2 is initialised.
    #[cfg(target_os = "windows")]
    {
        let navigate_js = format!(
            "if (window.location.href === 'about:blank') {{ window.location.href = 'http://tauri.localhost/{}'; }}",
            path
        );
        let _ = _window.eval(&navigate_js);
    }

    Ok(())
}

/// Called by the frontend once React has rendered. Shows and focuses the
/// window — Rust shows the window directly, avoiding the IPC-latency issues
/// that plagued the JS `getCurrentWindow().show()` approach.
///
/// Works for both secondary windows and the main window.
#[tauri::command]
pub fn show_window(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(&label) {
        window.show().map_err(|e| e.to_string())?;

        #[cfg(target_os = "linux")]
        {
            // Tao's set_visible(true) only calls show_all(), which doesn't
            // signal the compositor to fully manage the window. KWin needs
            // gtk_window_present() to properly attach interactive server-side
            // decorations (close / minimise / maximise buttons).
            if let Ok(gtk_win) = window.gtk_window() {
                use gtk::prelude::GtkWindowExt;
                gtk_win.present();
            }
        }

        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
