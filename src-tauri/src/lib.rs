mod avatar;
mod git;
mod window_manager;

use git::handler::GitService;
use git::types::{
    AddRemoteRequest, AvatarProviderMode, BackendMode, BranchInfo, BranchRequest, CloneRequest,
    CherryPickRequest, CherryPickResult,
    CommitDateMode, CommitFileItem, CommitFilesRequest, CommitHistoryItem, CommitHistoryRequest,
    CommitMarkers, CommitRequest, CreateBranchRequest, CreateTagRequest, DeleteBranchRequest,
    DeleteRemoteBranchRequest, DeleteRemoteTagRequest, DeleteTagRequest, DiffRequest,
    ExternalDiffRequest, ExternalDiffTool, FetchRequest, FileDiff, FileRequest, GitIdentity,
    HunkStageRequest, IdentityRequest, MergeRequest, MergeResult, NumstatRequest, NumstatResult,
    OperationResult, PruneRemoteRequest, PushTagRequest, PushRequest, RebaseRequest,
    RebaseResult, RemoteInfo, RemoveRemoteRequest, RenameBranchRequest, RenameRemoteRequest,
    RepoRequest, RepoStatus, ResetRequest, RevertCommitRequest, SetIdentityRequest,
    SetRemoteUrlRequest, Settings, StageFilesRequest, StashEntry, StashPushRequest, StashRequest,
    TagInfo, ThemeMode,
};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use tauri::{Emitter, Manager};
use notify::{RecommendedWatcher, RecursiveMode, Watcher};

struct AppState {
    git_service: GitService,
    avatar_service: Arc<avatar::AvatarService>,
}

struct CloneCancelFlag(Arc<AtomicBool>);

struct FsWatcherState(Mutex<Option<RecommendedWatcher>>);

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

fn configure_command(_command: &mut Command) {
    #[cfg(windows)]
    {
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

#[cfg(target_os = "linux")]
fn apply_linux_appimage_webkit_workarounds() {
    let graphics_mode = std::env::var("GITMUN_GRAPHICS_MODE")
        .unwrap_or_else(|_| "auto".to_string())
        .to_lowercase();

    let running_in_appimage = std::env::var_os("APPIMAGE").is_some();

    // Auto mode only applies for AppImage runtime, but explicit modes should work everywhere.
    if graphics_mode == "auto" && !running_in_appimage {
        return;
    }

    if graphics_mode == "native" {
        return;
    }

    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        // AppImage + some EGL stacks can fail to initialize a default display.
        // Disable dmabuf renderer for better compatibility unless user already chose.
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

const BUILD_VERSION: &str = match option_env!("GITMUN_BUILD_VERSION") {
    Some(value) => value,
    None => env!("CARGO_PKG_VERSION"),
};

#[tauri::command]
fn get_settings(state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.get_settings()
}

#[tauri::command]
fn set_backend_mode(mode: BackendMode, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_backend_mode(mode)
}

#[tauri::command]
fn set_show_result_log(show_result_log: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_show_result_log(show_result_log)
}

#[tauri::command]
fn set_theme_mode(theme_mode: ThemeMode, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_theme_mode(theme_mode)
}

#[tauri::command]
fn set_panel_layout(
    left_pane_width: u32,
    right_pane_width: u32,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state
        .git_service
        .set_panel_layout(left_pane_width, right_pane_width)
}

#[tauri::command]
fn set_confirm_revert(confirm_revert: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_confirm_revert(confirm_revert)
}

#[tauri::command]
fn get_config_file_path(state: tauri::State<'_, AppState>) -> Option<String> {
    state.git_service.get_config_file_path()
}

#[tauri::command]
fn get_build_version() -> String {
    BUILD_VERSION.to_string()
}

#[tauri::command]
fn get_global_diff_tool() -> Result<ExternalDiffTool, String> {
    let Some(value) = git_config_global_get("diff.tool")? else {
        return Ok(ExternalDiffTool::Other);
    };

    let value = value.to_lowercase();
    let tool = match value.as_str() {
        "meld" => ExternalDiffTool::Meld,
        "kompare" => ExternalDiffTool::Kompare,
        "winmerge" => ExternalDiffTool::WinMerge,
        "vscode" => ExternalDiffTool::VsCode,
        "vscodium" => ExternalDiffTool::VsCodium,
        _ => ExternalDiffTool::Other,
    };

    Ok(tool)
}

#[tauri::command]
fn get_global_default_branch() -> Result<Option<String>, String> {
    git_config_global_get("init.defaultBranch")
}

fn git_config_global_set(key: &str, value: &str) -> Result<(), String> {
    let mut command = Command::new("git");
    configure_command(&mut command);
    let output = command
        .args(["config", "--global", key, value])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Failed to set git config {key}")
        } else {
            stderr
        });
    }
    Ok(())
}

