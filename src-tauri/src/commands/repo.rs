use crate::git::types::{
    CloneRequest, CommitDetails, CommitDetailsRequest, CommitFileItem, CommitFilesRequest,
    CommitMarkers, CommitRequest, DiffRequest,
    ExternalDiffRequest, FetchRequest, FileDiff, FileRequest, GitIdentity, HunkStageRequest,
    IdentityRequest, NumstatRequest, NumstatResult, OperationResult, PushRequest, RepoRequest,
    RepoStatus, SetIdentityRequest, StageFilesRequest, StashEntry, StashPushRequest, StashRequest,
};
use crate::{configure_command, AppState, CloneCancelFlag};
use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use tauri::Manager;

#[tauri::command]
pub fn get_commit_markers(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<CommitMarkers, String> {
    state
        .git_service
        .get_commit_markers(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_commit_files(
    request: CommitFilesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitFileItem>, String> {
    state
        .git_service
        .get_commit_files(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_commit_details(
    request: CommitDetailsRequest,
    state: tauri::State<'_, AppState>,
) -> Result<CommitDetails, String> {
    state
        .git_service
        .get_commit_details(request)
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
            message: format!("Repository already initialized at {}", path.display()),
            output: None,
            repo_path: Some(path.to_string_lossy().to_string()),
            backend_used: "git-cli".to_string(),
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
pub fn cancel_clone(flag: tauri::State<'_, CloneCancelFlag>) {
    flag.0.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub fn get_default_clone_dir() -> String {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
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
pub fn get_repo_status(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<RepoStatus, String> {
    state
        .git_service
        .get_repo_status(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_numstat(
    request: NumstatRequest,
    state: tauri::State<'_, AppState>,
) -> Result<NumstatResult, String> {
    state
        .git_service
        .get_numstat(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stage_files(
    request: StageFilesRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_files(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn commit_changes(
    request: CommitRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .commit_changes(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn get_diff(
    request: DiffRequest,
    state: tauri::State<'_, AppState>,
) -> Result<FileDiff, String> {
    state
        .git_service
        .get_diff(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn unstage_file(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .unstage_file(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn unstage_all(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .unstage_all(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn stage_all(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .stage_all(request)
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
pub fn stash_list(
    request: RepoRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<StashEntry>, String> {
    state
        .git_service
        .stash_list(request)
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
pub async fn push_changes(
    request: PushRequest,
    app: tauri::AppHandle,
) -> Result<OperationResult, String> {
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
