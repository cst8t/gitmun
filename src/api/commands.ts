import {Channel, invoke} from "@tauri-apps/api/core";
import type {
    BranchInfo,
    CommitDetails,
    CommitFileItem,
    CommitHistoryItem,
    CommitLogScope,
    CommitMarkers,
    CommitPrimaryAction,
    CommitVerification,
    CommitRequest,
    CommitMessageRecovery,
    CreateBranchRequest,
    CherryPickRequest,
    CherryPickResult,
    DeleteBranchRequest,
    RenameBranchRequest,
    DeleteRemoteBranchRequest,
    CreateTagRequest,
    DeleteTagRequest,
    DeleteRemoteTagRequest,
    PushTagRequest,
    DiffRequest,
    FetchRequest,
    ExportPatchRequest,
    ExportCommitPatchRequest,
    ExternalDiffTool,
    FileDiff,
    FileRequest,
    GitIdentity,
    SshAllowedSignerStatus,
    HunkStageRequest,
    IdentityRequest,
    ImportPatchRequest,
    MergeResult,
    RebaseRequest,
    RebaseResult,
    OperationResult,
    PullAnalysis,
    PullStrategy,
    PushRequest,
    PushResult,
    RemoteInfo,
    RepoOpenLocation,
    RepoOpenLocationKind,
    RepoRequest,
    RepoStatus,
    RepoOpenBehaviour,
    RowStriping,
    SetBranchUpstreamRequest,
    Settings,
    StageFilesRequest,
    SubmoduleActionRequest,
    TagInfo,
    BackendMode,
    LinuxTerminalOption,
    LinuxTerminalEmulator,
    ThemeMode,
    ThemeBundle,
    UiTextScale,
    NumstatResult,
    SetIdentityRequest,
    AddRemoteRequest,
    AppUpdateChannel,
    AvailableUpdate,
    MicrosoftStoreUpdate,
    UpdateDownloadEvent,
    RemoveRemoteRequest,
    RenameRemoteRequest,
    SetRemoteUrlRequest,
    PruneRemoteRequest,
    StashEntry,
    CloneStartupOptions,
    ShellStartupAction,
} from "../types";

export function getRepoStatus(repoPath: string): Promise<RepoStatus> {
    return invoke<RepoStatus>("get_repo_status", {request: {repoPath}});
}

export function getRepoOpenLocations(): Promise<RepoOpenLocation[]> {
    return invoke<RepoOpenLocation[]>("get_repo_open_locations");
}

export function openRepoLocation(repoPath: string, kind: RepoOpenLocationKind): Promise<OperationResult> {
    return invoke<OperationResult>("open_repo_location", {repoPath, kind});
}

export function getNumstat(repoPath: string, filePath: string, staged: boolean): Promise<NumstatResult> {
    return invoke<NumstatResult>("get_numstat", {request: {repoPath, filePath, staged}});
}

export function getDiff(repoPath: string, filePath: string, staged: boolean): Promise<FileDiff> {
    return invoke<FileDiff>("get_diff", {request: {repoPath, filePath, staged}});
}

export function getBranches(repoPath: string): Promise<BranchInfo[]> {
    return invoke<BranchInfo[]>("get_branches", {request: {repoPath}});
}

export function switchBranch(repoPath: string, branchName: string): Promise<OperationResult> {
    return invoke<OperationResult>("switch_branch", {request: {repoPath, branchName}});
}

export function createBranch(request: CreateBranchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("create_branch", {request});
}

export function deleteBranch(request: DeleteBranchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("delete_branch", {request});
}

export function renameBranch(request: RenameBranchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("rename_branch", {request});
}

export function deleteTag(request: DeleteTagRequest): Promise<OperationResult> {
    return invoke<OperationResult>("delete_tag", {request});
}

export function createTag(request: CreateTagRequest): Promise<OperationResult> {
    return invoke<OperationResult>("create_tag", {request});
}

export function pushTag(request: PushTagRequest): Promise<OperationResult> {
    return invoke<OperationResult>("push_tag", {request});
}

