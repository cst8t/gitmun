use crate::AppState;
use crate::git::types::{
    CherryPickRequest, CherryPickResult, CommitHistoryItem, CommitHistoryRequest,
    CommitVerification, FileRequest, MergeRequest, MergeResult, OperationResult, RebaseRequest,
    RebaseResult, RepoRequest, ResetRequest, RevertCommitRequest, SignatureStatus,
};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
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
    state: tauri::State<'_, AppState>,
) -> Result<Vec<CommitVerification>, String> {
    if hashes.is_empty() {
        return Ok(Vec::new());
    }

    let gpg_keyserver_verification_enabled = state
        .git_service
        .get_settings()
        .gpg_keyserver_verification_enabled;

    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<CommitVerification>, String> {
        #[cfg(windows)]
        let _ =
            crate::ensure_windows_gpg_program_configured(Some(std::path::Path::new(&repo_path)))?;

        verify_commit_signatures(
            &repo_path,
            &hashes,
            gpg_keyserver_verification_enabled,
            &ProcessVerificationRunner,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

trait VerificationRunner {
    fn git_config_get(&self, repo_path: &str, key: &str) -> Result<Option<String>, String>;
    fn verify_signatures(
        &self,
        repo_path: &str,
        hashes: &[String],
        signers_override: Option<&Path>,
    ) -> Result<VerificationCommandOutput, String>;
    fn recv_gpg_key(&self, repo_path: &str, gpg_program: &str, key: &str) -> Result<(), String>;
    fn commit_key_type(&self, repo_path: &str, hash: &str) -> Result<Option<String>, String>;
}

struct VerificationCommandOutput {
    stdout: String,
    stderr: String,
    success: bool,
}

struct ProcessVerificationRunner;

impl VerificationRunner for ProcessVerificationRunner {
    fn git_config_get(&self, repo_path: &str, key: &str) -> Result<Option<String>, String> {
        let mut command = crate::configured_git_command();
        command.current_dir(repo_path);
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

    fn verify_signatures(
        &self,
        repo_path: &str,
        hashes: &[String],
        signers_override: Option<&Path>,
    ) -> Result<VerificationCommandOutput, String> {
        let mut cmd = crate::configured_git_command();
        cmd.current_dir(repo_path);
        if let Some(path) = signers_override {
            cmd.arg("-c")
                .arg(format!("gpg.ssh.allowedSignersFile={}", path.display()));
        }
        cmd.arg("log")
            .arg("--no-walk=unsorted")
            .arg("--format=%H%x1f%G?%x1f%GS%x1f%GF%x1f%GK");
        for hash in hashes {
            cmd.arg(hash);
        }
        let output = cmd.output().map_err(|e| e.to_string())?;
        Ok(VerificationCommandOutput {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
            success: output.status.success(),
        })
    }

    fn recv_gpg_key(&self, repo_path: &str, gpg_program: &str, key: &str) -> Result<(), String> {
        let mut command = Command::new(gpg_program);
        command.current_dir(repo_path);
        command.args(["--batch", "--recv-keys", key]);
        let output = command.output().map_err(|error| error.to_string())?;
        if output.status.success() {
            return Ok(());
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("GPG key fetch failed for {key}")
        } else {
            stderr
        })
    }

    fn commit_key_type(&self, repo_path: &str, hash: &str) -> Result<Option<String>, String> {
        let mut command = crate::configured_git_command();
        command.current_dir(repo_path);
        let output = command
            .args(["cat-file", "commit", hash])
            .output()
            .map_err(|error| error.to_string())?;

        if !output.status.success() {
            return Ok(None);
        }

        Ok(signature_key_type(&String::from_utf8_lossy(&output.stdout)))
    }
}

fn verify_commit_signatures(
    repo_path: &str,
    hashes: &[String],
    gpg_keyserver_verification_enabled: bool,
    runner: &impl VerificationRunner,
) -> Result<Vec<CommitVerification>, String> {
    let mut results = verify_with_git(repo_path, hashes, runner)?;

    if !gpg_keyserver_verification_enabled {
        return Ok(results);
    }

    let gpg_program = effective_gpg_program(repo_path, runner)?;
    let mut retry_hashes = Vec::new();
    for result in &results {
        if result.status != SignatureStatus::UnknownKey {
            continue;
        }

        let Some(key) = result
            .fingerprint
            .as_deref()
            .filter(|value| !value.is_empty())
        else {
            continue;
        };

        if runner.commit_key_type(repo_path, &result.hash)? != Some("gpg".to_string()) {
            continue;
        }

        if runner.recv_gpg_key(repo_path, &gpg_program, key).is_ok() {
            retry_hashes.push(result.hash.clone());
        }
    }

    if retry_hashes.is_empty() {
        return Ok(results);
    }

    let retry_results = verify_with_git(repo_path, &retry_hashes, runner)?;
    for retry_result in retry_results {
        if retry_result.status != SignatureStatus::Verified {
            continue;
        }
        if let Some(result) = results
            .iter_mut()
            .find(|result| result.hash == retry_result.hash)
        {
            *result = retry_result;
        }
    }

    Ok(results)
}

fn verify_with_git(
    repo_path: &str,
    hashes: &[String],
    runner: &impl VerificationRunner,
) -> Result<Vec<CommitVerification>, String> {
    // Read the allowedSignersFile path directly from git config. This is more
    // reliable than detecting from stderr, since error wording can change.
    let configured_signers = expand_home_path(
        runner
            .git_config_get(repo_path, "gpg.ssh.allowedSignersFile")
            .unwrap_or(None),
    );

    let mut temp_signers: Option<PathBuf> = None;
    let signers_override: Option<PathBuf> = if let Some(ref path) = configured_signers {
        let pb = PathBuf::from(path);
        if pb.exists() {
            Some(pb)
        } else {
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

    let verification_result =
        runner.verify_signatures(repo_path, hashes, signers_override.as_deref());

    if let Some(tmp) = temp_signers {
        let _ = std::fs::remove_file(tmp);
    }

    let output = verification_result?;
    if !output.success {
        return Err(if output.stderr.is_empty() {
            "git log --no-walk failed while verifying commit signatures".to_string()
        } else {
            output.stderr
        });
    }

    Ok(parse_verification_output(&output.stdout, hashes))
}

fn parse_verification_output(stdout: &str, requested_hashes: &[String]) -> Vec<CommitVerification> {
    let mut parsed = HashMap::new();
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
        let signer = if signer_raw.is_empty() {
            None
        } else {
            Some(signer_raw.to_string())
        };

        parsed.insert(hash.clone(), CommitVerification {
            hash,
            status,
            signer,
            fingerprint,
        });
    }

    requested_hashes
        .iter()
        .map(|hash| {
            parsed.remove(hash).unwrap_or_else(|| {
                eprintln!("Missing verification output for requested commit {hash}");
                CommitVerification {
                    hash: hash.clone(),
                    status: SignatureStatus::None,
                    signer: None,
                    fingerprint: None,
                }
            })
        })
        .collect()
}

fn expand_home_path(path: Option<String>) -> Option<String> {
    path.map(|p| {
        if p.starts_with("~/") || p == "~" {
            if let Some(home) = std::env::var_os("HOME") {
                return format!("{}{}", home.to_string_lossy(), &p[1..]);
            }
        }
        p
    })
}

fn effective_gpg_program(
    repo_path: &str,
    runner: &impl VerificationRunner,
) -> Result<String, String> {
    if let Ok(Some(program)) = runner.git_config_get(repo_path, "gpg.program") {
        return Ok(program);
    }

    #[cfg(windows)]
    {
        if let Some(path) = crate::resolve_known_gpg_program_path() {
            return Ok(path.to_string_lossy().into_owned());
        }
    }

    Ok("gpg".to_string())
}

fn signature_key_type(commit_text: &str) -> Option<String> {
    if commit_text.contains("-----BEGIN SSH SIGNATURE-----") {
        return Some("ssh".to_string());
    }
    if commit_text.contains("-----BEGIN PGP SIGNATURE-----") {
        return Some("gpg".to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    struct FakeRunner {
        verification_outputs: RefCell<Vec<String>>,
        fetched_keys: RefCell<Vec<String>>,
        verified_hashes: RefCell<Vec<Vec<String>>>,
        fetch_succeeds: bool,
        verification_succeeds: bool,
        verification_stderr: Option<String>,
        key_types: HashMap<String, String>,
        gpg_program: Option<String>,
    }

    impl FakeRunner {
        fn new(outputs: Vec<&str>) -> Self {
            Self {
                verification_outputs: RefCell::new(
                    outputs.into_iter().map(str::to_string).rev().collect(),
                ),
                fetched_keys: RefCell::new(Vec::new()),
                verified_hashes: RefCell::new(Vec::new()),
                fetch_succeeds: true,
                verification_succeeds: true,
                verification_stderr: None,
                key_types: HashMap::new(),
                gpg_program: None,
            }
        }

        fn with_key_type(mut self, hash: &str, key_type: &str) -> Self {
            self.key_types
                .insert(hash.to_string(), key_type.to_string());
            self
        }

        fn with_fetch_failure(mut self) -> Self {
            self.fetch_succeeds = false;
            self
        }

        fn with_verification_failure(mut self, stderr: &str) -> Self {
            self.verification_succeeds = false;
            self.verification_stderr = Some(stderr.to_string());
            self
        }

        fn with_gpg_program(mut self, program: &str) -> Self {
            self.gpg_program = Some(program.to_string());
            self
        }
    }

    impl VerificationRunner for FakeRunner {
        fn git_config_get(&self, _repo_path: &str, key: &str) -> Result<Option<String>, String> {
            Ok(match key {
                "gpg.program" => self.gpg_program.clone(),
                _ => None,
            })
        }

        fn verify_signatures(
            &self,
            _repo_path: &str,
            hashes: &[String],
            _signers_override: Option<&Path>,
        ) -> Result<VerificationCommandOutput, String> {
            self.verified_hashes.borrow_mut().push(hashes.to_vec());
            let stdout = self.verification_outputs
                .borrow_mut()
                .pop()
                .ok_or_else(|| "missing fake verification output".to_string())?;
            Ok(VerificationCommandOutput {
                stdout,
                stderr: self.verification_stderr.clone().unwrap_or_default(),
                success: self.verification_succeeds,
            })
        }

        fn recv_gpg_key(
            &self,
            _repo_path: &str,
            gpg_program: &str,
            key: &str,
        ) -> Result<(), String> {
            self.fetched_keys
                .borrow_mut()
                .push(format!("{gpg_program} {key}"));
            if self.fetch_succeeds {
                Ok(())
            } else {
                Err("fetch failed".to_string())
            }
        }

        fn commit_key_type(&self, _repo_path: &str, hash: &str) -> Result<Option<String>, String> {
            Ok(self.key_types.get(hash).cloned())
        }
    }

    #[test]
    fn maps_existing_verification_statuses() {
        let output = [
            "a\x1fG\x1fAlice\x1fFINGERPRINT\x1fKEY",
            "b\x1fB\x1fBob\x1f\x1fBADKEY",
            "c\x1fE\x1fCarol\x1f\x1fUNKNOWNKEY",
            "d\x1fN\x1f\x1f\x1f",
        ]
        .join("\n");
        let results = parse_verification_output(
            &output,
            &["a".to_string(), "b".to_string(), "c".to_string(), "d".to_string()],
        );

        assert_eq!(results[0].status, SignatureStatus::Verified);
        assert_eq!(results[0].fingerprint.as_deref(), Some("FINGERPRINT"));
        assert_eq!(results[1].status, SignatureStatus::Bad);
        assert_eq!(results[1].fingerprint.as_deref(), Some("BADKEY"));
        assert_eq!(results[2].status, SignatureStatus::UnknownKey);
        assert_eq!(results[2].fingerprint.as_deref(), Some("UNKNOWNKEY"));
        assert_eq!(results[3].status, SignatureStatus::None);
    }

    #[test]
    fn disabled_keyserver_verification_does_not_fetch_unknown_gpg_keys() {
        let runner =
            FakeRunner::new(vec!["a\x1fE\x1fAlice\x1f\x1fABC123"]).with_key_type("a", "gpg");
        let results = verify_commit_signatures("/repo", &["a".to_string()], false, &runner)
            .expect("verification should complete");

        assert_eq!(results[0].status, SignatureStatus::UnknownKey);
        assert!(runner.fetched_keys.borrow().is_empty());
        assert_eq!(runner.verified_hashes.borrow().len(), 1);
    }

    #[test]
    fn enabled_keyserver_verification_fetches_unknown_gpg_key_and_retries() {
        let runner = FakeRunner::new(vec![
            "a\x1fE\x1fAlice\x1f\x1fABC123",
            "a\x1fG\x1fAlice\x1fABC123\x1fABC123",
        ])
        .with_key_type("a", "gpg")
        .with_gpg_program("/usr/local/bin/gpg");
        let results = verify_commit_signatures("/repo", &["a".to_string()], true, &runner)
            .expect("verification should complete");

        assert_eq!(results[0].status, SignatureStatus::Verified);
        assert_eq!(
            runner.fetched_keys.borrow().as_slice(),
            &["/usr/local/bin/gpg ABC123".to_string()]
        );
        assert_eq!(
            runner.verified_hashes.borrow().as_slice(),
            &[vec!["a".to_string()], vec!["a".to_string()]]
        );
    }

    #[test]
    fn fetch_failure_leaves_unknown_key_status() {
        let runner = FakeRunner::new(vec!["a\x1fE\x1fAlice\x1f\x1fABC123"])
            .with_key_type("a", "gpg")
            .with_fetch_failure();
        let results = verify_commit_signatures("/repo", &["a".to_string()], true, &runner)
            .expect("verification should complete");

        assert_eq!(results[0].status, SignatureStatus::UnknownKey);
        assert_eq!(runner.fetched_keys.borrow().len(), 1);
        assert_eq!(runner.verified_hashes.borrow().len(), 1);
    }

    #[test]
    fn ssh_signatures_do_not_trigger_gpg_key_fetch() {
        let runner =
            FakeRunner::new(vec!["a\x1fE\x1fAlice\x1f\x1fSHA256:abc"]).with_key_type("a", "ssh");
        let results = verify_commit_signatures("/repo", &["a".to_string()], true, &runner)
            .expect("verification should complete");

        assert_eq!(results[0].status, SignatureStatus::UnknownKey);
        assert!(runner.fetched_keys.borrow().is_empty());
        assert_eq!(runner.verified_hashes.borrow().len(), 1);
    }

    #[test]
    fn detects_signature_type_from_commit_text() {
        assert_eq!(
            signature_key_type("gpgsig -----BEGIN PGP SIGNATURE-----"),
            Some("gpg".to_string())
        );
        assert_eq!(
            signature_key_type("gpgsig -----BEGIN SSH SIGNATURE-----"),
            Some("ssh".to_string())
        );
        assert_eq!(signature_key_type("tree abc"), None);
    }

    #[test]
    fn missing_verification_rows_return_none_for_requested_hashes() {
        let results = parse_verification_output(
            "a\x1fG\x1fAlice\x1fFINGERPRINT\x1fKEY",
            &["a".to_string(), "b".to_string()],
        );

        assert_eq!(results.len(), 2);
        assert_eq!(results[0].hash, "a");
        assert_eq!(results[0].status, SignatureStatus::Verified);
        assert_eq!(results[1].hash, "b");
        assert_eq!(results[1].status, SignatureStatus::None);
    }

    #[test]
    fn git_log_failure_returns_error() {
        let runner = FakeRunner::new(vec![""]).with_verification_failure("fatal: bad revision");
        let error = verify_commit_signatures("/repo", &["a".to_string()], false, &runner)
            .expect_err("git log failure should be returned");

        assert_eq!(error, "fatal: bad revision");
    }
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
        app.state::<AppState>()
            .git_service
            .cherry_pick_start(request)
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
        app.state::<AppState>()
            .git_service
            .cherry_pick_continue(request)
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
        app.state::<AppState>()
            .git_service
            .cherry_pick_abort(request)
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
        app.state::<AppState>()
            .git_service
            .revert_commit_start(request)
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
