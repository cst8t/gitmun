mod avatar;
pub mod commands;
mod config_file;
pub mod git;
mod instance_coordinator;
pub mod shell;
mod window_manager;

use git::handler::GitService;
use git::types::AvatarProviderMode;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use shell::cli::ShellStartupAction;
use std::path::{Path, PathBuf};
#[cfg(windows)]
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock, RwLock, atomic::AtomicBool};
use tauri::{Emitter, Manager};

pub struct AppState {
    pub git_service: GitService,
    pub avatar_service: Arc<avatar::AvatarService>,
}

pub struct CloneCancelFlag(pub Arc<AtomicBool>);

struct FsWatcherState(Mutex<Option<RecommendedWatcher>>);

struct StartupState(Mutex<Option<ShellStartupAction>>);

pub(crate) struct PendingCloneDestination(Mutex<Option<String>>);

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

#[cfg(windows)]
static BUNDLED_GIT_EXE: OnceLock<Option<PathBuf>> = OnceLock::new();

static CONFIGURED_GIT_EXE: OnceLock<RwLock<Option<PathBuf>>> = OnceLock::new();

#[cfg(windows)]
const MSIX_PACKAGE_FAMILY_NAME: &str = "cst8t.Gitmun_yqm0gq6me4wme";

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
pub(crate) fn is_msix_build() -> bool {
    #[cfg(target_os = "windows")]
    {
        option_env!("GITMUN_MSIX").is_some()
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

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
    if let Some(git_exe) = configured_git_executable_path() {
        #[cfg(windows)]
        {
            let mut command = std::process::Command::new(&git_exe);
            configure_bundled_git_environment(&mut command, &git_exe);
            return command;
        }

        #[cfg(not(windows))]
        {
            return std::process::Command::new(git_exe);
        }
    }

    match git_backend() {
        GitBackend::FlatpakHost => {
            let mut cmd = std::process::Command::new("flatpak-spawn");
            cmd.args(["--host", "git"]);
            cmd
        }
        GitBackend::FlatpakBundled => std::process::Command::new("/app/bin/git"),
        GitBackend::System => {
            #[cfg(windows)]
            {
                let git_exe = resolve_git_exe();
                let mut command = std::process::Command::new(&git_exe);
                configure_bundled_git_environment(&mut command, Path::new(&git_exe));
                command
            }
            #[cfg(not(windows))]
            {
                std::process::Command::new(resolve_git_exe())
            }
        }
    }
}

pub(crate) fn normalise_display_path(path: &str) -> String {
    #[cfg(windows)]
    {
        if let Some(stripped) = path.strip_prefix(r"\\?\") {
            if let Some(unc) = stripped.strip_prefix(r"UNC\") {
                return format!("\\\\{}", unc);
            }
            return stripped.to_string();
        }
    }
    path.to_string()
}

pub(crate) fn set_configured_git_executable_path(path: String) {
    let trimmed = path.trim();
    let next = if trimmed.is_empty() {
        None
    } else {
        let normalised = normalise_display_path(trimmed.trim_matches('"'));
        Some(PathBuf::from(normalised))
    };

    if let Ok(mut configured) = CONFIGURED_GIT_EXE.get_or_init(|| RwLock::new(None)).write() {
        *configured = next;
    }
}

fn configured_git_executable_path() -> Option<PathBuf> {
    CONFIGURED_GIT_EXE
        .get_or_init(|| RwLock::new(None))
        .read()
        .ok()
        .and_then(|configured| configured.clone())
        .filter(|candidate| candidate.exists())
}

fn resolve_on_path(names: &[&str]) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in names {
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

pub(crate) fn resolve_active_git_executable_path() -> String {
    let raw = if let Some(path) = configured_git_executable_path() {
        path.to_string_lossy().into_owned()
    } else {
        match git_backend() {
            GitBackend::FlatpakHost => return "flatpak-spawn --host git".to_string(),
            GitBackend::FlatpakBundled => return "/app/bin/git".to_string(),
            GitBackend::System => {
                #[cfg(windows)]
                {
                    let git_exe = PathBuf::from(resolve_git_exe());
                    if git_exe.is_absolute() {
                        git_exe.to_string_lossy().into_owned()
                    } else {
                        resolve_on_path(&["git.exe", "git"])
                            .map(|path| path.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "git".to_string())
                    }
                }

                #[cfg(not(windows))]
                {
                    resolve_on_path(&["git"])
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "git".to_string())
                }
            }
        }
    };
    normalise_display_path(&raw)
}

pub(crate) fn git_version_string() -> Result<String, String> {
    let mut command = git_command();
    configure_command(&mut command);
    let output = command
        .arg("--version")
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout)
            .trim()
            .strip_prefix("git version ")
            .unwrap_or("")
            .trim()
            .to_string();
        if !version.is_empty() {
            return Ok(version);
        }
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "Failed to detect Git version".to_string()
    } else {
        stderr
    })
}