export function deleteRemoteTag(request: DeleteRemoteTagRequest): Promise<OperationResult> {
    return invoke<OperationResult>("delete_remote_tag", {request});
}

export function deleteRemoteBranch(request: DeleteRemoteBranchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("delete_remote_branch", {request});
}

export function getCommitHistory(
    repoPath: string,
    limit?: number,
    afterHash?: string,
    offset?: number,
    scope?: CommitLogScope,
): Promise<CommitHistoryItem[]> {
    return invoke<CommitHistoryItem[]>("get_commit_history", {request: {repoPath, limit, afterHash, offset, scope}});
}

export function verifyCommits(repoPath: string, hashes: string[]): Promise<CommitVerification[]> {
    return invoke<CommitVerification[]>("verify_commits", {repoPath, hashes});
}

export function getCommitMarkers(repoPath: string): Promise<CommitMarkers> {
    return invoke<CommitMarkers>("get_commit_markers", {request: {repoPath}});
}

export function getCommitFiles(repoPath: string, commitHash: string): Promise<CommitFileItem[]> {
    return invoke<CommitFileItem[]>("get_commit_files", {request: {repoPath, commitHash}});
}

export function getCommitDetails(repoPath: string, commitHash: string): Promise<CommitDetails> {
    return invoke<CommitDetails>("get_commit_details", {request: {repoPath, commitHash}});
}

export function openExternalDiff(repoPath: string, commitHash: string, filePath: string): Promise<OperationResult> {
    return invoke<OperationResult>("open_external_diff", {request: {repoPath, commitHash, filePath}});
}

export function openWorkingTreeDiff(repoPath: string, filePath: string, staged: boolean): Promise<OperationResult> {
    return invoke<OperationResult>("open_working_tree_diff", {request: {repoPath, filePath, staged}});
}

export function checkPatchFile(request: ImportPatchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("check_patch_file", {request});
}

export function importPatchFile(request: ImportPatchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("import_patch_file", {request});
}

export function exportPatchFile(request: ExportPatchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("export_patch_file", {request});
}

export function exportCommitPatchFile(request: ExportCommitPatchRequest): Promise<OperationResult> {
    return invoke<OperationResult>("export_commit_patch_file", {request});
}

export function getRepoDiffTool(repoPath: string): Promise<string | null> {
    return invoke<string | null>("get_repo_diff_tool", {request: {repoPath}});
}

export function getGlobalGpgProgramPath(): Promise<string | null> {
    return invoke<string | null>("get_global_gpg_program_path");
}

export function setGlobalGpgProgram(gpgProgram: string): Promise<OperationResult> {
    return invoke<OperationResult>("set_global_gpg_program", {gpgProgram});
}

export function stageFiles(repoPath: string, files: string[]): Promise<OperationResult> {
    return invoke<OperationResult>("stage_files", {request: {repoPath, files}});
}

export function stageAll(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("stage_all", {request: {repoPath}});
}

export function unstageFile(repoPath: string, filePath: string): Promise<OperationResult> {
    return invoke<OperationResult>("unstage_file", {request: {repoPath, filePath}});
}

export function unstageAll(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("unstage_all", {request: {repoPath}});
}

export function stageHunk(repoPath: string, filePath: string, hunkIndex: number): Promise<OperationResult> {
    return invoke<OperationResult>("stage_hunk", {request: {repoPath, filePath, hunkIndex}});
}

export function unstageHunk(repoPath: string, filePath: string, hunkIndex: number): Promise<OperationResult> {
    return invoke<OperationResult>("unstage_hunk", {request: {repoPath, filePath, hunkIndex}});
}

export function discardFile(repoPath: string, filePath: string): Promise<OperationResult> {
    return invoke<OperationResult>("discard_file", {request: {repoPath, filePath}});
}

export function submoduleInit(request: SubmoduleActionRequest): Promise<OperationResult> {
    return invoke<OperationResult>("submodule_init", {request});
}

export function submoduleUpdate(request: SubmoduleActionRequest): Promise<OperationResult> {
    return invoke<OperationResult>("submodule_update", {request});
}

export function submoduleSync(request: SubmoduleActionRequest): Promise<OperationResult> {
    return invoke<OperationResult>("submodule_sync", {request});
}

