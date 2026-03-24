use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use super::cli::CliGitHandler;
use super::error::GitResult;
use super::gix_handler::GixGitHandler;
use super::types::{
    AddRemoteRequest, BackendMode, BranchInfo, BranchRequest, CherryPickRequest, CherryPickResult,
    CloneRequest, CommitDateMode, CommitFileItem, CommitFilesRequest, CommitHistoryItem,
    CommitHistoryRequest, CommitMarkers, CommitRequest, CreateBranchRequest, CreateTagRequest,
    DeleteBranchRequest, DeleteRemoteBranchRequest, DeleteRemoteTagRequest, DeleteTagRequest,
    DiffRequest, ExternalDiffRequest, FetchRequest, FileDiff, FileRequest, GitIdentity,
    HunkStageRequest, IdentityRequest, MergeRequest, MergeResult, NumstatRequest, NumstatResult,
    OperationResult, PruneRemoteRequest, PushRequest, PushTagRequest, RebaseRequest, RebaseResult,
    RemoteInfo, RemoveRemoteRequest, RenameBranchRequest, RenameRemoteRequest, RepoRequest,
    RepoStatus, ResetRequest, RevertCommitRequest, SetIdentityRequest, SetRemoteUrlRequest,
    Settings, StageFilesRequest, StashEntry, StashPushRequest, StashRequest, TagInfo, ThemeMode,
};

