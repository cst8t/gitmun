export type BackendMode = "Default" | "GitCliOnly";
export type ThemeMode = "System" | "Light" | "Dark";
export type ExternalDiffTool = "Other" | "Meld" | "Kompare" | "WinMerge" | "VsCode" | "VsCodium";
export type AvatarProviderMode = "Off" | "Libravatar";
export type CommitDateMode = "AuthorDate" | "CommitterDate";

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
  force: boolean;
  pushFollowTags: boolean;
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

export type RepoStatus = {
  changedFiles: FileStatusItem[];
  stagedFiles: FileStatusItem[];
  unversionedFiles: string[];
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

export type CommitHistoryItem = {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  date: string;
  message: string;
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

export type BranchInfo = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
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
};

export type SetIdentityRequest = {
  repoPath: string;
  scope: IdentityScope;
  name?: string | null;
  email?: string | null;
  signingKey?: string | null;
  signingFormat?: string | null;
  sshKeyPath?: string | null;
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
