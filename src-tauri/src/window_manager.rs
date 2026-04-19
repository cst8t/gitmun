use crate::git::types::ThemeMode;
use tauri::webview::NewWindowResponse;
use tauri::{Manager, Theme, window::Color};
use tauri_plugin_shell::ShellExt;

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

fn initial_theme_injection_script(system_theme: &str) -> String {
    r#"
      (() => {
        try {
          const storedMode = localStorage.getItem("gitmun.themeMode");
          const systemTheme = "__GITMUN_SYSTEM_THEME__";
          const theme = storedMode === "Light"
            ? "light"
            : storedMode === "Dark"
              ? "dark"
              : (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : systemTheme);
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
    .replace("__GITMUN_SYSTEM_THEME__", system_theme)
}

fn centred_sub_window_position(
    app: &tauri::AppHandle,
    width: f64,
    height: f64,
) -> Option<(f64, f64)> {
    let main_window = app.get_webview_window("main")?;
    let scale_factor = main_window.scale_factor().ok()?;
    let outer_position = main_window.outer_position().ok()?;
    let outer_size = main_window.outer_size().ok()?;
    let inner_size = main_window.inner_size().ok()?;

    let main_x = outer_position.x as f64 / scale_factor;
    let main_y = outer_position.y as f64 / scale_factor;
    let main_width = outer_size.width as f64 / scale_factor;
    let main_height = outer_size.height as f64 / scale_factor;

    // Use the main window's current decoration thickness to better estimate
    // the child window's outer frame on the active platform.
    let decoration_width = outer_size.width.saturating_sub(inner_size.width) as f64 / scale_factor;
    let decoration_height =
        outer_size.height.saturating_sub(inner_size.height) as f64 / scale_factor;

    let child_outer_width = width + decoration_width;
    let child_outer_height = height + decoration_height;

    Some((
        (main_x + (main_width - child_outer_width) / 2.0).round(),
        (main_y + (main_height - child_outer_height) / 2.0).round(),
    ))
}

fn should_open_url_externally(url: &url::Url) -> bool {
    matches!(url.scheme(), "http" | "https") && url.host_str() != Some("tauri.localhost")
}

#[allow(deprecated)]
fn open_url_in_system_browser(app: &tauri::AppHandle, url: &url::Url) {
    let _ = app.shell().open(url.to_string(), None);
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
    let system_theme = {
        #[cfg(target_os = "linux")]
        if std::env::var_os("FLATPAK_ID").is_some() {
            query_portal_color_scheme().unwrap_or_else(|| match resolve_system_theme(&app) {
                Theme::Light => "light",
                _ => "dark",
            })
        } else {
            match resolve_system_theme(&app) {
                Theme::Light => "light",
                _ => "dark",
            }
        }
        #[cfg(not(target_os = "linux"))]
        match resolve_system_theme(&app) {
            Theme::Light => "light",
            _ => "dark",
        }
    };

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.set_background_color(Some(background_colour));
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let mut builder =
        tauri::WebviewWindowBuilder::new(&app, &label, tauri::WebviewUrl::App(path.clone().into()))
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
            .initialization_script(initial_theme_injection_script(system_theme));

    if label == "attributions" {
        let app_handle_for_navigation = app.clone();
        let app_handle_for_new_window = app.clone();
        builder = builder
            .on_navigation(move |url| {
                if should_open_url_externally(url) {
                    open_url_in_system_browser(&app_handle_for_navigation, url);
                    false
                } else {
                    true
                }
            })
            .on_new_window(move |url, _features| {
                if should_open_url_externally(&url) {
                    open_url_in_system_browser(&app_handle_for_new_window, &url);
                }
                NewWindowResponse::Deny
            });
    }

    if let Some((x, y)) = centred_sub_window_position(&app, width, height) {
        builder = builder.position(x, y);
    }

    let _window = builder.build().map_err(|e| e.to_string())?;

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

#[cfg(target_os = "linux")]
fn query_portal_color_scheme() -> Option<&'static str> {
    // xdg-desktop-portal Settings.Read returns (<uint32 N>,)
    // 0 = no preference, 1 = prefer dark, 2 = prefer light
    let output = std::process::Command::new("gdbus")
        .args([
            "call",
            "--session",
            "--dest",
            "org.freedesktop.portal.Desktop",
            "--object-path",
            "/org/freedesktop/portal/desktop",
            "--method",
            "org.freedesktop.portal.Settings.Read",
            "org.freedesktop.appearance",
            "color-scheme",
        ])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    if stdout.contains("uint32 1") {
        Some("dark")
    } else if stdout.contains("uint32 2") {
        Some("light")
    } else {
        None
    }
}

#[tauri::command]
pub fn get_system_theme_hint(app: tauri::AppHandle) -> String {
    #[cfg(target_os = "linux")]
    if std::env::var_os("FLATPAK_ID").is_some() {
        if let Some(theme) = query_portal_color_scheme() {
            return theme.to_string();
        }
    }
    match resolve_system_theme(&app) {
        Theme::Light => "light".to_string(),
        _ => "dark".to_string(),
    }
}
