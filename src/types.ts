export type BackendMode = "Default" | "GitCliOnly";
export type ThemeMode = "System" | "Light" | "Dark";
export type ExternalDiffTool = "Other" | "Meld" | "Kompare" | "WinMerge" | "VsCode" | "VsCodium";
export type AvatarProviderMode = "Off" | "Libravatar";
export type CommitDateMode = "AuthorDate" | "CommitterDate";
export type LinuxGraphicsMode = "Auto" | "Safe" | "Native";

export type Settings = {
    backendMode: BackendMode;
    showResultLog: boolean;
    themeMode: ThemeMode;
    wrapDiffLines: boolean;
    leftPaneWidth: number;
    rightPaneWidth: number;
    confirmRevert: boolean;
    avatarProvider: AvatarProviderMode;
    tryPlatformFirst: boolean;
    defaultCloneDir: string;
    commitDateMode: CommitDateMode;
    pushFollowTags: boolean;
    autoCheckForUpdatesOnLaunch: boolean;
    autoInstallUpdates: boolean;
    updateEndpoint: string;
    linuxGraphicsMode: LinuxGraphicsMode;
};

export type AvailableUpdate = {
    currentVersion: string;
    version: string;
    date: number | null;
    body: string | null;
};

export type UpdateDownloadEvent =
    | {
        event: "Started";
        data: {
            contentLength: number | null;
        };
    }
    | {
        event: "Progress";
        data: {
            chunkLength: number;
        };
    }
    | {
        event: "Finished";
    };

export type OperationResult = {
    message: string;
    output?: string | null;
    repoPath?: string | null;
    backendUsed: "gix" | "git-cli" | "gix+cli-fallback";
};

export type RepoRequest = {
    repoPath: string;
};

export type CommitRequest = RepoRequest & {
    message: string;
    amend?: boolean;
};

export type CommitHistoryRequest = RepoRequest & {
    limit?: number;
    afterHash?: string;
    offset?: number;
};

export type CommitFilesRequest = RepoRequest & {
    commitHash: string;
};

export type ExternalDiffRequest = RepoRequest & {
    commitHash: string;
    filePath: string;
};

export type StageFilesRequest = RepoRequest & {
    files: string[];
};

export type SubmoduleActionRequest = RepoRequest & {
    path: string;
    recursive?: boolean;
};

export type CloneRequest = {
    repoUrl: string;
    destination: string;
};

export type DiffRequest = {
    repoPath: string;
    filePath: string;
    staged: boolean;
};

export type FileRequest = {
    repoPath: string;
    filePath: string;
};

export type HunkStageRequest = {
    repoPath: string;
    filePath: string;
    hunkIndex: number;
};

export type IdentityRequest = {
    repoPath: string;
    scope: IdentityScope;
};

export type FetchRequest = {
    repoPath: string;
    remote?: string | null;
};

export type PushRequest = {
    repoPath: string;
    remote?: string | null;
    remoteBranch?: string | null;
    setUpstream?: boolean;
    forceWithLease?: boolean;
    pushFollowTags: boolean;
};

export type SetBranchUpstreamRequest = RepoRequest & {
    branchName: string;
    remote: string;
    remoteBranch: string;
};

export type PullState =
    | "up_to_date"
    | "behind_only"
    | "ahead_only"
    | "divergent"
    | "no_upstream"
    | "detached_head"
    | "blocked_dirty_worktree"
    | "operation_in_progress";

export type PullRecommendedAction =
    | "none"
    | "ff-only-pull"
    | "push"
    | "rebase"
    | "merge";

export type PullAnalysis = {
    repoPath: string;
    currentBranch: string | null;
    upstreamBranch: string | null;
    ahead: number;
    behind: number;
    hasWorkingTreeChanges: boolean;
    hasStagedChanges: boolean;
    mergeInProgress: boolean;
    rebaseInProgress: boolean;
    cherryPickInProgress: boolean;
    revertInProgress: boolean;
    state: PullState;
    recommendedAction: PullRecommendedAction;
    message: string;
};

export type PullStrategy = "ff-only" | "rebase" | "merge";

export type PushFailureKind =
    | "non-fast-forward"
    | "no-upstream"
    | "upstream-missing"
    | "auth"
    | "network"
    | "other";

export type PushRejectionAnalysis = {
    repoPath: string;
    currentBranch: string | null;
    upstreamBranch: string | null;
    kind: PushFailureKind;
    message: string;
    suggestedNextActions: Array<"fetch" | "review" | "integrate" | "publish" | "repair-upstream" | "retry">;
};

export type PushResult = {
    message: string;
    output?: string | null;
    repoPath?: string | null;
    backendUsed: "gix" | "git-cli" | "gix+cli-fallback";
    success: boolean;
    rejection?: PushRejectionAnalysis | null;
};

export type FileStatusItem = {
    path: string;
    status: string;
    additions: number | null;
    deletions: number | null;
};

export type ConflictFileItem = {
    path: string;
    conflictType: string;
};

export type SubmoduleState =
    | "clean"
    | "uninitialised"
    | "missing"
    | "dirty"
    | "outOfSync"
    | "conflict"
    | "syncRequired";

export type SubmoduleStatus = {
    path: string;
    name: string;
    configuredUrl: string | null;
    localUrl: string | null;
    branch: string | null;
    currentBranch: string | null;
    expectedCommit: string | null;
    checkedOutCommit: string | null;
    initialised: boolean;
    missing: boolean;
    dirty: boolean;
    outOfSync: boolean;
    syncRequired: boolean;
    state: SubmoduleState;
};

