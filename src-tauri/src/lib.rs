mod avatar;
pub mod commands;
pub mod git;
mod window_manager;

use git::handler::GitService;
use git::types::AvatarProviderMode;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::{Arc, Mutex, OnceLock, atomic::AtomicBool};
use tauri::{Emitter, Manager};

pub struct AppState {
    pub git_service: GitService,
    pub avatar_service: Arc<avatar::AvatarService>,
}

pub struct CloneCancelFlag(pub Arc<AtomicBool>);

struct FsWatcherState(Mutex<Option<RecommendedWatcher>>);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub(crate) fn configure_command(_command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
#[derive(Clone, Copy)]
enum GitBackend {
    System,
    FlatpakHost,
    FlatpakBundled,
}

static GIT_BACKEND: OnceLock<GitBackend> = OnceLock::new();

fn git_backend() -> GitBackend {
    *GIT_BACKEND.get_or_init(detect_git_backend)
}

fn detect_git_backend() -> GitBackend {
    #[cfg(target_os = "linux")]
    if std::env::var_os("FLATPAK_ID").is_some() {
        let mut probe = std::process::Command::new("flatpak-spawn");
        probe.args(["--host", "git", "--version"]);
        configure_command(&mut probe);
        if probe.output().is_ok_and(|output| output.status.success()) {
            return GitBackend::FlatpakHost;
        }
        return GitBackend::FlatpakBundled;
    }

    GitBackend::System
}

pub(crate) fn git_command() -> std::process::Command {
    match git_backend() {
        GitBackend::FlatpakHost => {
            let mut cmd = std::process::Command::new("flatpak-spawn");
            cmd.args(["--host", "git"]);
            cmd
        }
        GitBackend::FlatpakBundled => std::process::Command::new("/app/bin/git"),
        GitBackend::System => std::process::Command::new(resolve_git_exe()),
    }
}

pub(crate) fn configured_git_command() -> std::process::Command {
    let mut command = git_command();
    configure_command(&mut command);
    command
}

/// On Windows, the installer may launch Gitmun before the updated PATH (with
/// Git's bin dir) propagates to child processes. Check known install locations
/// as a fallback so git.exe is found even in that window.
fn resolve_git_exe() -> std::ffi::OsString {
    #[cfg(windows)]
    {
        let git_in_path = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|dir| dir.join("git.exe").exists()))
            .unwrap_or(false);
        if !git_in_path {
            for candidate in &[
                r"C:\Program Files\Git\cmd\git.exe",
                r"C:\Program Files\Git\bin\git.exe",
                r"C:\Program Files (x86)\Git\cmd\git.exe",
            ] {
                if std::path::Path::new(candidate).exists() {
                    return (*candidate).into();
                }
            }
        }
    }
    "git".into()
}

/// Read linuxGraphicsMode from the saved config file without starting Tauri.
/// Used to apply WebKit env vars before the WebView is initialised.
#[cfg(target_os = "linux")]
fn read_saved_linux_graphics_mode() -> Option<String> {
    let config_dir = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".config"))
        })?;
    let config_file = config_dir.join("com.cst8t.gitmun").join("config.json");
    let text = std::fs::read_to_string(config_file).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("linuxGraphicsMode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
}