pub trait GitOperationHandler: Send + Sync {
    fn validate_repo_path(&self, repo_path: &str) -> GitResult<OperationResult>;
    fn get_numstat(&self, request: &NumstatRequest) -> GitResult<NumstatResult>;
    #[allow(dead_code)]
    fn clone_repo(&self, request: &CloneRequest) -> GitResult<OperationResult>;
    fn pull_changes(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn push_changes(&self, request: &PushRequest) -> GitResult<OperationResult>;
    fn commit_changes(&self, request: &CommitRequest) -> GitResult<OperationResult>;
    fn stage_files(&self, request: &StageFilesRequest) -> GitResult<OperationResult>;
    fn get_configured_diff_tool(&self, request: &RepoRequest) -> GitResult<Option<String>>;
    fn open_external_diff(&self, request: &ExternalDiffRequest) -> GitResult<OperationResult>;
    fn open_working_tree_diff(&self, request: &DiffRequest) -> GitResult<OperationResult>;
    fn get_repo_status(&self, request: &RepoRequest) -> GitResult<RepoStatus>;
    fn get_commit_history(
        &self,
        request: &CommitHistoryRequest,
    ) -> GitResult<Vec<CommitHistoryItem>>;
    fn get_commit_markers(&self, request: &RepoRequest) -> GitResult<CommitMarkers>;
    fn get_commit_files(&self, request: &CommitFilesRequest) -> GitResult<Vec<CommitFileItem>>;
    fn get_diff(&self, request: &DiffRequest) -> GitResult<FileDiff>;
    fn get_branches(&self, request: &RepoRequest) -> GitResult<Vec<BranchInfo>>;
    fn create_branch(&self, request: &CreateBranchRequest) -> GitResult<OperationResult>;
    fn unstage_file(&self, request: &FileRequest) -> GitResult<OperationResult>;
    fn unstage_all(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn stage_all(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn stage_hunk(&self, request: &HunkStageRequest) -> GitResult<OperationResult>;
    fn discard_file(&self, request: &FileRequest) -> GitResult<OperationResult>;
    fn fetch_remote(&self, request: &FetchRequest) -> GitResult<OperationResult>;
    fn stash(&self, request: &StashPushRequest) -> GitResult<OperationResult>;
    fn stash_list(&self, request: &RepoRequest) -> GitResult<Vec<StashEntry>>;
    fn stash_apply(&self, request: &StashRequest) -> GitResult<OperationResult>;
    fn stash_pop(&self, request: &StashRequest) -> GitResult<OperationResult>;
    fn stash_drop(&self, request: &StashRequest) -> GitResult<OperationResult>;
    fn get_identity(&self, request: &IdentityRequest) -> GitResult<GitIdentity>;
    fn set_identity(&self, request: &SetIdentityRequest) -> GitResult<OperationResult>;
    fn get_tags(&self, request: &RepoRequest) -> GitResult<Vec<TagInfo>>;
    fn get_remotes(&self, request: &RepoRequest) -> GitResult<Vec<RemoteInfo>>;
    fn switch_branch(&self, request: &BranchRequest) -> GitResult<OperationResult>;
    fn delete_branch(&self, request: &DeleteBranchRequest) -> GitResult<OperationResult>;
    fn rename_branch(&self, request: &RenameBranchRequest) -> GitResult<OperationResult>;
    fn delete_tag(&self, request: &DeleteTagRequest) -> GitResult<OperationResult>;
    fn create_tag(&self, request: &CreateTagRequest) -> GitResult<OperationResult>;
    fn push_tag(&self, request: &PushTagRequest) -> GitResult<OperationResult>;
    fn delete_remote_tag(&self, request: &DeleteRemoteTagRequest) -> GitResult<OperationResult>;
    fn merge_branch(&self, request: &MergeRequest) -> GitResult<MergeResult>;
    fn merge_abort(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn rebase_start(&self, request: &RebaseRequest) -> GitResult<RebaseResult>;
    fn rebase_continue(&self, request: &RepoRequest) -> GitResult<RebaseResult>;
    fn rebase_abort(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn cherry_pick_start(&self, request: &CherryPickRequest) -> GitResult<CherryPickResult>;
    fn cherry_pick_continue(&self, request: &RepoRequest) -> GitResult<CherryPickResult>;
    fn cherry_pick_abort(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn revert_commit_start(&self, request: &RevertCommitRequest) -> GitResult<CherryPickResult>;
    fn revert_continue(&self, request: &RepoRequest) -> GitResult<CherryPickResult>;
    fn revert_abort(&self, request: &RepoRequest) -> GitResult<OperationResult>;
    fn reset(&self, request: &ResetRequest) -> GitResult<OperationResult>;
    fn delete_remote_branch(
        &self,
        request: &DeleteRemoteBranchRequest,
    ) -> GitResult<OperationResult>;
    fn add_remote(&self, request: &AddRemoteRequest) -> GitResult<OperationResult>;
    fn remove_remote(&self, request: &RemoveRemoteRequest) -> GitResult<OperationResult>;
    fn rename_remote(&self, request: &RenameRemoteRequest) -> GitResult<OperationResult>;
    fn set_remote_url(&self, request: &SetRemoteUrlRequest) -> GitResult<OperationResult>;
    fn prune_remote(&self, request: &PruneRemoteRequest) -> GitResult<OperationResult>;
    fn conflict_accept_theirs(&self, request: &FileRequest) -> GitResult<OperationResult>;
    fn conflict_accept_ours(&self, request: &FileRequest) -> GitResult<OperationResult>;
    fn open_merge_tool(&self, request: &FileRequest) -> GitResult<OperationResult>;
}

pub struct GitService {
    settings: RwLock<Settings>,
    config_path: RwLock<Option<PathBuf>>,
    gix_handler: Arc<dyn GitOperationHandler>,
    cli_handler: Arc<dyn GitOperationHandler>,
}

impl GitService {
    pub fn new() -> Self {
        Self {
            settings: RwLock::new(Settings::default()),
            config_path: RwLock::new(None),
            gix_handler: Arc::new(GixGitHandler::new()),
            cli_handler: Arc::new(CliGitHandler::new()),
        }
    }

    pub fn initialize_config(&self, path: PathBuf) {
        if let Ok(mut config_path) = self.config_path.write() {
            *config_path = Some(path.clone());
        }

        let loaded = fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .unwrap_or_default();

        if let Ok(mut settings) = self.settings.write() {
            *settings = loaded;
        }

        let _ = self.persist_settings();
    }

    pub fn get_config_file_path(&self) -> Option<String> {
        self.config_path
            .read()
            .ok()
            .and_then(|path| path.as_ref().map(|p| p.to_string_lossy().to_string()))
    }

    pub fn get_settings(&self) -> Settings {
        self.settings
            .read()
            .map(|settings| settings.clone())
            .unwrap_or_else(|_| Settings::default())
    }

    pub fn set_backend_mode(&self, mode: BackendMode) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.backend_mode = mode;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_show_result_log(&self, show_result_log: bool) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.show_result_log = show_result_log;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_theme_mode(&self, theme_mode: ThemeMode) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.theme_mode = theme_mode;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_confirm_revert(&self, confirm_revert: bool) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.confirm_revert = confirm_revert;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_try_platform_first(&self, try_platform_first: bool) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.try_platform_first = try_platform_first;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_default_clone_dir(&self, default_clone_dir: String) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.default_clone_dir = default_clone_dir;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_avatar_provider(
        &self,
        avatar_provider: super::types::AvatarProviderMode,
    ) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.avatar_provider = avatar_provider;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_commit_date_mode(&self, commit_date_mode: CommitDateMode) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.commit_date_mode = commit_date_mode;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_push_follow_tags(&self, push_follow_tags: bool) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.push_follow_tags = push_follow_tags;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_auto_check_for_updates_on_launch(
        &self,
        auto_check_for_updates_on_launch: bool,
    ) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.auto_check_for_updates_on_launch = auto_check_for_updates_on_launch;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_auto_install_updates(&self, auto_install_updates: bool) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.auto_install_updates = auto_install_updates;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn set_panel_layout(&self, left_pane_width: u32, right_pane_width: u32) -> Settings {
        if let Ok(mut settings) = self.settings.write() {
            settings.left_pane_width = left_pane_width;
            settings.right_pane_width = right_pane_width;
            let next = settings.clone();
            drop(settings);
            let _ = self.persist_settings();
            return next;
        }

        Settings::default()
    }

    pub fn read_handler(&self) -> Arc<dyn GitOperationHandler> {
        self.active_read_handler()
    }

    fn active_read_handler(&self) -> Arc<dyn GitOperationHandler> {
        let mode = self
            .settings
            .read()
            .map(|settings| settings.backend_mode.clone())
            .unwrap_or(BackendMode::GitCliOnly);

        match mode {
            BackendMode::Default => Arc::clone(&self.gix_handler),
            BackendMode::GitCliOnly => Arc::clone(&self.cli_handler),
        }
    }

    fn active_write_handler(&self) -> Arc<dyn GitOperationHandler> {
        Arc::clone(&self.cli_handler)
    }

    #[allow(dead_code)]
    pub fn clone_repo(&self, request: CloneRequest) -> GitResult<OperationResult> {
        self.active_write_handler().clone_repo(&request)
    }

    pub fn get_numstat(&self, request: NumstatRequest) -> GitResult<NumstatResult> {
        self.cli_handler.get_numstat(&request)
    }

    pub fn validate_repo_path(&self, repo_path: &str) -> GitResult<OperationResult> {
        self.active_read_handler().validate_repo_path(repo_path)
    }

    pub fn pull_changes(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().pull_changes(&request)
    }

    pub fn push_changes(&self, request: PushRequest) -> GitResult<OperationResult> {
        self.active_write_handler().push_changes(&request)
    }

    pub fn commit_changes(&self, request: CommitRequest) -> GitResult<OperationResult> {
        self.active_write_handler().commit_changes(&request)
    }

    pub fn stage_files(&self, request: StageFilesRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stage_files(&request)
    }

    pub fn get_configured_diff_tool(&self, request: RepoRequest) -> GitResult<Option<String>> {
        self.active_read_handler()
            .get_configured_diff_tool(&request)
    }

    pub fn open_external_diff(&self, request: ExternalDiffRequest) -> GitResult<OperationResult> {
        self.active_read_handler().open_external_diff(&request)
    }

    pub fn open_working_tree_diff(&self, request: DiffRequest) -> GitResult<OperationResult> {
        self.active_read_handler().open_working_tree_diff(&request)
    }

    pub fn get_repo_status(&self, request: RepoRequest) -> GitResult<RepoStatus> {
        self.active_read_handler().get_repo_status(&request)
    }

    pub fn get_commit_markers(&self, request: RepoRequest) -> GitResult<CommitMarkers> {
        self.active_read_handler().get_commit_markers(&request)
    }

    pub fn get_commit_files(&self, request: CommitFilesRequest) -> GitResult<Vec<CommitFileItem>> {
        self.active_read_handler().get_commit_files(&request)
    }

    pub fn get_diff(&self, request: DiffRequest) -> GitResult<FileDiff> {
        self.active_read_handler().get_diff(&request)
    }

    pub fn get_branches(&self, request: RepoRequest) -> GitResult<Vec<BranchInfo>> {
        self.active_read_handler().get_branches(&request)
    }

    pub fn create_branch(&self, request: CreateBranchRequest) -> GitResult<OperationResult> {
        self.active_write_handler().create_branch(&request)
    }

    pub fn unstage_file(&self, request: FileRequest) -> GitResult<OperationResult> {
        self.active_write_handler().unstage_file(&request)
    }

    pub fn unstage_all(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().unstage_all(&request)
    }

    pub fn stage_all(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stage_all(&request)
    }

    pub fn stage_hunk(&self, request: HunkStageRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stage_hunk(&request)
    }

    pub fn discard_file(&self, request: FileRequest) -> GitResult<OperationResult> {
        self.active_write_handler().discard_file(&request)
    }

    pub fn fetch_remote(&self, request: FetchRequest) -> GitResult<OperationResult> {
        self.active_write_handler().fetch_remote(&request)
    }

    pub fn stash(&self, request: StashPushRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stash(&request)
    }

    pub fn stash_list(&self, request: RepoRequest) -> GitResult<Vec<StashEntry>> {
        self.active_read_handler().stash_list(&request)
    }

    pub fn stash_apply(&self, request: StashRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stash_apply(&request)
    }

    pub fn stash_pop(&self, request: StashRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stash_pop(&request)
    }

    pub fn stash_drop(&self, request: StashRequest) -> GitResult<OperationResult> {
        self.active_write_handler().stash_drop(&request)
    }

    pub fn get_identity(&self, request: IdentityRequest) -> GitResult<GitIdentity> {
        self.active_read_handler().get_identity(&request)
    }

    pub fn set_identity(&self, request: SetIdentityRequest) -> GitResult<OperationResult> {
        self.active_write_handler().set_identity(&request)
    }

    pub fn get_tags(&self, request: RepoRequest) -> GitResult<Vec<TagInfo>> {
        self.active_read_handler().get_tags(&request)
    }

    pub fn get_remotes(&self, request: RepoRequest) -> GitResult<Vec<RemoteInfo>> {
        self.active_read_handler().get_remotes(&request)
    }

    pub fn switch_branch(&self, request: BranchRequest) -> GitResult<OperationResult> {
        self.active_write_handler().switch_branch(&request)
    }

    pub fn delete_branch(&self, request: DeleteBranchRequest) -> GitResult<OperationResult> {
        self.active_write_handler().delete_branch(&request)
    }

    pub fn rename_branch(&self, request: RenameBranchRequest) -> GitResult<OperationResult> {
        self.active_write_handler().rename_branch(&request)
    }

    pub fn delete_tag(&self, request: DeleteTagRequest) -> GitResult<OperationResult> {
        self.active_write_handler().delete_tag(&request)
    }

    pub fn create_tag(&self, request: CreateTagRequest) -> GitResult<OperationResult> {
        self.active_write_handler().create_tag(&request)
    }

    pub fn push_tag(&self, request: PushTagRequest) -> GitResult<OperationResult> {
        self.active_write_handler().push_tag(&request)
    }

    pub fn delete_remote_tag(&self, request: DeleteRemoteTagRequest) -> GitResult<OperationResult> {
        self.active_write_handler().delete_remote_tag(&request)
    }

    pub fn merge_branch(&self, request: MergeRequest) -> GitResult<MergeResult> {
        self.active_write_handler().merge_branch(&request)
    }

    pub fn merge_abort(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().merge_abort(&request)
    }

    pub fn rebase_start(&self, request: RebaseRequest) -> GitResult<RebaseResult> {
        self.active_write_handler().rebase_start(&request)
    }

    pub fn rebase_continue(&self, request: RepoRequest) -> GitResult<RebaseResult> {
        self.active_write_handler().rebase_continue(&request)
    }

    pub fn rebase_abort(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().rebase_abort(&request)
    }

    pub fn cherry_pick_start(&self, request: CherryPickRequest) -> GitResult<CherryPickResult> {
        self.active_write_handler().cherry_pick_start(&request)
    }

    pub fn cherry_pick_continue(&self, request: RepoRequest) -> GitResult<CherryPickResult> {
        self.active_write_handler().cherry_pick_continue(&request)
    }

    pub fn cherry_pick_abort(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().cherry_pick_abort(&request)
    }

    pub fn revert_commit_start(&self, request: RevertCommitRequest) -> GitResult<CherryPickResult> {
        self.active_write_handler().revert_commit_start(&request)
    }

    pub fn revert_continue(&self, request: RepoRequest) -> GitResult<CherryPickResult> {
        self.active_write_handler().revert_continue(&request)
    }

    pub fn revert_abort(&self, request: RepoRequest) -> GitResult<OperationResult> {
        self.active_write_handler().revert_abort(&request)
    }

    pub fn reset(&self, request: ResetRequest) -> GitResult<OperationResult> {
        self.active_write_handler().reset(&request)
    }

    pub fn delete_remote_branch(
        &self,
        request: DeleteRemoteBranchRequest,
    ) -> GitResult<OperationResult> {
        self.active_write_handler().delete_remote_branch(&request)
    }

    pub fn add_remote(&self, request: AddRemoteRequest) -> GitResult<OperationResult> {
        self.active_write_handler().add_remote(&request)
    }

    pub fn remove_remote(&self, request: RemoveRemoteRequest) -> GitResult<OperationResult> {
        self.active_write_handler().remove_remote(&request)
    }

    pub fn rename_remote(&self, request: RenameRemoteRequest) -> GitResult<OperationResult> {
        self.active_write_handler().rename_remote(&request)
    }

    pub fn set_remote_url(&self, request: SetRemoteUrlRequest) -> GitResult<OperationResult> {
        self.active_write_handler().set_remote_url(&request)
    }

    pub fn prune_remote(&self, request: PruneRemoteRequest) -> GitResult<OperationResult> {
        self.active_write_handler().prune_remote(&request)
    }

    pub fn conflict_accept_theirs(&self, request: FileRequest) -> GitResult<OperationResult> {
        self.active_write_handler().conflict_accept_theirs(&request)
    }

    pub fn conflict_accept_ours(&self, request: FileRequest) -> GitResult<OperationResult> {
        self.active_write_handler().conflict_accept_ours(&request)
    }

    pub fn open_merge_tool(&self, request: FileRequest) -> GitResult<OperationResult> {
        self.active_write_handler().open_merge_tool(&request)
    }

    fn persist_settings(&self) -> Result<(), String> {
        let path = self
            .config_path
            .read()
            .map_err(|_| "Failed to acquire config path lock".to_string())?
            .clone()
            .ok_or_else(|| "Config path is not initialized".to_string())?;

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let settings = self
            .settings
            .read()
            .map_err(|_| "Failed to acquire settings lock".to_string())?
            .clone();

        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        fs::write(path, json).map_err(|e| e.to_string())
    }
}
