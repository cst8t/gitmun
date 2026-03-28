use crate::git::types::ThemeMode;
use tauri::{Manager, Theme, window::Color};

const LIGHT_WINDOW_BACKGROUND_COLOUR: Color = Color(244, 246, 251, 255);
const DARK_WINDOW_BACKGROUND_COLOUR: Color = Color(15, 17, 23, 255);
const LIGHT_WINDOW_BACKGROUND_HEX: &str = "#f4f6fb";
const DARK_WINDOW_BACKGROUND_HEX: &str = "#0f1117";

fn resolve_system_theme(app: &tauri::AppHandle) -> Theme {
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(theme) = window.theme() {
            return theme;
        }
    }
    Theme::Dark
}

pub(crate) fn background_colour_for_theme_mode(
    app: &tauri::AppHandle,
    theme_mode: &ThemeMode,
) -> Color {
    match theme_mode {
        ThemeMode::Light => LIGHT_WINDOW_BACKGROUND_COLOUR,
        ThemeMode::Dark => DARK_WINDOW_BACKGROUND_COLOUR,
        ThemeMode::System => match resolve_system_theme(app) {
            Theme::Light => LIGHT_WINDOW_BACKGROUND_COLOUR,
            Theme::Dark => DARK_WINDOW_BACKGROUND_COLOUR,
            _ => DARK_WINDOW_BACKGROUND_COLOUR,
        },
    }
}

fn initial_theme_injection_script() -> String {
    r#"
      (() => {
        try {
          const storedMode = localStorage.getItem("gitmun.themeMode");
          const theme = storedMode === "Light"
            ? "light"
            : storedMode === "Dark"
              ? "dark"
              : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
          const background = theme === "dark" ? "__GITMUN_DARK_BACKGROUND__" : "__GITMUN_LIGHT_BACKGROUND__";
          const html = document.documentElement;
          html.dataset.theme = theme;
          html.style.background = background;
          if (document.body) {
            document.body.style.background = background;
          } else {
            document.addEventListener(
              "DOMContentLoaded",
              () => {
                if (document.body) document.body.style.background = background;
              },
              { once: true }
            );
          }
        } catch (_) {}

        try {
          const handler = (event) => {
            if (
              event.target &&
              typeof event.target.closest === "function" &&
              event.target.closest("[data-allow-native-context-menu='true']")
            ) {
              return;
            }
            event.preventDefault();
          };
          window.addEventListener("contextmenu", handler, true);
        } catch (_) {}
      })();
    "#
    .replace("__GITMUN_DARK_BACKGROUND__", DARK_WINDOW_BACKGROUND_HEX)
    .replace("__GITMUN_LIGHT_BACKGROUND__", LIGHT_WINDOW_BACKGROUND_HEX)
}

#[tauri::command]
pub async fn open_sub_window(
    app: tauri::AppHandle,
    label: String,
    title: String,
    path: String,
    width: f64,
    height: f64,
    resizable: bool,
    show_immediately: bool,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let settings = state.git_service.get_settings();
    let background_colour = background_colour_for_theme_mode(&app, &settings.theme_mode);

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_background_color(Some(background_colour));
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
    .focused(show_immediately)
    .visible(show_immediately)
    .background_color(background_colour)
    .initialization_script(initial_theme_injection_script())
    .build()
    .map_err(|e| e.to_string())?;

    // WebView2 on Windows can fail to navigate when the window is created
    // from the backend - the WebView2 controller initialises asynchronously
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
/// window - Rust shows the window directly, avoiding the IPC-latency issues
/// that plagued the JS `getCurrentWindow().show()` approach.
///
/// Works for both secondary windows and the main window.
#[tauri::command]
pub fn show_window(
    app: tauri::AppHandle,
    label: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let settings = state.git_service.get_settings();
    let background_colour = background_colour_for_theme_mode(&app, &settings.theme_mode);

    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_background_color(Some(background_colour));

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