#[cfg(target_os = "linux")]
fn apply_linux_appimage_webkit_workarounds() {
    // The GNOME runtime configures WebKit correctly; applying GDK_BACKEND=x11
    // here would break GTK's portal communication and break prefers-color-scheme.
    if std::env::var_os("FLATPAK_ID").is_some() {
        return;
    }

    // Env var takes precedence; otherwise use the saved setting; default to "auto".
    let graphics_mode = std::env::var("GITMUN_GRAPHICS_MODE")
        .map(|v| v.to_lowercase())
        .or_else(|_| read_saved_linux_graphics_mode().ok_or(()))
        .unwrap_or_else(|_| "auto".to_string());

    // "native" opts out entirely; every other mode (including the default "auto")
    // applies the dmabuf workaround because some EGL/Mesa stacks corrupt the heap
    // without it, regardless of whether we are running from an AppImage.
    if graphics_mode == "native" {
        return;
    }

    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
        unsafe {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    let is_wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|value| value.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);
    let has_xwayland = std::env::var_os("DISPLAY").is_some();

    // safe: aggressively maximize compatibility, auto: only apply when Wayland likely triggers EGL issues.
    let prefer_x11 =
        graphics_mode == "safe" || (graphics_mode == "auto" && is_wayland && has_xwayland);
    if prefer_x11 && std::env::var_os("GDK_BACKEND").is_none() {
        unsafe {
            std::env::set_var("GDK_BACKEND", "x11");
        }
    }

    let force_software =
        graphics_mode == "safe" || (graphics_mode == "auto" && is_wayland && !has_xwayland);
    if force_software && std::env::var_os("LIBGL_ALWAYS_SOFTWARE").is_none() {
        unsafe {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
    }
}

#[cfg(target_os = "linux")]
fn sanitize_linux_xdg_env() {
    if let Ok(raw) = std::env::var("XDG_DATA_DIRS") {
        let filtered: Vec<&str> = raw
            .split(':')
            .filter(|entry| {
                if entry.is_empty() {
                    return false;
                }
                match std::fs::canonicalize(entry) {
                    Ok(_) => true,
                    Err(err) => err.raw_os_error() != Some(40),
                }
            })
            .collect();

        if !filtered.is_empty() && filtered.join(":") != raw {
            unsafe {
                std::env::set_var("XDG_DATA_DIRS", filtered.join(":"));
            }
        }
    }
}

/// Start watching the `.git` directory of the given repository.
/// Emits `git-fs-changed` events (debounced) when relevant files change,
/// allowing the frontend to refresh immediately after external modifications.
#[tauri::command]
fn watch_repo(
    repo_path: String,
    app: tauri::AppHandle,
    watcher: tauri::State<'_, FsWatcherState>,
) -> Result<(), String> {
    let git_dir = std::path::PathBuf::from(&repo_path).join(".git");
    if !git_dir.exists() {
        return Err(format!("No .git directory found in {repo_path}"));
    }

    let app_handle = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();

    let mut new_watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(event) = res {
            // Ignore object-database writes (.git/objects/) - they're numerous
            // during fetches but don't reflect a user-visible state change by
            // themselves; the accompanying refs update will trigger the refresh.
            let relevant = event.paths.iter().any(|p| {
                let s = p.to_string_lossy();
                !s.contains("/.git/objects/") && !s.contains("\\.git\\objects\\")
            });
            if relevant {
                let _ = tx.send(Ok(event));
            }
        }
    })
    .map_err(|e| e.to_string())?;

    new_watcher
        .watch(&git_dir, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // Debounce thread: collect rapid-fire events and only emit after 400 ms
    // of quiet, so a single commit (touching HEAD, index, refs, ...) produces
    // exactly one refresh.
    std::thread::spawn(move || {
        use std::time::{Duration, Instant};
        const DEBOUNCE: Duration = Duration::from_millis(400);
        let mut pending = false;
        let mut last_event = Instant::now();

        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Ok(_)) => {
                    pending = true;
                    last_event = Instant::now();
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if pending && last_event.elapsed() >= DEBOUNCE {
                        pending = false;
                        let _ = app_handle.emit("git-fs-changed", ());
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    // Replacing the old watcher automatically drops it, stopping the previous watch.
    let mut guard = watcher
        .0
        .lock()
        .map_err(|_| "Internal watcher state error".to_string())?;
    *guard = Some(new_watcher);
    Ok(())
}

/// Stop watching the currently watched repository.
#[tauri::command]
fn unwatch_repo(watcher: tauri::State<'_, FsWatcherState>) {
    if let Ok(mut guard) = watcher.0.lock() {
        *guard = None;
    }
}

#[tauri::command]
fn detect_desktop_environment() -> String {
    std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .to_lowercase()
}

pub fn run() {
    #[cfg(target_os = "linux")]
    sanitize_linux_xdg_env();

    #[cfg(target_os = "linux")]
    apply_linux_appimage_webkit_workarounds();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState {
            git_service: GitService::new(),
            avatar_service: Arc::new(avatar::AvatarService::new(
                AvatarProviderMode::default(),
                true,
            )),
        })
        .manage(CloneCancelFlag(Arc::new(AtomicBool::new(false))))
        .manage(FsWatcherState(Mutex::new(None)))
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            if let Ok(config_dir) = app.path().app_config_dir() {
                let state = app.state::<AppState>();
                state
                    .git_service
                    .initialize_config(config_dir.join("config.json"));

                // Sync avatar service with the loaded settings
                let settings = state.git_service.get_settings();
                if let Some(main_window) = app.get_webview_window("main") {
                    let background_colour = window_manager::background_colour_for_theme_mode(
                        &app.handle(),
                        &settings.theme_mode,
                    );
                    let _ = main_window.set_background_color(Some(background_colour));
                }
                state.avatar_service.set_mode(settings.avatar_provider);
                state
                    .avatar_service
                    .set_try_platform_first(settings.try_platform_first);
            }

            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::set_backend_mode,
            commands::settings::set_show_result_log,
            commands::settings::set_theme_mode,
            commands::settings::set_wrap_diff_lines,
            commands::settings::set_panel_layout,
            commands::settings::set_confirm_revert,
            commands::settings::get_config_file_path,
            commands::settings::get_build_version,
            commands::settings::get_commit_hash,
            commands::settings::is_updater_enabled,
            commands::settings::check_for_app_update,
            commands::settings::download_and_install_app_update,
            commands::settings::get_global_diff_tool,
            commands::settings::get_global_default_branch,
            commands::settings::set_global_diff_tool,
            commands::settings::set_global_default_branch,
            commands::settings::set_avatar_provider,
            commands::settings::set_try_platform_first,
            commands::settings::set_default_clone_dir,
            commands::settings::set_commit_date_mode,
            commands::settings::set_push_follow_tags,
            commands::settings::set_auto_check_for_updates_on_launch,
            commands::settings::set_auto_install_updates,
            commands::settings::set_update_endpoint,
            commands::settings::set_linux_graphics_mode,
            commands::history::get_commit_history,
            commands::history::verify_commits,
            commands::history::merge_branch,
            commands::history::merge_abort,
            commands::history::rebase_start,
            commands::history::rebase_continue,
            commands::history::rebase_abort,
            commands::history::cherry_pick_start,
            commands::history::cherry_pick_continue,
            commands::history::cherry_pick_abort,
            commands::history::revert_commit_start,
            commands::history::revert_continue,
            commands::history::revert_abort,
            commands::history::reset,
            commands::history::conflict_accept_theirs,
            commands::history::conflict_accept_ours,
            commands::history::open_merge_tool,
            commands::repo::get_commit_markers,
            commands::repo::get_commit_files,
            commands::repo::get_commit_details,
            commands::repo::validate_repo_path,
            commands::repo::init_repo,
            commands::repo::clone_repo,
            commands::repo::cancel_clone,
            commands::repo::get_default_clone_dir,
            commands::repo::open_external_diff,
            commands::repo::open_working_tree_diff,
            commands::repo::get_repo_diff_tool,
            commands::repo::analyze_pull,
            commands::repo::pull_changes,
            commands::repo::pull_with_strategy,
            commands::repo::get_repo_status,
            commands::repo::get_numstat,
            commands::repo::stage_files,
            commands::repo::commit_changes,
            commands::repo::get_diff,
            commands::repo::unstage_file,
            commands::repo::unstage_all,
            commands::repo::stage_all,
            commands::repo::stage_hunk,
            commands::repo::unstage_hunk,
            commands::repo::discard_file,
            commands::repo::fetch_remote,
            commands::repo::stash,
            commands::repo::stash_list,
            commands::repo::stash_apply,
            commands::repo::stash_pop,
            commands::repo::stash_drop,
            commands::repo::get_identity,
            commands::repo::set_identity,
            commands::repo::push_changes,
            commands::repo::fetch_avatar,
            commands::branches::get_branches,
            commands::branches::switch_branch,
            commands::branches::set_branch_upstream,
            commands::branches::create_branch,
            commands::branches::delete_branch,
            commands::branches::rename_branch,
            commands::branches::get_tags,
            commands::branches::delete_tag,
            commands::branches::create_tag,
            commands::branches::push_tag,
            commands::branches::delete_remote_tag,
            commands::branches::delete_remote_branch,
            commands::branches::get_remotes,
            commands::branches::add_remote,
            commands::branches::remove_remote,
            commands::branches::rename_remote,
            commands::branches::set_remote_url,
            commands::branches::prune_remote,
            detect_desktop_environment,
            watch_repo,
            unwatch_repo,
            window_manager::open_sub_window,
            window_manager::show_window,
            window_manager::get_system_theme_hint,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
