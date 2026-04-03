use std::collections::HashMap;
use std::fs;
use std::io::Write;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use super::error::{GitError, GitResult};
use super::handler::GitOperationHandler;
use super::types::{
    AddRemoteRequest, BranchInfo, BranchRequest, CherryPickRequest, CherryPickResult, CloneRequest,
    CommitDateMode, CommitDetails, CommitDetailsRequest, CommitFileItem, CommitFilesRequest,
    CommitHistoryItem, CommitHistoryRequest, CommitMarkers, CommitRequest, CommitTrailer,
    ConflictFileItem, CreateBranchRequest, CreateTagRequest, DeleteBranchRequest,
    DeleteRemoteBranchRequest, DeleteRemoteTagRequest, DeleteTagRequest, DiffHunk, DiffLine,
    DiffLineKind, DiffRequest, ExternalDiffRequest, FetchRequest, FileDiff, FileRequest,
    FileStatusItem, GitIdentity, HunkStageRequest, IdentityRequest, IdentityScope, LineEndingStyle,
    MergeRequest, MergeResult, NumstatRequest, NumstatResult, OperationResult, PruneRemoteRequest,
    PullAnalysis, PullRecommendedAction, PullState, PullStrategy, PullStrategyRequest,
    PushFailureKind, PushRejectionAnalysis, PushRequest, PushResult, PushTagRequest, RebaseRequest,
    RebaseResult, RemoteInfo, RemoveRemoteRequest, RenameBranchRequest, RenameRemoteRequest,
    RepoRequest, RepoStatus, ResetMode, ResetRequest, RevertCommitRequest,
    SetBranchUpstreamRequest, SetIdentityRequest, SetRemoteUrlRequest, SignatureStatus,
    StageFilesRequest, StashEntry, StashPushRequest, StashRequest, TagInfo, UpstreamStatus,
};

pub struct CliGitHandler;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

impl CliGitHandler {
    fn preferred_mime_from_path(file_path: &str) -> Option<String> {
        let mut first: Option<String> = None;
        for mime in mime_guess::from_path(file_path) {
            let essence = mime.essence_str().to_ascii_lowercase();
            if first.is_none() {
                first = Some(essence.clone());
            }
            if essence.starts_with("text/") {
                return Some(essence);
            }
        }

        first
    }