pub(crate) fn display_config_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        if is_msix_build() {
            let normalised = path
                .to_string_lossy()
                .replace('/', "\\")
                .to_ascii_lowercase();
            let msix_roaming = format!(
                "\\packages\\{}\\localcache\\roaming\\",
                MSIX_PACKAGE_FAMILY_NAME.to_ascii_lowercase()
            );
            if normalised.contains(&msix_roaming) {
                return path.to_path_buf();
            }

            if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
                return PathBuf::from(local_appdata)
                    .join("Packages")
                    .join(MSIX_PACKAGE_FAMILY_NAME)
                    .join("LocalCache")
                    .join("Roaming")
                    .join("com.cst8t.gitmun")
                    .join(
                        path.file_name()
                            .unwrap_or_else(|| std::ffi::OsStr::new("config.toml")),
                    );
            }
        }
    }

    path.to_path_buf()
}

#[cfg(windows)]
fn active_windows_git_exe_path() -> PathBuf {
    configured_git_executable_path().unwrap_or_else(|| PathBuf::from(resolve_git_exe()))
}

#[cfg(windows)]
fn resolve_git_bash_exe() -> Option<std::path::PathBuf> {
    let git_path = active_windows_git_exe_path();
    if git_path.is_absolute() {
        if let Some(parent) = git_path.parent() {
            let direct = parent.join("bash.exe");
            if direct.exists() {
                return Some(direct);
            }
            if let Some(root) = parent.parent() {
                let sibling = root.join("bin").join("bash.exe");
                if sibling.exists() {
                    return Some(sibling);
                }
            }
        }
    }

    [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ]
    .iter()
    .map(std::path::PathBuf::from)
    .find(|candidate| candidate.exists())
}

#[cfg(windows)]
pub(crate) fn git_bash_command() -> Option<std::process::Command> {
    resolve_git_bash_exe().map(std::process::Command::new)
}

#[cfg(windows)]
fn normalise_configured_program_path(value: &str) -> String {
    value.trim().trim_matches('"').to_string()
}

#[cfg(windows)]
fn configured_program_available(value: &str, names: &[&str]) -> bool {
    let value = normalise_configured_program_path(value);
    if value.is_empty() {
        return false;
    }

    let path = PathBuf::from(&value);
    if path.is_absolute() || value.contains('\\') || value.contains('/') {
        return path.exists();
    }

    let mut command_names = vec![value.as_str()];
    command_names.extend(names.iter().copied().filter(|name| *name != value.as_str()));
    resolve_on_windows_path(&command_names).is_some()
}

#[cfg(windows)]
fn git_config_get(key: &str, current_dir: Option<&Path>) -> Result<Option<String>, String> {
    let mut command = git_command();
    configure_command(&mut command);
    if let Some(path) = current_dir {
        command.current_dir(path);
    }
    let output = command
        .args(["config", "--get", key])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!value.is_empty()).then_some(value));
    }

    if output.status.code() == Some(1) {
        return Ok(None);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Failed to get git config {key}")
    } else {
        stderr
    })
}

