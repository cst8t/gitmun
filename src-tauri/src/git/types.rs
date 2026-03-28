use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CommitDateMode {
    AuthorDate,
    CommitterDate,
}

impl Default for CommitDateMode {
    fn default() -> Self {
        Self::AuthorDate
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BackendMode {
    Default,
    GitCliOnly,
}

impl Default for BackendMode {
    fn default() -> Self {
        Self::Default
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExternalDiffTool {
    /// No known tool configured, or a tool Gitmun doesn't manage.
    Other,
    Meld,
    Kompare,
    WinMerge,
    VsCode,
    VsCodium,
}

impl Default for ExternalDiffTool {
    fn default() -> Self {
        Self::Other
    }
}

impl Default for ThemeMode {
    fn default() -> Self {
        Self::System
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AvatarProviderMode {
    Off,
    Libravatar,
}

impl Default for AvatarProviderMode {
    fn default() -> Self {
        Self::Libravatar
    }
}

/// Controls WebKit graphics workarounds on Linux. Takes effect on next launch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LinuxGraphicsMode {
    /// Disable DMA-BUF renderer and compositing (recommended for most systems).
    Auto,
    /// Also force X11 backend and software rendering - for systems where `Auto`
    /// still causes issues (e.g. Wayland without XWayland).
    Safe,
    /// No overrides - full hardware acceleration.
    Native,
}

impl Default for LinuxGraphicsMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub backend_mode: BackendMode,
    pub show_result_log: bool,
    pub theme_mode: ThemeMode,
    #[serde(default)]
    pub wrap_diff_lines: bool,
    pub left_pane_width: u32,
    pub right_pane_width: u32,
    #[serde(default = "Settings::default_confirm_revert")]
    pub confirm_revert: bool,
    #[serde(default)]
    pub avatar_provider: AvatarProviderMode,
    #[serde(
        default = "Settings::default_try_platform_first",
        alias = "tryGithubFirst"
    )]
    pub try_platform_first: bool,
    #[serde(default)]
    pub default_clone_dir: String,
    #[serde(default)]
    pub commit_date_mode: CommitDateMode,
    #[serde(default)]
    pub push_follow_tags: bool,
    #[serde(default = "Settings::default_auto_check_for_updates_on_launch")]
    pub auto_check_for_updates_on_launch: bool,
    #[serde(default)]
    pub auto_install_updates: bool,
    #[serde(default)]
    pub linux_graphics_mode: LinuxGraphicsMode,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            backend_mode: BackendMode::Default,
            show_result_log: false,
            theme_mode: ThemeMode::System,
            wrap_diff_lines: false,
            left_pane_width: 300,
            right_pane_width: 420,
            confirm_revert: true,
            avatar_provider: AvatarProviderMode::Libravatar,
            try_platform_first: true,
            default_clone_dir: String::new(),
            commit_date_mode: CommitDateMode::AuthorDate,
            push_follow_tags: false,
            auto_check_for_updates_on_launch: true,
            auto_install_updates: false,
            linux_graphics_mode: LinuxGraphicsMode::Auto,
        }
    }
}

impl Settings {
    fn default_confirm_revert() -> bool {
        true
    }

    fn default_try_platform_first() -> bool {
        true
    }