    fn generic_label_from_path_extension(file_path: &str) -> Option<String> {
        let ext = Path::new(file_path).extension()?.to_str()?.trim();
        if ext.is_empty() {
            return None;
        }

        let normalized: String = ext
            .chars()
            .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '_' | '.'))
            .collect();
        if normalized.is_empty() {
            return None;
        }

        if normalized.len() <= 4 && normalized.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Some(normalized.to_ascii_uppercase());
        }

        Self::mime_token_to_label(&normalized)
    }

    pub fn new() -> Self {
        Self
    }

    fn configure_command(_command: &mut Command) {
        #[cfg(windows)]
        {
            _command.creation_flags(CREATE_NO_WINDOW);
        }
    }

    fn normalize_repo_path(repo_path: &str) -> GitResult<PathBuf> {
        let path = PathBuf::from(repo_path.trim());

        if repo_path.trim().is_empty() {
            return Err(GitError::InvalidInput(
                "Repository path cannot be empty".to_string(),
            ));
        }

        if !path.exists() {
            return Err(GitError::InvalidInput(format!(
                "Repository path does not exist: {}",
                path.display()
            )));
        }

        Ok(path)
    }

    fn run_git(args: &[&str], current_dir: Option<&Path>) -> GitResult<String> {
        Self::run_git_allow_exit_codes(args, current_dir, &[])
    }

    fn run_git_bytes(args: &[&str], current_dir: Option<&Path>) -> GitResult<Vec<u8>> {
        let mut command = crate::git_command();
        Self::configure_command(&mut command);
        command.args(args);

        if let Some(path) = current_dir {
            command.current_dir(path);
        }

        let output = command.output()?;
        if !output.status.success() {
            let stderr =
                Self::append_auth_help(String::from_utf8_lossy(&output.stderr).trim().to_string());
            let joined = format!("git {}", args.join(" "));
            return Err(GitError::CommandFailed {
                command: joined,
                stderr,
            });
        }

        Ok(output.stdout)
    }

    /// Returns `-c key=value` override args for tools that git doesn't know
    /// natively (VS Code, VS Codium). Prepend to any `git difftool` call.
    fn difftool_cmd_overrides(tool_name: &str) -> Vec<String> {
        match tool_name {
            "vscode" => vec![
                "-c".to_string(),
                "difftool.vscode.cmd=code --wait --diff $LOCAL $REMOTE".to_string(),
            ],
            "vscodium" => vec![
                "-c".to_string(),
                "difftool.vscodium.cmd=codium --wait --diff $LOCAL $REMOTE".to_string(),
            ],
            _ => vec![],
        }
    }

    /// Returns `-c key=value` override args for tools that git doesn't know
    /// natively (VS Code, VS Codium). Prepend to any `git mergetool` call.
    fn mergetool_cmd_overrides(tool_name: &str) -> Vec<String> {
        match tool_name {
            "vscode" => vec![
                "-c".to_string(),
                "mergetool.vscode.cmd=code --wait --merge $REMOTE $LOCAL $BASE $MERGED".to_string(),
            ],
            "vscodium" => vec![
                "-c".to_string(),
                "mergetool.vscodium.cmd=codium --wait --merge $REMOTE $LOCAL $BASE $MERGED"
                    .to_string(),
            ],
            _ => vec![],
        }
    }

    /// Spawns a command asynchronously and waits for completion on a background thread.
    /// This prevents long-running GUI tools from blocking the Tauri command handler.
    fn spawn_command_and_reap(mut command: Command, command_label: String) -> GitResult<()> {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn()?;
        std::thread::spawn(move || {
            if let Err(error) = child.wait() {
                eprintln!("Failed waiting for spawned command `{command_label}`: {error}");
            }
        });
        Ok(())
    }

    /// Like `run_git_with_overrides` but launches git asynchronously.
    fn spawn_git_with_overrides(
        overrides: &[String],
        args: &[&str],
        current_dir: Option<&Path>,
    ) -> GitResult<()> {
        let mut command = crate::git_command();
        Self::configure_command(&mut command);
        command
            .args(overrides.iter().map(String::as_str))
            .args(args);
        if let Some(path) = current_dir {
            command.current_dir(path);
        }
        let joined_args = args.join(" ");
        Self::spawn_command_and_reap(command, format!("git {joined_args}"))
    }

    /// Like `run_git_allow_exit_codes` but prepends owned override strings.
    fn run_git_with_overrides_allow_exit_codes(
        overrides: &[String],
        args: &[&str],
        current_dir: Option<&Path>,
        extra_ok_codes: &[i32],
    ) -> GitResult<String> {
        let prefix: Vec<&str> = overrides.iter().map(String::as_str).collect();
        let mut all: Vec<&str> = prefix;
        all.extend_from_slice(args);
        Self::run_git_allow_exit_codes(&all, current_dir, extra_ok_codes)
    }

    /// Like `run_git` but treats the given extra exit codes as success (stdout is returned).
    /// Useful for commands like `git diff --no-index` which exits with 1 when differences exist.
    fn run_git_allow_exit_codes(
        args: &[&str],
        current_dir: Option<&Path>,
        extra_ok_codes: &[i32],
    ) -> GitResult<String> {
        let mut command = crate::git_command();
        Self::configure_command(&mut command);
        command.args(args);

        if let Some(path) = current_dir {
            command.current_dir(path);
        }

        let output = command.output()?;

        let exit_ok = output.status.success()
            || output
                .status
                .code()
                .map(|c| extra_ok_codes.contains(&c))
                .unwrap_or(false);

        if !exit_ok {
            let stderr =
                Self::append_auth_help(String::from_utf8_lossy(&output.stderr).trim().to_string());
            let joined = format!("git {}", args.join(" "));
            return Err(GitError::CommandFailed {
                command: joined,
                stderr,
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        Ok(stdout)
    }

    fn path_to_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn current_branch_name(repo_path: &Path) -> Option<String> {
        Self::run_git_allow_exit_codes(
            &["rev-parse", "--abbrev-ref", "HEAD"],
            Some(repo_path),
            &[128],
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    }

    fn upstream_branch_name(repo_path: &Path) -> Option<String> {
        Self::run_git_allow_exit_codes(
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
            Some(repo_path),
            &[128],
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    }

    fn remote_tracking_ref_exists(repo_path: &Path, upstream: &str) -> bool {
        let trimmed = upstream.trim();
        if trimmed.is_empty() {
            return false;
        }

        let full_ref = format!("refs/remotes/{trimmed}");
        Self::run_git(
            &["rev-parse", "--verify", "--quiet", &full_ref],
            Some(repo_path),
        )
        .is_ok()
    }

    fn branch_upstream_status(repo_path: &Path, upstream: Option<&str>) -> UpstreamStatus {
        match upstream {
            Some(upstream_name) if Self::remote_tracking_ref_exists(repo_path, upstream_name) => {
                UpstreamStatus::Tracked
            }
            Some(_) => UpstreamStatus::Missing,
            None => UpstreamStatus::None,
        }
    }

    fn repo_request(repo_path: &Path) -> RepoRequest {
        RepoRequest {
            repo_path: Self::path_to_string(repo_path),
        }
    }

    fn is_detached_head(branch_name: Option<&str>) -> bool {
        matches!(branch_name, Some("HEAD"))
    }

    fn has_active_operation(status: &RepoStatus) -> bool {
        status.merge_in_progress
            || status.rebase_in_progress
            || status.cherry_pick_in_progress
            || status.revert_in_progress
    }

    fn classify_pull_state(
        current_branch: Option<&str>,
        upstream_branch: Option<&str>,
        ahead: u32,
        behind: u32,
        status: &RepoStatus,
    ) -> (PullState, PullRecommendedAction, String) {
        if Self::is_detached_head(current_branch) {
            return (
                PullState::DetachedHead,
                PullRecommendedAction::None,
                "Pull is unavailable while HEAD is detached.".to_string(),
            );
        }

        if Self::has_active_operation(status) {
            return (
                PullState::OperationInProgress,
                PullRecommendedAction::None,
                "Finish or abort the current merge, rebase, cherry-pick, or revert before pulling."
                    .to_string(),
            );
        }

        if upstream_branch.is_none() {
            return (
                PullState::NoUpstream,
                PullRecommendedAction::None,
                "This branch does not have an upstream configured.".to_string(),
            );
        }

        let has_working_tree_changes =
            !status.changed_files.is_empty() || !status.unversioned_files.is_empty();
        let has_staged_changes = !status.staged_files.is_empty();
        if has_working_tree_changes || has_staged_changes {
            return (
                PullState::BlockedDirtyWorktree,
                PullRecommendedAction::None,
                "Commit, stash, or discard local changes before integrating remote changes."
                    .to_string(),
            );
        }

        match (ahead, behind) {
            (0, 0) => (
                PullState::UpToDate,
                PullRecommendedAction::None,
                "This branch is already up to date with its upstream.".to_string(),
            ),
            (0, _) => (
                PullState::BehindOnly,
                PullRecommendedAction::FfOnlyPull,
                "Remote changes are available and can be fast-forwarded into this branch."
                    .to_string(),
            ),
            (_, 0) => (
                PullState::AheadOnly,
                PullRecommendedAction::Push,
                "This branch only has local commits. Push it instead of pulling.".to_string(),
            ),
            _ => (
                PullState::Divergent,
                PullRecommendedAction::Rebase,
                "This branch and its upstream both have unique commits. Choose rebase or merge before integrating."
                    .to_string(),
            ),
        }
    }

    fn build_pull_analysis(&self, repo_path: &Path) -> GitResult<PullAnalysis> {
        let status = self.get_repo_status(&Self::repo_request(repo_path))?;
        let current_branch = status
            .current_branch
            .clone()
            .or_else(|| Self::current_branch_name(repo_path));
        let upstream_branch = Self::upstream_branch_name(repo_path);
        let (ahead, behind) = match (&current_branch, &upstream_branch) {
            (Some(branch), Some(upstream)) if !Self::is_detached_head(Some(branch)) => {
                Self::get_ahead_behind(repo_path, branch, upstream)
            }
            _ => (0, 0),
        };
        let has_staged_changes = !status.staged_files.is_empty();
        let has_working_tree_changes = has_staged_changes
            || !status.changed_files.is_empty()
            || !status.unversioned_files.is_empty();
        let (state, recommended_action, message) = Self::classify_pull_state(
            current_branch.as_deref(),
            upstream_branch.as_deref(),
            ahead,
            behind,
            &status,
        );

        Ok(PullAnalysis {
            repo_path: Self::path_to_string(repo_path),
            current_branch,
            upstream_branch,
            ahead,
            behind,
            has_working_tree_changes,
            has_staged_changes,
            merge_in_progress: status.merge_in_progress,
            rebase_in_progress: status.rebase_in_progress,
            cherry_pick_in_progress: status.cherry_pick_in_progress,
            revert_in_progress: status.revert_in_progress,
            state,
            recommended_action,
            message,
        })
    }

    fn push_failure_branch_context(repo_path: &Path) -> (Option<String>, Option<String>) {
        (
            Self::current_branch_name(repo_path)
                .filter(|branch| !Self::is_detached_head(Some(branch))),
            Self::upstream_branch_name(repo_path),
        )
    }

    fn classify_push_failure(repo_path: &Path, stderr: &str) -> PushRejectionAnalysis {
        let stderr_lower = stderr.to_ascii_lowercase();
        let (current_branch, upstream_branch) = Self::push_failure_branch_context(repo_path);

        let (kind, message, suggested_next_actions) = if stderr_lower.contains("non-fast-forward")
            || stderr_lower.contains("[rejected]")
            || stderr_lower.contains("fetch first")
            || stderr_lower.contains("tip of your current branch is behind")
        {
            (
                PushFailureKind::NonFastForward,
                "Push was rejected because the remote branch has new commits. Fetch, review, and integrate those changes before pushing again.".to_string(),
                vec![
                    "fetch".to_string(),
                    "review".to_string(),
                    "integrate".to_string(),
                ],
            )
        } else if stderr_lower.contains("no upstream branch") {
            (
                PushFailureKind::NoUpstream,
                "This branch does not have an upstream yet. Publish it to a remote before pushing normally.".to_string(),
                vec!["publish".to_string()],
            )
        } else if stderr_lower.contains("upstream branch of your current branch does not match")
            || stderr_lower.contains("has no such ref was fetched")
            || stderr_lower.contains("couldn't find remote ref")
            || stderr_lower.contains("upstream is gone")
            || stderr_lower.contains("remote branch")
                && (stderr_lower.contains("not found")
                    || stderr_lower.contains("does not exist")
                    || stderr_lower.contains("missing"))
        {
            (
                PushFailureKind::UpstreamMissing,
                "The configured upstream branch is missing or no longer matches this branch. Repair the upstream before retrying.".to_string(),
                vec!["repair-upstream".to_string()],
            )
        } else if stderr_lower.contains("authentication failed")
            || stderr_lower.contains("could not read from remote repository")
            || stderr_lower.contains("permission denied")
            || stderr_lower.contains("permission to")
            || stderr_lower.contains("repository not found")
        {
            (
                PushFailureKind::Auth,
                "Push failed because Git could not authenticate with the remote.".to_string(),
                vec!["retry".to_string()],
            )
        } else if stderr_lower.contains("could not resolve host")
            || stderr_lower.contains("failed to connect")
            || stderr_lower.contains("connection timed out")
            || stderr_lower.contains("network is unreachable")
            || stderr_lower.contains("connection reset")
        {
            (
                PushFailureKind::Network,
                "Push failed because Git could not reach the remote.".to_string(),
                vec!["retry".to_string()],
            )
        } else {
            (
                PushFailureKind::Other,
                "Push failed. Review the Git output and retry when the repository state is clear."
                    .to_string(),
                vec!["retry".to_string()],
            )
        };

        PushRejectionAnalysis {
            repo_path: Self::path_to_string(repo_path),
            current_branch,
            upstream_branch,
            kind,
            message,
            suggested_next_actions,
        }
    }

    fn execute_pull_command(
        &self,
        repo_path: &Path,
        args: &[&str],
        success_message: &str,
        conflict_message: &str,
    ) -> GitResult<OperationResult> {
        match Self::run_git(args, Some(repo_path)) {
            Ok(output) => Ok(OperationResult {
                message: success_message.to_string(),
                output: (!output.is_empty()).then_some(output),
                repo_path: Some(Self::path_to_string(repo_path)),
                backend_used: "git-cli".to_string(),
            }),
            Err(GitError::CommandFailed { stderr, .. }) => {
                let status = self.get_repo_status(&Self::repo_request(repo_path))?;
                if status.merge_in_progress || status.rebase_in_progress {
                    return Ok(OperationResult {
                        message: conflict_message.to_string(),
                        output: (!stderr.is_empty()).then_some(stderr),
                        repo_path: Some(Self::path_to_string(repo_path)),
                        backend_used: "git-cli".to_string(),
                    });
                }

                Err(GitError::CommandFailed {
                    command: format!("git {}", args.join(" ")),
                    stderr,
                })
            }
            Err(error) => Err(error),
        }
    }

    fn try_rev_parse(repo_path: &Path, rev: &str) -> Option<String> {
        Self::run_git(&["rev-parse", rev], Some(repo_path))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn resolve_remote_tracking_ref(repo_path: &Path, base_ref: &str) -> Option<String> {
        let trimmed = base_ref.trim();
        if trimmed.is_empty() {
            return None;
        }

        let candidate = trimmed
            .strip_prefix("refs/remotes/")
            .or_else(|| trimmed.strip_prefix("remotes/"))
            .unwrap_or(trimmed);

        if !candidate.contains('/') {
            return None;
        }

        let full_ref = format!("refs/remotes/{candidate}");
        if Self::run_git(
            &["rev-parse", "--verify", "--quiet", &full_ref],
            Some(repo_path),
        )
        .is_ok()
        {
            Some(candidate.to_string())
        } else {
            None
        }
    }

    fn derive_local_branch_from_remote_ref(remote_ref: &str) -> Option<String> {
        let (_, branch_name) = remote_ref.split_once('/')?;
        let branch_name = branch_name.trim();

        if branch_name.is_empty() || branch_name == "HEAD" {
            return None;
        }

        Some(branch_name.to_string())
    }

    fn ensure_valid_branch_name(repo_path: &Path, branch_name: &str) -> GitResult<()> {
        if branch_name.trim().is_empty() {
            return Err(GitError::InvalidInput(
                "Branch name cannot be empty".to_string(),
            ));
        }

        if let Err(GitError::CommandFailed { .. }) = Self::run_git(
            &["check-ref-format", "--branch", branch_name],
            Some(repo_path),
        ) {
            return Err(GitError::InvalidInput(
                "Invalid branch name format".to_string(),
            ));
        }

        Ok(())
    }

    fn has_control_characters(value: &str) -> bool {
        value.chars().any(char::is_control)
    }

    fn validate_git_location(value: &str, field_name: &str) -> GitResult<()> {
        let trimmed = value.trim();

        if trimmed.is_empty() {
            return Err(GitError::InvalidInput(format!(
                "{field_name} cannot be empty"
            )));
        }

        if trimmed.starts_with('-') {
            return Err(GitError::InvalidInput(format!(
                "{field_name} cannot start with '-'"
            )));
        }

        if Self::has_control_characters(trimmed) {
            return Err(GitError::InvalidInput(format!(
                "{field_name} contains invalid control characters"
            )));
        }

        Ok(())
    }

    pub fn validate_clone_repo_url(repo_url: &str) -> GitResult<()> {
        Self::validate_git_location(repo_url, "Repository URL")
    }

    fn validate_remote_url(remote_url: &str) -> GitResult<()> {
        Self::validate_git_location(remote_url, "Remote URL")
    }

    fn ensure_valid_remote_name(repo_path: &Path, remote_name: &str) -> GitResult<()> {
        let trimmed = remote_name.trim();

        if trimmed.is_empty() {
            return Err(GitError::InvalidInput(
                "Remote name cannot be empty".to_string(),
            ));
        }

        if trimmed.starts_with('-') {
            return Err(GitError::InvalidInput(
                "Remote name cannot start with '-'".to_string(),
            ));
        }

        if trimmed.chars().any(char::is_whitespace) {
            return Err(GitError::InvalidInput(
                "Remote name cannot contain whitespace".to_string(),
            ));
        }

        if Self::has_control_characters(trimmed) {
            return Err(GitError::InvalidInput(
                "Remote name contains invalid control characters".to_string(),
            ));
        }

        let remote_ref = format!("refs/remotes/{trimmed}");
        if let Err(GitError::CommandFailed { .. }) = Self::run_git(
            &["check-ref-format", "--normalize", &remote_ref],
            Some(repo_path),
        ) {
            return Err(GitError::InvalidInput(
                "Invalid remote name format".to_string(),
            ));
        }

        Ok(())
    }

    fn ensure_valid_tag_name(repo_path: &Path, tag_name: &str) -> GitResult<()> {
        let trimmed = tag_name.trim();

        if trimmed.is_empty() {
            return Err(GitError::InvalidInput(
                "Tag name cannot be empty".to_string(),
            ));
        }

        if trimmed.starts_with('-') {
            return Err(GitError::InvalidInput(
                "Tag name cannot start with '-'".to_string(),
            ));
        }

        if trimmed.chars().any(char::is_whitespace) {
            return Err(GitError::InvalidInput(
                "Tag name cannot contain whitespace".to_string(),
            ));
        }

        if Self::has_control_characters(trimmed) {
            return Err(GitError::InvalidInput(
                "Tag name contains invalid control characters".to_string(),
            ));
        }

        let tag_ref = format!("refs/tags/{trimmed}");
        if let Err(GitError::CommandFailed { .. }) = Self::run_git(
            &["check-ref-format", "--normalize", &tag_ref],
            Some(repo_path),
        ) {
            return Err(GitError::InvalidInput(
                "Invalid tag name format".to_string(),
            ));
        }

        Ok(())
    }

    fn ensure_no_active_branch_operation(repo_path: &Path, action: &str) -> GitResult<()> {
        if Self::is_merge_in_progress(repo_path) {
            return Err(GitError::InvalidInput(format!(
                "Cannot {action} while a merge is in progress"
            )));
        }
        if Self::is_rebase_in_progress(repo_path) {
            return Err(GitError::InvalidInput(format!(
                "Cannot {action} while a rebase is in progress"
            )));
        }
        if Self::is_cherry_pick_in_progress(repo_path) {
            return Err(GitError::InvalidInput(format!(
                "Cannot {action} while a cherry-pick is in progress"
            )));
        }
        if Self::is_revert_in_progress(repo_path) {
            return Err(GitError::InvalidInput(format!(
                "Cannot {action} while a revert is in progress"
            )));
        }

        Ok(())
    }

    fn run_git_with_stdin(
        args: &[&str],
        current_dir: &Path,
        stdin_data: &[u8],
    ) -> GitResult<String> {
        let mut command = crate::git_command();
        Self::configure_command(&mut command);
        command
            .args(args)
            .current_dir(current_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = command.spawn()?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(stdin_data)
                .map_err(|e| GitError::IoError(e.to_string()))?;
        }

        let output = child.wait_with_output()?;

        if !output.status.success() {
            let stderr =
                Self::append_auth_help(String::from_utf8_lossy(&output.stderr).trim().to_string());
            let joined = format!("git {}", args.join(" "));
            return Err(GitError::CommandFailed {
                command: joined,
                stderr,
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout)
            .trim_end()
            .to_string();
        Ok(stdout)
    }

    fn append_auth_help(stderr: String) -> String {
        let lower = stderr.to_lowercase();

        let hint = if lower.contains("permission denied (publickey)")
            || lower.contains("could not read from remote repository")
            || lower.contains("ssh") && lower.contains("permission denied")
        {
            Some(
                "Authentication hint: SSH auth failed. Check your key setup (`ssh-add -l`), SSH agent, and remote URL.".to_string(),
            )
        } else if lower.contains("could not read username")
            || lower.contains("authentication failed")
            || lower.contains("http basic")
            || lower.contains("access denied")
            || lower.contains("403")
        {
            Some(
                "Authentication hint: HTTPS auth failed. Check your credential helper/token (`git config --global credential.helper`, `gh auth status`).".to_string(),
            )
        } else if lower.contains("no such device or address") || lower.contains("credential") {
            Some(
                "Authentication hint: Credential helper may be missing or misconfigured. Verify `git config --show-origin --get-all credential.helper`.".to_string(),
            )
        } else {
            None
        };

        match hint {
            Some(h) if !stderr.is_empty() => format!("{stderr}\n{h}"),
            Some(h) => h,
            None => stderr,
        }
    }

    fn is_added_file_in_commit(
        repo_path: &Path,
        commit_hash: &str,
        file_path: &str,
    ) -> GitResult<bool> {
        let output = Self::run_git(
            &[
                "show",
                "--name-status",
                "--format=",
                "--no-renames",
                commit_hash,
                "--",
                file_path,
            ],
            Some(repo_path),
        )?;

        for line in output.lines() {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next().unwrap_or_default().trim();
            let path = parts.next().unwrap_or_default().trim();
            if path == file_path {
                return Ok(status.starts_with('A'));
            }
        }

        Ok(false)
    }

    fn open_in_system_default(path: &Path) -> GitResult<()> {
        let mut command = if cfg!(target_os = "windows") {
            let mut cmd = Command::new("cmd");
            Self::configure_command(&mut cmd);
            cmd.args(["/C", "start", ""]).arg(path);
            cmd
        } else if cfg!(target_os = "macos") {
            let mut cmd = Command::new("open");
            Self::configure_command(&mut cmd);
            cmd.arg(path);
            cmd
        } else {
            let mut cmd = Command::new("xdg-open");
            Self::configure_command(&mut cmd);
            cmd.arg(path);
            cmd
        };

        let output = command.output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitError::CommandFailed {
                command: format!("open {}", path.display()),
                stderr,
            });
        }

        Ok(())
    }

    fn materialize_commit_file_for_open(
        repo_path: &Path,
        commit_hash: &str,
        file_path: &str,
    ) -> GitResult<PathBuf> {
        let blob_spec = format!("{commit_hash}:{file_path}");
        let content = Self::run_git(&["show", &blob_spec], Some(repo_path))?;

        let mut out_path = std::env::temp_dir();
        out_path.push("gitmun-opened-files");
        out_path.push(commit_hash);
        out_path.push(file_path);

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(&out_path, content.as_bytes())?;
        Ok(out_path)
    }

    fn get_diff_tool_name(repo_path: &Path) -> Option<String> {
        let mut command = crate::git_command();
        Self::configure_command(&mut command);
        let output = command
            .args(["config", "--get", "diff.tool"])
            .current_dir(repo_path)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() { None } else { Some(value) }
    }

    fn require_configured_diff_tool(repo_path: &Path) -> GitResult<String> {
        Self::get_diff_tool_name(repo_path).ok_or_else(|| {
            GitError::InvalidInput(
                "No external diff tool is configured. Configure one in Settings before using external diff."
                    .to_string(),
            )
        })
    }

    fn get_merge_tool_name(repo_path: &Path) -> Option<String> {
        let mut command = crate::git_command();
        Self::configure_command(&mut command);
        let output = command
            .args(["config", "--get", "merge.tool"])
            .current_dir(repo_path)
            .output()
            .ok()?;

        if !output.status.success() {
            return None;
        }

        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() { None } else { Some(value) }
    }

    fn require_configured_merge_tool(repo_path: &Path) -> GitResult<String> {
        Self::get_merge_tool_name(repo_path)
            .or_else(|| Self::get_diff_tool_name(repo_path))
            .ok_or_else(|| {
                GitError::InvalidInput(
                    "No merge tool is configured. Set merge.tool or diff.tool in git config before using the merge tool."
                        .to_string(),
                )
            })
    }

    fn materialize_index_file_for_diff(repo_path: &Path, file_path: &str) -> GitResult<PathBuf> {
        let spec = format!(":{file_path}");
        let content = Self::run_git(&["show", &spec], Some(repo_path))?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);

        let mut out_path = std::env::temp_dir();
        out_path.push("gitmun-difftool");
        out_path.push(format!("index-{now}-{}", std::process::id()));
        out_path.push(file_path);

        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        fs::write(&out_path, content.as_bytes())?;
        Ok(out_path)
    }

    fn launch_tool_for_two_paths(
        repo_path: &Path,
        tool_name: &str,
        left_path: &Path,
        right_path: &Path,
    ) -> GitResult<()> {
        let lower = tool_name.to_lowercase();

        let command = match lower.as_str() {
            "meld" => {
                let mut cmd = Command::new("meld");
                Self::configure_command(&mut cmd);
                cmd.arg(left_path).arg(right_path);
                cmd
            }
            "kompare" => {
                let mut cmd = Command::new("kompare");
                Self::configure_command(&mut cmd);
                cmd.arg(left_path).arg(right_path);
                cmd
            }
            "winmerge" => {
                let mut cmd = Command::new("WinMergeU");
                Self::configure_command(&mut cmd);
                cmd.arg(left_path).arg(right_path);
                cmd
            }
            _ => {
                let mut cmd = crate::git_command();
                Self::configure_command(&mut cmd);
                cmd.args(Self::difftool_cmd_overrides(tool_name))
                    .args(["difftool", "-y", "--tool", tool_name, "--no-index", "--"])
                    .arg(left_path)
                    .arg(right_path)
                    .current_dir(repo_path);
                cmd
            }
        };

        Self::spawn_command_and_reap(command, "external diff tool".to_string())
    }

    /// Returns an error if the repository's HEAD ref is broken (e.g. from an
    /// interrupted clone), or `None` if HEAD is valid or simply unborn (empty repo).
    pub fn check_head_broken(repo_path: &Path) -> Option<GitError> {
        match Self::run_git(&["rev-parse", "HEAD"], Some(repo_path)) {
            Err(GitError::CommandFailed { stderr, .. })
                if stderr.contains("appears to be broken") =>
            {
                Some(GitError::InvalidInput(
                    "This repository has a broken HEAD ref - the clone was likely interrupted. \
                     Delete the directory and re-clone."
                        .to_string(),
                ))
            }
            _ => None,
        }
    }
}

impl GitOperationHandler for CliGitHandler {
    fn validate_repo_path(&self, repo_path: &str) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(repo_path)?;
        let output = Self::run_git(&["rev-parse", "--show-toplevel"], Some(&repo_path))?;
        let resolved_path = if output.is_empty() {
            repo_path
        } else {
            PathBuf::from(output.trim())
        };

        if let Some(err) = Self::check_head_broken(&resolved_path) {
            return Err(err);
        }

        Ok(OperationResult {
            message: format!("Opened repository {}", resolved_path.display()),
            output: None,
            repo_path: Some(Self::path_to_string(&resolved_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn get_numstat(&self, request: &NumstatRequest) -> GitResult<NumstatResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();
        if file_path.is_empty() {
            return Err(GitError::InvalidInput("File path is required".to_string()));
        }

        let output = if request.staged {
            Self::run_git(
                &["diff", "--cached", "--numstat", "--", file_path],
                Some(&repo_path),
            )?
        } else {
            Self::run_git(&["diff", "--numstat", "--", file_path], Some(&repo_path))?
        };

        let (additions, deletions) = Self::parse_numstat_totals(&output);
        Ok(NumstatResult {
            file_path: file_path.to_string(),
            additions,
            deletions,
        })
    }

    fn clone_repo(&self, request: &CloneRequest) -> GitResult<OperationResult> {
        let repo_url = request.repo_url.trim();
        let destination = request.destination.trim();

        Self::validate_clone_repo_url(repo_url)?;

        let final_destination = Self::resolve_clone_destination(repo_url, destination)?;
        let final_destination_str = final_destination.to_string_lossy().to_string();
        let output = Self::run_git(&["clone", repo_url, &final_destination_str], None)?;
        Ok(OperationResult {
            message: format!("Cloned repository to {}", final_destination.display()),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(final_destination_str),
            backend_used: "git-cli".to_string(),
        })
    }

    fn analyze_pull(&self, request: &RepoRequest) -> GitResult<PullAnalysis> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        self.build_pull_analysis(&repo_path)
    }

    fn pull_changes(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        self.execute_pull_command(
            &repo_path,
            &["pull"],
            &format!("Pulled latest changes in {}", repo_path.display()),
            "Pull started a conflict resolution flow. Resolve the conflicts, then continue or complete the operation.",
        )
    }

    fn pull_with_strategy(&self, request: &PullStrategyRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let analysis = self.build_pull_analysis(&repo_path)?;

        match request.strategy {
            PullStrategy::FfOnly => {
                if !matches!(analysis.state, PullState::BehindOnly) {
                    return Err(GitError::InvalidInput(
                        "Fast-forward pull is only available when the branch is behind its upstream."
                            .to_string(),
                    ));
                }

                self.execute_pull_command(
                    &repo_path,
                    &["pull", "--ff-only"],
                    "Fast-forward pull complete.",
                    "Pull started a conflict resolution flow. Resolve the conflicts, then continue or complete the operation.",
                )
            }
            PullStrategy::Rebase => {
                if !matches!(analysis.state, PullState::BehindOnly | PullState::Divergent) {
                    return Err(GitError::InvalidInput(
                        "Rebase pull is only available when remote changes need to be integrated."
                            .to_string(),
                    ));
                }

                self.execute_pull_command(
                    &repo_path,
                    &["pull", "--rebase"],
                    "Rebase pull complete.",
                    "Rebase started and needs conflict resolution. Resolve the conflicts, then continue the rebase.",
                )
            }
            PullStrategy::Merge => {
                if !matches!(analysis.state, PullState::BehindOnly | PullState::Divergent) {
                    return Err(GitError::InvalidInput(
                        "Merge pull is only available when remote changes need to be integrated."
                            .to_string(),
                    ));
                }

                self.execute_pull_command(
                    &repo_path,
                    &["pull", "--no-rebase"],
                    "Merge pull complete.",
                    "Merge started and needs conflict resolution. Resolve the conflicts, then complete or abort the merge.",
                )
            }
        }
    }

    fn commit_changes(&self, request: &CommitRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let message = request.message.trim();

        if message.is_empty() {
            return Err(GitError::InvalidInput(
                "Commit message cannot be empty".to_string(),
            ));
        }

        let mut args = vec!["commit", "-m", message];
        let commit_gpgsign = Self::run_git_allow_exit_codes(
            &["config", "--get", "commit.gpgsign"],
            Some(&repo_path),
            &[1],
        )
        .ok()
        .map(|value| value.trim().to_ascii_lowercase());
        let has_signing_key =
            Self::run_git(&["config", "--get", "user.signingkey"], Some(&repo_path))
                .map(|value| !value.trim().is_empty())
                .unwrap_or(false);
        let should_sign = match commit_gpgsign.as_deref() {
            Some("false") | Some("0") | Some("no") | Some("off") => false,
            Some("true") | Some("1") | Some("yes") | Some("on") => true,
            Some(_) => true,
            None => has_signing_key,
        };
        if should_sign {
            args.push("-S");
        }
        if request.amend == Some(true) {
            args.push("--amend");
        }
        let output = Self::run_git(&args, Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Committed changes in {}", repo_path.display()),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stage_files(&self, request: &StageFilesRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let files: Vec<&str> = request
            .files
            .iter()
            .map(|file| file.trim())
            .filter(|file| !file.is_empty())
            .collect();

        if files.is_empty() {
            return Err(GitError::InvalidInput(
                "No files selected for staging".to_string(),
            ));
        }

        let mut args = vec!["add", "--"];
        args.extend(files.iter().copied());
        Self::run_git(&args, Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Staged {} file(s) in {}", files.len(), repo_path.display()),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn get_configured_diff_tool(&self, request: &RepoRequest) -> GitResult<Option<String>> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Ok(Self::get_diff_tool_name(&repo_path))
    }

    fn open_external_diff(&self, request: &ExternalDiffRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let commit_hash = request.commit_hash.trim();
        let file_path = request.file_path.trim();

        if commit_hash.is_empty() || file_path.is_empty() {
            return Err(GitError::InvalidInput(
                "Commit hash and file path are required".to_string(),
            ));
        }

        if Self::is_added_file_in_commit(&repo_path, commit_hash, file_path)? {
            let working_tree_file = repo_path.join(file_path);
            let path_to_open = if working_tree_file.exists() {
                working_tree_file
            } else {
                Self::materialize_commit_file_for_open(&repo_path, commit_hash, file_path)?
            };

            Self::open_in_system_default(&path_to_open)?;

            return Ok(OperationResult {
                message: format!("Opened new file {file_path} in system editor"),
                output: None,
                repo_path: Some(Self::path_to_string(&repo_path)),
                backend_used: "git-cli".to_string(),
            });
        }

        let tool_name = Self::require_configured_diff_tool(&repo_path)?;
        let parent = format!("{commit_hash}^");
        let overrides = Self::difftool_cmd_overrides(&tool_name);
        let args = [
            "difftool",
            "-y",
            "--tool",
            tool_name.as_str(),
            parent.as_str(),
            commit_hash,
            "--",
            file_path,
        ];
        Self::spawn_git_with_overrides(&overrides, &args, Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Opened external diff for {file_path}"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn open_working_tree_diff(&self, request: &DiffRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();

        if file_path.is_empty() {
            return Err(GitError::InvalidInput("File path is required".to_string()));
        }

        if request.staged {
            let tool_name = Self::require_configured_diff_tool(&repo_path)?;
            let overrides = Self::difftool_cmd_overrides(&tool_name);
            let args = [
                "difftool",
                "-y",
                "--tool",
                tool_name.as_str(),
                "--cached",
                "--",
                file_path,
            ];
            Self::spawn_git_with_overrides(&overrides, &args, Some(&repo_path))?;
        } else {
            let working_tree_path = repo_path.join(file_path);
            if !working_tree_path.exists() {
                return Err(GitError::InvalidInput(format!(
                    "Working tree file does not exist: {}",
                    working_tree_path.display()
                )));
            }

            match Self::materialize_index_file_for_diff(&repo_path, file_path) {
                Ok(index_copy) => {
                    let tool_name = Self::require_configured_diff_tool(&repo_path)?;
                    Self::launch_tool_for_two_paths(
                        &repo_path,
                        tool_name.as_str(),
                        &index_copy,
                        &working_tree_path,
                    )?;
                }
                Err(_) => {
                    // Likely untracked file: open directly in system editor
                    Self::open_in_system_default(&working_tree_path)?;
                }
            }
        }

        Ok(OperationResult {
            message: format!("Opened diff for {file_path}"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn get_repo_status(&self, request: &RepoRequest) -> GitResult<RepoStatus> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let output = Self::run_git(
            &["-c", "core.quotepath=false", "status", "--porcelain=v1"],
            Some(&repo_path),
        )?;
        let mut status = Self::parse_repo_status(&output);
        status.current_branch = Self::detect_current_branch(&repo_path);

        // Detect merge state
        let merge_head_path = repo_path.join(".git/MERGE_HEAD");
        status.merge_in_progress = merge_head_path.exists();
        if status.merge_in_progress {
            status.merge_head_branch = Self::detect_merge_branch(&repo_path);
            status.conflicted_files = Self::parse_conflicted_files(&output);
            status.merge_message = std::fs::read_to_string(repo_path.join(".git/MERGE_MSG")).ok();
        }

        status.rebase_in_progress = Self::is_rebase_in_progress(&repo_path);
        if status.rebase_in_progress {
            status.rebase_onto = Self::detect_rebase_onto(&repo_path);
            if !status.merge_in_progress {
                status.conflicted_files = Self::parse_conflicted_files(&output);
            }
        }

        status.cherry_pick_in_progress = Self::is_cherry_pick_in_progress(&repo_path);
        if status.cherry_pick_in_progress {
            status.cherry_pick_head = Self::detect_cherry_pick_head(&repo_path);
            if !status.merge_in_progress && !status.rebase_in_progress {
                status.conflicted_files = Self::parse_conflicted_files(&output);
            }
        }

        status.revert_in_progress = Self::is_revert_in_progress(&repo_path);
        if status.revert_in_progress {
            status.revert_head = Self::detect_revert_head(&repo_path);
            if !status.merge_in_progress
                && !status.rebase_in_progress
                && !status.cherry_pick_in_progress
            {
                status.conflicted_files = Self::parse_conflicted_files(&output);
            }
        }

        // Gather numstat for unstaged changes
        let unstaged_numstat =
            Self::run_git(&["diff", "--numstat"], Some(&repo_path)).unwrap_or_default();
        let unstaged_stats = Self::parse_numstat(&unstaged_numstat);

        // Gather numstat for staged changes
        let staged_numstat =
            Self::run_git(&["diff", "--cached", "--numstat"], Some(&repo_path)).unwrap_or_default();
        let staged_stats = Self::parse_numstat(&staged_numstat);

        for file in &mut status.changed_files {
            if let Some((add, del)) = unstaged_stats.get(file.path.as_str()) {
                file.additions = Some(*add);
                file.deletions = Some(*del);
            }
        }

        for file in &mut status.staged_files {
            if let Some((add, del)) = staged_stats.get(file.path.as_str()) {
                file.additions = Some(*add);
                file.deletions = Some(*del);
            }
        }

        Ok(status)
    }

    fn get_commit_history(
        &self,
        request: &CommitHistoryRequest,
    ) -> GitResult<Vec<CommitHistoryItem>> {
        let date_placeholder = match request.commit_date_mode {
            CommitDateMode::AuthorDate => "%ad",
            CommitDateMode::CommitterDate => "%cd",
        };
        let log_format = format!("%H%x1f%h%x1f%an%x1f%ae%x1f{date_placeholder}%x1f%s%x1f%G?");
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let limit = request.limit.unwrap_or(100).clamp(1, 5000).to_string();
        let skip = format!("--skip={}", request.offset.unwrap_or(0));
        let pretty = format!("--pretty=format:{log_format}");

        let output = match Self::run_git(
            &[
                "log",
                "-n",
                limit.as_str(),
                skip.as_str(),
                "--date=iso-strict",
                pretty.as_str(),
            ],
            Some(&repo_path),
        ) {
            Ok(stdout) => stdout,
            Err(GitError::CommandFailed { command: _, stderr })
                if stderr.contains("does not have any commits yet")
                    || stderr.contains("appears to be broken") =>
            {
                return Ok(Vec::new());
            }
            Err(error) => return Err(error),
        };

        let mut commits = Vec::new();

        for line in output.lines().filter(|line| !line.trim().is_empty()) {
            let mut parts = line.splitn(7, '\u{1f}');
            let hash = parts.next().unwrap_or_default().trim().to_string();
            let short_hash = parts.next().unwrap_or_default().trim().to_string();
            let author = parts.next().unwrap_or_default().trim().to_string();
            let author_email = parts.next().unwrap_or_default().trim().to_string();
            let date = parts.next().unwrap_or_default().trim().to_string();
            let message = parts.next().unwrap_or_default().trim().to_string();
            let sig_char = parts.next().unwrap_or_default().trim();

            if hash.is_empty() || short_hash.is_empty() {
                continue;
            }

            // %G? values: G=good, B=bad, U=good/unknown-validity, X=good/expired,
            // Y=good/expired-key, R=good/revoked-key, E=missing key, N=none.
            // For unsigned commits git returns N immediately without invoking GPG.
            let signature_status = match sig_char {
                "G" | "U" | "X" | "Y" | "R" => SignatureStatus::Verified,
                "B" => SignatureStatus::Bad,
                "E" => SignatureStatus::UnknownKey,
                _ => SignatureStatus::None,
            };

            commits.push(CommitHistoryItem {
                hash,
                short_hash,
                author,
                author_email,
                date,
                message,
                signature_status,
                key_type: None,
            });
        }

        Ok(commits)
    }

    fn get_commit_markers(&self, request: &RepoRequest) -> GitResult<CommitMarkers> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;

        let local_head = Self::try_rev_parse(&repo_path, "HEAD");
        let upstream_ref = Self::run_git(
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
            Some(&repo_path),
        )
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
        let upstream_head = upstream_ref
            .as_deref()
            .and_then(|upstream| Self::try_rev_parse(&repo_path, upstream));

        Ok(CommitMarkers {
            local_head,
            upstream_head,
            upstream_ref,
        })
    }

    fn get_commit_files(&self, request: &CommitFilesRequest) -> GitResult<Vec<CommitFileItem>> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let commit_hash = request.commit_hash.trim();

        if commit_hash.is_empty() {
            return Ok(Vec::new());
        }

        let output = Self::run_git(
            &[
                "show",
                "--name-status",
                "--format=",
                "--no-renames",
                commit_hash,
            ],
            Some(&repo_path),
        )?;

        let mut files = Vec::new();
        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            let mut parts = line.splitn(2, '\t');
            let status_raw = parts.next().unwrap_or_default().trim();
            let path = parts.next().unwrap_or_default().trim();

            if path.is_empty() {
                continue;
            }

            let status = match status_raw.chars().next().unwrap_or('M') {
                'A' => "added",
                'D' => "deleted",
                'R' => "renamed",
                'C' => "copied",
                _ => "modified",
            }
            .to_string();

            files.push(CommitFileItem {
                path: path.to_string(),
                status,
            });
        }

        Ok(files)
    }

    fn get_commit_details(&self, request: &CommitDetailsRequest) -> GitResult<CommitDetails> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let hash = request.commit_hash.trim();

        if hash.is_empty() {
            return Err(GitError::InvalidInput(
                "Commit hash is required".to_string(),
            ));
        }

        // Single call: fields separated by \x1f (unit separator), record ends with \x1e
        let format = "%H\x1f%an\x1f%ae\x1f%aI\x1f%cn\x1f%ce\x1f%cI\x1f%P\x1f%b\x1e";
        let output = Self::run_git(
            &["log", "-1", &format!("--format={}", format), hash],
            Some(&repo_path),
        )?;

        // Split on record separator; take the first record
        let record = output.split('\x1e').next().unwrap_or_default();
        let parts: Vec<&str> = record.splitn(9, '\x1f').collect();
        if parts.len() < 8 {
            return Err(GitError::InvalidInput(format!(
                "Unexpected git log output for {}",
                hash
            )));
        }

        let full_hash = parts[0].trim().to_string();
        let author = parts[1].trim().to_string();
        let author_email = parts[2].trim().to_string();
        let author_date = parts[3].trim().to_string();
        let committer = parts[4].trim().to_string();
        let committer_email = parts[5].trim().to_string();
        let committer_date = parts[6].trim().to_string();
        let parent_hashes = parts[7]
            .split_whitespace()
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        let body = if parts.len() > 8 { parts[8] } else { "" };
        let trailers = parse_commit_trailers(body);

        // Tags pointing at this commit (may be empty output)
        let tags_output =
            Self::run_git(&["tag", "--points-at", hash], Some(&repo_path)).unwrap_or_default();
        let tags = tags_output
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();

        Ok(CommitDetails {
            hash: full_hash,
            author,
            author_email,
            author_date,
            committer,
            committer_email,
            committer_date,
            parent_hashes,
            tags,
            trailers,
        })
    }

    fn get_diff(&self, request: &DiffRequest) -> GitResult<FileDiff> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();
        let line_ending = Self::detect_line_ending(&repo_path, file_path, request.staged);
        let detected_file_type =
            Self::detect_file_type_label(&repo_path, file_path, request.staged);

        let mut args = vec!["diff"];
        if request.staged {
            args.push("--cached");
        }
        args.push("--");
        args.push(file_path);

        let output = match Self::run_git(&args, Some(&repo_path)) {
            Ok(stdout) => stdout,
            Err(GitError::CommandFailed { command: _, stderr }) if stderr.is_empty() => {
                // Empty stderr + non-zero exit: no tracked changes. Fall through to check
                // whether this is an untracked new file that we can diff with --no-index.
                String::new()
            }
            Err(error) => return Err(error),
        };

        // If we got no diff output, only synthesize an all-added diff for files that are truly
        // new (untracked in working tree, or added in index). Otherwise leave it empty.
        let output = if output.is_empty() {
            if request.staged {
                if Self::is_added_in_index(&repo_path, file_path) {
                    let index_ref = format!(":{}", file_path);
                    match Self::run_git(&["show", &index_ref], Some(&repo_path)) {
                        Ok(content) => {
                            // Build a synthetic diff from the index content for newly added files.
                            return Ok(Self::synthetic_new_file_diff(
                                file_path,
                                &content,
                                line_ending,
                                detected_file_type.clone(),
                            ));
                        }
                        Err(_) => String::new(),
                    }
                } else {
                    String::new()
                }
            } else {
                if Self::is_untracked_file(&repo_path, file_path) {
                    let null_device = if cfg!(windows) { "NUL" } else { "/dev/null" };
                    let full_path = repo_path.join(file_path);
                    let full_path_str = full_path.to_string_lossy().into_owned();

                    // Untracked file: diff against /dev/null (exits 1 when differences found)
                    match Self::run_git_allow_exit_codes(
                        &["diff", "--no-index", "--", null_device, &full_path_str],
                        Some(&repo_path),
                        &[1],
                    ) {
                        Ok(diff_output) if !diff_output.is_empty() => diff_output,
                        _ => String::new(),
                    }
                } else {
                    String::new()
                }
            }
        } else {
            output
        };

        if output.is_empty() {
            return Ok(FileDiff {
                file_path: file_path.to_string(),
                hunks: Vec::new(),
                is_binary: false,
                line_ending,
                detected_file_type,
            });
        }

        let is_binary_diff = output
            .lines()
            .any(|line| line.starts_with("Binary files ") && line.ends_with(" differ"))
            || output.lines().any(|line| line.trim() == "GIT binary patch");

        if is_binary_diff {
            return Ok(FileDiff {
                file_path: file_path.to_string(),
                hunks: Vec::new(),
                is_binary: true,
                line_ending,
                detected_file_type,
            });
        }

        let hunks = Self::parse_diff_hunks(&output);

        Ok(FileDiff {
            file_path: file_path.to_string(),
            hunks,
            is_binary: false,
            line_ending,
            detected_file_type,
        })
    }

    fn get_branches(&self, request: &RepoRequest) -> GitResult<Vec<BranchInfo>> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let output = Self::run_git(
            &[
                "branch",
                "-a",
                "--format=%(refname)|%(refname:short)|%(HEAD)|%(upstream:short)",
            ],
            Some(&repo_path),
        )?;

        let mut branches = Vec::new();

        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.splitn(4, '|').collect();
            if parts.len() < 2 {
                continue;
            }

            let full_ref = parts[0].trim();
            let name = parts[1].trim().to_string();
            let is_current = parts.get(2).map(|s| s.trim() == "*").unwrap_or(false);
            let upstream_raw = parts
                .get(3)
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let upstream = if upstream_raw.is_empty() {
                None
            } else {
                Some(upstream_raw.clone())
            };

            let is_remote = full_ref.starts_with("refs/remotes/");
            let upstream_status = if is_remote {
                UpstreamStatus::None
            } else {
                Self::branch_upstream_status(&repo_path, upstream.as_deref())
            };

            let (ahead, behind) = if matches!(upstream_status, UpstreamStatus::Tracked) {
                let up = upstream.as_deref().unwrap_or_default();
                Self::get_ahead_behind(&repo_path, &name, up)
            } else {
                (0, 0)
            };

            branches.push(BranchInfo {
                name,
                is_current,
                is_remote,
                upstream,
                upstream_status,
                ahead,
                behind,
            });
        }

        Ok(branches)
    }

    fn unstage_file(&self, request: &FileRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();
        Self::run_git(&["restore", "--staged", "--", file_path], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Unstaged {file_path}"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn unstage_all(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::run_git(&["restore", "--staged", "."], Some(&repo_path))?;

        Ok(OperationResult {
            message: "Unstaged all files".to_string(),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stage_all(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::run_git(&["add", "-A"], Some(&repo_path))?;

        Ok(OperationResult {
            message: "Staged all files".to_string(),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stage_hunk(&self, request: &HunkStageRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();

        // Get the full diff for the file
        let diff_output = Self::run_git(&["diff", "--", file_path], Some(&repo_path))?;

        if diff_output.is_empty() {
            return Err(GitError::InvalidInput(
                "No unstaged changes for this file".to_string(),
            ));
        }

        // Extract the diff header (everything before the first hunk)
        let header = Self::extract_diff_header(&diff_output);

        // Parse hunks from the raw diff
        let raw_hunks = Self::extract_raw_hunks(&diff_output);

        if request.hunk_index >= raw_hunks.len() {
            return Err(GitError::InvalidInput(format!(
                "Hunk index {} out of range (file has {} hunks)",
                request.hunk_index,
                raw_hunks.len()
            )));
        }

        // Build a patch: header + single hunk
        let patch = format!("{}\n{}\n", header, raw_hunks[request.hunk_index]);

        Self::run_git_with_stdin(&["apply", "--cached"], &repo_path, patch.as_bytes())?;

        Ok(OperationResult {
            message: format!("Staged hunk {} of {file_path}", request.hunk_index),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn unstage_hunk(&self, request: &HunkStageRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();

        // Get the staged diff for the file.
        let diff_output = Self::run_git(&["diff", "--cached", "--", file_path], Some(&repo_path))?;

        if diff_output.is_empty() {
            return Err(GitError::InvalidInput(
                "No staged changes for this file".to_string(),
            ));
        }

        let header = Self::extract_diff_header(&diff_output);
        let raw_hunks = Self::extract_raw_hunks(&diff_output);

        if request.hunk_index >= raw_hunks.len() {
            return Err(GitError::InvalidInput(format!(
                "Hunk index {} out of range (file has {} hunks)",
                request.hunk_index,
                raw_hunks.len()
            )));
        }

        // Reverse-apply the staged hunk to the index to unstage it.
        let patch = format!("{}\n{}\n", header, raw_hunks[request.hunk_index]);
        Self::run_git_with_stdin(&["apply", "-R", "--cached"], &repo_path, patch.as_bytes())?;

        Ok(OperationResult {
            message: format!("Unstaged hunk {} of {file_path}", request.hunk_index),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn discard_file(&self, request: &FileRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();

        // Check if the file is untracked
        let status_output = Self::run_git(
            &[
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "--",
                file_path,
            ],
            Some(&repo_path),
        )?;

        let is_untracked = status_output.lines().any(|line| line.starts_with("??"));

        if is_untracked {
            let full_path = repo_path.join(file_path);
            if full_path.is_dir() {
                fs::remove_dir_all(&full_path).map_err(|e| GitError::IoError(e.to_string()))?;
            } else {
                fs::remove_file(&full_path).map_err(|e| GitError::IoError(e.to_string()))?;
            }
        } else {
            Self::run_git(&["checkout", "--", file_path], Some(&repo_path))?;
        }

        Ok(OperationResult {
            message: format!("Discarded changes in {file_path}"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn fetch_remote(&self, request: &FetchRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let mut args = vec!["fetch", "--prune"];
        if let Some(ref remote) = request.remote {
            let remote = remote.trim();
            if remote.is_empty() {
                return Err(GitError::InvalidInput(
                    "Remote name cannot be empty".to_string(),
                ));
            }
            Self::ensure_valid_remote_name(&repo_path, remote)?;
            args.push(remote);
        }
        let output = Self::run_git(&args, Some(&repo_path))?;

        Ok(OperationResult {
            message: "Fetched from remote".to_string(),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stash(&self, request: &StashPushRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;

        let mut cmd: Vec<String> = vec!["stash".into(), "push".into()];
        if request.include_untracked {
            cmd.push("--include-untracked".into());
        }
        if let Some(ref msg) = request.message {
            let trimmed = msg.trim();
            if !trimmed.is_empty() {
                cmd.push("-m".into());
                cmd.push(trimmed.to_string());
            }
        }
        if !request.paths.is_empty() {
            cmd.push("--".into());
            cmd.extend(request.paths.iter().cloned());
        }

        let refs: Vec<&str> = cmd.iter().map(String::as_str).collect();
        let output = Self::run_git(&refs, Some(&repo_path))?;

        Ok(OperationResult {
            message: "Stashed changes".to_string(),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stash_list(&self, request: &RepoRequest) -> GitResult<Vec<StashEntry>> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let output = match Self::run_git(&["stash", "list", "--format=%gd|%h|%s"], Some(&repo_path))
        {
            Ok(o) => o,
            Err(GitError::CommandFailed { stderr, .. }) if stderr.is_empty() => {
                return Ok(Vec::new());
            }
            Err(e) => return Err(e),
        };

        let entries = output
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|line| {
                let parts: Vec<&str> = line.splitn(3, '|').collect();
                let ref_name = parts.first()?.trim();
                let index: u32 = ref_name
                    .strip_prefix("stash@{")
                    .and_then(|s| s.strip_suffix('}'))
                    .and_then(|s| s.parse().ok())?;
                let short_hash = parts
                    .get(1)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                let message = parts
                    .get(2)
                    .map(|s| s.trim().to_string())
                    .unwrap_or_default();
                Some(StashEntry {
                    index,
                    message,
                    short_hash,
                })
            })
            .collect();

        Ok(entries)
    }

    fn stash_apply(&self, request: &StashRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let stash_ref = format!("stash@{{{}}}", request.stash_index);
        let output = Self::run_git(&["stash", "apply", &stash_ref], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Applied {}", stash_ref),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stash_pop(&self, request: &StashRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let stash_ref = format!("stash@{{{}}}", request.stash_index);
        let output = Self::run_git(&["stash", "pop", &stash_ref], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Popped {}", stash_ref),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn stash_drop(&self, request: &StashRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let stash_ref = format!("stash@{{{}}}", request.stash_index);
        let output = Self::run_git(&["stash", "drop", &stash_ref], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Dropped {}", stash_ref),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn get_identity(&self, request: &IdentityRequest) -> GitResult<GitIdentity> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let scope_flag = match request.scope {
            IdentityScope::Local => "--local",
            IdentityScope::Global => "--global",
        };

        let name = Self::run_git(&["config", scope_flag, "user.name"], Some(&repo_path)).ok();
        let email = Self::run_git(&["config", scope_flag, "user.email"], Some(&repo_path)).ok();
        let signing_key =
            Self::run_git(&["config", scope_flag, "user.signingkey"], Some(&repo_path)).ok();
        let signing_format =
            Self::run_git(&["config", scope_flag, "gpg.format"], Some(&repo_path)).ok();
        let ssh_key_path = Self::run_git(
            &["config", scope_flag, "gpg.ssh.allowedSignersFile"],
            Some(&repo_path),
        )
        .ok();
        let commit_signing_enabled =
            Self::run_git(&["config", scope_flag, "commit.gpgsign"], Some(&repo_path))
                .ok()
                .map(|value| {
                    let normalized = value.trim().to_ascii_lowercase();
                    matches!(normalized.as_str(), "true" | "yes" | "on" | "1")
                })
                .unwrap_or(false);

        Ok(GitIdentity {
            name,
            email,
            signing_key,
            signing_format,
            ssh_key_path,
            commit_signing_enabled,
        })
    }

    fn set_identity(&self, request: &SetIdentityRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let scope_flag = match request.scope {
            IdentityScope::Local => "--local",
            IdentityScope::Global => "--global",
        };

        let set_or_unset = |key: &str, value: &Option<String>| -> GitResult<()> {
            let Some(raw) = value.as_ref() else {
                return Ok(());
            };

            if raw.trim().is_empty() {
                // git config --unset exits with code 5 when key is not set
                let _ = Self::run_git_allow_exit_codes(
                    &["config", scope_flag, "--unset", key],
                    Some(&repo_path),
                    &[5],
                )?;
                return Ok(());
            }

            Self::run_git(&["config", scope_flag, key, raw], Some(&repo_path))?;
            Ok(())
        };

        set_or_unset("user.name", &request.name)?;
        set_or_unset("user.email", &request.email)?;
        set_or_unset("user.signingkey", &request.signing_key)?;
        set_or_unset("gpg.format", &request.signing_format)?;
        set_or_unset("gpg.ssh.allowedSignersFile", &request.ssh_key_path)?;
        if let Some(commit_signing_enabled) = request.commit_signing_enabled {
            let commit_gpgsign = if commit_signing_enabled {
                "true"
            } else {
                "false"
            };
            Self::run_git(
                &["config", scope_flag, "commit.gpgsign", commit_gpgsign],
                Some(&repo_path),
            )?;
        } else if let Some(signing_key) = request.signing_key.as_ref() {
            let commit_gpgsign = if signing_key.trim().is_empty() {
                "false"
            } else {
                "true"
            };
            Self::run_git(
                &["config", scope_flag, "commit.gpgsign", commit_gpgsign],
                Some(&repo_path),
            )?;
        }

        Ok(OperationResult {
            message: "Git identity updated".to_string(),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn get_tags(&self, request: &RepoRequest) -> GitResult<Vec<TagInfo>> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let output = match Self::run_git(
            &[
                "tag",
                "-l",
                "--sort=-version:refname",
                "--format=%(refname:short)|%(objectname:short)|%(subject)",
            ],
            Some(&repo_path),
        ) {
            Ok(stdout) => stdout,
            Err(GitError::CommandFailed { command: _, stderr }) if stderr.is_empty() => {
                return Ok(Vec::new());
            }
            Err(error) => return Err(error),
        };

        let mut tags = Vec::new();

        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.splitn(3, '|').collect();
            if parts.is_empty() {
                continue;
            }

            let name = parts[0].trim().to_string();
            let hash = parts
                .get(1)
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let message_raw = parts
                .get(2)
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let message = if message_raw.is_empty() {
                None
            } else {
                Some(message_raw)
            };

            tags.push(TagInfo {
                name,
                hash,
                message,
            });
        }

        Ok(tags)
    }

    fn get_remotes(&self, request: &RepoRequest) -> GitResult<Vec<RemoteInfo>> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let output = Self::run_git(&["remote", "-v"], Some(&repo_path))?;

        let mut seen = HashMap::new();

        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }

            let name = parts[0].to_string();
            let url = parts[1].to_string();

            seen.entry(name).or_insert(url);
        }

        let remotes = seen
            .into_iter()
            .map(|(name, url)| RemoteInfo { name, url })
            .collect();

        Ok(remotes)
    }

    fn push_changes(&self, request: &PushRequest) -> GitResult<PushResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let current_branch = Self::current_branch_name(&repo_path)
            .filter(|branch| !Self::is_detached_head(Some(branch)))
            .ok_or_else(|| {
                GitError::InvalidInput("Push is unavailable while HEAD is detached.".to_string())
            })?;
        let remote = request
            .remote
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let explicit_remote_branch = request
            .remote_branch
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());

        if remote.is_none() && (request.set_upstream || explicit_remote_branch.is_some()) {
            return Err(GitError::InvalidInput(
                "Publishing requires an explicit remote selection.".to_string(),
            ));
        }

        let target_remote_branch = match (remote, explicit_remote_branch) {
            (Some(_), Some(branch)) => Some(branch.to_string()),
            (Some(_), None) => Some(current_branch.clone()),
            (None, Some(_)) => unreachable!(),
            (None, None) => None,
        };

        let mut args = vec!["push"];
        if request.force_with_lease {
            args.push("--force-with-lease");
        }
        if request.push_follow_tags {
            args.push("--follow-tags");
        }
        if request.set_upstream {
            args.push("--set-upstream");
        }

        let refspec = match (remote, target_remote_branch.as_deref()) {
            (Some(_), Some(target_branch)) if target_branch != current_branch => {
                Some(format!("{current_branch}:{target_branch}"))
            }
            (Some(_), Some(_)) => Some(current_branch.clone()),
            _ => None,
        };

        if let Some(remote_name) = remote {
            args.push(remote_name);
            if let Some(target_refspec) = refspec.as_deref() {
                args.push(target_refspec);
            }
        }

        match Self::run_git(&args, Some(&repo_path)) {
            Ok(output) => Ok(PushResult {
                message: match (
                    remote,
                    target_remote_branch.as_deref(),
                    request.set_upstream,
                ) {
                    (Some(remote_name), Some(target_branch), true) => {
                        format!("Published branch to {remote_name}/{target_branch}")
                    }
                    (Some(remote_name), Some(target_branch), false) => {
                        format!("Pushed changes to {remote_name}/{target_branch}")
                    }
                    _ => "Pushed changes".to_string(),
                },
                output: (!output.is_empty()).then_some(output),
                repo_path: Some(Self::path_to_string(&repo_path)),
                backend_used: "git-cli".to_string(),
                success: true,
                rejection: None,
            }),
            Err(GitError::CommandFailed { stderr, .. }) => {
                let rejection = Self::classify_push_failure(&repo_path, &stderr);
                Ok(PushResult {
                    message: rejection.message.clone(),
                    output: (!stderr.is_empty()).then_some(stderr),
                    repo_path: Some(Self::path_to_string(&repo_path)),
                    backend_used: "git-cli".to_string(),
                    success: false,
                    rejection: Some(rejection),
                })
            }
            Err(e) => Err(e),
        }
    }

    fn switch_branch(&self, request: &BranchRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let branch_name = request.branch_name.trim();

        if branch_name.is_empty() {
            return Err(GitError::InvalidInput(
                "Branch name cannot be empty".to_string(),
            ));
        }

        Self::ensure_no_active_branch_operation(&repo_path, "switch branches")?;

        // `git switch` is available from git 2.23+; fall back to `git checkout` if it fails
        let result = Self::run_git(&["switch", branch_name], Some(&repo_path));
        if result.is_err() {
            Self::run_git(&["checkout", branch_name], Some(&repo_path))?;
        }

        Ok(OperationResult {
            message: format!("Switched to branch '{branch_name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn set_branch_upstream(
        &self,
        request: &SetBranchUpstreamRequest,
    ) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let branch_name = request.branch_name.trim();
        let remote = request.remote.trim();
        let remote_branch = request.remote_branch.trim();

        if branch_name.is_empty() {
            return Err(GitError::InvalidInput(
                "Branch name cannot be empty".to_string(),
            ));
        }
        if remote.is_empty() {
            return Err(GitError::InvalidInput(
                "Remote name cannot be empty".to_string(),
            ));
        }
        if remote_branch.is_empty() {
            return Err(GitError::InvalidInput(
                "Remote branch name cannot be empty".to_string(),
            ));
        }

        Self::ensure_no_active_branch_operation(&repo_path, "change upstream tracking")?;

        let remote_tracking_ref = format!("{remote}/{remote_branch}");
        if !Self::remote_tracking_ref_exists(&repo_path, &remote_tracking_ref) {
            return Err(GitError::InvalidInput(format!(
                "Remote branch '{remote_tracking_ref}' was not found. Fetch or choose a different branch."
            )));
        }

        Self::run_git(
            &[
                "branch",
                "--set-upstream-to",
                &remote_tracking_ref,
                branch_name,
            ],
            Some(&repo_path),
        )?;

        Ok(OperationResult {
            message: format!("Set upstream for '{branch_name}' to '{remote_tracking_ref}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn create_branch(&self, request: &CreateBranchRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::ensure_no_active_branch_operation(&repo_path, "create a branch")?;

        let base_ref = request
            .base_ref
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let remote_tracking_ref =
            base_ref.and_then(|value| Self::resolve_remote_tracking_ref(&repo_path, value));

        let mut branch_name = request.branch_name.trim().to_string();

        if request.match_tracking_branch.unwrap_or(false) {
            let remote_ref = remote_tracking_ref.as_deref().ok_or_else(|| {
                GitError::InvalidInput(
                    "Match tracking branch name requires a remote branch base reference"
                        .to_string(),
                )
            })?;

            branch_name =
                Self::derive_local_branch_from_remote_ref(remote_ref).ok_or_else(|| {
                    GitError::InvalidInput(
                        "Cannot derive a local branch name from this remote reference".to_string(),
                    )
                })?;
        }

        if branch_name.trim().is_empty() {
            return Err(GitError::InvalidInput(
                "Branch name cannot be empty".to_string(),
            ));
        }

        Self::ensure_valid_branch_name(&repo_path, branch_name.as_str())?;

        let checkout = request.checkout_after_creation.unwrap_or(false);

        let mut args = if checkout {
            vec!["checkout", "-b", branch_name.as_str()]
        } else {
            vec!["branch", branch_name.as_str()]
        };

        if let Some(base_ref) = base_ref {
            args.push(base_ref);
        }

        Self::run_git(&args, Some(&repo_path))?;

        let mut result_message = format!("Created branch '{branch_name}'");

        if request.track_remote.unwrap_or(false) {
            let remote_branch = remote_tracking_ref.as_deref().ok_or_else(|| {
                GitError::InvalidInput(
                    "Tracking requires a valid remote branch base reference".to_string(),
                )
            })?;

            Self::run_git(
                &[
                    "branch",
                    "--set-upstream-to",
                    remote_branch,
                    branch_name.as_str(),
                ],
                Some(&repo_path),
            )?;
            result_message.push_str(&format!(" and set to track '{remote_branch}'"));
        }

        if checkout {
            result_message.push_str(" and checked out");
        }

        Ok(OperationResult {
            message: result_message,
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn delete_branch(&self, request: &DeleteBranchRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let branch_name = request.branch_name.trim();

        if branch_name.is_empty() {
            return Err(GitError::InvalidInput(
                "Branch name cannot be empty".to_string(),
            ));
        }

        Self::ensure_no_active_branch_operation(&repo_path, "delete a branch")?;

        let flag = if request.force.unwrap_or(false) {
            "-D"
        } else {
            "-d"
        };
        Self::run_git(&["branch", flag, branch_name], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Deleted branch '{branch_name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn rename_branch(&self, request: &RenameBranchRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::ensure_no_active_branch_operation(&repo_path, "rename a branch")?;

        let old_name = request.old_name.trim();
        let new_name = request.new_name.trim();

        if old_name.is_empty() || new_name.is_empty() {
            return Err(GitError::InvalidInput(
                "Branch names cannot be empty".to_string(),
            ));
        }

        if old_name == new_name {
            return Err(GitError::InvalidInput(
                "New branch name must be different from the current name".to_string(),
            ));
        }

        if Self::run_git(
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{old_name}"),
            ],
            Some(&repo_path),
        )
        .is_err()
        {
            return Err(GitError::InvalidInput(format!(
                "Local branch '{old_name}' does not exist"
            )));
        }

        if Self::run_git(
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{new_name}"),
            ],
            Some(&repo_path),
        )
        .is_ok()
        {
            return Err(GitError::InvalidInput(format!(
                "A branch named '{new_name}' already exists"
            )));
        }

        Self::ensure_valid_branch_name(&repo_path, new_name)?;

        Self::run_git(&["branch", "-m", old_name, new_name], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Renamed branch '{old_name}' to '{new_name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn delete_tag(&self, request: &DeleteTagRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let tag_name = request.tag_name.trim();

        Self::ensure_valid_tag_name(&repo_path, tag_name)?;

        Self::run_git(&["tag", "-d", tag_name], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Deleted tag '{tag_name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn create_tag(&self, request: &CreateTagRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let tag_name = request.tag_name.trim();

        Self::ensure_valid_tag_name(&repo_path, tag_name)?;

        let message = request
            .message
            .as_deref()
            .map(str::trim)
            .filter(|m| !m.is_empty());
        let target = request
            .target
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty());

        if let Some(tgt) = target {
            if tgt.starts_with('-') {
                return Err(GitError::InvalidInput(
                    "Tag target cannot start with '-'".to_string(),
                ));
            }
            if Self::has_control_characters(tgt) {
                return Err(GitError::InvalidInput(
                    "Tag target contains invalid control characters".to_string(),
                ));
            }
        }

        let mut args: Vec<&str> = vec!["tag"];
        if let Some(msg) = message {
            args.extend_from_slice(&["-a", tag_name, "-m", msg]);
        } else {
            args.push(tag_name);
        }
        if let Some(tgt) = target {
            args.push(tgt);
        }

        Self::run_git(&args, Some(&repo_path))?;

        let kind = if message.is_some() {
            "annotated tag"
        } else {
            "tag"
        };
        Ok(OperationResult {
            message: format!("Created {kind} '{tag_name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn push_tag(&self, request: &PushTagRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let remote = request.remote.trim();
        let tag_name = request.tag_name.trim();

        Self::ensure_valid_remote_name(&repo_path, remote)?;
        Self::ensure_valid_tag_name(&repo_path, tag_name)?;

        Self::run_git(&["push", remote, tag_name], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Pushed tag '{tag_name}' to '{remote}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn delete_remote_tag(&self, request: &DeleteRemoteTagRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let remote = request.remote.trim();
        let tag_name = request.tag_name.trim();

        Self::ensure_valid_remote_name(&repo_path, remote)?;
        Self::ensure_valid_tag_name(&repo_path, tag_name)?;

        Self::run_git(&["push", remote, "--delete", tag_name], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Deleted tag '{tag_name}' from remote '{remote}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn delete_remote_branch(
        &self,
        request: &DeleteRemoteBranchRequest,
    ) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let remote = request.remote.trim();
        let branch = request.branch.trim();

        if branch.is_empty() {
            return Err(GitError::InvalidInput(
                "Branch name cannot be empty".to_string(),
            ));
        }

        Self::ensure_valid_remote_name(&repo_path, remote)?;

        let refspec = format!(":{branch}");
        match Self::run_git(&["push", remote, &refspec], Some(&repo_path)) {
            Ok(_) => {}
            Err(GitError::CommandFailed { ref stderr, .. })
                if stderr.contains("remote ref does not exist") =>
            {
                return Err(GitError::InvalidInput(format!(
                    "Branch '{branch}' no longer exists on remote '{remote}'. Try fetching to refresh the branch list."
                )));
            }
            Err(e) => return Err(e),
        }

        Ok(OperationResult {
            message: format!("Deleted remote branch '{remote}/{branch}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn add_remote(&self, request: &AddRemoteRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let name = request.name.trim();
        let url = request.url.trim();
        if url.is_empty() {
            return Err(GitError::InvalidInput(
                "Remote name and URL cannot be empty".to_string(),
            ));
        }
        Self::ensure_valid_remote_name(&repo_path, name)?;
        Self::validate_remote_url(url)?;
        Self::run_git(&["remote", "add", name, url], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Added remote '{name}' ({url})"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn remove_remote(&self, request: &RemoveRemoteRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let name = request.name.trim();
        Self::ensure_valid_remote_name(&repo_path, name)?;
        Self::run_git(&["remote", "remove", name], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Removed remote '{name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn rename_remote(&self, request: &RenameRemoteRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let old_name = request.old_name.trim();
        let new_name = request.new_name.trim();
        Self::ensure_valid_remote_name(&repo_path, old_name)?;
        Self::ensure_valid_remote_name(&repo_path, new_name)?;
        Self::run_git(&["remote", "rename", old_name, new_name], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Renamed remote '{old_name}' to '{new_name}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn set_remote_url(&self, request: &SetRemoteUrlRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let name = request.name.trim();
        let url = request.url.trim();
        if url.is_empty() {
            return Err(GitError::InvalidInput(
                "Remote name and URL cannot be empty".to_string(),
            ));
        }
        Self::ensure_valid_remote_name(&repo_path, name)?;
        Self::validate_remote_url(url)?;
        Self::run_git(&["remote", "set-url", name, url], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Updated URL for remote '{name}' to '{url}'"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn prune_remote(&self, request: &PruneRemoteRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let name = request.name.trim();
        Self::ensure_valid_remote_name(&repo_path, name)?;
        let output = Self::run_git(&["remote", "prune", name], Some(&repo_path))?;
        Ok(OperationResult {
            message: format!("Pruned stale tracking branches for '{name}'"),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn merge_branch(&self, request: &MergeRequest) -> GitResult<MergeResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if Self::is_merge_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "Cannot start merge while another merge is in progress".to_string(),
            ));
        }
        if Self::is_rebase_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "Cannot start merge while a rebase is in progress".to_string(),
            ));
        }
        if Self::is_cherry_pick_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "Cannot start merge while a cherry-pick is in progress".to_string(),
            ));
        }

        let mut args = vec!["merge"];

        if request.no_ff == Some(true) {
            args.push("--no-ff");
        }
        if request.ff_only == Some(true) {
            args.push("--ff-only");
        }
        if let Some(ref msg) = request.message {
            args.push("-m");
            args.push(msg.as_str());
        }

        args.push(&request.branch_name);

        // Allow exit code 1 - git merge exits 1 on conflicts
        let result = Self::run_git_allow_exit_codes(&args, Some(&repo_path), &[1]);

        match result {
            Ok(output) => {
                let merge_head_path = repo_path.join(".git/MERGE_HEAD");
                let has_conflicts = merge_head_path.exists();

                let conflicted_files = if has_conflicts {
                    Self::get_conflicted_files(&repo_path)
                } else {
                    vec![]
                };

                Ok(MergeResult {
                    message: if has_conflicts {
                        format!(
                            "Merge conflicts in {} file(s) - resolve and commit",
                            conflicted_files.len()
                        )
                    } else {
                        format!("Merged '{}' into current branch", request.branch_name)
                    },
                    output: Some(output),
                    repo_path: Some(Self::path_to_string(&repo_path)),
                    backend_used: "git-cli".to_string(),
                    success: !has_conflicts,
                    has_conflicts,
                    conflicted_files,
                })
            }
            Err(e) => Err(e),
        }
    }

    fn merge_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;

        let merge_head = repo_path.join(".git/MERGE_HEAD");
        if !merge_head.exists() {
            return Err(GitError::InvalidInput(
                "No merge in progress to abort".to_string(),
            ));
        }

        let output = Self::run_git(&["merge", "--abort"], Some(&repo_path))?;

        Ok(OperationResult {
            message: "Merge aborted".to_string(),
            output: if output.is_empty() {
                None
            } else {
                Some(output)
            },
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn rebase_start(&self, request: &RebaseRequest) -> GitResult<RebaseResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::ensure_no_active_branch_operation(&repo_path, "start a rebase")?;

        let onto = request.onto.trim();

        if onto.is_empty() {
            return Err(GitError::InvalidInput(
                "Rebase target cannot be empty".to_string(),
            ));
        }

        let output = Self::run_git_allow_exit_codes(&["rebase", onto], Some(&repo_path), &[1])?;
        let rebase_in_progress = Self::is_rebase_in_progress(&repo_path);
        let conflicted_files = if rebase_in_progress {
            Self::get_conflicted_files(&repo_path)
        } else {
            vec![]
        };
        let has_conflicts = !conflicted_files.is_empty();

        Ok(RebaseResult {
            message: if has_conflicts {
                format!(
                    "Rebase conflicts in {} file(s) - resolve and continue",
                    conflicted_files.len()
                )
            } else {
                format!("Rebased current branch onto '{onto}'")
            },
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
            success: !has_conflicts,
            has_conflicts,
            conflicted_files,
        })
    }

    fn rebase_continue(&self, request: &RepoRequest) -> GitResult<RebaseResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if !Self::is_rebase_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "No rebase in progress to continue".to_string(),
            ));
        }

        let output = Self::run_git_with_overrides_allow_exit_codes(
            &["-c".to_string(), "core.editor=true".to_string()],
            &["rebase", "--continue"],
            Some(&repo_path),
            &[1],
        )?;
        let rebase_in_progress = Self::is_rebase_in_progress(&repo_path);
        let conflicted_files = if rebase_in_progress {
            Self::get_conflicted_files(&repo_path)
        } else {
            vec![]
        };
        let has_conflicts = !conflicted_files.is_empty();

        Ok(RebaseResult {
            message: if has_conflicts {
                format!(
                    "Rebase conflicts in {} file(s) - resolve and continue",
                    conflicted_files.len()
                )
            } else if rebase_in_progress {
                "Rebase continued".to_string()
            } else {
                "Rebase complete".to_string()
            },
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
            success: !has_conflicts,
            has_conflicts,
            conflicted_files,
        })
    }

    fn rebase_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if !Self::is_rebase_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "No rebase in progress to abort".to_string(),
            ));
        }

        let output = Self::run_git(&["rebase", "--abort"], Some(&repo_path))?;
        Ok(OperationResult {
            message: "Rebase aborted".to_string(),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn cherry_pick_start(&self, request: &CherryPickRequest) -> GitResult<CherryPickResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::ensure_no_active_branch_operation(&repo_path, "start a cherry-pick")?;

        let commit_hash = request.commit_hash.trim();

        if commit_hash.is_empty() {
            return Err(GitError::InvalidInput(
                "Cherry-pick commit hash cannot be empty".to_string(),
            ));
        }

        let output =
            Self::run_git_allow_exit_codes(&["cherry-pick", commit_hash], Some(&repo_path), &[1])?;
        let cherry_pick_in_progress = Self::is_cherry_pick_in_progress(&repo_path);
        let conflicted_files = if cherry_pick_in_progress {
            Self::get_conflicted_files(&repo_path)
        } else {
            vec![]
        };
        let has_conflicts = !conflicted_files.is_empty();

        Ok(CherryPickResult {
            message: if has_conflicts {
                format!(
                    "Cherry-pick conflicts in {} file(s) - resolve and continue",
                    conflicted_files.len()
                )
            } else {
                format!("Cherry-picked '{commit_hash}' onto current branch")
            },
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
            success: !has_conflicts,
            has_conflicts,
            conflicted_files,
        })
    }

    fn cherry_pick_continue(&self, request: &RepoRequest) -> GitResult<CherryPickResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if !Self::is_cherry_pick_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "No cherry-pick in progress to continue".to_string(),
            ));
        }

        let output = Self::run_git_with_overrides_allow_exit_codes(
            &["-c".to_string(), "core.editor=true".to_string()],
            &["cherry-pick", "--continue"],
            Some(&repo_path),
            &[1],
        )?;
        let cherry_pick_in_progress = Self::is_cherry_pick_in_progress(&repo_path);
        let conflicted_files = if cherry_pick_in_progress {
            Self::get_conflicted_files(&repo_path)
        } else {
            vec![]
        };
        let has_conflicts = !conflicted_files.is_empty();

        Ok(CherryPickResult {
            message: if has_conflicts {
                format!(
                    "Cherry-pick conflicts in {} file(s) - resolve and continue",
                    conflicted_files.len()
                )
            } else if cherry_pick_in_progress {
                "Cherry-pick continued".to_string()
            } else {
                "Cherry-pick complete".to_string()
            },
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
            success: !has_conflicts,
            has_conflicts,
            conflicted_files,
        })
    }

    fn cherry_pick_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if !Self::is_cherry_pick_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "No cherry-pick in progress to abort".to_string(),
            ));
        }

        let output = Self::run_git(&["cherry-pick", "--abort"], Some(&repo_path))?;
        Ok(OperationResult {
            message: "Cherry-pick aborted".to_string(),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn revert_commit_start(&self, request: &RevertCommitRequest) -> GitResult<CherryPickResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        Self::ensure_no_active_branch_operation(&repo_path, "start a revert")?;

        let commit_hash = request.commit_hash.trim();
        if commit_hash.is_empty() {
            return Err(GitError::InvalidInput(
                "Revert commit hash cannot be empty".to_string(),
            ));
        }

        let output = Self::run_git_allow_exit_codes(
            &["revert", "--no-edit", commit_hash],
            Some(&repo_path),
            &[1],
        )?;
        let revert_in_progress = Self::is_revert_in_progress(&repo_path);
        let conflicted_files = if revert_in_progress {
            Self::get_conflicted_files(&repo_path)
        } else {
            vec![]
        };
        let has_conflicts = !conflicted_files.is_empty();

        Ok(CherryPickResult {
            message: if has_conflicts {
                format!(
                    "Revert conflicts in {} file(s) - resolve and continue",
                    conflicted_files.len()
                )
            } else {
                format!("Reverted '{commit_hash}'")
            },
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
            success: !has_conflicts,
            has_conflicts,
            conflicted_files,
        })
    }

    fn revert_continue(&self, request: &RepoRequest) -> GitResult<CherryPickResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if !Self::is_revert_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "No revert in progress to continue".to_string(),
            ));
        }

        let output = Self::run_git_with_overrides_allow_exit_codes(
            &["-c".to_string(), "core.editor=true".to_string()],
            &["revert", "--continue"],
            Some(&repo_path),
            &[1],
        )?;
        let revert_in_progress = Self::is_revert_in_progress(&repo_path);
        let conflicted_files = if revert_in_progress {
            Self::get_conflicted_files(&repo_path)
        } else {
            vec![]
        };
        let has_conflicts = !conflicted_files.is_empty();

        Ok(CherryPickResult {
            message: if has_conflicts {
                format!(
                    "Revert conflicts in {} file(s) - resolve and continue",
                    conflicted_files.len()
                )
            } else if revert_in_progress {
                "Revert continued".to_string()
            } else {
                "Revert complete".to_string()
            },
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
            success: !has_conflicts,
            has_conflicts,
            conflicted_files,
        })
    }

    fn revert_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if !Self::is_revert_in_progress(&repo_path) {
            return Err(GitError::InvalidInput(
                "No revert in progress to abort".to_string(),
            ));
        }

        let output = Self::run_git(&["revert", "--abort"], Some(&repo_path))?;
        Ok(OperationResult {
            message: "Revert aborted".to_string(),
            output: (!output.is_empty()).then_some(output),
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn reset(&self, request: &ResetRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        if request.target.trim().is_empty() {
            return Err(GitError::InvalidInput(
                "Reset target is required".to_string(),
            ));
        }
        let mode_flag = match request.mode {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
        };
        Self::run_git(
            &["reset", mode_flag, request.target.trim()],
            Some(&repo_path),
        )?;
        let mode_label = match request.mode {
            ResetMode::Soft => "soft",
            ResetMode::Mixed => "mixed",
        };
        Ok(OperationResult {
            message: format!("Reset ({mode_label}) to {}", request.target.trim()),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn conflict_accept_theirs(&self, request: &FileRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();
        if file_path.is_empty() {
            return Err(GitError::InvalidInput("File path is required".to_string()));
        }

        Self::run_git(&["checkout", "--theirs", "--", file_path], Some(&repo_path))?;
        Self::run_git(&["add", "--", file_path], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Accepted theirs for {file_path}"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn conflict_accept_ours(&self, request: &FileRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();
        if file_path.is_empty() {
            return Err(GitError::InvalidInput("File path is required".to_string()));
        }

        Self::run_git(&["checkout", "--ours", "--", file_path], Some(&repo_path))?;
        Self::run_git(&["add", "--", file_path], Some(&repo_path))?;

        Ok(OperationResult {
            message: format!("Accepted ours for {file_path}"),
            output: None,
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }

    fn open_merge_tool(&self, request: &FileRequest) -> GitResult<OperationResult> {
        let repo_path = Self::normalize_repo_path(&request.repo_path)?;
        let file_path = request.file_path.trim();
        if file_path.is_empty() {
            return Err(GitError::InvalidInput("File path is required".to_string()));
        }

        let tool_name = Self::require_configured_merge_tool(&repo_path)?;

        // All tools go through git mergetool.
        // -c mergetool.keepBackup=false suppresses the .orig backup file.
        let mut overrides = Self::mergetool_cmd_overrides(&tool_name);
        overrides.extend(["-c".to_string(), "mergetool.keepBackup=false".to_string()]);
        let args = [
            "mergetool",
            "--tool",
            &tool_name,
            "--no-prompt",
            "--",
            file_path,
        ];
        let output = Self::run_git_with_overrides_allow_exit_codes(
            &overrides,
            &args,
            Some(&repo_path),
            &[1],
        )?;

        Ok(OperationResult {
            message: format!("Opened merge tool for {file_path}"),
            output: if output.is_empty() {
                None
            } else {
                Some(output)
            },
            repo_path: Some(Self::path_to_string(&repo_path)),
            backend_used: "git-cli".to_string(),
        })
    }
}

impl CliGitHandler {
    fn mime_token_to_label(token: &str) -> Option<String> {
        let mut cleaned = token.trim().to_ascii_lowercase();
        if cleaned.is_empty() {
            return None;
        }

        while let Some(rest) = cleaned
            .strip_prefix("x-")
            .or_else(|| cleaned.strip_prefix("vnd."))
        {
            cleaned = rest.to_string();
        }

        let words: Vec<String> = cleaned
            .split(['-', '_', '.', '+'])
            .filter(|part| !part.is_empty())
            .map(|part| {
                let mut chars = part.chars();
                match chars.next() {
                    Some(first) => {
                        let mut word = String::new();
                        word.extend(first.to_uppercase());
                        word.push_str(chars.as_str());
                        word
                    }
                    None => String::new(),
                }
            })
            .filter(|part| !part.is_empty())
            .collect();

        if words.is_empty() {
            None
        } else {
            Some(words.join(" "))
        }
    }

    fn file_type_label_from_mime(mime: &str) -> Option<String> {
        let essence = mime.split(';').next()?.trim().to_ascii_lowercase();
        let (top_level, subtype) = essence.split_once('/')?;

        if top_level == "text" {
            if subtype == "plain" {
                return Some("Text".to_string());
            }

            let preferred = subtype
                .rsplit_once('+')
                .map(|(_, suffix)| suffix)
                .unwrap_or(subtype);

            return Self::mime_token_to_label(preferred)
                .or_else(|| Self::mime_token_to_label(subtype))
                .or_else(|| Some("Text".to_string()));
        }

        let preferred = subtype
            .rsplit_once('+')
            .map(|(_, suffix)| suffix)
            .unwrap_or(subtype);

        Self::mime_token_to_label(preferred)
            .or_else(|| Self::mime_token_to_label(subtype))
            .or_else(|| Self::mime_token_to_label(top_level))
    }

    fn read_file_bytes_for_detection(
        repo_path: &Path,
        file_path: &str,
        staged: bool,
    ) -> Option<Vec<u8>> {
        if !staged {
            let full_path = repo_path.join(file_path);
            if let Ok(bytes) = fs::read(full_path) {
                return Some(bytes);
            }
        }

        let index_ref = format!(":{file_path}");
        Self::run_git_bytes(&["show", &index_ref], Some(repo_path)).ok()
    }

    fn detect_file_type_label(repo_path: &Path, file_path: &str, staged: bool) -> Option<String> {
        if let Some(bytes) = Self::read_file_bytes_for_detection(repo_path, file_path, staged) {
            let is_utf8_text = std::str::from_utf8(&bytes).is_ok();

            if is_utf8_text {
                if let Some(mime) = Self::preferred_mime_from_path(file_path) {
                    if mime.starts_with("text/") {
                        if let Some(label) = Self::file_type_label_from_mime(&mime) {
                            return Some(label);
                        }
                    }
                }

                if let Some(label) = Self::generic_label_from_path_extension(file_path) {
                    return Some(label);
                }

                return Some("Text".to_string());
            }

            if let Some(kind) = infer::get(&bytes) {
                if let Some(label) = Self::file_type_label_from_mime(kind.mime_type()) {
                    return Some(label);
                }
            }

            if let Some(mime) = Self::preferred_mime_from_path(file_path) {
                if let Some(label) = Self::file_type_label_from_mime(&mime) {
                    return Some(label);
                }
            }
        }

        if let Some(mime) = Self::preferred_mime_from_path(file_path) {
            return Self::file_type_label_from_mime(&mime);
        }

        if let Some(label) = Self::generic_label_from_path_extension(file_path) {
            return Some(label);
        }

        Some("Text".to_string())
    }

    fn parse_line_ending_token(token: &str) -> Option<LineEndingStyle> {
        match token {
            "lf" => Some(LineEndingStyle::Lf),
            "crlf" => Some(LineEndingStyle::Crlf),
            "mixed" => Some(LineEndingStyle::Mixed),
            _ => None,
        }
    }

    fn detect_line_ending_from_ls_files(
        repo_path: &Path,
        file_path: &str,
        staged: bool,
    ) -> Option<LineEndingStyle> {
        let output =
            Self::run_git(&["ls-files", "--eol", "--", file_path], Some(repo_path)).ok()?;
        let first_line = output.lines().find(|line| !line.trim().is_empty())?;

        let prefix = if staged { "i/" } else { "w/" };
        let token = first_line
            .split_whitespace()
            .find_map(|part| part.strip_prefix(prefix))?;

        Self::parse_line_ending_token(token)
    }

    fn detect_line_ending_from_bytes(bytes: &[u8]) -> Option<LineEndingStyle> {
        if bytes.is_empty() || bytes.contains(&0) {
            return None;
        }

        let mut lf_count = 0usize;
        let mut crlf_count = 0usize;

        let mut idx = 0usize;
        while idx < bytes.len() {
            if bytes[idx] == b'\n' {
                if idx > 0 && bytes[idx - 1] == b'\r' {
                    crlf_count += 1;
                } else {
                    lf_count += 1;
                }
            }
            idx += 1;
        }

        match (crlf_count > 0, lf_count > 0) {
            (true, false) => Some(LineEndingStyle::Crlf),
            (false, true) => Some(LineEndingStyle::Lf),
            (true, true) => Some(LineEndingStyle::Mixed),
            (false, false) => None,
        }
    }

    fn detect_line_ending_from_file(repo_path: &Path, file_path: &str) -> Option<LineEndingStyle> {
        let full_path = repo_path.join(file_path);
        let bytes = fs::read(full_path).ok()?;
        Self::detect_line_ending_from_bytes(&bytes)
    }

    fn detect_line_ending(repo_path: &Path, file_path: &str, staged: bool) -> LineEndingStyle {
        Self::detect_line_ending_from_ls_files(repo_path, file_path, staged)
            .or_else(|| {
                if staged {
                    None
                } else {
                    Self::detect_line_ending_from_file(repo_path, file_path)
                }
            })
            .unwrap_or(LineEndingStyle::Unknown)
    }

    fn is_untracked_file(repo_path: &Path, file_path: &str) -> bool {
        let output = match Self::run_git(
            &[
                "-c",
                "core.quotepath=false",
                "status",
                "--porcelain=v1",
                "--",
                file_path,
            ],
            Some(repo_path),
        ) {
            Ok(value) => value,
            Err(_) => return false,
        };

        output.lines().any(|line| {
            line.strip_prefix("?? ")
                .map(|path| path.trim() == file_path)
                .unwrap_or(false)
        })
    }

    fn is_added_in_index(repo_path: &Path, file_path: &str) -> bool {
        let output = match Self::run_git(
            &[
                "-c",
                "core.quotepath=false",
                "diff",
                "--cached",
                "--name-status",
                "--no-renames",
                "--",
                file_path,
            ],
            Some(repo_path),
        ) {
            Ok(value) => value,
            Err(_) => return false,
        };

        output.lines().any(|line| {
            let mut parts = line.splitn(2, '\t');
            let status = parts.next().unwrap_or_default().trim();
            let path = parts.next().unwrap_or_default().trim();
            status.starts_with('A') && path == file_path
        })
    }

    fn split_content_lines_for_display<'a>(
        content: &'a str,
        line_ending: LineEndingStyle,
    ) -> Vec<&'a str> {
        if matches!(line_ending, LineEndingStyle::Crlf) && content.contains("\r\n") {
            content.split_terminator("\r\n").collect()
        } else {
            content.lines().collect()
        }
    }

    /// Build a FileDiff from raw file content where every line is an addition.
    /// Used for newly staged files (no prior version in the index or working tree).
    fn synthetic_new_file_diff(
        file_path: &str,
        content: &str,
        line_ending: LineEndingStyle,
        detected_file_type: Option<String>,
    ) -> FileDiff {
        let lines = Self::split_content_lines_for_display(content, line_ending);
        let line_count = lines.len();

        let diff_lines: Vec<DiffLine> = lines
            .into_iter()
            .enumerate()
            .map(|(i, text)| DiffLine {
                kind: DiffLineKind::Add,
                content: text.to_string(),
                old_line_no: None,
                new_line_no: Some((i + 1) as u32),
            })
            .collect();

        let header = format!("@@ -0,0 +1,{} @@", line_count);
        let hunk = DiffHunk {
            header,
            lines: diff_lines,
        };

        FileDiff {
            file_path: file_path.to_string(),
            hunks: vec![hunk],
            is_binary: false,
            line_ending,
            detected_file_type,
        }
    }

    fn parse_repo_status(output: &str) -> RepoStatus {
        let mut changed_files = Vec::new();
        let mut staged_files = Vec::new();
        let mut unversioned_files = Vec::new();

        for line in output.lines().filter(|line| !line.trim().is_empty()) {
            let Some((x, y, path)) = Self::parse_status_line(line) else {
                continue;
            };

            if x == '?' && y == '?' {
                unversioned_files.push(path);
                continue;
            }

            // Conflict files (U in either column) are handled separately
            if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
                continue;
            }

            let status = format!("{x}{y}");
            if x != ' ' && x != '?' {
                staged_files.push(FileStatusItem {
                    path: path.clone(),
                    status: status.clone(),
                    additions: None,
                    deletions: None,
                });
            }

            if y != ' ' && y != '?' {
                changed_files.push(FileStatusItem {
                    path,
                    status,
                    additions: None,
                    deletions: None,
                });
            }
        }

        RepoStatus {
            changed_files,
            staged_files,
            unversioned_files,
            current_branch: None,
            merge_in_progress: false,
            merge_head_branch: None,
            conflicted_files: vec![],
            merge_message: None,
            rebase_in_progress: false,
            rebase_onto: None,
            cherry_pick_in_progress: false,
            cherry_pick_head: None,
            revert_in_progress: false,
            revert_head: None,
        }
    }

    fn parse_conflicted_files(porcelain_output: &str) -> Vec<ConflictFileItem> {
        let mut conflicts = Vec::new();
        for line in porcelain_output.lines() {
            let Some((x, y, path)) = Self::parse_status_line(line) else {
                continue;
            };

            let conflict_type = match (x, y) {
                ('U', 'U') => "both_modified",
                ('A', 'A') => "both_added",
                ('D', 'D') => "both_deleted",
                ('A', 'U') => "added_by_us",
                ('U', 'A') => "added_by_them",
                ('D', 'U') => "deleted_by_us",
                ('U', 'D') => "deleted_by_them",
                _ => continue,
            };

            conflicts.push(ConflictFileItem {
                path,
                conflict_type: conflict_type.to_string(),
            });
        }
        conflicts
    }

    fn get_conflicted_files(repo_path: &Path) -> Vec<String> {
        Self::run_git(&["diff", "--name-only", "--diff-filter=U"], Some(repo_path))
            .unwrap_or_default()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| l.trim().to_string())
            .collect()
    }

    fn parse_merge_subject_branch(first_line: &str, prefix: &str) -> Option<String> {
        first_line
            .strip_prefix(prefix)
            .and_then(|rest| rest.split('\'').next())
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(|branch| branch.to_string())
    }

    fn detect_merge_branch(repo_path: &Path) -> Option<String> {
        let merge_msg_path = repo_path.join(".git/MERGE_MSG");
        if let Ok(msg) = std::fs::read_to_string(&merge_msg_path) {
            if let Some(first_line) = msg.lines().next() {
                if let Some(branch) = Self::parse_merge_subject_branch(first_line, "Merge branch '")
                {
                    return Some(branch);
                }
                if let Some(branch) =
                    Self::parse_merge_subject_branch(first_line, "Merge remote-tracking branch '")
                {
                    return Some(branch);
                }
            }
        }

        // Fallback: resolve MERGE_HEAD to a short hash
        Self::run_git(&["rev-parse", "--short", "MERGE_HEAD"], Some(repo_path))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    }

    fn is_merge_in_progress(repo_path: &Path) -> bool {
        repo_path.join(".git/MERGE_HEAD").exists()
    }

    fn is_rebase_in_progress(repo_path: &Path) -> bool {
        repo_path.join(".git/rebase-merge").exists() || repo_path.join(".git/rebase-apply").exists()
    }

    fn detect_rebase_onto(repo_path: &Path) -> Option<String> {
        let onto = [".git/rebase-merge/onto", ".git/rebase-apply/onto"]
            .iter()
            .find_map(|relative| {
                std::fs::read_to_string(repo_path.join(relative))
                    .ok()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
            })?;

        Self::run_git(&["rev-parse", "--short", onto.as_str()], Some(repo_path))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or(Some(onto))
    }

    fn is_cherry_pick_in_progress(repo_path: &Path) -> bool {
        repo_path.join(".git/CHERRY_PICK_HEAD").exists()
    }

    fn detect_cherry_pick_head(repo_path: &Path) -> Option<String> {
        let head = std::fs::read_to_string(repo_path.join(".git/CHERRY_PICK_HEAD"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())?;

        Self::run_git(&["rev-parse", "--short", head.as_str()], Some(repo_path))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or(Some(head))
    }

    fn is_revert_in_progress(repo_path: &Path) -> bool {
        repo_path.join(".git/REVERT_HEAD").exists()
    }

    fn detect_revert_head(repo_path: &Path) -> Option<String> {
        let head = std::fs::read_to_string(repo_path.join(".git/REVERT_HEAD"))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())?;

        Self::run_git(&["rev-parse", "--short", head.as_str()], Some(repo_path))
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .or(Some(head))
    }

    fn detect_current_branch(repo_path: &Path) -> Option<String> {
        let branch_name = Self::run_git(&["branch", "--show-current"], Some(repo_path)).ok()?;
        let trimmed_branch_name = branch_name.trim();
        if !trimmed_branch_name.is_empty() {
            return Some(trimmed_branch_name.to_string());
        }

        let detached_head =
            Self::run_git(&["rev-parse", "--short", "HEAD"], Some(repo_path)).ok()?;
        let trimmed_detached_head = detached_head.trim();
        if trimmed_detached_head.is_empty() {
            None
        } else {
            Some(format!("detached@{trimmed_detached_head}"))
        }
    }

    fn parse_status_line(line: &str) -> Option<(char, char, String)> {
        if line.len() < 4 {
            return None;
        }

        let mut chars = line.chars();
        let x = chars.next()?;
        let y = chars.next()?;
        let path_part = line.get(3..)?.trim();
        let path = Self::extract_status_path(path_part);

        if path.is_empty() {
            return None;
        }

        Some((x, y, path))
    }

    fn extract_status_path(path_part: &str) -> String {
        let trimmed = path_part.trim();
        if let Some((_, renamed_to)) = trimmed.rsplit_once(" -> ") {
            renamed_to.trim().to_string()
        } else {
            trimmed.to_string()
        }
    }

    pub fn resolve_clone_destination(repo_url: &str, destination: &str) -> GitResult<PathBuf> {
        let repo_url = repo_url.trim();
        let destination = destination.trim();

        Self::validate_clone_repo_url(repo_url)?;

        if destination.is_empty() {
            return Err(GitError::InvalidInput(
                "Destination path cannot be empty".to_string(),
            ));
        }

        let destination_path = PathBuf::from(destination);

        if !destination_path.exists() {
            return Ok(destination_path);
        }

        if !destination_path.is_dir() {
            return Err(GitError::InvalidInput(format!(
                "Destination must be a directory path: {}",
                destination_path.display()
            )));
        }

        let mut entries = fs::read_dir(&destination_path)?;
        if entries.next().is_none() {
            return Ok(destination_path);
        }

        let repo_name = Self::repo_name_from_url(repo_url).ok_or_else(|| {
            GitError::InvalidInput("Could not derive repository name from URL".to_string())
        })?;
        let final_path = destination_path.join(repo_name);

        if final_path.exists() {
            return Err(GitError::InvalidInput(format!(
                "Target path already exists: {}",
                final_path.display()
            )));
        }

        Ok(final_path)
    }

    fn repo_name_from_url(repo_url: &str) -> Option<String> {
        let trimmed = repo_url.trim().trim_end_matches('/');
        let last_segment = trimmed.rsplit(['/', '\\', ':']).next()?;
        let normalized = last_segment.trim_end_matches(".git").trim();

        if normalized.is_empty() {
            None
        } else {
            Some(normalized.to_string())
        }
    }

    fn parse_numstat(output: &str) -> HashMap<&str, (u32, u32)> {
        let mut stats = HashMap::new();
        for line in output.lines().filter(|l| !l.trim().is_empty()) {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            // Binary files show "-" for additions/deletions
            let additions = parts[0].parse::<u32>().unwrap_or(0);
            let deletions = parts[1].parse::<u32>().unwrap_or(0);
            let path = parts[2].trim();
            stats.insert(path, (additions, deletions));
        }
        stats
    }

    fn parse_numstat_totals(output: &str) -> (u32, u32) {
        let mut additions = 0u32;
        let mut deletions = 0u32;

        for line in output.lines().filter(|line| !line.trim().is_empty()) {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            additions = additions.saturating_add(parts[0].parse::<u32>().unwrap_or(0));
            deletions = deletions.saturating_add(parts[1].parse::<u32>().unwrap_or(0));
        }

        (additions, deletions)
    }

    fn get_ahead_behind(repo_path: &Path, branch: &str, upstream: &str) -> (u32, u32) {
        let range = format!("{branch}...{upstream}");
        let output = Self::run_git(
            &["rev-list", "--left-right", "--count", &range],
            Some(repo_path),
        );

        match output {
            Ok(stdout) => {
                let parts: Vec<&str> = stdout.split_whitespace().collect();
                if parts.len() == 2 {
                    let ahead = parts[0].parse::<u32>().unwrap_or(0);
                    let behind = parts[1].parse::<u32>().unwrap_or(0);
                    (ahead, behind)
                } else {
                    (0, 0)
                }
            }
            Err(_) => (0, 0),
        }
    }

    fn parse_diff_hunks(diff_output: &str) -> Vec<DiffHunk> {
        let mut hunks = Vec::new();
        let mut current_hunk: Option<DiffHunk> = None;
        let mut old_line: u32 = 0;
        let mut new_line: u32 = 0;

        for line in diff_output.lines() {
            if line.starts_with("@@") {
                // Save previous hunk if exists
                if let Some(hunk) = current_hunk.take() {
                    hunks.push(hunk);
                }

                // Parse hunk header: @@ -X,Y +A,B @@
                let (parsed_old, parsed_new) = Self::parse_hunk_header(line);
                old_line = parsed_old;
                new_line = parsed_new;

                current_hunk = Some(DiffHunk {
                    header: line.to_string(),
                    lines: Vec::new(),
                });
            } else if let Some(ref mut hunk) = current_hunk {
                if let Some(stripped) = line.strip_prefix('+') {
                    hunk.lines.push(DiffLine {
                        kind: DiffLineKind::Add,
                        content: stripped.to_string(),
                        old_line_no: None,
                        new_line_no: Some(new_line),
                    });
                    new_line += 1;
                } else if let Some(stripped) = line.strip_prefix('-') {
                    hunk.lines.push(DiffLine {
                        kind: DiffLineKind::Remove,
                        content: stripped.to_string(),
                        old_line_no: Some(old_line),
                        new_line_no: None,
                    });
                    old_line += 1;
                } else if line.starts_with(' ') || line.is_empty() {
                    let content = if line.is_empty() {
                        String::new()
                    } else {
                        line[1..].to_string()
                    };
                    hunk.lines.push(DiffLine {
                        kind: DiffLineKind::Context,
                        content,
                        old_line_no: Some(old_line),
                        new_line_no: Some(new_line),
                    });
                    old_line += 1;
                    new_line += 1;
                }
                // Skip lines like "\ No newline at end of file"
            }
        }

        // Don't forget the last hunk
        if let Some(hunk) = current_hunk {
            hunks.push(hunk);
        }

        hunks
    }

    fn parse_hunk_header(header: &str) -> (u32, u32) {
        // Parse @@ -X,Y +A,B @@ format
        let mut old_start: u32 = 1;
        let mut new_start: u32 = 1;

        if let Some(at_content) = header.strip_prefix("@@") {
            let at_content = if let Some(pos) = at_content[1..].find("@@") {
                &at_content[1..pos + 1]
            } else {
                at_content
            };

            for part in at_content.split_whitespace() {
                if let Some(old_part) = part.strip_prefix('-') {
                    if let Some((start, _)) = old_part.split_once(',') {
                        old_start = start.parse().unwrap_or(1);
                    } else {
                        old_start = old_part.parse().unwrap_or(1);
                    }
                } else if let Some(new_part) = part.strip_prefix('+') {
                    if let Some((start, _)) = new_part.split_once(',') {
                        new_start = start.parse().unwrap_or(1);
                    } else {
                        new_start = new_part.parse().unwrap_or(1);
                    }
                }
            }
        }

        (old_start, new_start)
    }

    fn extract_diff_header(diff_output: &str) -> String {
        let mut header_lines = Vec::new();
        for line in diff_output.lines() {
            if line.starts_with("@@") {
                break;
            }
            header_lines.push(line);
        }
        header_lines.join("\n")
    }

    fn extract_raw_hunks(diff_output: &str) -> Vec<String> {
        let mut hunks = Vec::new();
        let mut current_hunk_lines: Vec<&str> = Vec::new();
        let mut in_hunk = false;

        for line in diff_output.lines() {
            if line.starts_with("@@") {
                if in_hunk && !current_hunk_lines.is_empty() {
                    hunks.push(current_hunk_lines.join("\n"));
                    current_hunk_lines.clear();
                }
                in_hunk = true;
                current_hunk_lines.push(line);
            } else if in_hunk {
                current_hunk_lines.push(line);
            }
        }

        if !current_hunk_lines.is_empty() {
            hunks.push(current_hunk_lines.join("\n"));
        }

        hunks
    }
}

/// Parse git-trailer lines from a commit body.
///
/// Scans lines from the end of the body, collecting `Key: value` pairs that
/// match the trailer format. Stops on the first non-empty, non-matching line
/// (trailers form a contiguous block at the end of the message body).
pub(super) fn parse_commit_trailers(body: &str) -> Vec<CommitTrailer> {
    let lines: Vec<&str> = body.lines().collect();
    let mut trailers = Vec::new();

    for line in lines.iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Trailer format: Token: value  (token is word chars + hyphens)
        if let Some(colon_pos) = trimmed.find(':') {
            let key = &trimmed[..colon_pos];
            let value = trimmed[colon_pos + 1..].trim();
            let key_valid =
                !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
            if key_valid && !value.is_empty() {
                trailers.push(CommitTrailer {
                    key: key.to_string(),
                    value: value.to_string(),
                });
                continue;
            }
        }
        break;
    }

    trailers.reverse();
    trailers
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hunk_header_standard() {
        assert_eq!(
            CliGitHandler::parse_hunk_header("@@ -10,6 +10,7 @@"),
            (10, 10)
        );
    }

    #[test]
    fn hunk_header_different_lines() {
        assert_eq!(CliGitHandler::parse_hunk_header("@@ -1,3 +5,4 @@"), (1, 5));
    }

    #[test]
    fn hunk_header_single_line_no_count() {
        // @@ -5 +5 @@ (no comma)
        assert_eq!(CliGitHandler::parse_hunk_header("@@ -5 +7 @@"), (5, 7));
    }

    #[test]
    fn hunk_header_with_function_name() {
        assert_eq!(
            CliGitHandler::parse_hunk_header("@@ -20,4 +20,5 @@ fn my_func() {"),
            (20, 20)
        );
    }

    #[test]
    fn status_line_modified_unstaged() {
        let result = CliGitHandler::parse_status_line(" M src/main.rs");
        assert_eq!(result, Some((' ', 'M', "src/main.rs".to_string())));
    }

    #[test]
    fn status_line_staged_modified() {
        let result = CliGitHandler::parse_status_line("M  src/lib.rs");
        assert_eq!(result, Some(('M', ' ', "src/lib.rs".to_string())));
    }

    #[test]
    fn status_line_untracked() {
        let result = CliGitHandler::parse_status_line("?? new_file.txt");
        assert_eq!(result, Some(('?', '?', "new_file.txt".to_string())));
    }

    #[test]
    fn status_line_rename() {
        let result = CliGitHandler::parse_status_line("R  old.rs -> new.rs");
        assert_eq!(result, Some(('R', ' ', "new.rs".to_string())));
    }

    #[test]
    fn status_line_too_short_returns_none() {
        assert_eq!(CliGitHandler::parse_status_line("M "), None);
        assert_eq!(CliGitHandler::parse_status_line(""), None);
    }

    #[test]
    fn status_line_empty_path_returns_none() {
        assert_eq!(CliGitHandler::parse_status_line("M    "), None);
    }

    #[test]
    fn conflict_both_modified() {
        let output = "UU src/conflict.rs\n";
        let result = CliGitHandler::parse_conflicted_files(output);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].conflict_type, "both_modified");
        assert_eq!(result[0].path, "src/conflict.rs");
    }

    #[test]
    fn conflict_all_types() {
        let output = "\
UU both_mod.rs
AA both_add.rs
DD both_del.rs
AU added_by_us.rs
UA added_by_them.rs
DU deleted_by_us.rs
UD deleted_by_them.rs
";
        let result = CliGitHandler::parse_conflicted_files(output);
        assert_eq!(result.len(), 7);
        let types: Vec<&str> = result.iter().map(|c| c.conflict_type.as_str()).collect();
        assert!(types.contains(&"both_modified"));
        assert!(types.contains(&"both_added"));
        assert!(types.contains(&"both_deleted"));
        assert!(types.contains(&"added_by_us"));
        assert!(types.contains(&"added_by_them"));
        assert!(types.contains(&"deleted_by_us"));
        assert!(types.contains(&"deleted_by_them"));
    }

    #[test]
    fn conflict_non_conflict_lines_ignored() {
        let output = " M regular.rs\n?? untracked.rs\n";
        let result = CliGitHandler::parse_conflicted_files(output);
        assert!(result.is_empty());
    }

    #[test]
    fn repo_status_untracked_file() {
        let output = "?? new_file.txt\n";
        let status = CliGitHandler::parse_repo_status(output);
        assert_eq!(status.unversioned_files, vec!["new_file.txt"]);
        assert!(status.staged_files.is_empty());
        assert!(status.changed_files.is_empty());
    }

    #[test]
    fn repo_status_staged_new_file() {
        let output = "A  new_staged.rs\n";
        let status = CliGitHandler::parse_repo_status(output);
        assert_eq!(status.staged_files.len(), 1);
        assert_eq!(status.staged_files[0].path, "new_staged.rs");
        assert!(status.changed_files.is_empty());
    }

    #[test]
    fn repo_status_modified_unstaged() {
        let output = " M changed.rs\n";
        let status = CliGitHandler::parse_repo_status(output);
        assert_eq!(status.changed_files.len(), 1);
        assert_eq!(status.changed_files[0].path, "changed.rs");
        assert!(status.staged_files.is_empty());
    }

    #[test]
    fn repo_status_staged_and_unstaged() {
        let output = "MM both.rs\n";
        let status = CliGitHandler::parse_repo_status(output);
        assert_eq!(status.staged_files.len(), 1);
        assert_eq!(status.changed_files.len(), 1);
    }

    #[test]
    fn repo_status_conflict_lines_excluded_from_staged_changed() {
        let output = "UU conflict.rs\nAA also_conflict.rs\n";
        let status = CliGitHandler::parse_repo_status(output);
        assert!(status.staged_files.is_empty());
        assert!(status.changed_files.is_empty());
    }

    #[test]
    fn repo_status_empty_output() {
        let status = CliGitHandler::parse_repo_status("");
        assert!(status.staged_files.is_empty());
        assert!(status.changed_files.is_empty());
        assert!(status.unversioned_files.is_empty());
    }

    #[test]
    fn diff_hunks_empty_input() {
        assert!(CliGitHandler::parse_diff_hunks("").is_empty());
    }

    #[test]
    fn diff_hunks_single_hunk() {
        let diff = "@@ -1,3 +1,4 @@\n context\n+added\n-removed\n context2\n";
        let hunks = CliGitHandler::parse_diff_hunks(diff);
        assert_eq!(hunks.len(), 1);
        assert_eq!(hunks[0].lines.len(), 4);
        assert!(matches!(hunks[0].lines[0].kind, DiffLineKind::Context));
        assert!(matches!(hunks[0].lines[1].kind, DiffLineKind::Add));
        assert!(matches!(hunks[0].lines[2].kind, DiffLineKind::Remove));
        assert!(matches!(hunks[0].lines[3].kind, DiffLineKind::Context));
    }

    #[test]
    fn diff_hunks_line_numbers() {
        let diff = "@@ -5,2 +10,2 @@\n context\n+added\n";
        let hunks = CliGitHandler::parse_diff_hunks(diff);
        let lines = &hunks[0].lines;
        // Context line at old=5, new=10
        assert_eq!(lines[0].old_line_no, Some(5));
        assert_eq!(lines[0].new_line_no, Some(10));
        // Add line increments new_line only
        assert_eq!(lines[1].old_line_no, None);
        assert_eq!(lines[1].new_line_no, Some(11));
    }

    #[test]
    fn diff_hunks_no_newline_marker_skipped() {
        let diff = "@@ -1,1 +1,1 @@\n context\n\\ No newline at end of file\n";
        let hunks = CliGitHandler::parse_diff_hunks(diff);
        // The "\ No newline" line should not appear as a hunk line
        assert_eq!(hunks[0].lines.len(), 1);
    }

    #[test]
    fn diff_hunks_multiple_hunks() {
        let diff = "@@ -1,1 +1,1 @@\n ctx1\n@@ -10,1 +10,1 @@\n ctx2\n";
        let hunks = CliGitHandler::parse_diff_hunks(diff);
        assert_eq!(hunks.len(), 2);
    }

    #[test]
    fn numstat_basic() {
        let output = "5\t3\tsrc/main.rs\n10\t0\tsrc/lib.rs\n";
        let stats = CliGitHandler::parse_numstat(output);
        assert_eq!(stats.get("src/main.rs"), Some(&(5, 3)));
        assert_eq!(stats.get("src/lib.rs"), Some(&(10, 0)));
    }

    #[test]
    fn numstat_binary_file() {
        // Binary files show "-" which parses as 0
        let output = "-\t-\timage.png\n";
        let stats = CliGitHandler::parse_numstat(output);
        assert_eq!(stats.get("image.png"), Some(&(0, 0)));
    }

    #[test]
    fn numstat_empty_input() {
        assert!(CliGitHandler::parse_numstat("").is_empty());
    }

    #[test]
    fn repo_name_https_with_git_suffix() {
        assert_eq!(
            CliGitHandler::repo_name_from_url("https://example.com/user/myrepo.git"),
            Some("myrepo".to_string())
        );
    }

    #[test]
    fn repo_name_https_without_git_suffix() {
        assert_eq!(
            CliGitHandler::repo_name_from_url("https://example.com/user/myrepo"),
            Some("myrepo".to_string())
        );
    }

    #[test]
    fn repo_name_ssh_url() {
        assert_eq!(
            CliGitHandler::repo_name_from_url("git@example.com:user/repo.git"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn repo_name_trailing_slash() {
        assert_eq!(
            CliGitHandler::repo_name_from_url("https://example.com/user/repo/"),
            Some("repo".to_string())
        );
    }

    #[test]
    fn trailers_empty_body() {
        assert!(parse_commit_trailers("").is_empty());
    }

    #[test]
    fn trailers_single() {
        let result = parse_commit_trailers("Reviewed-by: Alice");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].key, "Reviewed-by");
        assert_eq!(result[0].value, "Alice");
    }

    #[test]
    fn trailers_multiple_in_order() {
        let body = "Reviewed-by: Alice\nSigned-off-by: Bob";
        let result = parse_commit_trailers(body);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].key, "Reviewed-by");
        assert_eq!(result[1].key, "Signed-off-by");
    }

    #[test]
    fn trailers_value_with_colon() {
        let result = parse_commit_trailers("Co-authored-by: Name <email@example.com>");
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].key, "Co-authored-by");
        assert_eq!(result[0].value, "Name <email@example.com>");
    }

    #[test]
    fn trailers_stops_at_body_paragraph() {
        let body = "This is the body.\n\nReviewed-by: Alice";
        let result = parse_commit_trailers(body);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].key, "Reviewed-by");
    }

    #[test]
    fn trailers_invalid_key_with_space_not_collected() {
        let result = parse_commit_trailers("Not A Key: value");
        assert!(result.is_empty());
    }
}