#[cfg(windows)]
fn git_config_global_set(key: &str, value: &str) -> Result<(), String> {
    let mut command = git_command();
    configure_command(&mut command);
    let output = command
        .args(["config", "--global", key, value])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Failed to set git config {key}")
    } else {
        stderr
    })
}

#[cfg(windows)]
fn gpg_program_candidates_from_git_exe() -> Vec<PathBuf> {
    let git_exe = active_windows_git_exe_path();
    let Some(root) = git_exe.parent().and_then(|path| path.parent()) else {
        return vec![];
    };

    vec![
        root.join("usr").join("bin").join("gpg.exe"),
        root.join("mingw64").join("bin").join("gpg.exe"),
    ]
}

#[cfg(windows)]
fn known_gpg_program_install_paths() -> Vec<PathBuf> {
    let mut paths = vec![
        PathBuf::from(r"C:\Program Files\Git\usr\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files\Git\mingw64\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\usr\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Git\mingw64\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files\GnuPG\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files (x86)\GnuPG\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files\Gpg4win\bin\gpg.exe"),
        PathBuf::from(r"C:\Program Files (x86)\Gpg4win\bin\gpg.exe"),
    ];

    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let root = PathBuf::from(program_files);
        paths.extend([
            root.join("Git").join("usr").join("bin").join("gpg.exe"),
            root.join("Git").join("mingw64").join("bin").join("gpg.exe"),
            root.join("GnuPG").join("bin").join("gpg.exe"),
            root.join("Gpg4win").join("bin").join("gpg.exe"),
        ]);
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        let root = PathBuf::from(program_files_x86);
        paths.extend([
            root.join("Git").join("usr").join("bin").join("gpg.exe"),
            root.join("Git").join("mingw64").join("bin").join("gpg.exe"),
            root.join("GnuPG").join("bin").join("gpg.exe"),
            root.join("Gpg4win").join("bin").join("gpg.exe"),
        ]);
    }
    if let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") {
        paths.extend([
            PathBuf::from(&local_appdata)
                .join("Programs")
                .join("Git")
                .join("usr")
                .join("bin")
                .join("gpg.exe"),
            PathBuf::from(local_appdata)
                .join("Programs")
                .join("Git")
                .join("mingw64")
                .join("bin")
                .join("gpg.exe"),
        ]);
    }

    paths
}

#[cfg(windows)]
pub(crate) fn resolve_known_gpg_program_path() -> Option<PathBuf> {
    resolve_on_windows_path(&["gpg.exe", "gpg"])
        .or_else(|| {
            gpg_program_candidates_from_git_exe()
                .into_iter()
                .find(|candidate| candidate.exists())
        })
        .or_else(|| {
            known_gpg_program_install_paths()
                .into_iter()
                .find(|candidate| candidate.exists())
        })
}

#[cfg(windows)]
pub(crate) fn ensure_windows_gpg_program_configured(
    current_dir: Option<&Path>,
) -> Result<Option<PathBuf>, String> {
    if let Some(configured) = git_config_get("gpg.program", current_dir)? {
        if configured_program_available(&configured, &["gpg.exe", "gpg"]) {
            return Ok(None);
        }
    }

    let Some(path) = resolve_known_gpg_program_path() else {
        return Ok(None);
    };

    git_config_global_set("gpg.program", &path.to_string_lossy())?;
    Ok(Some(path))
}

#[cfg(windows)]
fn known_diff_tool_path_names(tool_key: &str) -> &'static [&'static str] {
    match tool_key {
        "meld" => &["Meld.exe", "meld.exe"],
        "winmerge" => &["WinMergeU.exe", "winmergeu.exe"],
        _ => &[],
    }
}

#[cfg(windows)]
fn known_diff_tool_install_paths(tool_key: &str) -> &'static [&'static str] {
    match tool_key {
        "meld" => &[
            r"C:\Program Files\Meld\Meld.exe",
            r"C:\Program Files (x86)\Meld\Meld.exe",
        ],
        "winmerge" => &[
            r"C:\Program Files\WinMerge\WinMergeU.exe",
            r"C:\Program Files (x86)\WinMerge\WinMergeU.exe",
        ],
        _ => &[],
    }
}