export function submoduleFetch(request: SubmoduleActionRequest): Promise<OperationResult> {
    return invoke<OperationResult>("submodule_fetch", {request});
}

export function submodulePull(request: SubmoduleActionRequest): Promise<OperationResult> {
    return invoke<OperationResult>("submodule_pull", {request});
}

export function commitChanges(repoPath: string, message: string, amend?: boolean): Promise<OperationResult> {
    return invoke<OperationResult>("commit_changes", {request: {repoPath, message, amend}});
}

export function getCommitMessageRecovery(repoPath: string): Promise<CommitMessageRecovery | null> {
    return invoke<CommitMessageRecovery | null>("get_commit_message_recovery", {request: {repoPath}});
}

export function fetchRemote(repoPath: string, remote?: string): Promise<OperationResult> {
    return invoke<OperationResult>("fetch_remote", {request: {repoPath, remote}});
}

export function pullChanges(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("pull_changes", {request: {repoPath}});
}

export function analyzePull(repoPath: string): Promise<PullAnalysis> {
    return invoke<PullAnalysis>("analyze_pull", {request: {repoPath}});
}

export function pullWithStrategy(repoPath: string, strategy: PullStrategy): Promise<OperationResult> {
    return invoke<OperationResult>("pull_with_strategy", {request: {repoPath, strategy}});
}

export function pushChanges(request: PushRequest): Promise<PushResult> {
    return invoke<PushResult>("push_changes", {request});
}

export function setBranchUpstream(request: SetBranchUpstreamRequest): Promise<OperationResult> {
    return invoke<OperationResult>("set_branch_upstream", {request});
}

export function stash(
    repoPath: string,
    message: string | null,
    includeUntracked: boolean,
    paths: string[],
): Promise<OperationResult> {
    return invoke<OperationResult>("stash", {request: {repoPath, message, includeUntracked, paths}});
}

export function stashList(repoPath: string): Promise<StashEntry[]> {
    return invoke<StashEntry[]>("stash_list", {request: {repoPath}});
}

export function stashApply(repoPath: string, stashIndex: number): Promise<OperationResult> {
    return invoke<OperationResult>("stash_apply", {request: {repoPath, stashIndex}});
}

export function stashPop(repoPath: string, stashIndex: number): Promise<OperationResult> {
    return invoke<OperationResult>("stash_pop", {request: {repoPath, stashIndex}});
}

export function stashDrop(repoPath: string, stashIndex: number): Promise<OperationResult> {
    return invoke<OperationResult>("stash_drop", {request: {repoPath, stashIndex}});
}

export function mergeBranch(
    repoPath: string,
    branchName: string,
    options?: { noFf?: boolean; ffOnly?: boolean; message?: string },
): Promise<MergeResult> {
    return invoke<MergeResult>("merge_branch", {
        request: {repoPath, branchName, ...options},
    });
}

export function mergeAbort(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("merge_abort", {request: {repoPath}});
}

export function rebaseStart(request: RebaseRequest): Promise<RebaseResult> {
    return invoke<RebaseResult>("rebase_start", {request});
}

export function rebaseContinue(repoPath: string): Promise<RebaseResult> {
    return invoke<RebaseResult>("rebase_continue", {request: {repoPath}});
}

export function rebaseAbort(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("rebase_abort", {request: {repoPath}});
}

export function cherryPickStart(request: CherryPickRequest): Promise<CherryPickResult> {
    return invoke<CherryPickResult>("cherry_pick_start", {request});
}

export function cherryPickContinue(repoPath: string): Promise<CherryPickResult> {
    return invoke<CherryPickResult>("cherry_pick_continue", {request: {repoPath}});
}

export function cherryPickAbort(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("cherry_pick_abort", {request: {repoPath}});
}

export function revertCommitStart(repoPath: string, commitHash: string): Promise<CherryPickResult> {
    return invoke<CherryPickResult>("revert_commit_start", {request: {repoPath, commitHash}});
}

export function revertContinue(repoPath: string): Promise<CherryPickResult> {
    return invoke<CherryPickResult>("revert_continue", {request: {repoPath}});
}

