use crate::git::types::{
    CherryPickRequest, CherryPickResult, CommitHistoryItem, CommitHistoryRequest,
    CommitVerification, FileRequest, MergeRequest, MergeResult, OperationResult, RebaseRequest,
    RebaseResult, RepoRequest, ResetRequest, RevertCommitRequest, SignatureStatus,
};
use crate::AppState;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[tauri::command]
pub async fn get_commit_history(
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

/// Batch-verify the signatures of the given commits using `git log --no-walk`.
/// Only hashes that were flagged as `Signed` by the fast gix detection path are
/// passed in; the command calls GPG/SSH once per signed commit (via git's %G?
/// format specifier) and returns the authoritative verification status for each.
#[tauri::command]
pub async fn verify_commits(
    repo_path: String,
    hashes: Vec<String>,
) -> Result<Vec<CommitVerification>, String> {
    if hashes.is_empty() {
        return Ok(Vec::new());
    }

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<CommitVerification>, String> {
        // Read the allowedSignersFile path directly from git config. This is
        // more reliable than detecting from stderr, since error message wording
        // can change across git versions.
        let configured_signers = crate::git_command()
            .current_dir(&repo_path)
            .args(["config", "--get", "gpg.ssh.allowedSignersFile"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());

        // Expand a leading ~ to the home directory (git config stores the raw value).
        let configured_signers = configured_signers.map(|p| {
            if p.starts_with("~/") || p == "~" {
                if let Some(home) = std::env::var_os("HOME") {
                    return format!("{}{}", home.to_string_lossy(), &p[1..]);
                }
            }
            p
        });

        // Determine the effective signers file: use the configured path if it
        // exists, otherwise create a temporary empty file so git doesn't error
        // out entirely when SSH signatures are present.
        let mut temp_signers: Option<std::path::PathBuf> = None;
        let signers_override: Option<std::path::PathBuf> = if let Some(ref path) = configured_signers {
            let pb = std::path::PathBuf::from(path);
            if pb.exists() {
                Some(pb)
            } else {
                // Configured but missing - fall back to empty to get status chars.
                let tmp = std::env::temp_dir().join(format!(
                    "gitmun-empty-signers-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .map_err(|e| e.to_string())?
                        .as_nanos()
                ));
                std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
                temp_signers = Some(tmp.clone());
                Some(tmp)
            }
        } else {
            None
        };

        let mut cmd = crate::git_command();
        cmd.current_dir(&repo_path);
        if let Some(ref path) = signers_override {
            cmd.arg("-c")
                .arg(format!("gpg.ssh.allowedSignersFile={}", path.display()));
        }
        cmd.arg("log")
            .arg("--no-walk=unsorted")
            .arg("--format=%H%x1f%G?%x1f%GS%x1f%GF%x1f%GK");
        for hash in &hashes {
            cmd.arg(hash);
        }
        let output = cmd.output().map_err(|e| e.to_string())?;

        if let Some(tmp) = temp_signers {
            let _ = std::fs::remove_file(tmp);
        }

        let stdout = String::from_utf8_lossy(&output.stdout);

        let mut results = Vec::new();
        for line in stdout.lines().filter(|l| !l.trim().is_empty()) {
            let mut parts = line.splitn(5, '\x1f');
            let hash = parts.next().unwrap_or_default().trim().to_string();
            let sig_char = parts.next().unwrap_or_default().trim();
            let signer_raw = parts.next().unwrap_or_default().trim();
            let fingerprint_raw = parts.next().unwrap_or_default().trim();
            let key_id_raw = parts.next().unwrap_or_default().trim();

            if hash.is_empty() {
                continue;
            }

            let fingerprint = if fingerprint_raw.is_empty() {
                (!key_id_raw.is_empty()).then(|| key_id_raw.to_string())
            } else {
                Some(fingerprint_raw.to_string())
            };

            let status = match sig_char {
                "G" | "X" | "Y" | "R" => SignatureStatus::Verified,
                "B" => SignatureStatus::Bad,
                "U" | "E" => SignatureStatus::UnknownKey,
                _ => SignatureStatus::None,
            };
            let signer = if signer_raw.is_empty() { None } else { Some(signer_raw.to_string()) };

            results.push(CommitVerification { hash, status, signer, fingerprint });
        }
        Ok(results)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn merge_branch(
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
pub async fn merge_abort(
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
pub async fn rebase_start(
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
pub async fn rebase_continue(
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
pub async fn rebase_abort(
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
pub async fn cherry_pick_start(
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
pub async fn cherry_pick_continue(
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
pub async fn cherry_pick_abort(
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
pub async fn revert_commit_start(
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
pub async fn revert_continue(
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
pub async fn revert_abort(
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
pub fn reset(
    request: ResetRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .reset(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn conflict_accept_theirs(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .conflict_accept_theirs(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn conflict_accept_ours(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .conflict_accept_ours(request)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn open_merge_tool(
    request: FileRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, String> {
    state
        .git_service
        .open_merge_tool(request)
        .map_err(|error| error.to_string())
}