#[cfg(windows)]
fn known_diff_tool_local_appdata_paths(tool_key: &str) -> Vec<std::path::PathBuf> {
    let Some(local_appdata) = std::env::var_os("LOCALAPPDATA") else {
        return vec![];
    };
    let root = std::path::PathBuf::from(local_appdata);
    match tool_key {
        "meld" => vec![root.join("Programs").join("Meld").join("Meld.exe")],
        "winmerge" => vec![root.join("Programs").join("WinMerge").join("WinMergeU.exe")],
        _ => vec![],
    }
}

#[cfg(windows)]
fn resolve_on_windows_path(names: &[&str]) -> Option<std::path::PathBuf> {
    resolve_on_path(names)
}

#[cfg(windows)]
pub(crate) fn resolve_known_diff_tool_path(tool_key: &str) -> Option<std::path::PathBuf> {
    resolve_on_windows_path(known_diff_tool_path_names(tool_key))
        .or_else(|| {
            known_diff_tool_install_paths(tool_key)
                .iter()
                .map(std::path::PathBuf::from)
                .find(|candidate| candidate.exists())
        })
        .or_else(|| {
            known_diff_tool_local_appdata_paths(tool_key)
                .into_iter()
                .find(|candidate| candidate.exists())
        })
}

pub(crate) fn configured_git_command() -> std::process::Command {
    let mut command = git_command();
    configure_command(&mut command);
    command
}

fn resolve_git_exe() -> std::ffi::OsString {
    #[cfg(windows)]
    {
        for candidate in &[
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
            r"C:\Program Files (x86)\Git\cmd\git.exe",
        ] {
            if std::path::Path::new(candidate).exists() {
                return (*candidate).into();
            }
        }
        let git_in_path = std::env::var_os("PATH")
            .map(|p| std::env::split_paths(&p).any(|dir| dir.join("git.exe").exists()))
            .unwrap_or(false);
        if git_in_path {
            return "git".into();
        }
        if let Some(candidate) = bundled_git_exe() {
            return candidate.into_os_string();
        }
    }
    "git".into()
}

#[cfg(windows)]
fn bundled_git_exe() -> Option<PathBuf> {
    BUNDLED_GIT_EXE
        .get()
        .and_then(|candidate| candidate.as_ref())
        .filter(|candidate| candidate.exists())
        .cloned()
}

#[cfg(windows)]
pub(crate) fn is_using_bundled_git_runtime() -> bool {
    let git_exe = active_windows_git_exe_path();
    bundled_git_exe().is_some_and(|bundled| git_exe == bundled)
}

#[cfg(not(windows))]
pub(crate) fn is_using_bundled_git_runtime() -> bool {
    false
}

#[cfg(windows)]
fn configure_bundled_git_environment(command: &mut Command, git_exe: &Path) {
    let Some(bundled_git_exe) = bundled_git_exe() else {
        return;
    };
    if git_exe != bundled_git_exe {
        return;
    }

    let Some(root) = bundled_git_exe.parent().and_then(|path| path.parent()) else {
        return;
    };

    let mut paths = [
        root.join("cmd"),
        root.join("mingw64").join("bin"),
        root.join("usr").join("bin"),
    ]
    .into_iter()
    .filter(|path| path.exists())
    .collect::<Vec<_>>();

    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    if let Ok(path) = std::env::join_paths(paths) {
        command.env("PATH", path);
    }
}

#[cfg(windows)]
fn initialise_bundled_git_path(app: &tauri::App) {
    let resource_git_exe = app
        .path()
        .resolve("mingit/cmd/git.exe", tauri::path::BaseDirectory::Resource)
        .ok()
        .filter(|candidate| candidate.exists());

    let msix_layout_git_exe = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|parent| parent.join("mingit").join("cmd").join("git.exe"))
        })
        .filter(|candidate| candidate.exists());

    let _ = BUNDLED_GIT_EXE.set(resource_git_exe.or(msix_layout_git_exe));
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
    read_saved_linux_graphics_mode_from_config_dir(&config_dir)
}