fn git_config_global_get(key: &str) -> Result<Option<String>, String> {
    let mut command = Command::new("git");
    configure_command(&mut command);
    let output = command
        .args(["config", "--global", "--get", key])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            return Ok(None);
        }
        return Ok(Some(value));
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

fn validate_branch_name(name: &str) -> Result<(), String> {
    let mut command = Command::new("git");
    configure_command(&mut command);
    let output = command
        .args(["check-ref-format", "--branch", name])
        .output()
        .map_err(|error| error.to_string())?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        format!("Invalid branch name: {name}")
    } else {
        stderr
    })
}

fn git_config_global_unset(key: &str) -> Result<(), String> {
    let mut command = Command::new("git");
    configure_command(&mut command);
    // --unset exits 5 when the key doesn't exist — treat that as success
    let output = command
        .args(["config", "--global", "--unset", key])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() && output.status.code() != Some(5) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("Failed to unset git config {key}")
        } else {
            stderr
        });
    }
    Ok(())
}

#[tauri::command]
fn set_global_diff_tool(tool: ExternalDiffTool) -> Result<OperationResult, String> {
    // Always clean up tool-specific cmd keys Gitmun may have written previously,
    // so switching away from VS Code/Codium leaves no stale entries behind.
    for key in &[
        "difftool.vscode.cmd",
        "mergetool.vscode.cmd",
        "difftool.vscodium.cmd",
        "mergetool.vscodium.cmd",
    ] {
        let _ = git_config_global_unset(key);
    }

    let message = match tool {
        ExternalDiffTool::Other => {
            let _ = git_config_global_unset("diff.tool");
            "Cleared diff.tool from global git config".to_string()
        }
        ExternalDiffTool::Meld => {
            git_config_global_set("diff.tool", "meld")?;
            "Set git global diff.tool=meld".to_string()
        }
        ExternalDiffTool::Kompare => {
            git_config_global_set("diff.tool", "kompare")?;
            "Set git global diff.tool=kompare".to_string()
        }
        ExternalDiffTool::WinMerge => {
            git_config_global_set("diff.tool", "winmerge")?;
            "Set git global diff.tool=winmerge".to_string()
        }
        ExternalDiffTool::VsCode => {
            git_config_global_set("diff.tool", "vscode")?;
            git_config_global_set("difftool.vscode.cmd", "code --wait --diff $LOCAL $REMOTE")?;
            git_config_global_set("mergetool.vscode.cmd", "code --wait --merge $REMOTE $LOCAL $BASE $MERGED")?;
            "Set git global diff.tool=vscode (with difftool/mergetool cmd)".to_string()
        }
        ExternalDiffTool::VsCodium => {
            git_config_global_set("diff.tool", "vscodium")?;
            git_config_global_set("difftool.vscodium.cmd", "codium --wait --diff $LOCAL $REMOTE")?;
            git_config_global_set("mergetool.vscodium.cmd", "codium --wait --merge $REMOTE $LOCAL $BASE $MERGED")?;
            "Set git global diff.tool=vscodium (with difftool/mergetool cmd)".to_string()
        }
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
    })
}