export type RepoStatus = {
    changedFiles: FileStatusItem[];
    stagedFiles: FileStatusItem[];
    unversionedFiles: string[];
    submodules: SubmoduleStatus[];
    currentBranch: string | null;
    mergeInProgress: boolean;
    mergeHeadBranch: string | null;
    conflictedFiles: ConflictFileItem[];
    mergeMessage: string | null;
    rebaseInProgress: boolean;
    rebaseOnto: string | null;
    cherryPickInProgress: boolean;
    cherryPickHead: string | null;
    revertInProgress: boolean;
    revertHead: string | null;
};

export type MergeRequest = RepoRequest & {
    branchName: string;
    noFf?: boolean;
    ffOnly?: boolean;
    message?: string;
};

export type MergeResult = {
    message: string;
    output?: string | null;
    repoPath?: string | null;
    backendUsed: "gix" | "git-cli" | "gix+cli-fallback";
    success: boolean;
    hasConflicts: boolean;
    conflictedFiles: string[];
};

export type RebaseRequest = RepoRequest & {
    onto: string;
};

export type RebaseResult = {
    message: string;
    output?: string | null;
    repoPath?: string | null;
    backendUsed: "gix" | "git-cli" | "gix+cli-fallback";
    success: boolean;
    hasConflicts: boolean;
    conflictedFiles: string[];
};

export type CherryPickRequest = RepoRequest & {
    commitHash: string;
};

export type CherryPickResult = {
    message: string;
    output?: string | null;
    repoPath?: string | null;
    backendUsed: "gix" | "git-cli" | "gix+cli-fallback";
    success: boolean;
    hasConflicts: boolean;
    conflictedFiles: string[];
};

export type NumstatResult = {
    filePath: string;
    additions: number;
    deletions: number;
};

export type SignatureStatus = "none" | "signed" | "verified" | "unknownKey" | "bad";

export type CommitHistoryItem = {
    hash: string;
    shortHash: string;
    author: string;
    authorEmail: string;
    date: string;
    message: string;
    signatureStatus: SignatureStatus;
    keyType: string | null;
};

export type CommitTrailer = {
    key: string;
    value: string;
};

export type CommitDetails = {
    hash: string;
    author: string;
    authorEmail: string;
    authorDate: string;
    committer: string;
    committerEmail: string;
    committerDate: string;
    parentHashes: string[];
    tags: string[];
    trailers: CommitTrailer[];
};

export type CommitVerification = {
    hash: string;
    status: SignatureStatus;
    signer: string | null;
    fingerprint: string | null;
};

export type CommitMarkers = {
    localHead: string | null;
    upstreamHead: string | null;
    upstreamRef: string | null;
};

export type CommitFileItem = {
    path: string;
    status: string;
};

export type DiffLineKind = "Add" | "Remove" | "Context" | "add" | "remove" | "context";

export type DiffLine = {
    kind: DiffLineKind;
    content: string;
    oldLineNo: number | null;
    newLineNo: number | null;
};

export type DiffHunk = {
    header: string;
    lines: DiffLine[];
};

export type LineEndingStyle = "lf" | "crlf" | "mixed" | "unknown";

export type FileDiff = {
    filePath: string;
    hunks: DiffHunk[];
    isBinary: boolean;
    lineEnding: LineEndingStyle;
    detectedFileType?: string | null;
};

export type UpstreamStatus = "tracked" | "none" | "missing";

export type BranchInfo = {
    name: string;
    isCurrent: boolean;
    isRemote: boolean;
    upstream: string | null;
    upstreamStatus: UpstreamStatus;
    ahead: number;
    behind: number;
};

export type CreateBranchRequest = RepoRequest & {
    branchName: string;
    baseRef?: string;
    checkoutAfterCreation?: boolean;
    trackRemote?: boolean;
    matchTrackingBranch?: boolean;
};

export type DeleteBranchRequest = RepoRequest & {
    branchName: string;
    force?: boolean;
};

export type RenameBranchRequest = RepoRequest & {
    oldName: string;
    newName: string;
};

export type DeleteTagRequest = RepoRequest & {
    tagName: string;
};

export type CreateTagRequest = RepoRequest & {
    tagName: string;
    message?: string | null;
    target?: string | null;
};

export type PushTagRequest = RepoRequest & {
    remote: string;
    tagName: string;
};

export type DeleteRemoteTagRequest = RepoRequest & {
    remote: string;
    tagName: string;
};

export type DeleteRemoteBranchRequest = RepoRequest & {
    remote: string;
    branch: string;
};

export type AddRemoteRequest = RepoRequest & {
    name: string;
    url: string;
};

export type RemoveRemoteRequest = RepoRequest & {
    name: string;
};

export type RenameRemoteRequest = RepoRequest & {
    oldName: string;
    newName: string;
};

export type SetRemoteUrlRequest = RepoRequest & {
    name: string;
    url: string;
};

export type PruneRemoteRequest = RepoRequest & {
    name: string;
};

export type IdentityScope = "Local" | "Global";

export type GitIdentity = {
    name: string | null;
    email: string | null;
    signingKey: string | null;
    signingFormat: string | null;
    sshKeyPath: string | null;
    commitSigningEnabled: boolean;
};

export type SetIdentityRequest = {
    repoPath: string;
    scope: IdentityScope;
    name?: string | null;
    email?: string | null;
    signingKey?: string | null;
    signingFormat?: string | null;
    sshKeyPath?: string | null;
    commitSigningEnabled?: boolean;
};

export type TagInfo = {
    name: string;
    hash: string;
    message: string | null;
};

export type RemoteInfo = {
    name: string;
    url: string;
};

export type RepositorySelectedPayload = {
    repoPath: string;
};

export type StashEntry = {
    index: number;
    message: string;
    shortHash: string;
};