export function revertAbort(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("revert_abort", {request: {repoPath}});
}

export type ResetMode = "soft" | "mixed" | "hard";

export function resetTo(repoPath: string, target: string, mode: ResetMode): Promise<OperationResult> {
    return invoke<OperationResult>("reset", {request: {repoPath, target, mode}});
}

export function conflictAcceptTheirs(repoPath: string, filePath: string): Promise<OperationResult> {
    return invoke<OperationResult>("conflict_accept_theirs", {request: {repoPath, filePath}});
}

export function conflictAcceptOurs(repoPath: string, filePath: string): Promise<OperationResult> {
    return invoke<OperationResult>("conflict_accept_ours", {request: {repoPath, filePath}});
}

export function openMergeTool(repoPath: string, filePath: string): Promise<OperationResult> {
    return invoke<OperationResult>("open_merge_tool", {request: {repoPath, filePath}});
}

export function getIdentity(repoPath: string, scope: "Local" | "Global"): Promise<GitIdentity> {
    return invoke<GitIdentity>("get_identity", {request: {repoPath, scope}});
}

export function setIdentity(request: SetIdentityRequest): Promise<OperationResult> {
    return invoke<OperationResult>("set_identity", {request});
}

export function getSshAllowedSignerStatus(repoPath: string, scope: "Local" | "Global"): Promise<SshAllowedSignerStatus> {
    return invoke<SshAllowedSignerStatus>("get_ssh_allowed_signer_status", {request: {repoPath, scope}});
}

export function addSshSigningKeyToAllowedSigners(repoPath: string, scope: "Local" | "Global"): Promise<OperationResult> {
    return invoke<OperationResult>("add_ssh_signing_key_to_allowed_signers", {request: {repoPath, scope}});
}

export function getTags(repoPath: string): Promise<TagInfo[]> {
    return invoke<TagInfo[]>("get_tags", {request: {repoPath}});
}

export function getRemotes(repoPath: string): Promise<RemoteInfo[]> {
    return invoke<RemoteInfo[]>("get_remotes", {request: {repoPath}});
}

export function addRemote(request: AddRemoteRequest): Promise<OperationResult> {
    return invoke<OperationResult>("add_remote", {request});
}

export function removeRemote(request: RemoveRemoteRequest): Promise<OperationResult> {
    return invoke<OperationResult>("remove_remote", {request});
}

export function renameRemote(request: RenameRemoteRequest): Promise<OperationResult> {
    return invoke<OperationResult>("rename_remote", {request});
}

export function setRemoteUrl(request: SetRemoteUrlRequest): Promise<OperationResult> {
    return invoke<OperationResult>("set_remote_url", {request});
}

export function pruneRemote(request: PruneRemoteRequest): Promise<OperationResult> {
    return invoke<OperationResult>("prune_remote", {request});
}

export function getSettings(): Promise<Settings> {
    return invoke<Settings>("get_settings");
}

export function getThemeBundle(): Promise<ThemeBundle> {
    return invoke<ThemeBundle>("get_theme_bundle");
}

export function setBackendMode(mode: BackendMode): Promise<Settings> {
    return invoke<Settings>("set_backend_mode", {mode});
}

export function setShowResultLog(showResultLog: boolean): Promise<Settings> {
    return invoke<Settings>("set_show_result_log", {showResultLog});
}

export function setThemeMode(themeMode: ThemeMode): Promise<Settings> {
    return invoke<Settings>("set_theme_mode", {themeMode});
}

export function setUiTextScale(uiTextScale: UiTextScale): Promise<Settings> {
    return invoke<Settings>("set_ui_text_scale", {uiTextScale});
}

export function setWrapDiffLines(wrapDiffLines: boolean): Promise<Settings> {
    return invoke<Settings>("set_wrap_diff_lines", {wrapDiffLines});
}

export function setRowStriping(rowStriping: RowStriping): Promise<Settings> {
    return invoke<Settings>("set_row_striping", {rowStriping});
}

export function setShowCommitGraphButton(showCommitGraphButton: boolean): Promise<Settings> {
    return invoke<Settings>("set_show_commit_graph_button", {showCommitGraphButton});
}

