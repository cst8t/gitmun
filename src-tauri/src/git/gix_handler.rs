use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::{collections::HashMap, collections::HashSet};

use super::cli::CliGitHandler;
use super::error::{GitError, GitResult};
use super::handler::GitOperationHandler;
use super::types::{
    AddRemoteRequest, BranchInfo, BranchRequest, CherryPickRequest, CherryPickResult, CloneRequest,
    CommitDateMode, CommitDetails, CommitDetailsRequest, CommitFileItem, CommitFilesRequest,
    CommitHistoryItem, CommitHistoryRequest, CommitMarkers, CommitRequest, ConflictFileItem,
    CreateBranchRequest, CreateTagRequest, DeleteBranchRequest, DeleteRemoteBranchRequest,
    DeleteRemoteTagRequest, DeleteTagRequest, DiffRequest, ExternalDiffRequest, FetchRequest,
    FileDiff, FileRequest, FileStatusItem, GitIdentity, HunkStageRequest, IdentityRequest,
    MergeRequest, MergeResult, NumstatRequest, NumstatResult, OperationResult, PruneRemoteRequest,
    PullAnalysis, PullStrategyRequest, PushRequest, PushResult, PushTagRequest, RebaseRequest,
    RebaseResult, RemoteInfo, RemoveRemoteRequest, RenameBranchRequest, RenameRemoteRequest,
    RepoRequest, RepoStatus, ResetRequest, RevertCommitRequest, SetIdentityRequest,
    SetRemoteUrlRequest, SignatureStatus, StageFilesRequest, StashEntry, StashPushRequest,
    StashRequest, TagInfo,
};

pub struct GixGitHandler {
    cli_fallback: CliGitHandler,
}

impl GixGitHandler {
    pub fn new() -> Self {
        Self {
            cli_fallback: CliGitHandler::new(),
        }
    }

    fn validate_repo_with_gix(&self, repo_path: &str) -> GitResult<()> {
        let path = Path::new(repo_path.trim());

        gix::discover(path).map_err(|error| GitError::GixError(error.to_string()))?;
        Ok(())
    }

    fn discover_repo_root(&self, repo_path: &str) -> GitResult<String> {
        let path = Path::new(repo_path.trim());
        let repo = gix::discover(path).map_err(|error| GitError::GixError(error.to_string()))?;
        let root = repo.workdir().unwrap_or(repo.path());
        Ok(root.to_string_lossy().to_string())
    }

    fn with_cli_fallback_backend(mut result: OperationResult) -> OperationResult {
        result.backend_used = "gix+cli-fallback".to_string();
        result
    }

    fn with_cli_fallback_push_backend(mut result: PushResult) -> PushResult {
        result.backend_used = "gix+cli-fallback".to_string();
        result
    }

    fn bstr_to_string(value: &gix::bstr::BStr) -> String {
        String::from_utf8_lossy(value.as_ref()).to_string()
    }

