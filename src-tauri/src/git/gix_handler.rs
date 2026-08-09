use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::{collections::HashMap, collections::HashSet};

use super::cli::CliGitHandler;
use super::error::{GitError, GitResult};
use super::error_interpretation::interpret_gix_error;
use super::handler::GitOperationHandler;
use super::types::{
    AddRemoteRequest, BranchInfo, BranchRequest, CherryPickRequest, CherryPickResult, CloneRequest,
    CommitDateMode, CommitDetails, CommitDetailsRequest, CommitFileItem, CommitFilesRequest,
    CommitHistoryItem, CommitHistoryRequest, CommitLogScope, CommitMarkers, CommitMessageRecovery,
    CommitRefDecoration, CommitRefKind, CommitRequest, ConflictFileItem, CreateBranchRequest,
    CreateTagRequest, DeleteBranchRequest, DeleteRemoteBranchRequest, DeleteRemoteTagRequest,
    DeleteTagRequest, DiffRequest, ExportCommitPatchRequest, ExportPatchRequest,
    ExternalDiffRequest, FetchRequest, FileDiff, FileRequest, FileStatusItem, GitIdentity,
    HunkStageRequest, IdentityRequest, ImportPatchRequest, MergeRequest, MergeResult,
    NumstatRequest, NumstatResult, OperationResult, PruneRemoteRequest, PullAnalysis,
    PullStrategyRequest, PushRequest, PushResult, PushTagRequest, RebaseRequest, RebaseResult,
    RemoteInfo, RemoveRemoteRequest, RenameBranchRequest, RenameRemoteRequest, RepoRequest,
    RepoStatus, ResetRequest, RevertCommitRequest, SetBranchUpstreamRequest, SetIdentityRequest,
    SetRemoteUrlRequest, SignatureStatus, SshAllowedSignerStatus, StageFilesRequest, StashEntry,
    StashPushRequest, StashRequest, SubmoduleActionRequest, TagInfo, UpstreamStatus,
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

        gix::discover(path).map_err(|error| Self::gix_error(None, error))?;
        Ok(())
    }

    fn discover_repo_root(&self, repo_path: &str) -> GitResult<String> {
        let path = Path::new(repo_path.trim());
        let repo = gix::discover(path).map_err(|error| Self::gix_error(None, error))?;
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

    fn collapse_unversioned_path(repo_path: &Path, path: &str, tracked_paths: &[String]) -> String {
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        if parts.len() <= 1 {
            return if repo_path.join(path).is_dir() && !path.ends_with('/') {
                format!("{path}/")
            } else {
                path.to_string()
            };
        }

        for index in 0..parts.len() - 1 {
            let candidate = parts[..=index].join("/");
            let has_tracked_descendant = tracked_paths.iter().any(|tracked_path| {
                tracked_path == &candidate
                    || tracked_path
                        .strip_prefix(&candidate)
                        .map(|rest| rest.starts_with('/'))
                        .unwrap_or(false)
            });
            if repo_path.join(&candidate).is_dir() && !has_tracked_descendant {
                return format!("{candidate}/");
            }
        }

        path.to_string()
    }

    fn mailmap_identity(
        mailmap: &gix::mailmap::Snapshot,
        signature: gix::actor::SignatureRef<'_>,
    ) -> (String, String) {
        let resolved = mailmap.resolve_cow(signature);
        (
            Self::bstr_to_string(resolved.name.as_ref()),
            Self::bstr_to_string(resolved.email.as_ref()),
        )
    }

    fn gix_error<E>(operation: Option<&str>, error: E) -> GitError
    where
        E: std::error::Error + 'static,
    {
        let interpreted = interpret_gix_error(operation, &error);
        GitError::GixError {
            message: error.to_string(),
            interpreted: Some(interpreted),
        }
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

    fn conflict_type(conflict: gix::status::plumbing::index_as_worktree::Conflict) -> &'static str {
        use gix::status::plumbing::index_as_worktree::Conflict;

        match conflict {
            Conflict::BothDeleted => "both_deleted",
            Conflict::AddedByUs => "added_by_us",
            Conflict::DeletedByThem => "deleted_by_them",
            Conflict::AddedByThem => "added_by_them",
            Conflict::DeletedByUs => "deleted_by_us",
            Conflict::BothAdded => "both_added",
            Conflict::BothModified => "both_modified",
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
        let refs = repo.references().map_err(|e| Self::gix_error(None, e))?;

        let mut branches = Vec::new();

        let local_iter = refs
            .local_branches()
            .map_err(|e| Self::gix_error(None, e))?;

        for reference in local_iter {
            let reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
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
            let (upstream_status, ahead, behind) = if let Some(ref upstream_name) = upstream {
                let local_oid = reference.id().detach();
                let remote_ref_name = format!("refs/remotes/{}", upstream_name);
                match repo.find_reference(remote_ref_name.as_str()) {
                    Ok(remote_ref) => {
                        let remote_oid = remote_ref.id().detach();
                        if local_oid == remote_oid {
                            (UpstreamStatus::Tracked, 0, 0)
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
                            (UpstreamStatus::Tracked, ahead, behind)
                        }
                    }
                    Err(_) => (UpstreamStatus::Missing, 0, 0),
                }
            } else {
                (UpstreamStatus::None, 0, 0)
            };

            branches.push(BranchInfo {
                name: short_name,
                is_current,
                is_remote: false,
                upstream,
                upstream_status,
                ahead,
                behind,
            });
        }

        let remote_iter = refs
            .remote_branches()
            .map_err(|e| Self::gix_error(None, e))?;

        for reference in remote_iter {
            let reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
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
                upstream_status: UpstreamStatus::None,
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
        let refs = repo.references().map_err(|e| Self::gix_error(None, e))?;
        let tag_iter = refs.tags().map_err(|e| Self::gix_error(None, e))?;

        let mut matching = Vec::new();
        for reference in tag_iter {
            let reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
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

    fn collect_commit_ref_decorations_with_gix(
        repo: &gix::Repository,
    ) -> GitResult<HashMap<String, Vec<CommitRefDecoration>>> {
        let mut decorations = HashMap::new();

        let refs = repo.references().map_err(|e| Self::gix_error(None, e))?;
        let local_iter = refs
            .local_branches()
            .map_err(|e| Self::gix_error(None, e))?;
        for reference in local_iter {
            let reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
            let hash = reference.id().detach().to_hex().to_string();
            let name = Self::bstr_to_string(reference.name().shorten());
            Self::push_commit_ref_decoration(
                &mut decorations,
                hash,
                CommitRefDecoration {
                    name,
                    kind: CommitRefKind::LocalBranch,
                },
            );
        }

        let refs = repo.references().map_err(|e| Self::gix_error(None, e))?;
        let remote_iter = refs
            .remote_branches()
            .map_err(|e| Self::gix_error(None, e))?;
        for reference in remote_iter {
            let reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
            let name = Self::bstr_to_string(reference.name().shorten());
            if name.ends_with("/HEAD") {
                continue;
            }
            let hash = reference.id().detach().to_hex().to_string();
            Self::push_commit_ref_decoration(
                &mut decorations,
                hash,
                CommitRefDecoration {
                    name,
                    kind: CommitRefKind::RemoteBranch,
                },
            );
        }

        let refs = repo.references().map_err(|e| Self::gix_error(None, e))?;
        let tag_iter = refs.tags().map_err(|e| Self::gix_error(None, e))?;
        for reference in tag_iter {
            let reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
            let raw_oid = reference.id().detach();
            let hash = repo
                .find_object(raw_oid)
                .ok()
                .and_then(|obj| obj.peel_to_kind(gix::object::Kind::Commit).ok())
                .map(|obj| obj.id.to_hex().to_string())
                .unwrap_or_else(|| raw_oid.to_hex().to_string());
            let name = Self::bstr_to_string(reference.name().shorten());
            Self::push_commit_ref_decoration(
                &mut decorations,
                hash,
                CommitRefDecoration {
                    name,
                    kind: CommitRefKind::Tag,
                },
            );
        }

        for refs in decorations.values_mut() {
            Self::sort_commit_ref_decorations(refs);
        }

        Ok(decorations)
    }

    fn push_commit_ref_decoration(
        decorations: &mut HashMap<String, Vec<CommitRefDecoration>>,
        hash: String,
        decoration: CommitRefDecoration,
    ) {
        let refs = decorations.entry(hash).or_default();
        if !refs.contains(&decoration) {
            refs.push(decoration);
        }
    }

    fn sort_commit_ref_decorations(refs: &mut [CommitRefDecoration]) {
        refs.sort_by(|a, b| {
            Self::commit_ref_kind_order(&a.kind)
                .cmp(&Self::commit_ref_kind_order(&b.kind))
                .then_with(|| a.name.cmp(&b.name))
        });
    }

    fn commit_ref_kind_order(kind: &CommitRefKind) -> u8 {
        match kind {
            CommitRefKind::LocalBranch => 0,
            CommitRefKind::RemoteBranch => 1,
            CommitRefKind::Tag => 2,
        }
    }

    fn collect_tags_with_gix(repo: &gix::Repository) -> GitResult<Vec<TagInfo>> {
        let refs = repo.references().map_err(|e| Self::gix_error(None, e))?;

        let tag_iter = refs.tags().map_err(|e| Self::gix_error(None, e))?;

        let mut tags = Vec::new();

        for reference in tag_iter {
            let mut reference = reference.map_err(|e| GitError::GixError {
                message: e.to_string(),
                interpreted: None,
            })?;
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
                .map_err(|e| Self::gix_error(None, e))?;

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
                    let normalised = value.trim().to_ascii_lowercase();
                    matches!(normalised.as_str(), "true" | "yes" | "on" | "1")
                })
                .unwrap_or(false),
        })
    }

    fn collect_commit_history_with_gix(
        repo: &gix::Repository,
        limit: usize,
        offset: usize,
        commit_date_mode: &CommitDateMode,
    ) -> GitResult<Vec<CommitHistoryItem>> {
        let start_id = match repo.head_id() {
            Ok(id) => id.detach(),
            Err(_) => return Ok(Vec::new()),
        };

        let walk = repo
            .rev_walk([start_id])
            .sorting(gix::revision::walk::Sorting::ByCommitTime(
                Default::default(),
            ))
            .all()
            .map_err(|e| Self::gix_error(None, e))?;

        let mut commits = Vec::with_capacity(limit.min(256));
        let mailmap = repo.open_mailmap();
        let mut ref_decorations =
            Self::collect_commit_ref_decorations_with_gix(repo).unwrap_or_default();

        for info in walk.skip(offset).take(limit) {
            let info = info.map_err(|e| Self::gix_error(None, e))?;
            let parent_hashes = info
                .parent_ids()
                .map(|id| id.detach().to_hex().to_string())
                .collect();
            let oid = info.id();
            let commit = repo
                .find_object(oid)
                .map_err(|e| Self::gix_error(None, e))?
                .try_into_commit()
                .map_err(|e| Self::gix_error(None, e))?;

            // Full hex hash
            let hash = oid.to_hex().to_string();

            let short_hash = hash.chars().take(7).collect::<String>();

            // Author name and email from the author signature
            let author_sig = commit.author().map_err(|e| Self::gix_error(None, e))?;
            let (author, author_email) = Self::mailmap_identity(&mailmap, author_sig);
            // Date from author or committer signature depending on the setting
            let date_time = match commit_date_mode {
                CommitDateMode::AuthorDate => author_sig.time,
                CommitDateMode::CommitterDate => {
                    commit
                        .committer()
                        .map_err(|e| Self::gix_error(None, e))?
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
            let decoded = commit.decode().map_err(|e| Self::gix_error(None, e))?;
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
            let commit_ref_decorations = ref_decorations.remove(&hash).unwrap_or_default();

            commits.push(CommitHistoryItem {
                hash,
                short_hash,
                author,
                author_email,
                date,
                message,
                parent_hashes,
                ref_decorations: commit_ref_decorations,
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
        command.env("GIT_OPTIONAL_LOCKS", "0");
        if staged {
            command
                .arg("-c")
                .arg("core.quotepath=false")
                .args(["diff", "--cached"]);
        } else {
            command
                .arg("-c")
                .arg("core.quotepath=false")
                .arg("diff-files");
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
        let mut dirty_submodule_paths: HashSet<String> = HashSet::new();
        let mut gix_conflicted_files = Vec::new();
        let repo_path = repo.workdir().unwrap_or(repo.path());
        let tracked_paths: Vec<String> = repo
            .index()
            .map(|index| {
                index
                    .entries()
                    .iter()
                    .map(|entry| Self::bstr_to_string(entry.path(&index)))
                    .collect()
            })
            .unwrap_or_default();

        let mut status_iter = repo
            .status(gix::progress::Discard)
            .map_err(|error| Self::gix_error(None, error))?
            .index_worktree_submodules(gix::status::Submodule::Given {
                ignore: gix::submodule::config::Ignore::None,
                check_dirty: false,
            })
            .into_iter(Vec::<gix::bstr::BString>::new())
            .map_err(|error| Self::gix_error(None, error))?;

        while let Some(next_item) = status_iter.next() {
            let item = next_item.map_err(|error| Self::gix_error(None, error))?;

            match item {
                gix::status::Item::IndexWorktree(worktree_item) => {
                    if let gix::status::index_worktree::Item::Modification {
                        rela_path,
                        status,
                        ..
                    } = &worktree_item
                    {
                        use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};

                        match status {
                            EntryStatus::Conflict { summary, .. } => {
                                gix_conflicted_files.push(ConflictFileItem {
                                    path: Self::bstr_to_string(rela_path.as_ref()),
                                    conflict_type: Self::conflict_type(*summary).to_string(),
                                });
                            }
                            EntryStatus::Change(Change::SubmoduleModification(status))
                                if status
                                    .changes
                                    .as_ref()
                                    .is_some_and(|changes| !changes.is_empty()) =>
                            {
                                dirty_submodule_paths
                                    .insert(Self::bstr_to_string(rela_path.as_ref()));
                            }
                            _ => {}
                        }
                    }

                    if let gix::status::index_worktree::Item::DirectoryContents { entry, .. } =
                        &worktree_item
                    {
                        if matches!(entry.status, gix::dir::entry::Status::Untracked) {
                            let path = Self::bstr_to_string(entry.rela_path.as_ref());
                            unversioned_paths.insert(Self::collapse_unversioned_path(
                                repo_path,
                                &path,
                                &tracked_paths,
                            ));
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
        gix_conflicted_files.sort_by(|left, right| left.path.cmp(&right.path));

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
            gix_conflicted_files
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

        let mut status = RepoStatus {
            changed_files,
            staged_files,
            unversioned_files,
            unversioned_items: vec![],
            submodules: CliGitHandler::collect_submodules_for_status(
                repo_path,
                Some(&dirty_submodule_paths),
            ),
            current_branch: Self::current_branch(repo),
            detached_head: matches!(repo.head_name(), Ok(None)),
            shallow: CliGitHandler::repo_is_shallow(repo_path),
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
        };
        CliGitHandler::refresh_unversioned_items(&mut status, repo_path);
        CliGitHandler::remove_submodule_file_entries(&mut status);
        Ok(status)
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
            interpreted_error: None,
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
            .map_err(|error| Self::gix_error(None, error))?;
        let (mut checkout, _) = prepare
            .fetch_then_checkout(gix::progress::Discard, &should_interrupt)
            .map_err(|error| Self::gix_error(None, error))?;
        checkout
            .main_worktree(gix::progress::Discard, &should_interrupt)
            .map_err(|error| Self::gix_error(None, error))?;

        Ok(OperationResult {
            message: format!("Cloned repository to {}", final_destination.display()),
            output: Some("Clone completed using gix".to_string()),
            repo_path: Some(final_destination_str),
            backend_used: "gix".to_string(),
            interpreted_error: None,
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

    fn set_branch_upstream(
        &self,
        request: &SetBranchUpstreamRequest,
    ) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .set_branch_upstream(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn commit_changes(&self, request: &CommitRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .commit_changes(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_commit_message_recovery(
        &self,
        request: &RepoRequest,
    ) -> GitResult<Option<CommitMessageRecovery>> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.get_commit_message_recovery(request)
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

    fn check_patch_file(&self, request: &ImportPatchRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .check_patch_file(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn import_patch_file(&self, request: &ImportPatchRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .import_patch_file(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn export_patch_file(&self, request: &ExportPatchRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .export_patch_file(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn export_commit_patch_file(
        &self,
        request: &ExportCommitPatchRequest,
    ) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .export_commit_patch_file(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_repo_status(&self, request: &RepoRequest) -> GitResult<RepoStatus> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|error| Self::gix_error(None, error));

        match repo.and_then(|repository| Self::collect_repo_status_with_gix(&repository)) {
            Ok(status) => Ok(status),
            Err(_) => self.cli_fallback.get_repo_status(request),
        }
    }

    fn get_commit_history(
        &self,
        request: &CommitHistoryRequest,
    ) -> GitResult<Vec<CommitHistoryItem>> {
        if request.topo_order || request.scope == CommitLogScope::AllRefs {
            return self.cli_fallback.get_commit_history(request);
        }

        let repo_path = Path::new(request.repo_path.trim());
        let limit = request.limit.unwrap_or(100).clamp(1, 5000);
        let offset = request.offset.unwrap_or(0);
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e));
        match repo.and_then(|r| {
            Self::collect_commit_history_with_gix(&r, limit, offset, &request.commit_date_mode)
        }) {
            Ok(history) => Ok(history),
            Err(_) => self.cli_fallback.get_commit_history(request),
        }
    }

    fn get_commit_markers(&self, request: &RepoRequest) -> GitResult<CommitMarkers> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e));
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
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e))?;

        let oid = gix::ObjectId::from_hex(request.commit_hash.trim().as_bytes())
            .map_err(|e| Self::gix_error(None, e))?;

        let commit = repo
            .find_object(oid)
            .map_err(|e| Self::gix_error(None, e))?
            .try_into_commit()
            .map_err(|e| Self::gix_error(None, e))?;

        let author_sig = commit.author().map_err(|e| Self::gix_error(None, e))?;
        let mailmap = repo.open_mailmap();
        let (author, author_email) = Self::mailmap_identity(&mailmap, author_sig);
        let author_date = gix::date::parse_header(author_sig.time)
            .and_then(|t: gix::date::Time| t.format(gix::date::time::format::ISO8601_STRICT).ok())
            .unwrap_or_else(|| author_sig.time.to_string());

        let committer_sig = commit.committer().map_err(|e| Self::gix_error(None, e))?;
        let (committer, committer_email) = Self::mailmap_identity(&mailmap, committer_sig);
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
        let processed_body = super::commit_message::process_commit_body(&body);

        let tags = Self::collect_commit_tags(&repo, &oid)?;

        Ok(CommitDetails {
            hash: oid.to_hex().to_string(),
            author,
            author_email,
            author_date,
            committer,
            committer_email,
            committer_date,
            body: processed_body.body,
            parent_hashes,
            tags,
            trailers: processed_body.trailers,
        })
    }

    fn get_diff(&self, request: &DiffRequest) -> GitResult<FileDiff> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.get_diff(request)
    }

    fn get_branches(&self, request: &RepoRequest) -> GitResult<Vec<BranchInfo>> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e));
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

    fn submodule_init(&self, request: &SubmoduleActionRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .submodule_init(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn submodule_update(&self, request: &SubmoduleActionRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .submodule_update(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn submodule_sync(&self, request: &SubmoduleActionRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .submodule_sync(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn submodule_fetch(&self, request: &SubmoduleActionRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .submodule_fetch(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn submodule_pull(&self, request: &SubmoduleActionRequest) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .submodule_pull(request)
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
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e));
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

    fn get_ssh_allowed_signer_status(
        &self,
        request: &IdentityRequest,
    ) -> GitResult<SshAllowedSignerStatus> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback.get_ssh_allowed_signer_status(request)
    }

    fn add_ssh_signing_key_to_allowed_signers(
        &self,
        request: &IdentityRequest,
    ) -> GitResult<OperationResult> {
        self.validate_repo_with_gix(&request.repo_path)?;
        self.cli_fallback
            .add_ssh_signing_key_to_allowed_signers(request)
            .map(Self::with_cli_fallback_backend)
    }

    fn get_tags(&self, request: &RepoRequest) -> GitResult<Vec<TagInfo>> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e));
        match repo.and_then(|r| Self::collect_tags_with_gix(&r)) {
            Ok(tags) => Ok(tags),
            Err(_) => self.cli_fallback.get_tags(request),
        }
    }

    fn get_remotes(&self, request: &RepoRequest) -> GitResult<Vec<RemoteInfo>> {
        let repo_path = Path::new(request.repo_path.trim());
        let repo = gix::discover(repo_path).map_err(|e| Self::gix_error(None, e));
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

#[cfg(test)]
mod tests {
    use super::GixGitHandler;
    use crate::git::types::SubmoduleState;
    use gix::status::plumbing::index_as_worktree::Conflict;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use tempfile::TempDir;

    fn run_git(repo: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(repo)
            .status()
            .expect("run git");
        assert!(status.success(), "git {args:?} failed");
    }

    fn init_repo() -> TempDir {
        let repo = TempDir::new().expect("create temporary repository");
        run_git(repo.path(), &["init", "-b", "main"]);
        run_git(repo.path(), &["config", "user.email", "test@gitmun.test"]);
        run_git(repo.path(), &["config", "user.name", "Gitmun Test"]);
        run_git(repo.path(), &["config", "commit.gpgsign", "false"]);
        run_git(repo.path(), &["config", "core.autocrlf", "false"]);
        run_git(repo.path(), &["commit", "--allow-empty", "-m", "initial"]);
        repo
    }

    fn make_index_entry_stale(repo: &Path, file_path: &str) -> (PathBuf, Vec<u8>) {
        let output = Command::new("git")
            .args(["rev-parse", "--git-path", "index"])
            .current_dir(repo)
            .output()
            .expect("resolve index path");
        assert!(output.status.success(), "resolve index path");
        let raw_index_path =
            String::from_utf8(output.stdout).expect("index path should be valid UTF-8");
        let index_path = {
            let path = PathBuf::from(raw_index_path.trim());
            if path.is_absolute() {
                path
            } else {
                repo.join(path)
            }
        };
        let index_before = fs::read(&index_path).expect("read index");
        let tracked_file = fs::OpenOptions::new()
            .write(true)
            .open(repo.join(file_path))
            .expect("open tracked file");
        tracked_file
            .set_times(
                fs::FileTimes::new()
                    .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1)),
            )
            .expect("set tracked file timestamp");
        (index_path, index_before)
    }

    #[test]
    fn maps_all_conflict_types() {
        let cases = [
            (Conflict::BothDeleted, "both_deleted"),
            (Conflict::AddedByUs, "added_by_us"),
            (Conflict::DeletedByThem, "deleted_by_them"),
            (Conflict::AddedByThem, "added_by_them"),
            (Conflict::DeletedByUs, "deleted_by_us"),
            (Conflict::BothAdded, "both_added"),
            (Conflict::BothModified, "both_modified"),
        ];

        for (conflict, expected) in cases {
            assert_eq!(GixGitHandler::conflict_type(conflict), expected);
        }
    }

    #[test]
    fn gix_collector_reads_conflicts_without_rewriting_index() {
        let repo_dir = init_repo();
        fs::write(repo_dir.path().join("calibration-report.txt"), "baseline\n")
            .expect("write calibration report");
        fs::write(repo_dir.path().join("inspection-record.txt"), "stable\n")
            .expect("write inspection record");
        run_git(
            repo_dir.path(),
            &["add", "calibration-report.txt", "inspection-record.txt"],
        );
        run_git(
            repo_dir.path(),
            &["commit", "-m", "add calibration records"],
        );
        run_git(repo_dir.path(), &["switch", "-c", "recalibrate"]);
        fs::write(
            repo_dir.path().join("calibration-report.txt"),
            "branch reading\n",
        )
        .expect("write branch reading");
        run_git(repo_dir.path(), &["commit", "-am", "record branch reading"]);
        run_git(repo_dir.path(), &["switch", "main"]);
        fs::write(
            repo_dir.path().join("calibration-report.txt"),
            "main reading\n",
        )
        .expect("write main reading");
        run_git(repo_dir.path(), &["commit", "-am", "record main reading"]);

        let merge_status = Command::new("git")
            .args(["merge", "recalibrate"])
            .current_dir(repo_dir.path())
            .status()
            .expect("run git merge");
        assert!(!merge_status.success(), "merge should produce a conflict");
        let (index_path, index_before) =
            make_index_entry_stale(repo_dir.path(), "inspection-record.txt");

        let repo = gix::discover(repo_dir.path()).expect("discover repository");
        let status =
            GixGitHandler::collect_repo_status_with_gix(&repo).expect("collect gix status");

        assert!(status.merge_in_progress);
        assert_eq!(status.conflicted_files.len(), 1);
        assert_eq!(status.conflicted_files[0].path, "calibration-report.txt");
        assert_eq!(status.conflicted_files[0].conflict_type, "both_modified");
        assert_eq!(
            fs::read(&index_path).expect("read index after status"),
            index_before
        );
        assert!(!index_path.with_file_name("index.lock").exists());
    }

    #[test]
    fn gix_collector_reads_dirty_submodule_without_rewriting_index() {
        let source = init_repo();
        fs::write(source.path().join("lib.txt"), "v1").expect("write library file");
        run_git(source.path(), &["add", "lib.txt"]);
        run_git(source.path(), &["commit", "-m", "add library file"]);

        let parent = init_repo();
        run_git(
            parent.path(),
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source.path().to_str().expect("source path"),
                "deps/lib",
            ],
        );
        run_git(parent.path(), &["commit", "-m", "add submodule"]);

        let submodule_path = parent.path().join("deps/lib");
        let (index_path, index_before) = make_index_entry_stale(&submodule_path, "lib.txt");
        fs::write(submodule_path.join("field-notes.txt"), "untracked")
            .expect("write untracked submodule file");

        let repo = gix::discover(parent.path()).expect("discover repository");
        let status =
            GixGitHandler::collect_repo_status_with_gix(&repo).expect("collect gix status");

        assert_eq!(status.submodules.len(), 1);
        assert_eq!(status.submodules[0].path, "deps/lib");
        assert_eq!(status.submodules[0].state, SubmoduleState::Dirty);
        assert!(status.submodules[0].dirty);
        assert_eq!(
            fs::read(&index_path).expect("read submodule index after status"),
            index_before
        );
        assert!(!index_path.with_file_name("index.lock").exists());
    }
}