export function setPersistentErrorToasts(persistentErrorToasts: boolean): Promise<Settings> {
    return invoke<Settings>("set_persistent_error_toasts", {persistentErrorToasts});
}

export function setErrorToastClearDelayMs(errorToastClearDelayMs: number): Promise<Settings> {
    return invoke<Settings>("set_error_toast_clear_delay_ms", {errorToastClearDelayMs});
}

export function setPanelLayout(leftPaneWidth: number, rightPaneWidth: number): Promise<Settings> {
    return invoke<Settings>("set_panel_layout", {leftPaneWidth, rightPaneWidth});
}

export function setConfirmRevert(confirmRevert: boolean): Promise<Settings> {
    return invoke<Settings>("set_confirm_revert", {confirmRevert});
}

export function setDefaultCloneDir(defaultCloneDir: string): Promise<Settings> {
    return invoke<Settings>("set_default_clone_dir", {defaultCloneDir});
}

export function setPushFollowTags(pushFollowTags: boolean): Promise<Settings> {
    return invoke<Settings>("set_push_follow_tags", {pushFollowTags});
}

export function setCommitPrimaryAction(commitPrimaryAction: CommitPrimaryAction): Promise<Settings> {
    return invoke<Settings>("set_commit_primary_action", {commitPrimaryAction});
}

export function setAutoCheckForUpdatesOnLaunch(autoCheckForUpdatesOnLaunch: boolean): Promise<Settings> {
    return invoke<Settings>("set_auto_check_for_updates_on_launch", {autoCheckForUpdatesOnLaunch});
}

export function setAutoInstallUpdates(autoInstallUpdates: boolean): Promise<Settings> {
    return invoke<Settings>("set_auto_install_updates", {autoInstallUpdates});
}

export function setUpdateEndpoint(updateEndpoint: string): Promise<Settings> {
    return invoke<Settings>("set_update_endpoint", {updateEndpoint});
}

export function setRepoOpenBehaviour(repoOpenBehaviour: RepoOpenBehaviour): Promise<Settings> {
    return invoke<Settings>("set_repo_open_behaviour", {repoOpenBehaviour});
}

export function setGpgKeyserverVerificationEnabled(enabled: boolean): Promise<Settings> {
    return invoke<Settings>("set_gpg_keyserver_verification_enabled", {enabled});
}

export function getLinuxTerminalOptions(): Promise<LinuxTerminalOption[]> {
    return invoke<LinuxTerminalOption[]>("get_linux_terminal_options");
}

export function setLinuxTerminalEmulator(linuxTerminalEmulator: LinuxTerminalEmulator): Promise<Settings> {
    return invoke<Settings>("set_linux_terminal_emulator", {linuxTerminalEmulator});
}

export function setLinuxTerminalCustomCommand(linuxTerminalCustomCommand: string): Promise<Settings> {
    return invoke<Settings>("set_linux_terminal_custom_command", {linuxTerminalCustomCommand});
}

export function getConfigFilePath(): Promise<string | null> {
    return invoke<string | null>("get_config_file_path");
}

export function getConfigFolderPath(): Promise<string | null> {
    return invoke<string | null>("get_config_folder_path");
}

export function getBuildVersion(): Promise<string> {
    return invoke<string>("get_build_version");
}

export function isUpdaterEnabled(): Promise<boolean> {
    return invoke<boolean>("is_updater_enabled");
}

export function getAppUpdateChannel(): Promise<AppUpdateChannel> {
    return invoke<AppUpdateChannel>("get_app_update_channel");
}

export function checkForAppUpdate(): Promise<AvailableUpdate | null> {
    return invoke<AvailableUpdate | null>("check_for_app_update");
}

export function checkMicrosoftStoreUpdate(): Promise<MicrosoftStoreUpdate | null> {
    return invoke<MicrosoftStoreUpdate | null>("check_microsoft_store_update");
}

export function openMicrosoftStoreUpdatePage(): Promise<void> {
    return invoke<void>("open_microsoft_store_update_page");
}

