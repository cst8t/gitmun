use crate::git::types::{
    CloneRequest, CommitDetails, CommitDetailsRequest, CommitFileItem, CommitFilesRequest,
    CommitMarkers, CommitMessageRecovery, CommitRequest, DiffRequest, ExportCommitPatchRequest,
    ExportPatchRequest, ExternalDiffRequest, FetchRequest, FileDiff, FileRequest, GitIdentity,
    HunkStageRequest, IdentityRequest, ImportPatchRequest, NumstatRequest, NumstatResult,
    OperationResult, PullAnalysis, PullStrategyRequest, PushRequest, PushResult, RepoRequest,
    RepoStatus, SetIdentityRequest, SshAllowedSignerStatus, StageFilesRequest, StashEntry,
    StashPushRequest, StashRequest, SubmoduleActionRequest,
};
#[cfg(target_os = "linux")]
use crate::git::types::{LINUX_TERMINAL_AUTO_ID, LINUX_TERMINAL_CUSTOM_ID};
use crate::{AppState, CloneCancelFlag, configure_command};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const DEFAULT_GIT_DESCRIPTION: &str =
    "Unnamed repository; edit this file 'description' to name the repository.";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RepoOpenLocationKind {
    FileExplorer,
    Terminal,
    GitBash,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RepoOpenLocation {
    kind: RepoOpenLocationKind,
    label: String,
    fallback_label: String,
    icon_data_url: Option<String>,
}

#[tauri::command]
pub fn get_repo_display_name(repo_path: String) -> Option<String> {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    read_repo_display_name(Path::new(trimmed))
}

fn read_repo_display_name(repo_path: &Path) -> Option<String> {
    let git_dir = resolve_git_dir(repo_path)?;
    let description = std::fs::read_to_string(git_dir.join("description")).ok()?;
    parse_repo_description(&description)
}

fn parse_repo_description(description: &str) -> Option<String> {
    let trimmed = description.trim();
    if trimmed.is_empty() || trimmed == DEFAULT_GIT_DESCRIPTION {
        return None;
    }
    Some(trimmed.to_string())
}

fn resolve_git_dir(repo_path: &Path) -> Option<PathBuf> {
    let dot_git = repo_path.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    if !dot_git.is_file() {
        return None;
    }

    let gitdir = std::fs::read_to_string(&dot_git).ok()?;
    let path = gitdir.trim().strip_prefix("gitdir:")?.trim();
    if path.is_empty() {
        return None;
    }

    let path = PathBuf::from(path);
    if path.is_absolute() {
        Some(path)
    } else {
        Some(repo_path.join(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn repo_with_git_dir() -> TempDir {
        let dir = TempDir::new().expect("create temp dir");
        std::fs::create_dir(dir.path().join(".git")).expect("create git dir");
        dir
    }

    fn write_description(repo: &Path, description: &str) {
        std::fs::write(repo.join(".git").join("description"), description)
            .expect("write description");
    }

    #[test]
    fn repo_display_name_ignores_default_description() {
        let dir = repo_with_git_dir();
        write_description(dir.path(), DEFAULT_GIT_DESCRIPTION);

        assert_eq!(read_repo_display_name(dir.path()), None);
    }

    #[test]
    fn repo_display_name_ignores_empty_description() {
        let dir = repo_with_git_dir();
        write_description(dir.path(), "  \n");

        assert_eq!(read_repo_display_name(dir.path()), None);
    }

    #[test]
    fn repo_display_name_reads_custom_description() {
        let dir = repo_with_git_dir();
        write_description(dir.path(), "  Project Atlas  \n");

        assert_eq!(
            read_repo_display_name(dir.path()).as_deref(),
            Some("Project Atlas")
        );
    }

    #[test]
    fn repo_display_name_ignores_missing_description() {
        let dir = repo_with_git_dir();

        assert_eq!(read_repo_display_name(dir.path()), None);
    }

    #[test]
    fn repo_display_name_resolves_gitdir_file() {
        let dir = TempDir::new().expect("create temp dir");
        let git_dir = dir.path().join("actual-git-dir");
        std::fs::create_dir(&git_dir).expect("create git dir");
        std::fs::write(dir.path().join(".git"), "gitdir: actual-git-dir\n")
            .expect("write gitdir file");
        std::fs::write(git_dir.join("description"), "Linked Repo\n").expect("write description");

        assert_eq!(
            read_repo_display_name(dir.path()).as_deref(),
            Some("Linked Repo")
        );
    }
}

#[tauri::command]
pub fn get_repo_open_locations(state: tauri::State<'_, AppState>) -> Vec<RepoOpenLocation> {
    let terminal_label = default_terminal_label(&state.git_service.get_settings());
    let locations = vec![
        RepoOpenLocation {
            kind: RepoOpenLocationKind::FileExplorer,
            label: default_file_manager_label().to_string(),
            fallback_label: default_file_manager_label().to_string(),
            icon_data_url: None,
        },
        RepoOpenLocation {
            kind: RepoOpenLocationKind::Terminal,
            label: terminal_label,
            fallback_label: "Terminal".to_string(),
            icon_data_url: None,
        },
    ];

    #[cfg(target_os = "windows")]
    let locations = {
        let mut locations = locations;
        if crate::resolve_system_git_bash_exe().is_some() {
            locations.push(RepoOpenLocation {
                kind: RepoOpenLocationKind::GitBash,
                label: "Git Bash".to_string(),
                fallback_label: "Git Bash".to_string(),
                icon_data_url: None,
            });
        }
        locations
    };

    locations
}

#[tauri::command]
pub fn open_repo_location(
    repo_path: String,
    kind: RepoOpenLocationKind,
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    let path = validate_repo_open_path(&repo_path)?;

    match kind {
        RepoOpenLocationKind::FileExplorer => {
            app.opener()
                .open_path(path.to_string_lossy().to_string(), None::<&str>)
                .map_err(|e| format!("Failed to open file manager: {e}"))?;
            Ok(repo_open_result(
                format!("Opened repository in {}", default_file_manager_label()),
                path,
            ))
        }
        RepoOpenLocationKind::Terminal => {
            open_terminal_at(&path, &state.git_service.get_settings())?;
            Ok(repo_open_result(
                "Opened repository in Terminal".to_string(),
                path,
            ))
        }
        RepoOpenLocationKind::GitBash => {
            open_git_bash_at(&path)?;
            Ok(repo_open_result(
                "Opened repository in Git Bash".to_string(),
                path,
            ))
        }
    }
}

fn validate_repo_open_path(repo_path: &str) -> Result<PathBuf, String> {
    let trimmed = repo_path.trim();
    if trimmed.is_empty() {
        return Err("Repository path cannot be empty".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_dir() {
        return Err("Repository path must be an existing directory".to_string());
    }
    Ok(path)
}

fn repo_open_result(message: String, path: PathBuf) -> OperationResult {
    OperationResult {
        message,
        output: None,
        repo_path: Some(path.to_string_lossy().to_string()),
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    }
}

fn default_file_manager_label() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "File Explorer"
    }
    #[cfg(target_os = "macos")]
    {
        "Finder"
    }
    #[cfg(target_os = "linux")]
    {
        "File Manager"
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "File Manager"
    }
}

fn default_terminal_label(settings: &crate::git::types::Settings) -> String {
    #[cfg(target_os = "linux")]
    {
        return linux_terminal_label(settings);
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = settings;
        "Terminal".to_string()
    }
}

fn open_terminal_at(path: &Path, settings: &crate::git::types::Settings) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = settings;
        return open_terminal_at_windows(path);
    }

    #[cfg(target_os = "macos")]
    {
        let _ = settings;
        return open_terminal_at_macos(path);
    }

    #[cfg(target_os = "linux")]
    {
        return open_terminal_at_linux(path, settings);
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        let _ = settings;
        Err("Opening a terminal is not supported on this platform".to_string())
    }
}

fn open_git_bash_at(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        return open_git_bash_at_windows(path);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = path;
        Err("Git Bash is only available on Windows".to_string())
    }
}

#[cfg(target_os = "windows")]
fn open_git_bash_at_windows(path: &Path) -> Result<(), String> {
    let git_bash = crate::resolve_system_git_bash_exe()
        .ok_or_else(|| "Git Bash from Git for Windows was not found".to_string())?;
    std::process::Command::new(git_bash)
        .arg(format!("--cd={}", path.display()))
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Git Bash: {e}"))
}

#[cfg(target_os = "windows")]
fn open_terminal_at_windows(path: &Path) -> Result<(), String> {
    let mut wt = std::process::Command::new("wt.exe");
    wt.arg("-d").arg(path);
    if wt.spawn().is_ok() {
        return Ok(());
    }

    std::process::Command::new("cmd.exe")
        .arg("/C")
        .arg("start")
        .arg("")
        .arg("/D")
        .arg(path)
        .arg("cmd.exe")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open terminal: {e}"))
}

#[cfg(target_os = "macos")]
fn open_terminal_at_macos(path: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Terminal: {e}"))
}

#[cfg(target_os = "linux")]
fn open_terminal_at_linux(
    path: &Path,
    settings: &crate::git::types::Settings,
) -> Result<(), String> {
    linux_terminal_launcher(settings, path)
        .spawn()
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn linux_terminal_label(settings: &crate::git::types::Settings) -> String {
    let registry = linux_terminal_launch::TerminalRegistry::with_known_terminals();
    registry.label_for_preference(&linux_terminal_preference(
        settings.linux_terminal_emulator.as_str(),
    ))
}

#[cfg(target_os = "linux")]
fn linux_terminal_launcher(
    settings: &crate::git::types::Settings,
    path: &Path,
) -> linux_terminal_launch::TerminalLauncher {
    linux_terminal_launch::TerminalLauncher::new()
        .working_dir(path)
        .registry(linux_terminal_launch::TerminalRegistry::with_known_terminals())
        .preference(linux_terminal_preference(
            settings.linux_terminal_emulator.as_str(),
        ))
        .custom_command(settings.linux_terminal_custom_command.clone())
        .detach_from_parent(true)
}

#[cfg(target_os = "linux")]
fn linux_terminal_preference(id: &str) -> linux_terminal_launch::TerminalPreference {
    match id {
        LINUX_TERMINAL_AUTO_ID => linux_terminal_launch::TerminalPreference::Auto,
        LINUX_TERMINAL_CUSTOM_ID => linux_terminal_launch::TerminalPreference::Custom,
        other => linux_terminal_launch::TerminalPreference::registered(other),
    }
}

#[tauri::command]
pub async fn get_commit_markers(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<CommitMarkers, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .get_commit_markers(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_commit_files(
    request: CommitFilesRequest,
    app: tauri::AppHandle,
) -> Result<Vec<CommitFileItem>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .get_commit_files(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_commit_details(
    request: CommitDetailsRequest,
    app: tauri::AppHandle,
) -> Result<CommitDetails, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .get_commit_details(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn validate_repo_path(
    repo_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .validate_repo_path(&repo_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn init_repo(repo_path: String) -> Result<OperationResult, String> {
    let repo_path = repo_path.trim();
    if repo_path.is_empty() {
        return Err("Repository path cannot be empty".to_string());
    }

    let path = std::path::PathBuf::from(repo_path);
    if path.exists() && !path.is_dir() {
        return Err("Repository path must be a directory".to_string());
    }
    if !path.exists() {
        std::fs::create_dir_all(&path).map_err(|e| format!("Failed to create directory: {e}"))?;
    }

    if path.join(".git").exists() {
        return Ok(OperationResult {
            message: format!("Repository already initialised at {}", path.display()),
            output: None,
            repo_path: Some(path.to_string_lossy().to_string()),
            backend_used: "git-cli".to_string(),
            interpreted_error: None,
        });
    }

    let mut command = crate::git_command();
    configure_command(&mut command);
    command.arg("init").arg("-b").arg("main").current_dir(&path);
    let output = command
        .output()
        .map_err(|e| format!("Failed to launch git: {e}"))?;

    if !output.status.success() {
        let mut fallback = crate::git_command();
        configure_command(&mut fallback);
        fallback.arg("init").current_dir(&path);
        let fallback_output = fallback
            .output()
            .map_err(|e| format!("Failed to launch git: {e}"))?;
        if !fallback_output.status.success() {
            let stderr = String::from_utf8_lossy(&fallback_output.stderr)
                .trim()
                .to_string();
            return Err(if stderr.is_empty() {
                "Failed to initialise repository".to_string()
            } else {
                stderr
            });
        }
    }

    Ok(OperationResult {
        message: format!("Initialised repository at {}", path.display()),
        output: None,
        repo_path: Some(path.to_string_lossy().to_string()),
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub async fn clone_repo(
    request: CloneRequest,
    on_progress: tauri::ipc::Channel<String>,
    cancel_flag: tauri::State<'_, CloneCancelFlag>,
) -> Result<OperationResult, String> {
    use crate::git::cli::CliGitHandler;

    let repo_url = request.repo_url.trim().to_string();
    let destination = request.destination.trim().to_string();

    CliGitHandler::validate_clone_repo_url(&repo_url).map_err(|e| e.to_string())?;

    let final_dest = CliGitHandler::resolve_clone_destination(&repo_url, &destination)
        .map_err(|e| e.to_string())?;
    let final_dest_str = final_dest.to_string_lossy().to_string();
    let dest_existed = final_dest.exists();
    let cleanup_path = final_dest_str.clone();

    let mut cmd = crate::git_command();
    configure_command(&mut cmd);
    cmd.args(["clone", "--progress", &repo_url, &final_dest_str])
        .stderr(Stdio::piped())
        .stdout(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch git: {e}"))?;

    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture git clone stderr".to_string())?;

    // Reset cancel flag and grab a clone of the Arc for use in spawn_blocking.
    cancel_flag.0.store(false, Ordering::Relaxed);
    let cancel = cancel_flag.0.clone();

    // Read git's stderr in a background thread, forwarding each progress line
    // to the frontend via the Channel and collecting output for error reporting.
    let reader_thread = std::thread::spawn(move || -> String {
        let mut reader = std::io::BufReader::new(stderr);
        let mut buf = [0u8; 4096];
        let mut partial = String::new();
        let mut collected = String::new();

        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    partial.push_str(&chunk);
                    let parts: Vec<&str> = partial.split(|c| c == '\r' || c == '\n').collect();
                    for part in &parts[..parts.len() - 1] {
                        let line = part.trim();
                        if !line.is_empty() {
                            collected.push_str(line);
                            collected.push('\n');
                            let _ = on_progress.send(line.to_string());
                        }
                    }
                    partial = parts.last().unwrap_or(&"").to_string();
                }
                Err(_) => break,
            }
        }
        // Flush any remaining partial line.
        let remaining = partial.trim().to_string();
        if !remaining.is_empty() {
            collected.push_str(&remaining);
            collected.push('\n');
            let _ = on_progress.send(remaining.clone());
        }
        collected
    });

    // Poll for git exit every 100 ms so we can honour cancel requests without
    // blocking the async runtime (which would freeze the frontend stuff)
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        loop {
            match child.try_wait().map_err(|e| format!("Clone error: {e}"))? {
                Some(status) => {
                    let stderr_output = reader_thread.join().unwrap_or_default();
                    return if status.success() {
                        Ok(())
                    } else {
                        Err(format!("Clone failed: {}", stderr_output.trim_end()))
                    };
                }
                None => {
                    if cancel.load(Ordering::Relaxed) {
                        child.kill().ok();
                        child.wait().ok();
                        reader_thread.join().ok();
                        if !dest_existed {
                            let _ = std::fs::remove_dir_all(&cleanup_path);
                        }
                        return Err("Clone cancelled.".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
    })
    .await
    .map_err(|e| format!("Internal error: {e}"))??;

    Ok(OperationResult {
        message: format!("Cloned repository to {}", final_dest.display()),
        output: None,
        repo_path: Some(final_dest_str),
        backend_used: "git-cli".to_string(),
        interpreted_error: None,
    })
}

#[tauri::command]
pub fn cancel_clone(flag: tauri::State<'_, CloneCancelFlag>) {
    flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_default_clone_dir() -> String {
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    #[cfg(not(windows))]
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join("GitmunProjects")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn open_external_diff(
    request: ExternalDiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_external_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_working_tree_diff(
    request: DiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_working_tree_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn check_patch_file(
    request: ImportPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .check_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn import_patch_file(
    request: ImportPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .import_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_patch_file(
    request: ExportPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .export_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn export_commit_patch_file(
    request: ExportCommitPatchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .export_commit_patch_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_repo_diff_tool(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    state
        .git_service
        .get_configured_diff_tool(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pull_changes(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.pull_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn analyze_pull(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<PullAnalysis, String> {
    state
        .git_service
        .analyze_pull(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn pull_with_strategy(
    request: PullStrategyRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .pull_with_strategy(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_repo_status(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<RepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_repo_status(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_numstat(
    request: NumstatRequest,
    app: tauri::AppHandle,
) -> Result<NumstatResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_numstat(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stage_files(
    request: StageFilesRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.stage_files(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn commit_changes(
    request: CommitRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.commit_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_commit_message_recovery(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Option<CommitMessageRecovery>, String> {
    state
        .git_service
        .get_commit_message_recovery(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_diff(request: DiffRequest, app: tauri::AppHandle) -> Result<FileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.get_diff(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn unstage_file(
    request: FileRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.unstage_file(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn unstage_all(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.unstage_all(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stage_all(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.stage_all(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stage_hunk(
    request: HunkStageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_hunk(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn unstage_hunk(
    request: HunkStageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .unstage_hunk(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn discard_file(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .discard_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_init(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_init(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_update(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_update(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_sync(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_sync(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_fetch(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_fetch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn submodule_pull(
    request: SubmoduleActionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .submodule_pull(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn fetch_remote(
    request: FetchRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.fetch_remote(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn stash(
    request: StashPushRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn stash_list(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<Vec<StashEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.stash_list(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stash_apply(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_apply(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stash_pop(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_pop(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stash_drop(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_drop(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_identity(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<GitIdentity, String> {
    state
        .git_service
        .get_identity(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn set_identity(
    request: SetIdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .set_identity(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_ssh_allowed_signer_status(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<SshAllowedSignerStatus, String> {
    state
        .git_service
        .get_ssh_allowed_signer_status(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn add_ssh_signing_key_to_allowed_signers(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .add_ssh_signing_key_to_allowed_signers(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn push_changes(
    request: PushRequest,
    app: tauri::AppHandle,
) -> Result<PushResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.push_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_avatar(
    email: String,
    repo_path: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    // Clone the Arc before any await so the non-'static State borrow is not
    // captured in the async generator.
    let service = app.state::<AppState>().avatar_service.clone();
    tauri::async_runtime::spawn_blocking(move || service.fetch(&email, &repo_path))
        .await
        .map_err(|e| e.to_string())
}