    fn status_from_worktree_summary(
        summary: gix::status::index_worktree::iter::Summary,
    ) -> &'static str {
        match summary {
            gix::status::index_worktree::iter::Summary::Removed => "deleted",
            gix::status::index_worktree::iter::Summary::Added => "added",
            gix::status::index_worktree::iter::Summary::Modified
            | gix::status::index_worktree::iter::Summary::TypeChange
            | gix::status::index_worktree::iter::Summary::Conflict => "modified",
            gix::status::index_worktree::iter::Summary::Renamed => "renamed",
            gix::status::index_worktree::iter::Summary::Copied => "added",
            gix::status::index_worktree::iter::Summary::IntentToAdd => "added",
        }
    }

    fn status_from_tree_index_change(
        change: &gix::diff::index::Change,
    ) -> (&gix::bstr::BStr, &'static str) {
        match change {
            gix::diff::index::Change::Addition { location, .. } => (location.as_ref(), "added"),
            gix::diff::index::Change::Deletion { location, .. } => (location.as_ref(), "deleted"),
            gix::diff::index::Change::Modification { location, .. } => {
                (location.as_ref(), "modified")
            }
            gix::diff::index::Change::Rewrite { location, copy, .. } => {
                (location.as_ref(), if *copy { "added" } else { "renamed" })
            }
        }
    }

    fn current_branch(repo: &gix::Repository) -> Option<String> {
        match repo.head_name() {
            Ok(Some(name)) => Some(Self::bstr_to_string(name.shorten())),
            Ok(None) => repo.head_id().ok().map(|id| {
                let full = id.to_string();
                let short: String = full.chars().take(7).collect();
                format!("detached@{short}")
            }),
            Err(_) => None,
        }
    }

    fn collect_branches_with_gix(repo: &gix::Repository) -> GitResult<Vec<BranchInfo>> {
        let current_branch_name: Option<String> = match repo.head_name() {
            Ok(Some(name)) => Some(Self::bstr_to_string(name.shorten())),
            _ => None,
        };

        let config = repo.config_snapshot();
        let refs = repo
            .references()
            .map_err(|e| GitError::GixError(e.to_string()))?;

        let mut branches = Vec::new();

        let local_iter = refs
            .local_branches()
            .map_err(|e| GitError::GixError(e.to_string()))?;

        for reference in local_iter {
            let reference = reference.map_err(|e| GitError::GixError(e.to_string()))?;
            let short_name = Self::bstr_to_string(reference.name().shorten());
            let is_current = current_branch_name.as_deref() == Some(short_name.as_str());

            // Read upstream tracking config: branch.<name>.remote + branch.<name>.merge
            let upstream: Option<String> = {
                let remote_key = format!("branch.{}.remote", short_name);
                let merge_key = format!("branch.{}.merge", short_name);
                let remote = config.string(remote_key.as_str()).map(|v| v.to_string());
                let merge = config.string(merge_key.as_str()).map(|v| v.to_string());
                match (remote, merge) {
                    (Some(remote), Some(merge)) => {
                        // merge is like "refs/heads/main" - strip prefix
                        let branch_part = merge
                            .strip_prefix("refs/heads/")
                            .unwrap_or(merge.as_str())
                            .to_string();
                        Some(format!("{}/{}", remote, branch_part))
                    }
                    _ => None,
                }
            };

            // Compute ahead/behind entirely in-process using rev_walk.
            // If gix can't locate the remote tracking ref (e.g. transient file
            // lock during a concurrent fetch) we propagate the error so the
            // caller falls back to the CLI path rather than silently returning
            // ahead=0 and causing a badge flicker.
            let (ahead, behind) = if let Some(ref upstream_name) = upstream {
                let local_oid = reference.id().detach();
                let remote_ref_name = format!("refs/remotes/{}", upstream_name);
                let remote_ref = repo.find_reference(remote_ref_name.as_str()).map_err(|e| {
                    GitError::GixError(format!("remote ref not found for {upstream_name}: {e}"))
                })?;
                let remote_oid = remote_ref.id().detach();
                if local_oid == remote_oid {
                    (0, 0)
                } else {
                    let ahead = repo
                        .rev_walk([local_oid])
                        .with_hidden([remote_oid])
                        .all()
                        .map(|walk| walk.filter_map(|r| r.ok()).count() as u32)
                        .unwrap_or(0);
                    let behind = repo
                        .rev_walk([remote_oid])
                        .with_hidden([local_oid])
                        .all()
                        .map(|walk| walk.filter_map(|r| r.ok()).count() as u32)
                        .unwrap_or(0);
                    (ahead, behind)
                }
            } else {
                (0, 0)
            };

            branches.push(BranchInfo {
                name: short_name,
                is_current,
                is_remote: false,
                upstream,
                ahead,
                behind,
            });
        }

        let remote_iter = refs
            .remote_branches()
            .map_err(|e| GitError::GixError(e.to_string()))?;

        for reference in remote_iter {
            let reference = reference.map_err(|e| GitError::GixError(e.to_string()))?;
            let short_name = Self::bstr_to_string(reference.name().shorten());
            // Skip symbolic HEAD pointers like "origin/HEAD"
            if short_name.ends_with("/HEAD") {
                continue;
            }
            branches.push(BranchInfo {
                name: short_name,
                is_current: false,
                is_remote: true,
                upstream: None,
                ahead: 0,
                behind: 0,
            });
        }

        Ok(branches)
    }

    /// Natural version sort: split on non-alphanumeric boundaries and compare
    /// numeric runs as integers, text runs lexicographically.
    /// e.g. "v0.1.20" > "v0.1.9" > "v0.1.2"
    fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
        // Split into alternating numeric / non-numeric chunks
        fn parts(s: &str) -> impl Iterator<Item = (bool, &str)> {
            let mut rest = s;
            std::iter::from_fn(move || {
                if rest.is_empty() {
                    return None;
                }
                let is_digit = rest.starts_with(|c: char| c.is_ascii_digit());
                let end = rest
                    .find(|c: char| c.is_ascii_digit() != is_digit)
                    .unwrap_or(rest.len());
                let chunk = &rest[..end];
                rest = &rest[end..];
                Some((is_digit, chunk))
            })
        }

        let mut ai = parts(a);
        let mut bi = parts(b);
        loop {
            match (ai.next(), bi.next()) {
                (None, None) => return std::cmp::Ordering::Equal,
                (None, Some(_)) => return std::cmp::Ordering::Less,
                (Some(_), None) => return std::cmp::Ordering::Greater,
                (Some((ad, ac)), Some((bd, bc))) => {
                    let ord = if ad && bd {
                        let an: u64 = ac.parse().unwrap_or(0);
                        let bn: u64 = bc.parse().unwrap_or(0);
                        an.cmp(&bn)
                    } else {
                        ac.cmp(bc)
                    };
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
            }
        }
    }

    fn collect_commit_tags(
        repo: &gix::Repository,
        target: &gix::ObjectId,
    ) -> GitResult<Vec<String>> {
        let refs = repo
            .references()
            .map_err(|e| GitError::GixError(e.to_string()))?;
        let tag_iter = refs.tags().map_err(|e| GitError::GixError(e.to_string()))?;

        let mut matching = Vec::new();
        for reference in tag_iter {
            let reference = reference.map_err(|e| GitError::GixError(e.to_string()))?;
            let raw_oid = reference.id().detach();

            // Peel through annotated tag objects to reach the commit.
            let peeled = repo
                .find_object(raw_oid)
                .ok()
                .and_then(|obj| obj.peel_to_kind(gix::object::Kind::Commit).ok())
                .map(|obj| obj.id);

            if peeled.as_ref() == Some(target) {
                let short_name = Self::bstr_to_string(reference.name().shorten());
                matching.push(short_name);
            }
        }

        Ok(matching)
    }

    fn collect_tags_with_gix(repo: &gix::Repository) -> GitResult<Vec<TagInfo>> {
        let refs = repo
            .references()
            .map_err(|e| GitError::GixError(e.to_string()))?;

        let tag_iter = refs.tags().map_err(|e| GitError::GixError(e.to_string()))?;

        let mut tags = Vec::new();

        for reference in tag_iter {
            let mut reference = reference.map_err(|e| GitError::GixError(e.to_string()))?;
            let short_name = Self::bstr_to_string(reference.name().shorten());

            // The tag object OID (before peeling) - format as hex then truncate to 7 chars
            let tag_oid = reference.id().detach();
            let short_hash: String = format!("{:.7}", tag_oid);

            // Try to peel to an annotated tag object to get the message
            let message: Option<String> = reference.peel_to_tag().ok().and_then(|tag_obj| {
                tag_obj.decode().ok().and_then(|decoded| {
                    let msg = Self::bstr_to_string(decoded.message);
                    // The message field contains the full tag message body.
                    // Take the first line (title) and return None if empty.
                    let title = msg.lines().next().unwrap_or("").trim().to_string();
                    if title.is_empty() { None } else { Some(title) }
                })
            });

            tags.push(TagInfo {
                name: short_name,
                hash: short_hash,
                message,
            });
        }

        // Sort newest-first using natural version order (numeric segments compared as integers)
        tags.sort_by(|a, b| Self::version_cmp(&b.name, &a.name));

        Ok(tags)
    }

    fn collect_remotes_with_gix(repo: &gix::Repository) -> GitResult<Vec<RemoteInfo>> {
        let names = repo.remote_names();
        let mut remotes = Vec::new();

        for name in names.iter() {
            let remote = repo
                .find_remote(name.as_ref())
                .map_err(|e| GitError::GixError(e.to_string()))?;

            // Prefer the fetch URL; fall back to push URL
            let url = remote
                .url(gix::remote::Direction::Fetch)
                .or_else(|| remote.url(gix::remote::Direction::Push))
                .map(|u| u.to_bstring().to_string())
                .unwrap_or_default();

            if !url.is_empty() {
                remotes.push(RemoteInfo {
                    name: name.to_string(),
                    url,
                });
            }
        }

        Ok(remotes)
    }

    fn collect_commit_markers_with_gix(repo: &gix::Repository) -> GitResult<CommitMarkers> {
        // local HEAD OID
        let local_head = repo.head_id().ok().map(|id| id.to_hex().to_string());

        // Derive upstream from config: branch.<name>.remote + branch.<name>.merge
        // upstream_ref is the short display form e.g. "origin/main"
        let upstream_ref: Option<String> = (|| -> Option<String> {
            let branch_name = repo.head_name().ok()??.shorten().to_string();
            let config = repo.config_snapshot();
            let remote_key = format!("branch.{}.remote", branch_name);
            let merge_key = format!("branch.{}.merge", branch_name);
            let remote = config.string(remote_key.as_str())?.to_string();
            let merge = config.string(merge_key.as_str())?.to_string();
            let branch_part = merge.strip_prefix("refs/heads/").unwrap_or(merge.as_str());
            Some(format!("{}/{}", remote, branch_part))
        })();

        let upstream_head: Option<String> = upstream_ref.as_deref().and_then(|short_name| {
            let full_ref = format!("refs/remotes/{}", short_name);
            repo.find_reference(full_ref.as_str())
                .ok()
                .map(|r| r.id().to_hex().to_string())
        });

        Ok(CommitMarkers {
            local_head,
            upstream_head,
            upstream_ref,
        })
    }

    fn collect_identity_with_gix(
        repo: &gix::Repository,
        scope: &super::types::IdentityScope,
    ) -> GitResult<GitIdentity> {
        let config = repo.config_snapshot();

        let filter: Box<dyn Fn(&gix::config::file::Metadata) -> bool> = match scope {
            super::types::IdentityScope::Local => Box::new(|meta: &gix::config::file::Metadata| {
                matches!(
                    meta.source,
                    gix::config::Source::Local | gix::config::Source::Worktree
                )
            }),
            super::types::IdentityScope::Global => {
                Box::new(|meta: &gix::config::file::Metadata| {
                    matches!(
                        meta.source,
                        gix::config::Source::Git | gix::config::Source::User
                    )
                })
            }
        };

        let get = |key: &str| -> Option<String> {
            config
                .string_filter(key, &filter)
                .map(|v| v.to_string())
                .filter(|s| !s.is_empty())
        };

        Ok(GitIdentity {
            name: get("user.name"),
            email: get("user.email"),
            signing_key: get("user.signingkey"),
            signing_format: get("gpg.format"),
            ssh_key_path: get("gpg.ssh.allowedSignersFile"),
            commit_signing_enabled: get("commit.gpgsign")
                .map(|value| {
                    let normalized = value.trim().to_ascii_lowercase();
                    matches!(normalized.as_str(), "true" | "yes" | "on" | "1")
                })
                .unwrap_or(false),
        })
    }

    fn collect_commit_history_with_gix(
        repo: &gix::Repository,
        limit: usize,
        after_hash: Option<&str>,
        commit_date_mode: &CommitDateMode,
    ) -> GitResult<Vec<CommitHistoryItem>> {
        // Determine walk starting points. When a cursor hash is provided, start
        // from that commit's parents so each page is O(limit) rather than
        // O(offset + limit). Fall back to HEAD for the first page.
        let start_ids: Vec<gix::ObjectId> = if let Some(hash) = after_hash {
            let oid = gix::ObjectId::from_hex(hash.as_bytes())
                .map_err(|e| GitError::GixError(e.to_string()))?;
            let after_commit = repo
                .find_object(oid)
                .map_err(|e| GitError::GixError(e.to_string()))?
                .try_into_commit()
                .map_err(|e| GitError::GixError(e.to_string()))?;
            after_commit.parent_ids().map(|r| r.detach()).collect()
        } else {
            match repo.head_id() {
                Ok(id) => vec![id.detach()],
                Err(_) => return Ok(Vec::new()),
            }
        };

        if start_ids.is_empty() {
            // after_hash was the root commit (no parents) - nothing more to load
            return Ok(Vec::new());
        }

        let walk = repo
            .rev_walk(start_ids)
            .all()
            .map_err(|e| GitError::GixError(e.to_string()))?;

        let mut commits = Vec::with_capacity(limit.min(256));

        for info in walk.take(limit) {
            let info = info.map_err(|e| GitError::GixError(e.to_string()))?;
            let oid = info.id();
            let commit = repo
                .find_object(oid)
                .map_err(|e| GitError::GixError(e.to_string()))?
                .try_into_commit()
                .map_err(|e| GitError::GixError(e.to_string()))?;

            // Full hex hash
            let hash = oid.to_hex().to_string();

            let short_hash = hash.chars().take(7).collect::<String>();

            // Author name and email from the author signature
            let author_sig = commit
                .author()
                .map_err(|e| GitError::GixError(e.to_string()))?;
            let author = Self::bstr_to_string(author_sig.name);
            let author_email = Self::bstr_to_string(author_sig.email);
            // Date from author or committer signature depending on the setting
            let date_time = match commit_date_mode {
                CommitDateMode::AuthorDate => author_sig.time,
                CommitDateMode::CommitterDate => {
                    commit
                        .committer()
                        .map_err(|e| GitError::GixError(e.to_string()))?
                        .time
                }
            };
            let date = gix::date::parse_header(date_time)
                .and_then(|t: gix::date::Time| {
                    t.format(gix::date::time::format::ISO8601_STRICT).ok()
                })
                .unwrap_or_else(|| date_time.to_string());

            // Subject line (first line of message)
            let message = commit
                .message()
                .map(|m| Self::bstr_to_string(m.title).trim().to_string())
                .unwrap_or_default();

            // Detect signature presence cheaply - no subprocess, no crypto.
            // Verification happens lazily via verify_commits.
            let decoded = commit
                .decode()
                .map_err(|e| GitError::GixError(e.to_string()))?;
            let sig_value = decoded
                .extra_headers
                .iter()
                .find(|(k, _)| &**k == b"gpgsig")
                .map(|(_, v)| v.as_ref());
            let (signature_status, key_type) = if let Some(sig) = sig_value {
                let kt = if sig.starts_with(b"-----BEGIN SSH SIGNATURE-----") {
                    "ssh"
                } else {
                    "gpg"
                };
                (SignatureStatus::Signed, Some(kt.to_string()))
            } else {
                (SignatureStatus::None, None)
            };

            commits.push(CommitHistoryItem {
                hash,
                short_hash,
                author,
                author_email,
                date,
                message,
                signature_status,
                key_type,
            });
        }

        Ok(commits)
    }

    fn collect_diff_tool_with_gix(repo: &gix::Repository) -> Option<String> {
        repo.config_snapshot()
            .string("diff.tool")
            .map(|v| v.to_string())
            .filter(|s| !s.is_empty())
    }

    fn parse_merge_subject_branch(first_line: &str, prefix: &str) -> Option<String> {
        first_line
            .strip_prefix(prefix)
            .and_then(|rest| rest.split('\'').next())
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
            .map(|branch| branch.to_string())
    }

    fn detect_merge_branch(git_dir: &Path) -> Option<String> {
        let msg = std::fs::read_to_string(git_dir.join("MERGE_MSG")).ok()?;
        let first_line = msg.lines().next()?;
        Self::parse_merge_subject_branch(first_line, "Merge branch '").or_else(|| {
            Self::parse_merge_subject_branch(first_line, "Merge remote-tracking branch '")
        })
    }

    fn detect_conflicted_files(git_dir: &Path) -> Vec<ConflictFileItem> {
        let repo_path = git_dir.parent().unwrap_or(git_dir);
        let output = crate::configured_git_command()
            .args(["-c", "core.quotepath=false", "status", "--porcelain=v1"])
            .current_dir(repo_path)
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();

        let mut conflicts = Vec::new();
        for line in output.lines() {
            if line.len() < 4 {
                continue;
            }
            let x = line.as_bytes()[0] as char;
            let y = line.as_bytes()[1] as char;
            let path = line[3..].to_string();
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

    fn parse_numstat(output: &str) -> HashMap<String, (u32, u32)> {
        let mut stats = HashMap::new();
        for line in output.lines().filter(|line| !line.trim().is_empty()) {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 3 {
                continue;
            }
            let additions = parts[0].parse::<u32>().unwrap_or(0);
            let deletions = parts[1].parse::<u32>().unwrap_or(0);
            let path = parts[2].trim();
            stats.insert(path.to_string(), (additions, deletions));
        }
        stats
    }

    fn collect_numstat(repo_path: &Path, staged: bool) -> HashMap<String, (u32, u32)> {
        let mut command = crate::configured_git_command();
        command.arg("-c").arg("core.quotepath=false").arg("diff");
        if staged {
            command.arg("--cached");
        }
        command.arg("--numstat").current_dir(repo_path);

        let output = match command.output() {
            Ok(output) if output.status.success() => output,
            _ => return HashMap::new(),
        };

        let stdout = String::from_utf8_lossy(&output.stdout);
        Self::parse_numstat(&stdout)
    }

    fn detect_rebase_onto(git_dir: &Path) -> Option<String> {
        for dir_name in ["rebase-merge", "rebase-apply"] {
            let onto_path = git_dir.join(dir_name).join("onto");
            if let Ok(raw) = std::fs::read_to_string(onto_path) {
                let trimmed = raw.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }

    fn detect_cherry_pick_head(git_dir: &Path) -> Option<String> {
        let raw = std::fs::read_to_string(git_dir.join("CHERRY_PICK_HEAD")).ok()?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn collect_repo_status_with_gix(repo: &gix::Repository) -> GitResult<RepoStatus> {
        let mut changed_by_path: HashMap<String, &'static str> = HashMap::new();
        let mut staged_by_path: HashMap<String, &'static str> = HashMap::new();
        let mut unversioned_paths: HashSet<String> = HashSet::new();

        let mut status_iter = repo
            .status(gix::progress::Discard)
            .map_err(|error| GitError::GixError(error.to_string()))?
            .into_iter(Vec::<gix::bstr::BString>::new())
            .map_err(|error| GitError::GixError(error.to_string()))?;

        while let Some(next_item) = status_iter.next() {
            let item = next_item.map_err(|error| GitError::GixError(error.to_string()))?;

            match item {
                gix::status::Item::IndexWorktree(worktree_item) => {
                    if let gix::status::index_worktree::Item::DirectoryContents { entry, .. } =
                        &worktree_item
                    {
                        if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                            unversioned_paths
                                .insert(Self::bstr_to_string(entry.rela_path.as_ref()));
                            continue;
                        }
                    }

                    if let Some(summary) = worktree_item.summary() {
                        let path = Self::bstr_to_string(worktree_item.rela_path());
                        let status = Self::status_from_worktree_summary(summary);
                        changed_by_path.insert(path, status);
                    }
                }
                gix::status::Item::TreeIndex(change) => {
                    let (path, status) = Self::status_from_tree_index_change(&change);
                    staged_by_path.insert(Self::bstr_to_string(path), status);
                }
            }
        }

        let mut changed_files: Vec<FileStatusItem> = changed_by_path
            .into_iter()
            .map(|(path, status)| FileStatusItem {
                path,
                status: status.to_string(),
                additions: None,
                deletions: None,
            })
            .collect();
        changed_files.sort_by(|left, right| left.path.cmp(&right.path));

        let mut staged_files: Vec<FileStatusItem> = staged_by_path
            .into_iter()
            .map(|(path, status)| FileStatusItem {
                path,
                status: status.to_string(),
                additions: None,
                deletions: None,
            })
            .collect();
        staged_files.sort_by(|left, right| left.path.cmp(&right.path));

        let repo_path = repo.workdir().unwrap_or(repo.path());
        let unstaged_stats = Self::collect_numstat(repo_path, false);
        let staged_stats = Self::collect_numstat(repo_path, true);

        for file in &mut changed_files {
            if let Some((additions, deletions)) = unstaged_stats.get(&file.path) {
                file.additions = Some(*additions);
                file.deletions = Some(*deletions);
            }
        }

        for file in &mut staged_files {
            if let Some((additions, deletions)) = staged_stats.get(&file.path) {
                file.additions = Some(*additions);
                file.deletions = Some(*deletions);
            }
        }

        let mut unversioned_files: Vec<String> = unversioned_paths.into_iter().collect();
        unversioned_files.sort();

        // Detect merge state via filesystem (same approach as CLI handler)
        let git_dir = repo.git_dir();
        let merge_in_progress = git_dir.join("MERGE_HEAD").exists();
        let (merge_head_branch, merge_message) = if merge_in_progress {
            let merge_head_branch = Self::detect_merge_branch(git_dir);
            let merge_message = std::fs::read_to_string(git_dir.join("MERGE_MSG")).ok();
            (merge_head_branch, merge_message)
        } else {
            (None, None)
        };

        let rebase_in_progress =
            git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists();
        let rebase_onto = if rebase_in_progress {
            Self::detect_rebase_onto(git_dir)
        } else {
            None
        };

        let cherry_pick_in_progress = git_dir.join("CHERRY_PICK_HEAD").exists();
        let cherry_pick_head = if cherry_pick_in_progress {
            Self::detect_cherry_pick_head(git_dir)
        } else {
            None
        };

        let conflicted_files = if merge_in_progress || rebase_in_progress || cherry_pick_in_progress
        {
            Self::detect_conflicted_files(git_dir)
        } else {
            vec![]
        };

        let revert_in_progress = git_dir.join("REVERT_HEAD").exists();
        let revert_head = if revert_in_progress {
            std::fs::read_to_string(git_dir.join("REVERT_HEAD"))
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        } else {
            None
        };

        Ok(RepoStatus {
            changed_files,
            staged_files,
            unversioned_files,
            current_branch: Self::current_branch(repo),
            merge_in_progress,
            merge_head_branch,
            conflicted_files,
            merge_message,
            rebase_in_progress,
            rebase_onto,
            cherry_pick_in_progress,
            cherry_pick_head,
            revert_in_progress,
            revert_head,
        })
    }
}

impl GitOperationHandler for GixGitHandler {
    fn validate_repo_path(&self, repo_path: &str) -> GitResult<OperationResult> {
        let resolved_repo_path = self.discover_repo_root(repo_path)?;

        if let Some(err) = CliGitHandler::check_head_broken(Path::new(&resolved_repo_path)) {
            return Err(err);
        }

        Ok(OperationResult {
            message: format!("Opened repository {resolved_repo_path}"),
            output: None,
            repo_path: Some(resolved_repo_path),
            backend_used: "gix".to_string(),
        })
    }

    fn get_numstat(&self, request: &NumstatRequest) -> GitResult<NumstatResult> {
        self.cli_fallback.get_numstat(request)
    }

    fn clone_repo(&self, request: &CloneRequest) -> GitResult<OperationResult> {
        let repo_url = request.repo_url.trim();
        let destination = request.destination.trim();
        let final_destination = CliGitHandler::resolve_clone_destination(repo_url, destination)?;
        let final_destination_str = final_destination.to_string_lossy().to_string();

        let should_interrupt = AtomicBool::new(false);
        let mut prepare = gix::prepare_clone(repo_url, final_destination_str.as_str())
            .map_err(|error| GitError::GixError(error.to_string()))?;
        let (mut checkout, _) = prepare
            .fetch_then_checkout(gix::progress::Discard, &should_interrupt)
            .map_err(|error| GitError::GixError(error.to_string()))?;
        checkout
            .main_worktree(gix::progress::Discard, &should_interrupt)
            .map_err(|error| GitError::GixError(error.to_string()))?;

        Ok(OperationResult {
            message: format!("Cloned repository to {}", final_destination.display()),
            output: Some("Clone completed using gix".to_string()),
            repo_path: Some(final_destination_str),
            backend_used: "gix".to_string(),
        })
    }

    fn analyze_pull(&self, request: &RepoRequest) -> GitResult<PullAnalysis> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.analyze_pull(request)
    }

    fn pull_changes(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .pull_changes(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn pull_with_strategy(&self, request: &PullStrategyRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .pull_with_strategy(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn push_changes(&self, request: &PushRequest) -> GitResult<PushResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .push_changes(request)
            .map(Self::with_cli_fallback_push_backend)
    }

    fn commit_changes(&self, request: &CommitRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .commit_changes(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stage_files(&self, request: &StageFilesRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stage_files(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_configured_diff_tool(&self, request: &RepoRequest) -> GitResult<Option<String>> {
        let repo_path = Path::new(request.repo_path.trim());
        match gix::discover(repo_path) {
            Ok(repo) => Ok(Self::collect_diff_tool_with_gix(&repo)),
            Err(_) => self.cli_fallback.get_configured_diff_tool(request),
        }
    }

    fn open_external_diff(&self, request: &ExternalDiffRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .open_external_diff(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn open_working_tree_diff(&self, request: &DiffRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .open_working_tree_diff(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_repo_status(&self, request: &RepoRequest) -> GitResult<RepoStatus> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|error| GitError::GixError(error.to_string()));

        match repo.and_then(|repository| Self::collect_repo_status_with_gix(&repository)) {
            Ok(status) => Ok(status),
            Err(_) => self.cli_fallback.get_repo_status(request),
        }
    }

    fn get_commit_history(
        &self,
        request: &CommitHistoryRequest,
    ) -> GitResult<Vec<CommitHistoryItem>> {
        let repo_path = Path::new(request.repo_path.trim());
        let limit = request.limit.unwrap_or(100).clamp(1, 5000);
        let after_hash = request.after_hash.as_deref();
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()));
        match repo.and_then(|r| {
            Self::collect_commit_history_with_gix(&r, limit, after_hash, &request.commit_date_mode)
        }) {
            Ok(history) => Ok(history),
            Err(_) => self.cli_fallback.get_commit_history(request),
        }
    }

    fn get_commit_markers(&self, request: &RepoRequest) -> GitResult<CommitMarkers> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()));
        match repo.and_then(|r| Self::collect_commit_markers_with_gix(&r)) {
            Ok(markers) => Ok(markers),
            Err(_) => self.cli_fallback.get_commit_markers(request),
        }
    }

    fn get_commit_files(&self, request: &CommitFilesRequest) -> GitResult<Vec<CommitFileItem>> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.get_commit_files(request)
    }

    fn get_commit_details(&self, request: &CommitDetailsRequest) -> GitResult<CommitDetails> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()))?;

        let oid = gix::ObjectId::from_hex(request.commit_hash.trim().as_bytes())
            .map_err(|e| GitError::GixError(e.to_string()))?;

        let commit = repo
            .find_object(oid)
            .map_err(|e| GitError::GixError(e.to_string()))?
            .try_into_commit()
            .map_err(|e| GitError::GixError(e.to_string()))?;

        let author_sig = commit
            .author()
            .map_err(|e| GitError::GixError(e.to_string()))?;
        let author = Self::bstr_to_string(author_sig.name);
        let author_email = Self::bstr_to_string(author_sig.email);
        let author_date = gix::date::parse_header(author_sig.time)
            .and_then(|t: gix::date::Time| t.format(gix::date::time::format::ISO8601_STRICT).ok())
            .unwrap_or_else(|| author_sig.time.to_string());

        let committer_sig = commit
            .committer()
            .map_err(|e| GitError::GixError(e.to_string()))?;
        let committer = Self::bstr_to_string(committer_sig.name);
        let committer_email = Self::bstr_to_string(committer_sig.email);
        let committer_date = gix::date::parse_header(committer_sig.time)
            .and_then(|t: gix::date::Time| t.format(gix::date::time::format::ISO8601_STRICT).ok())
            .unwrap_or_else(|| committer_sig.time.to_string());

        let parent_hashes: Vec<String> = commit
            .parent_ids()
            .map(|id| id.detach().to_hex().to_string())
            .collect();

        let body = commit
            .message()
            .map(|m| m.body.map(|b| Self::bstr_to_string(b)).unwrap_or_default())
            .unwrap_or_default();
        let trailers = super::cli::parse_commit_trailers(&body);

        let tags = Self::collect_commit_tags(&repo, &oid)?;

        Ok(CommitDetails {
            hash: oid.to_hex().to_string(),
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
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.get_diff(request)
    }

    fn get_branches(&self, request: &RepoRequest) -> GitResult<Vec<BranchInfo>> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()));
        match repo.and_then(|repository| Self::collect_branches_with_gix(&repository)) {
            Ok(branches) => Ok(branches),
            Err(_) => self.cli_fallback.get_branches(request),
        }
    }

    fn unstage_file(&self, request: &FileRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .unstage_file(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn unstage_all(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .unstage_all(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stage_all(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stage_all(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stage_hunk(&self, request: &HunkStageRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stage_hunk(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn unstage_hunk(&self, request: &HunkStageRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .unstage_hunk(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn discard_file(&self, request: &FileRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .discard_file(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn fetch_remote(&self, request: &FetchRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .fetch_remote(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stash(&self, request: &StashPushRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stash(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stash_list(&self, request: &RepoRequest) -> GitResult<Vec<StashEntry>> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.stash_list(request)
    }

    fn stash_apply(&self, request: &StashRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stash_apply(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stash_pop(&self, request: &StashRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stash_pop(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn stash_drop(&self, request: &StashRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .stash_drop(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_identity(&self, request: &IdentityRequest) -> GitResult<GitIdentity> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()));
        match repo.and_then(|r| Self::collect_identity_with_gix(&r, &request.scope)) {
            Ok(identity) => Ok(identity),
            Err(_) => self.cli_fallback.get_identity(request),
        }
    }

    fn set_identity(&self, request: &SetIdentityRequest) -> GitResult<OperationResult> {
        // We set via CLI to ensure consistency with git's config semantics
        self.cli_fallback
            .set_identity(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_tags(&self, request: &RepoRequest) -> GitResult<Vec<TagInfo>> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()));
        match repo.and_then(|r| Self::collect_tags_with_gix(&r)) {
            Ok(tags) => Ok(tags),
            Err(_) => self.cli_fallback.get_tags(request),
        }
    }

    fn get_remotes(&self, request: &RepoRequest) -> GitResult<Vec<RemoteInfo>> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| GitError::GixError(e.to_string()));
        match repo.and_then(|r| Self::collect_remotes_with_gix(&r)) {
            Ok(remotes) => Ok(remotes),
            Err(_) => self.cli_fallback.get_remotes(request),
        }
    }

    fn switch_branch(&self, request: &BranchRequest) -> GitResult<OperationResult> {
        self.cli_fallback.switch_branch(request)
    }

    fn create_branch(&self, request: &CreateBranchRequest) -> GitResult<OperationResult> {
        self.cli_fallback.create_branch(request)
    }

    fn delete_branch(&self, request: &DeleteBranchRequest) -> GitResult<OperationResult> {
        self.cli_fallback.delete_branch(request)
    }

    fn rename_branch(&self, request: &RenameBranchRequest) -> GitResult<OperationResult> {
        self.cli_fallback.rename_branch(request)
    }

    fn delete_tag(&self, request: &DeleteTagRequest) -> GitResult<OperationResult> {
        self.cli_fallback.delete_tag(request)
    }

    fn create_tag(&self, request: &CreateTagRequest) -> GitResult<OperationResult> {
        self.cli_fallback.create_tag(request)
    }

    fn push_tag(&self, request: &PushTagRequest) -> GitResult<OperationResult> {
        self.cli_fallback.push_tag(request)
    }

    fn delete_remote_tag(&self, request: &DeleteRemoteTagRequest) -> GitResult<OperationResult> {
        self.cli_fallback.delete_remote_tag(request)
    }

    fn merge_branch(&self, request: &MergeRequest) -> GitResult<MergeResult> {
        self.cli_fallback.merge_branch(request)
    }

    fn merge_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.cli_fallback.merge_abort(request)
    }

    fn rebase_start(&self, request: &RebaseRequest) -> GitResult<RebaseResult> {
        self.cli_fallback.rebase_start(request)
    }

    fn rebase_continue(&self, request: &RepoRequest) -> GitResult<RebaseResult> {
        self.cli_fallback.rebase_continue(request)
    }

    fn rebase_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.cli_fallback.rebase_abort(request)
    }

    fn cherry_pick_start(&self, request: &CherryPickRequest) -> GitResult<CherryPickResult> {
        self.cli_fallback.cherry_pick_start(request)
    }

    fn cherry_pick_continue(&self, request: &RepoRequest) -> GitResult<CherryPickResult> {
        self.cli_fallback.cherry_pick_continue(request)
    }

    fn cherry_pick_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.cli_fallback.cherry_pick_abort(request)
    }

    fn revert_commit_start(&self, request: &RevertCommitRequest) -> GitResult<CherryPickResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.revert_commit_start(request)
    }

    fn revert_continue(&self, request: &RepoRequest) -> GitResult<CherryPickResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.revert_continue(request)
    }

    fn revert_abort(&self, request: &RepoRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .revert_abort(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn reset(&self, request: &ResetRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .reset(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn delete_remote_branch(
        &self,
        request: &DeleteRemoteBranchRequest,
    ) -> GitResult<OperationResult> {
        self.cli_fallback.delete_remote_branch(request)
    }

    fn add_remote(&self, request: &AddRemoteRequest) -> GitResult<OperationResult> {
        self.cli_fallback.add_remote(request)
    }

    fn remove_remote(&self, request: &RemoveRemoteRequest) -> GitResult<OperationResult> {
        self.cli_fallback.remove_remote(request)
    }

    fn rename_remote(&self, request: &RenameRemoteRequest) -> GitResult<OperationResult> {
        self.cli_fallback.rename_remote(request)
    }

    fn set_remote_url(&self, request: &SetRemoteUrlRequest) -> GitResult<OperationResult> {
        self.cli_fallback.set_remote_url(request)
    }

    fn prune_remote(&self, request: &PruneRemoteRequest) -> GitResult<OperationResult> {
        self.cli_fallback.prune_remote(request)
    }

    fn conflict_accept_theirs(&self, request: &FileRequest) -> GitResult<OperationResult> {
        self.cli_fallback.conflict_accept_theirs(request)
    }

    fn conflict_accept_ours(&self, request: &FileRequest) -> GitResult<OperationResult> {
        self.cli_fallback.conflict_accept_ours(request)
    }

    fn open_merge_tool(&self, request: &FileRequest) -> GitResult<OperationResult> {
        self.cli_fallback.open_merge_tool(request)
    }
}