#[cfg(target_os = "linux")]
fn read_saved_linux_graphics_mode_from_config_dir(config_dir: &std::path::Path) -> Option<String> {
    let app_dir = config_dir.join("com.cst8t.gitmun");
    let toml_path = app_dir.join("config.toml");
    if toml_path.exists() {
        return config_file::read_linux_graphics_mode_from_toml(&toml_path);
    }

    let json_path = app_dir.join("config.json");
    let text = std::fs::read_to_string(json_path).ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    json.get("linuxGraphicsMode")
        .and_then(|v| v.as_str())
        .map(|s| s.to_ascii_lowercase())
}

#[cfg(all(test, target_os = "linux"))]
mod linux_config_tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn saved_graphics_mode_ignores_json_when_toml_exists_without_mode() {
        let dir = TempDir::new().unwrap();
        let app_dir = dir.path().join("com.cst8t.gitmun");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(app_dir.join("config.toml"), "showResultLog = true\n").unwrap();
        std::fs::write(
            app_dir.join("config.json"),
            r#"{"linuxGraphicsMode": "Safe"}"#,
        )
        .unwrap();

        let mode = read_saved_linux_graphics_mode_from_config_dir(dir.path());
        assert_eq!(mode, None);
    }

    #[test]
    fn saved_graphics_mode_reads_json_before_toml_migration() {
        let dir = TempDir::new().unwrap();
        let app_dir = dir.path().join("com.cst8t.gitmun");
        std::fs::create_dir_all(&app_dir).unwrap();
        std::fs::write(
            app_dir.join("config.json"),
            r#"{"linuxGraphicsMode": "Safe"}"#,
        )
        .unwrap();

        let mode = read_saved_linux_graphics_mode_from_config_dir(dir.path());
        assert_eq!(mode.as_deref(), Some("safe"));
    }
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

#[cfg(target_os = "linux")]
fn configure_linux_webkit_text_input(window: &tauri::WebviewWindow<tauri::Wry>) {
    let _ = window.with_webview(|webview| {
        use webkit2gtk::{WebContextExt, WebViewExt};

        let webview = webview.inner();
        if let Some(context) = webview.context() {
            let languages = linux_spell_checking_languages();
            let language_refs: Vec<&str> = languages.iter().map(String::as_str).collect();
            context.set_spell_checking_languages(&language_refs);
            context.set_spell_checking_enabled(true);
        }

        webview.connect_context_menu(|_, menu, _, _| {
            filter_linux_webkit_text_context_menu(menu);
            false
        });
    });
}

#[cfg(target_os = "linux")]
fn filter_linux_webkit_text_context_menu(menu: &webkit2gtk::ContextMenu) {
    use webkit2gtk::{ContextMenuExt, ContextMenuItemExt};

    for item in menu.items() {
        if item.is_separator() {
            continue;
        }
        if !linux_webkit_text_context_menu_item_is_allowed(&item) {
            menu.remove(&item);
        }
    }

    remove_redundant_linux_webkit_context_menu_separators(menu);
}

#[cfg(target_os = "linux")]
fn linux_webkit_text_context_menu_item_is_allowed(item: &webkit2gtk::ContextMenuItem) -> bool {
    use webkit2gtk::{ContextMenuAction, ContextMenuExt, ContextMenuItemExt};

    if let Some(submenu) = item.submenu() {
        filter_linux_webkit_text_context_menu(&submenu);
        return submenu.n_items() > 0;
    }

    matches!(
        item.stock_action(),
        ContextMenuAction::Copy
            | ContextMenuAction::Cut
            | ContextMenuAction::Paste
            | ContextMenuAction::PasteAsPlainText
            | ContextMenuAction::Delete
            | ContextMenuAction::SelectAll
            | ContextMenuAction::SpellingGuess
            | ContextMenuAction::NoGuessesFound
            | ContextMenuAction::IgnoreSpelling
            | ContextMenuAction::LearnSpelling
            | ContextMenuAction::IgnoreGrammar
    )
}