#[tauri::command]
fn set_global_default_branch(default_branch: String) -> Result<OperationResult, String> {
    let branch = default_branch.trim();

    let message = if branch.is_empty() {
        git_config_global_unset("init.defaultBranch")?;
        "Cleared init.defaultBranch from global git config".to_string()
    } else {
        validate_branch_name(branch)?;
        git_config_global_set("init.defaultBranch", branch)?;
        format!("Set git global init.defaultBranch={branch}")
    };

    Ok(OperationResult {
        message,
        output: None,
        repo_path: None,
        backend_used: "git-cli".to_string(),
    })
}

#[tauri::command]
async fn get_commit_history(
    request: CommitHistoryRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitHistoryItem>, String> {
    let mut req = request;
    req.commit_date_mode = state.git_service.get_settings().commit_date_mode;
    let handler = state.git_service.read_handler();
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<CommitHistoryItem>, String> {
        handler.get_commit_history(&req).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_commit_markers(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<CommitMarkers, String> {
    state
        .git_service
        .get_commit_markers(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_commit_files(
    request: CommitFilesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitFileItem>, String> {
    state
        .git_service
        .get_commit_files(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn validate_repo_path(
    repo_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .validate_repo_path(&repo_path)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn init_repo(repo_path: String) -> Result<OperationResult, String> {
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
            message: format!("Repository already initialized at {}", path.display()),
            output: None,
            repo_path: Some(path.to_string_lossy().to_string()),
            backend_used: "git-cli".to_string(),
        });
    }

    let mut command = Command::new("git");
    configure_command(&mut command);
    command.arg("init").arg("-b").arg("main").current_dir(&path);
    let output = command
        .output()
        .map_err(|e| format!("Failed to launch git: {e}"))?;

    if !output.status.success() {
        let mut fallback = Command::new("git");
        configure_command(&mut fallback);
        fallback.arg("init").current_dir(&path);
        let fallback_output = fallback
            .output()
            .map_err(|e| format!("Failed to launch git: {e}"))?;
        if !fallback_output.status.success() {
            let stderr = String::from_utf8_lossy(&fallback_output.stderr).trim().to_string();
            return Err(if stderr.is_empty() {
                "Failed to initialize repository".to_string()
            } else {
                stderr
            });
        }
    }

    Ok(OperationResult {
        message: format!("Initialized repository at {}", path.display()),
        output: None,
        repo_path: Some(path.to_string_lossy().to_string()),
        backend_used: "git-cli".to_string(),
    })
}

#[tauri::command]
async fn clone_repo(
    request: CloneRequest,
    on_progress: tauri::ipc::Channel<String>,
    cancel_flag: tauri::State<'_, CloneCancelFlag>,
) -> Result<OperationResult, String> {
    use git::cli::CliGitHandler;

    let repo_url = request.repo_url.trim().to_string();
    let destination = request.destination.trim().to_string();

    CliGitHandler::validate_clone_repo_url(&repo_url).map_err(|e| e.to_string())?;

    let final_dest = CliGitHandler::resolve_clone_destination(&repo_url, &destination)
        .map_err(|e| e.to_string())?;
    let final_dest_str = final_dest.to_string_lossy().to_string();
    let dest_existed = final_dest.exists();
    let cleanup_path = final_dest_str.clone();

    let mut cmd = Command::new("git");
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
                    let parts: Vec<&str> =
                        partial.split(|c| c == '\r' || c == '\n').collect();
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
    })
}

#[tauri::command]
fn cancel_clone(flag: tauri::State<'_, CloneCancelFlag>) {
    flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
fn get_default_clone_dir() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home)
        .join("GitmunProjects")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
fn open_external_diff(
    request: ExternalDiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_external_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_working_tree_diff(
    request: DiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_working_tree_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_repo_diff_tool(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    state
        .git_service
        .get_configured_diff_tool(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn pull_changes(
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
fn get_repo_status(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<RepoStatus, String> {
    state
        .git_service
        .get_repo_status(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_numstat(
    request: NumstatRequest,
    state: tauri::State<'_, AppState>,
) -> Result<NumstatResult, String> {
    state
        .git_service
        .get_numstat(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stage_files(
    request: StageFilesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_files(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn commit_changes(
    request: CommitRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .commit_changes(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_diff(request: DiffRequest, state: tauri::State<'_, AppState>) -> Result<FileDiff, String> {
    state
        .git_service
        .get_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_branches(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<BranchInfo>, String> {
    state
        .git_service
        .get_branches(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn switch_branch(
    request: BranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .switch_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_branch(
    request: CreateBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .create_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_branch(
    request: DeleteBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn rename_branch(
    request: RenameBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .rename_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_tag(
    request: DeleteTagRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_tag(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn create_tag(request: CreateTagRequest, state: tauri::State<'_, AppState>) -> Result<OperationResult, String> {
    state.git_service.create_tag(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn push_tag(request: PushTagRequest, state: tauri::State<'_, AppState>) -> Result<OperationResult, String> {
    state.git_service.push_tag(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_remote_tag(request: DeleteRemoteTagRequest, state: tauri::State<'_, AppState>) -> Result<OperationResult, String> {
    state.git_service.delete_remote_tag(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_remote_branch(
    request: DeleteRemoteBranchRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .delete_remote_branch(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn add_remote(
    request: AddRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.add_remote(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_remote(
    request: RemoveRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.remove_remote(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_remote(
    request: RenameRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.rename_remote(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_remote_url(
    request: SetRemoteUrlRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.set_remote_url(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn prune_remote(
    request: PruneRemoteRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state.git_service.prune_remote(request).map_err(|e| e.to_string())
}

#[tauri::command]
fn unstage_file(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .unstage_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn unstage_all(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .unstage_all(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stage_all(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_all(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stage_hunk(
    request: HunkStageRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_hunk(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn discard_file(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .discard_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn fetch_remote(
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
fn stash(
    request: StashPushRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stash_list(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<StashEntry>, String> {
    state
        .git_service
        .stash_list(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stash_apply(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_apply(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stash_pop(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_pop(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn stash_drop(
    request: StashRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stash_drop(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_identity(
    request: IdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<GitIdentity, String> {
    state
        .git_service
        .get_identity(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_identity(
    request: SetIdentityRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .set_identity(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_tags(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<TagInfo>, String> {
    state
        .git_service
        .get_tags(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn get_remotes(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<RemoteInfo>, String> {
    state
        .git_service
        .get_remotes(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn push_changes(
    request: PushRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .git_service
            .push_changes(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_avatar(
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

#[tauri::command]
fn set_avatar_provider(
    avatar_provider: AvatarProviderMode,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.avatar_service.set_mode(avatar_provider.clone());
    state.git_service.set_avatar_provider(avatar_provider)
}

#[tauri::command]
fn set_try_platform_first(try_platform_first: bool, state: tauri::State<'_, AppState>) -> Settings {
    state
        .avatar_service
        .set_try_platform_first(try_platform_first);
    state.git_service.set_try_platform_first(try_platform_first)
}

#[tauri::command]
fn set_default_clone_dir(
    default_clone_dir: String,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.git_service.set_default_clone_dir(default_clone_dir)
}

#[tauri::command]
fn set_commit_date_mode(
    commit_date_mode: CommitDateMode,
    state: tauri::State<'_, AppState>,
) -> Settings {
    state.git_service.set_commit_date_mode(commit_date_mode)
}

#[tauri::command]
fn set_push_follow_tags(push_follow_tags: bool, state: tauri::State<'_, AppState>) -> Settings {
    state.git_service.set_push_follow_tags(push_follow_tags)
}

#[tauri::command]
async fn merge_branch(
    request: MergeRequest,
    app: tauri::AppHandle,
) -> Result<MergeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.merge_branch(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn merge_abort(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.merge_abort(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rebase_start(
    request: RebaseRequest,
    app: tauri::AppHandle,
) -> Result<RebaseResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.rebase_start(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rebase_continue(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<RebaseResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.rebase_continue(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn rebase_abort(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.rebase_abort(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cherry_pick_start(
    request: CherryPickRequest,
    app: tauri::AppHandle,
) -> Result<CherryPickResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.cherry_pick_start(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cherry_pick_continue(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<CherryPickResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.cherry_pick_continue(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn cherry_pick_abort(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.cherry_pick_abort(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn revert_commit_start(
    request: RevertCommitRequest,
    app: tauri::AppHandle,
) -> Result<CherryPickResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.revert_commit_start(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn revert_continue(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<CherryPickResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.revert_continue(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn revert_abort(
    request: RepoRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>().git_service.revert_abort(request)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn reset(
    request: ResetRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .reset(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn conflict_accept_theirs(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .conflict_accept_theirs(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn conflict_accept_ours(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .conflict_accept_ours(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_merge_tool(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_merge_tool(request)
        .map_err(|error| error.to_string())
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
            // Ignore object-database writes (.git/objects/) — they're numerous
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
    // of quiet, so a single commit (touching HEAD, index, refs, …) produces
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(AppState {
            git_service: GitService::new(),
            avatar_service: Arc::new(avatar::AvatarService::new(AvatarProviderMode::default(), true)),
        })
        .manage(CloneCancelFlag(Arc::new(AtomicBool::new(false))))
        .manage(FsWatcherState(Mutex::new(None)))
        .setup(|app| {
            if let Ok(config_dir) = app.path().app_config_dir() {
                let state = app.state::<AppState>();
                state
                    .git_service
                    .initialize_config(config_dir.join("config.json"));

                // Sync avatar service with the loaded settings
                let settings = state.git_service.get_settings();
                state.avatar_service.set_mode(settings.avatar_provider);
                state
                    .avatar_service
                    .set_try_platform_first(settings.try_platform_first);
            }

            Ok(())
        });

    builder
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_backend_mode,
            set_show_result_log,
            set_theme_mode,
            set_panel_layout,
            set_confirm_revert,
            get_config_file_path,
            get_build_version,
            get_global_diff_tool,
            get_global_default_branch,
            set_global_diff_tool,
            set_global_default_branch,
            get_commit_history,
            get_commit_markers,
            get_commit_files,
            open_external_diff,
            open_working_tree_diff,
            get_repo_diff_tool,
            validate_repo_path,
            init_repo,
            clone_repo,
            cancel_clone,
            get_default_clone_dir,
            pull_changes,
            get_repo_status,
            get_numstat,
            stage_files,
            commit_changes,
            get_diff,
            get_branches,
            switch_branch,
            create_branch,
            delete_branch,
            rename_branch,
            delete_tag,
            create_tag,
            push_tag,
            delete_remote_tag,
            delete_remote_branch,
            add_remote,
            remove_remote,
            rename_remote,
            set_remote_url,
            prune_remote,
            unstage_file,
            unstage_all,
            stage_all,
            stage_hunk,
            discard_file,
            fetch_remote,
            stash,
            stash_list,
            stash_apply,
            stash_pop,
            stash_drop,
            get_identity,
            set_identity,
            get_tags,
            get_remotes,
            push_changes,
            detect_desktop_environment,
            fetch_avatar,
            set_avatar_provider,
            set_try_platform_first,
            set_default_clone_dir,
            set_commit_date_mode,
            set_push_follow_tags,
            merge_branch,
            merge_abort,
            rebase_start,
            rebase_continue,
            rebase_abort,
            cherry_pick_start,
            cherry_pick_continue,
            cherry_pick_abort,
            revert_commit_start,
            revert_continue,
            revert_abort,
            reset,
            conflict_accept_theirs,
            conflict_accept_ours,
            open_merge_tool,
            watch_repo,
            unwatch_repo,
            window_manager::open_sub_window,
            window_manager::show_window
        ])
        .run(tauri::generate_context!())
        .expect("failed to run tauri application");
}