    fn default_auto_check_for_updates_on_launch() -> bool {
        true
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneRequest {
    pub repo_url: String,
    pub destination: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRequest {
    pub repo_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumstatRequest {
    pub repo_path: String,
    pub file_path: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageFilesRequest {
    pub repo_path: String,
    pub files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistoryRequest {
    pub repo_path: String,
    pub limit: Option<usize>,
    /// Hash of the last commit from the previous page. The gix path uses this
    /// to start the walk from that commit's parents rather than skipping from
    /// HEAD, keeping each page O(limit) instead of O(offset + limit).
    /// The CLI fallback uses `offset` as a skip count (fast enough via git).
    pub after_hash: Option<String>,
    pub offset: Option<usize>,
    #[serde(default)]
    pub commit_date_mode: CommitDateMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFilesRequest {
    pub repo_path: String,
    pub commit_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDiffRequest {
    pub repo_path: String,
    pub commit_hash: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    pub repo_path: String,
    pub message: String,
    pub amend: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub message: String,
    pub output: Option<String>,
    pub repo_path: Option<String>,
    pub backend_used: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NumstatResult {
    pub file_path: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStatusItem {
    pub path: String,
    pub status: String,
    pub additions: Option<u32>,
    pub deletions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFileItem {
    pub path: String,
    /// One of: "both_modified", "added_by_us", "added_by_them",
    /// "deleted_by_us", "deleted_by_them", "both_added", "both_deleted"
    pub conflict_type: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub changed_files: Vec<FileStatusItem>,
    pub staged_files: Vec<FileStatusItem>,
    pub unversioned_files: Vec<String>,
    pub current_branch: Option<String>,
    /// True when the repo is in a merge state (.git/MERGE_HEAD exists).
    pub merge_in_progress: bool,
    /// The branch being merged (parsed from MERGE_MSG or MERGE_HEAD).
    pub merge_head_branch: Option<String>,
    /// Files with unresolved conflicts.
    pub conflicted_files: Vec<ConflictFileItem>,
    /// Contents of .git/MERGE_MSG (pre-populated commit message for merge commits).
    pub merge_message: Option<String>,
    /// True when the repo is in a rebase state (.git/rebase-merge or .git/rebase-apply exists).
    pub rebase_in_progress: bool,
    /// The rebase target (resolved from rebase metadata).
    pub rebase_onto: Option<String>,
    /// True when the repo is in a cherry-pick state (.git/CHERRY_PICK_HEAD exists).
    pub cherry_pick_in_progress: bool,
    /// The commit currently being cherry-picked (short hash when available).
    pub cherry_pick_head: Option<String>,
    /// True when the repo is in a revert state (.git/REVERT_HEAD exists).
    pub revert_in_progress: bool,
    /// The commit being reverted (short hash when available).
    pub revert_head: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeRequest {
    pub repo_path: String,
    pub branch_name: String,
    /// When true, always create a merge commit even for fast-forward merges.
    pub no_ff: Option<bool>,
    /// When true, only fast-forward (fail if not possible).
    pub ff_only: Option<bool>,
    /// Optional custom commit message for the merge commit.
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub message: String,
    pub output: Option<String>,
    pub repo_path: Option<String>,
    pub backend_used: String,
    /// True if the merge completed cleanly (fast-forward or auto-merge).
    pub success: bool,
    /// True if there are conflicts that require manual resolution.
    pub has_conflicts: bool,
    /// List of files with conflicts (empty if no conflicts).
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseRequest {
    pub repo_path: String,
    pub onto: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebaseResult {
    pub message: String,
    pub output: Option<String>,
    pub repo_path: Option<String>,
    pub backend_used: String,
    pub success: bool,
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickRequest {
    pub repo_path: String,
    pub commit_hash: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CherryPickResult {
    pub message: String,
    pub output: Option<String>,
    pub repo_path: Option<String>,
    pub backend_used: String,
    pub success: bool,
    pub has_conflicts: bool,
    pub conflicted_files: Vec<String>,
}

/// Whether the commit carries a cryptographic signature and, if so, whether
/// we were able to verify it against the local keyring / allowedSignersFile.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum SignatureStatus {
    /// No gpgsig header present.
    None,
    /// gpgsig header present but we have not attempted verification yet
    /// (fast path from gix - no subprocess cost).
    Signed,
    /// Signature cryptographically valid (G / U / X / Y / R from git %G?).
    Verified,
    /// Signature present but key is not in the local keyring (E).
    UnknownKey,
    /// Signature is cryptographically bad (B).
    Bad,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitHistoryItem {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub author_email: String,
    pub date: String,
    pub message: String,
    pub signature_status: SignatureStatus,
    /// "ssh" or "gpg", detected from the raw signature header.
    pub key_type: Option<String>,
}

/// Result of verifying a single commit's signature.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitVerification {
    pub hash: String,
    pub status: SignatureStatus,
    pub signer: Option<String>,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitMarkers {
    pub local_head: Option<String>,
    pub upstream_head: Option<String>,
    pub upstream_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitFileItem {
    pub path: String,
    pub status: String,
}

// Diff types
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub file_path: String,
    pub hunks: Vec<DiffHunk>,
    pub is_binary: bool,
    pub line_ending: LineEndingStyle,
    pub detected_file_type: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LineEndingStyle {
    Lf,
    Crlf,
    Mixed,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub content: String,
    pub old_line_no: Option<u32>,
    pub new_line_no: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiffLineKind {
    Add,
    Remove,
    Context,
}

// Branch info
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
}

// Identity
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitIdentity {
    pub name: Option<String>,
    pub email: Option<String>,
    pub signing_key: Option<String>,
    pub signing_format: Option<String>,
    pub ssh_key_path: Option<String>,
    pub commit_signing_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum IdentityScope {
    #[serde(rename = "Local", alias = "local")]
    Local,
    #[serde(rename = "Global", alias = "global")]
    Global,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetIdentityRequest {
    pub repo_path: String,
    pub scope: IdentityScope,
    pub name: Option<String>,
    pub email: Option<String>,
    pub signing_key: Option<String>,
    pub signing_format: Option<String>,
    pub ssh_key_path: Option<String>,
    pub commit_signing_enabled: Option<bool>,
}

// Tags
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub hash: String,
    pub message: Option<String>,
}

// Remotes
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

// Request types
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffRequest {
    pub repo_path: String,
    pub file_path: String,
    pub staged: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRequest {
    pub repo_path: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkStageRequest {
    pub repo_path: String,
    pub file_path: String,
    pub hunk_index: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityRequest {
    pub repo_path: String,
    pub scope: IdentityScope,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchRequest {
    pub repo_path: String,
    pub remote: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRequest {
    pub repo_path: String,
    pub force: bool,
    #[serde(default)]
    pub push_follow_tags: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchRequest {
    pub repo_path: String,
    pub branch_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBranchRequest {
    pub repo_path: String,
    pub branch_name: String,
    /// Base branch, tag, or commit to create from. Defaults to HEAD if None.
    pub base_ref: Option<String>,
    /// Whether to checkout the new branch after creation. Defaults to false if None.
    pub checkout_after_creation: Option<bool>,
    /// Whether to set up tracking relationship with remote. Defaults to false if None.
    pub track_remote: Option<bool>,
    /// When true, name the new branch to match the tracking branch name (strip the remote prefix).
    /// e.g. creating from "origin/feature/foo" → branch name "feature/foo". Defaults to false if None.
    pub match_tracking_branch: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteBranchRequest {
    pub repo_path: String,
    pub branch_name: String,
    /// When true, force-delete even if unmerged (git branch -D). Defaults to false.
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameBranchRequest {
    pub repo_path: String,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRemoteBranchRequest {
    pub repo_path: String,
    pub remote: String,
    pub branch: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddRemoteRequest {
    pub repo_path: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRemoteRequest {
    pub repo_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRemoteRequest {
    pub repo_path: String,
    pub old_name: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetRemoteUrlRequest {
    pub repo_path: String,
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PruneRemoteRequest {
    pub repo_path: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTagRequest {
    pub repo_path: String,
    pub tag_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTagRequest {
    pub repo_path: String,
    pub tag_name: String,
    pub message: Option<String>,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushTagRequest {
    pub repo_path: String,
    pub remote: String,
    pub tag_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertCommitRequest {
    pub repo_path: String,
    pub commit_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteRemoteTagRequest {
    pub repo_path: String,
    pub remote: String,
    pub tag_name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub short_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashRequest {
    pub repo_path: String,
    pub stash_index: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashPushRequest {
    pub repo_path: String,
    pub message: Option<String>,
    pub include_untracked: bool,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetMode {
    Soft,
    Mixed,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetRequest {
    pub repo_path: String,
    pub target: String,
    pub mode: ResetMode,
}