#[cfg(target_os = "linux")]
fn remove_redundant_linux_webkit_context_menu_separators(menu: &webkit2gtk::ContextMenu) {
    use webkit2gtk::{ContextMenuExt, ContextMenuItemExt};

    let items = menu.items();
    let mut previous_kept_was_separator = true;
    let mut last_separator = None;

    for item in items {
        if item.is_separator() {
            if previous_kept_was_separator {
                menu.remove(&item);
            } else {
                last_separator = Some(item);
                previous_kept_was_separator = true;
            }
        } else {
            last_separator = None;
            previous_kept_was_separator = false;
        }
    }

    if let Some(item) = last_separator {
        menu.remove(&item);
    }
}

#[cfg(target_os = "linux")]
fn linux_spell_checking_languages() -> Vec<String> {
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            if let Some(locale) = normalise_linux_spell_checking_locale(&value) {
                return vec![locale];
            }
        }
    }

    vec!["en_GB".to_string()]
}

#[cfg(target_os = "linux")]
fn normalise_linux_spell_checking_locale(value: &str) -> Option<String> {
    let locale = value
        .split(['.', '@'])
        .next()
        .unwrap_or_default()
        .replace('-', "_");

    if locale.is_empty() || locale.eq_ignore_ascii_case("c") || locale.eq_ignore_ascii_case("posix")
    {
        None
    } else {
        Some(locale)
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

#[tauri::command]
fn get_startup_action(state: tauri::State<'_, StartupState>) -> Option<ShellStartupAction> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn take_pending_clone_destination(
    state: tauri::State<'_, PendingCloneDestination>,
) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

#[tauri::command]
fn open_repo_in_new_window(path: String) -> Result<(), String> {
    instance_coordinator::spawn_new_instance_open_repo(&path)
}

#[tauri::command]
async fn open_clone_window(
    destination: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    pending: tauri::State<'_, PendingCloneDestination>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window("clone-repository") {
        if let Some(path) = destination {
            let mut guard = pending
                .0
                .lock()
                .map_err(|_| "Internal clone destination state error".to_string())?;
            *guard = Some(path.clone());
            let _ = app.emit("clone-destination-updated", path);
        }
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    if let Some(owner) = instance_coordinator::find_sub_window_owner("clone-repository") {
        if instance_coordinator::send_command(
            owner.port,
            &instance_coordinator::CoordinatorCommand::OpenCloneWindow {
                destination: destination.clone(),
            },
        )
        .is_ok()
        {
            return Ok(());
        }
    }

    if let Some(path) = destination {
        let mut guard = pending
            .0
            .lock()
            .map_err(|_| "Internal clone destination state error".to_string())?;
        *guard = Some(path);
    }

    window_manager::open_sub_window(
        app,
        "clone-repository".to_string(),
        "Clone Repository".to_string(),
        "clone.html".to_string(),
        520.0,
        460.0,
        false,
        false,
        state,
    )
    .await
}

pub fn run() {
    #[cfg(target_os = "linux")]
    sanitize_linux_xdg_env();

    #[cfg(target_os = "linux")]
    apply_linux_appimage_webkit_workarounds();

    let startup_action = shell::cli::parse_shell_action(&std::env::args().collect::<Vec<String>>());

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
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
        .manage(StartupState(Mutex::new(startup_action)))
        .manage(PendingCloneDestination(Mutex::new(None)))
        .setup(|app| {
            #[cfg(windows)]
            initialise_bundled_git_path(app);

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            if let Ok(config_dir) = app.path().app_config_dir() {
                let state = app.state::<AppState>();
                state
                    .git_service
                    .initialise_config(config_dir.join("config.toml"));

                // Sync avatar service with the loaded settings
                let settings = state.git_service.get_settings();
                if let Some(main_window) = app.get_webview_window("main") {
                    let background_colour = window_manager::background_colour_for_theme_mode(
                        &app.handle(),
                        &settings.theme_mode,
                    );
                    let _ = main_window.set_background_color(Some(background_colour));

                    #[cfg(target_os = "linux")]
                    configure_linux_webkit_text_input(&main_window);

                    #[cfg(target_os = "windows")]
                    if crate::is_msix_build() {
                        let _ = main_window.show();
                        let _ = main_window.set_focus();
                    }
                }
                state.avatar_service.set_mode(settings.avatar_provider);
                state
                    .avatar_service
                    .set_try_platform_first(settings.try_platform_first);
            }

            instance_coordinator::init(&app.handle())?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::Focused(true) = event {
                    instance_coordinator::notify_focused();
                }
                if let tauri::WindowEvent::Destroyed = event {
                    instance_coordinator::deregister();
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                instance_coordinator::unregister_sub_window(window.label().as_ref());
            }
        });

    builder
        .invoke_handler(tauri::generate_handler![
            commands::settings::get_settings,
            commands::settings::set_backend_mode,
            commands::settings::set_show_result_log,
            commands::settings::set_theme_mode,
            commands::settings::set_ui_text_scale,
            commands::settings::set_wrap_diff_lines,
            commands::settings::set_panel_layout,
            commands::settings::set_confirm_revert,
            commands::settings::get_config_file_path,
            commands::settings::get_config_folder_path,
            commands::settings::get_build_version,
            commands::settings::get_commit_hash,
            commands::settings::get_app_update_channel,
            commands::settings::is_updater_enabled,
            commands::settings::check_for_app_update,
            commands::settings::download_and_install_app_update,
            commands::store_update::check_microsoft_store_update,
            commands::store_update::request_microsoft_store_update,
            commands::settings::get_global_diff_tool,
            commands::settings::get_global_diff_tool_path,
            commands::settings::get_global_default_branch,
            commands::settings::get_global_file_mode,
            commands::settings::get_global_pull_rebase,
            commands::settings::get_global_pull_ff,
            commands::settings::get_global_pull_autostash,
            commands::settings::get_global_fetch_prune,
            commands::settings::get_global_push_default,
            commands::settings::get_global_push_auto_setup_remote,
            commands::settings::get_global_core_editor,
            commands::settings::get_global_core_autocrlf,
            commands::settings::get_global_credential_helper,
            commands::settings::get_active_git_executable_path,
            commands::settings::get_active_git_version,
            commands::settings::get_global_gpg_program,
            commands::settings::get_global_gpg_program_path,
            commands::settings::set_global_diff_tool,
            commands::settings::set_global_default_branch,
            commands::settings::set_global_pull_rebase,
            commands::settings::set_global_pull_ff,
            commands::settings::set_global_pull_autostash,
            commands::settings::set_global_fetch_prune,
            commands::settings::set_global_push_default,
            commands::settings::set_global_push_auto_setup_remote,
            commands::settings::set_global_core_editor,
            commands::settings::set_global_core_autocrlf,
            commands::settings::set_global_credential_helper,
            commands::settings::set_global_file_mode,
            commands::settings::set_git_executable_path,
            commands::settings::set_global_gpg_program,
            commands::settings::set_avatar_provider,
            commands::settings::set_try_platform_first,
            commands::settings::set_default_clone_dir,
            commands::settings::set_commit_date_mode,
            commands::settings::set_push_follow_tags,
            commands::settings::set_commit_primary_action,
            commands::settings::set_commit_message_recommended_length,
            commands::settings::set_auto_check_for_updates_on_launch,
            commands::settings::set_auto_install_updates,
            commands::settings::set_update_endpoint,
            commands::settings::set_linux_graphics_mode,
            commands::settings::set_repo_open_behaviour,
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
            commands::repo::submodule_init,
            commands::repo::submodule_update,
            commands::repo::submodule_sync,
            commands::repo::submodule_fetch,
            commands::repo::submodule_pull,
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
            get_startup_action,
            open_clone_window,
            open_repo_in_new_window,
            take_pending_clone_destination,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