export function downloadAndInstallAppUpdate(expectedVersion?: string): Promise<void> {
    const onEvent = new Channel<UpdateDownloadEvent>();
    return invoke<void>("download_and_install_app_update", {expectedVersion, onEvent});
}

export function downloadAndInstallAppUpdateWithProgress(
    onProgress: (event: UpdateDownloadEvent) => void,
    expectedVersion?: string,
): Promise<void> {
    const onEvent = new Channel<UpdateDownloadEvent>();
    onEvent.onmessage = onProgress;
    return invoke<void>("download_and_install_app_update", {expectedVersion, onEvent});
}

export function getCommitHash(): Promise<string> {
    return invoke<string>("get_commit_hash");
}

export function getGlobalDiffTool(): Promise<ExternalDiffTool> {
    return invoke<ExternalDiffTool>("get_global_diff_tool");
}

export function getGlobalDiffToolPath(tool: ExternalDiffTool): Promise<string | null> {
    return invoke<string | null>("get_global_diff_tool_path", {tool});
}

export function setGlobalDiffToolWithPath(
    tool: ExternalDiffTool,
    toolPath?: string | null,
): Promise<OperationResult> {
    return invoke<OperationResult>("set_global_diff_tool", {tool, toolPath});
}

export function fetchAvatar(email: string, repoPath: string): Promise<string | null> {
    return invoke<string | null>("fetch_avatar", {email, repoPath});
}

export function validateRepoPath(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("validate_repo_path", {repoPath});
}

export function getRepoDisplayName(repoPath: string): Promise<string | null> {
    return invoke<string | null>("get_repo_display_name", {repoPath});
}

export function initRepo(repoPath: string): Promise<OperationResult> {
    return invoke<OperationResult>("init_repo", {repoPath});
}

export function detectDesktopEnvironment(): Promise<string> {
    return invoke<string>("detect_desktop_environment");
}

export function getSystemThemeHint(): Promise<string> {
    return invoke<string>("get_system_theme_hint");
}

export function watchRepo(repoPath: string): Promise<void> {
    return invoke<void>("watch_repo", {repoPath});
}

export function unwatchRepo(): Promise<void> {
    return invoke<void>("unwatch_repo");
}

export async function setMainWindowTitle(title: string): Promise<void> {
    const {getCurrentWindow} = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTitle(title);
}

export function openSettingsWindow(): Promise<void> {
    return invoke("open_sub_window", {
        label: "settings",
        path: "settings.html",
        title: "Settings",
        width: 650,
        height: 640,
        resizable: false,
        showImmediately: false,
    });
}

export function openCloneWindow(): Promise<void> {
    return openCloneWindowWithOptions();
}

export function openAboutWindow(): Promise<void> {
    return invoke("open_sub_window", {
        label: "about",
        path: "about.html",
        title: "About Gitmun",
        width: 380,
        height: 420,
        resizable: false,
        showImmediately: false,
    });
}

export function openAttributionsWindow(): Promise<void> {
    return invoke("open_sub_window", {
        label: "attributions",
        path: "ATTRIBUTIONS.html",
        title: "Third-Party Attributions",
        width: 900,
        height: 700,
        resizable: true,
        showImmediately: true,
    });
}

export function openResultLogWindow(): Promise<void> {
    return invoke("open_sub_window", {
        label: "result-log",
        path: "result-log.html",
        title: "Result Log",
        width: 760,
        height: 460,
        resizable: true,
        showImmediately: false,
    });
}

export function getStartupAction(): Promise<ShellStartupAction | null> {
    return invoke<ShellStartupAction | null>("get_startup_action");
}

export function openRepoInNewWindow(path: string): Promise<void> {
    return invoke("open_repo_in_new_window", {path});
}

export function openCloneWindowWithOptions(options: CloneStartupOptions = {}): Promise<void> {
    return invoke("open_clone_window", {
        repoUrl: options.repoUrl ?? null,
        destination: options.destination ?? null,
        startClone: options.startClone ?? false,
    });
}

export function takePendingCloneOptions(): Promise<CloneStartupOptions | null> {
    return invoke<CloneStartupOptions | null>("take_pending_clone_options");
}
