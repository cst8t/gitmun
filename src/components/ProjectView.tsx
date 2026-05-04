/**
 * ProjectView - all per-project state and logic.
 *
 * This component is keyed by repoPath in App.tsx. Whenever the active
 * repository changes, React completely unmounts the old instance and mounts a
 * fresh one. That guarantees that no state, hook value, interval, or
 * in-flight async result from a previous project can ever survive into the
 * new one.
 */
import React, { useState, useCallback, useEffect, useRef } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Titlebar } from "./Titlebar";
import { Sidebar } from "./sidebar/Sidebar";
import { CentrePanel, type CentreTab } from "./centre/CentrePanel";
import { DiffPanel } from "./diff/DiffPanel";
import { IdentityPanel } from "./identity/IdentityPanel";
import { ConfirmRevertDialog } from "./centre/ConfirmRevertDialog";
import { DivergentPullDialog } from "./centre/DivergentPullDialog";
import { PushRejectedDialog } from "./centre/PushRejectedDialog";
import { NoDiffToolWarning } from "./NoDiffToolWarning";
import { MergeDialog, type MergeStrategy } from "./sidebar/MergeDialog";
import { AddRemoteDialog } from "./sidebar/AddRemoteDialog";
import { EditRemoteDialog } from "./sidebar/EditRemoteDialog";
import { CreateTagDialog } from "./sidebar/CreateTagDialog";
import { CreateBranchDialog } from "./sidebar/CreateBranchDialog";
import { RenameBranchDialog } from "./sidebar/RenameBranchDialog";
import { StashPushDialog } from "./sidebar/StashPushDialog";
import { UpstreamDialog, type UpstreamDialogMode } from "./sidebar/UpstreamDialog";
import { FolderIcon, GitIcon } from "./icons";
import { useGitStatus } from "../hooks/useGitStatus";
import { useGitBranches } from "../hooks/useGitBranches";
import { useGitLog } from "../hooks/useGitLog";
import { useGitDiff } from "../hooks/useGitDiff";
import { useCommitFiles } from "../hooks/useCommitFiles";
import { useGitIdentity } from "../hooks/useGitIdentity";
import { useGitTags } from "../hooks/useGitTags";
import { useGitRemotes } from "../hooks/useGitRemotes";
import { useGitStashes } from "../hooks/useGitStashes";
import * as api from "../api/commands";
import type {
  CommitLogScope,
  CommitMarkers,
  CommitPrimaryAction,
  CreateBranchRequest,
  GitIdentity,
  PullAnalysis,
  PullStrategy,
  PushRequest,
  PushRejectionAnalysis,
  RemoteInfo,
  StashEntry,
} from "../types";
import type { ResultLogEntry } from "../utils/resultLog";
import { appendResultLog } from "../utils/resultLog";
import type { PlatformType } from "../hooks/usePlatform";
import type { ToastType } from "../hooks/useToast";
import { getRemoteActionState } from "../utils/remoteActionState";

// Tracks whether the no-diff-tool warning has already been shown this session
// (lives outside the component so repo switches don't reset it).
let noDiffToolWarnedThisSession = false;

const EMPTY_COMMIT_MARKERS: CommitMarkers = {
  localHead: null,
  upstreamHead: null,
  upstreamRef: null,
};

function deriveLocalBranchName(remoteBranchName: string): string | null {
  const slashIndex = remoteBranchName.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= remoteBranchName.length - 1) {
    return null;
  }

  const localBranchName = remoteBranchName.slice(slashIndex + 1).trim();
  if (!localBranchName || localBranchName === "HEAD") {
    return null;
  }

  return localBranchName;
}

function extractStashRef(output: string | null | undefined): string | null {
  if (!output) {
    return null;
  }

  const match = output.match(/stash@\{\d+}/);
  return match ? match[0] : null;
}

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function buildStashDropPrompt(
  stash: Pick<StashEntry, "index" | "message">,
  t: TFunction<"projectView">,
): string {
  const trimmedMessage = stash.message.trim();
  const stashLabel = trimmedMessage
    ? t("ask.dropStash.stashLabelWithMessage", { index: stash.index, message: trimmedMessage })
    : t("ask.dropStash.stashLabel", { index: stash.index });
  return t("ask.dropStash.message", { stashLabel });
}

export function getEffectiveCommitAction(
  selectedAction: CommitPrimaryAction,
  canCommitAndPush: boolean,
): CommitPrimaryAction {
  return canCommitAndPush ? selectedAction : "commit";
}

export type ProjectViewProps = {
  /** The active repository path. Changing this key causes a full remount. */
  repoPath: string | null;
  /** Increments each time settings are saved - triggers a full data refresh. */
  settingsRevision: number;
  platform: PlatformType;
  showToast: (message: string, type?: ToastType) => void;
  recentRepos: string[];
  identityOpen: boolean;
  onIdentityToggle: () => void;
  onRepoSelect: (path: string) => void;
  onOpenExistingClick: () => void;
  onCloneClick: () => void;
  onInitRepoClick: () => void;
  onAboutClick: () => void;
  onSettingsClick: () => void;
  leftPaneWidth: number;
  rightPaneWidth: number;
  leftPaneCollapsed: boolean;
  onSetLeftPaneCollapsed: (collapsed: boolean) => void;
  draggingPane: "left" | "right" | null;
  onSetDraggingPane: (pane: "left" | "right" | null) => void;
  /** Ref pointing to div.app__body - owned by App for the resize observer. */
  appBodyRef: React.RefObject<HTMLDivElement | null>;
  confirmRevert: boolean;
  onSetConfirmRevert: (v: boolean) => void;
  isNative: boolean;
  winRadius: number;
};

export function ProjectView({
  repoPath,
  settingsRevision,
  platform,
  showToast,
  recentRepos,
  identityOpen,
  onIdentityToggle,
  onRepoSelect,
  onOpenExistingClick,
  onCloneClick,
  onInitRepoClick,
  onAboutClick,
  onSettingsClick,
  leftPaneWidth,
  rightPaneWidth,
  leftPaneCollapsed,
  onSetLeftPaneCollapsed,
  draggingPane,
  onSetDraggingPane,
  appBodyRef,
  confirmRevert,
  onSetConfirmRevert,
  isNative,
  winRadius,
}: ProjectViewProps) {
  const { t } = useTranslation("projectView");
  const collapsedRightPaneBonus = leftPaneCollapsed
    ? Math.max(0, leftPaneWidth + 6 - 22)
    : 0;
  const effectiveRightPaneWidth = rightPaneWidth + collapsedRightPaneBonus;

  const { status, refresh: refreshStatus } = useGitStatus(repoPath);
  const { branches, refresh: refreshBranches } = useGitBranches(repoPath);
  const { tags, refresh: refreshTags } = useGitTags(repoPath);
  const { remotes, refresh: refreshRemotes } = useGitRemotes(repoPath);
  const { stashes, refresh: refreshStashes } = useGitStashes(repoPath);
  const [logScope, setLogScope] = useState<CommitLogScope>("currentCheckout");

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileStaged, setSelectedFileStaged] = useState(false);
  const [selectedSubmodulePath, setSelectedSubmodulePath] = useState<string | null>(null);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  const [centreTab, setCentreTab] = useState<CentreTab>("changes");
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitMarkers, setCommitMarkers] = useState<CommitMarkers>(EMPTY_COMMIT_MARKERS);
  const [repoDiffToolName, setRepoDiffToolName] = useState<string | null>(null);
  const [showNoDiffToolWarning, setShowNoDiffToolWarning] = useState(false);
  const { diff, loading: diffLoading } = useGitDiff(
    repoPath,
    selectedSubmodulePath ? null : selectedFile,
    selectedFileStaged,
    diffRefreshKey,
  );
  const { files: commitFiles, loading: commitFilesLoading } = useCommitFiles(
    repoPath,
    centreTab === "log" ? selectedCommitHash : null,
  );

  const [revertPendingPaths, setRevertPendingPaths] = useState<string[] | null>(null);
  const [mergePendingBranch, setMergePendingBranch] = useState<string | null>(null);
  const [renamePendingBranch, setRenamePendingBranch] = useState<string | null>(null);
  const [showAddRemoteDialog, setShowAddRemoteDialog] = useState(false);
  const [editingRemote, setEditingRemote] = useState<RemoteInfo | null>(null);
  const [showCreateTagDialog, setShowCreateTagDialog] = useState(false);
  const [createTagTarget, setCreateTagTarget] = useState<string | null>(null);
  const [createBranchFromTagName, setCreateBranchFromTagName] = useState<string | null>(null);
  const [isCommitting, setIsCommitting] = useState(false);
  const [isRebaseActionRunning, setIsRebaseActionRunning] = useState(false);
  const [isCherryPickActionRunning, setIsCherryPickActionRunning] = useState(false);
  const [isRevertActionRunning, setIsRevertActionRunning] = useState(false);
  const [showStashDialog, setShowStashDialog] = useState(false);
  const [stashBusy, setStashBusy] = useState(false);
  const [hunkActionBusy, setHunkActionBusy] = useState(false);
  const [remoteOp, setRemoteOp] = useState<"fetch" | "pull" | "push" | null>(null);
  const [divergentPullAnalysis, setDivergentPullAnalysis] = useState<PullAnalysis | null>(null);
  const [pushRejectionAnalysis, setPushRejectionAnalysis] = useState<PushRejectionAnalysis | null>(null);
  const [upstreamDialogMode, setUpstreamDialogMode] = useState<UpstreamDialogMode | null>(null);
  const [commitPrimaryAction, setCommitPrimaryActionState] = useState<CommitPrimaryAction>("commit");
  const [pushFollowTags, setPushFollowTags] = useState(false);
  const [wrapDiffLines, setWrapDiffLines] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { identity: localIdentity, saving: localIdentitySaving, saveIdentity: saveLocalIdentity } =
    useGitIdentity(repoPath, "Local");
  const { identity: globalIdentity, saving: globalIdentitySaving, saveIdentity: saveGlobalIdentity } =
    useGitIdentity(repoPath, "Global");
  const [identityScope, setIdentityScope] = useState<"local" | "global">(() => {
    const stored = localStorage.getItem("gitmun.identityScope");
    return stored === "global" ? "global" : "local";
  });
  useEffect(() => {
    localStorage.setItem("gitmun.identityScope", identityScope);
  }, [identityScope]);
  const activeIdentity = identityScope === "local" ? localIdentity : globalIdentity;
  const displayName = activeIdentity?.name || (identityScope === "local" ? globalIdentity?.name : null);
  const initials = (displayName ?? "?")
    .split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  const [identityAvatar, setIdentityAvatar] = useState<string | null>(null);

  const currentBranch = status?.currentBranch ?? null;
  const {
    commits,
    loadMore,
    hasMore,
    loading: logLoading,
    error: logError,
    refresh: refreshLog,
  } = useGitLog(repoPath, logScope);
  const stagedFiles = status?.stagedFiles ?? [];
  const unstagedFiles = status?.changedFiles ?? [];
  const unversionedFiles = status?.unversionedFiles ?? [];
  const submodules = status?.submodules ?? [];
  const selectedSubmodule = submodules.find(submodule => submodule.path === selectedSubmodulePath) ?? null;
  const conflictedFiles = status?.conflictedFiles ?? [];
  const mergeInProgress = status?.mergeInProgress ?? false;
  const mergeHeadBranch = status?.mergeHeadBranch ?? null;
  const mergeMessage = status?.mergeMessage ?? null;
  const rebaseInProgress = status?.rebaseInProgress ?? false;
  const rebaseOnto = status?.rebaseOnto ?? null;
  const cherryPickInProgress = status?.cherryPickInProgress ?? false;
  const cherryPickHead = status?.cherryPickHead ?? null;
  const revertInProgress = status?.revertInProgress ?? false;
  const revertHead = status?.revertHead ?? null;
  const hasWorkingTreeChanges =
    stagedFiles.length > 0 || unstagedFiles.length > 0 || unversionedFiles.length > 0
    || submodules.some(submodule => submodule.state !== "clean");
  const lastCommitMessage = commits[0]?.message ?? "";
  const currentBranchInfo = branches.find(b => b.isCurrent && !b.isRemote);
  const remoteBranches = branches.filter(b => b.isRemote);
  const remoteActionState = getRemoteActionState(currentBranch, currentBranchInfo);
  const canCommitAndPush = currentBranchInfo?.upstreamStatus === "tracked";
  const effectiveCommitAction = getEffectiveCommitAction(commitPrimaryAction, canCommitAndPush);
  const remoteActionLabel = remoteActionState.kind === "publish"
    ? t("remoteAction.publish", { ns: "git" })
    : remoteActionState.kind === "repair-upstream"
      ? t("remoteAction.repairUpstream", { ns: "git" })
      : t("remoteAction.push", { ns: "git" });
  const remoteActionTitle = remoteActionState.kind === "detached"
    ? t("remoteAction.detachedTitle", { ns: "git" })
    : remoteActionState.kind === "repair-upstream"
      ? t("remoteAction.repairUpstreamTitle", { ns: "git" })
      : undefined;

  useEffect(() => {
    setLogScope("currentCheckout");
  }, [repoPath]);

  const commitMarkersKey = [
    commits[0]?.hash ?? "",
    currentBranchInfo?.upstream ?? "",
    String(currentBranchInfo?.ahead ?? 0),
    String(currentBranchInfo?.behind ?? 0),
  ].join("|");
  const isUnstaged =
    unstagedFiles.some(f => f.path === selectedFile) ||
    unversionedFiles.includes(selectedFile ?? "");

  useEffect(() => {
    if (!repoPath) {
      setCommitMarkers(EMPTY_COMMIT_MARKERS);
      return;
    }
    let cancelled = false;
    api.getCommitMarkers(repoPath)
      .then(markers => { if (!cancelled) setCommitMarkers(markers); })
      .catch(() => { if (!cancelled) setCommitMarkers(EMPTY_COMMIT_MARKERS); });
    return () => { cancelled = true; };
  }, [repoPath, commitMarkersKey]);

  // Keep selectedFile in sync when the file disappears from the working tree.
  useEffect(() => {
    if (!selectedFile || !status) return;
    const inStaged = status.stagedFiles.some(f => f.path === selectedFile);
    const inUnstaged = status.changedFiles.some(f => f.path === selectedFile);
    const inUnversioned = status.unversionedFiles.includes(selectedFile);
    if (!inStaged && !inUnstaged && !inUnversioned) {
      setSelectedFile(null);
      setSelectedFileStaged(false);
      return;
    }
    if (selectedFileStaged && !inStaged && (inUnstaged || inUnversioned)) {
      setSelectedFileStaged(false);
      return;
    }
    if (!selectedFileStaged && inStaged && !inUnstaged && !inUnversioned) {
      setSelectedFileStaged(true);
    }
  }, [selectedFile, selectedFileStaged, status]);

  useEffect(() => {
    if (!selectedSubmodulePath || !status) return;
    const stillPresent = status.submodules.some(submodule => submodule.path === selectedSubmodulePath);
    if (!stillPresent) {
      setSelectedSubmodulePath(null);
    }
  }, [selectedSubmodulePath, status]);

  // Keep selectedCommitHash pointing to a real commit.
  useEffect(() => {
    if (commits.length === 0) { setSelectedCommitHash(null); return; }
    setSelectedCommitHash(prev => {
      if (!prev) return commits[0].hash;
      return commits.some(c => c.hash === prev) ? prev : commits[0].hash;
    });
  }, [commits]);

  useEffect(() => {
    let cancelled = false;
    if (!repoPath) { setRepoDiffToolName(null); return; }
    api.getRepoDiffTool(repoPath)
      .then(tool => {
        if (cancelled) return;
        setRepoDiffToolName(tool);
        if (!tool && !noDiffToolWarnedThisSession && !localStorage.getItem("gitmun.hideNoDiffToolWarning")) {
          noDiffToolWarnedThisSession = true;
          setShowNoDiffToolWarning(true);
        }
      })
      .catch(() => { if (!cancelled) setRepoDiffToolName(null); });
    return () => { cancelled = true; };
  }, [repoPath]);

  useEffect(() => {
    let cancelled = false;
    api.getSettings()
      .then((settings) => {
        if (!cancelled) {
          setCommitPrimaryActionState(settings.commitPrimaryAction ?? "commit");
          setPushFollowTags(settings.pushFollowTags ?? false);
          setWrapDiffLines(settings.wrapDiffLines ?? false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCommitPrimaryActionState("commit");
          setPushFollowTags(false);
          setWrapDiffLines(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [settingsRevision]);

  useEffect(() => {
    // Respect the user's scope choice; fall back to global email when local
    // scope is selected but has no email configured (very common).
    const email = identityScope === "local"
      ? (localIdentity?.email || globalIdentity?.email)
      : globalIdentity?.email;
    if (!email || !repoPath) { setIdentityAvatar(null); return; }
    let cancelled = false;
    api.fetchAvatar(email, repoPath)
      .then(url => { if (!cancelled) setIdentityAvatar(url); })
      .catch(() => { if (!cancelled) setIdentityAvatar(null); });
    return () => { cancelled = true; };
  }, [localIdentity?.email, globalIdentity?.email, identityScope, repoPath, settingsRevision]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshStatus(), refreshBranches(), refreshTags(), refreshRemotes(), refreshLog(), refreshStashes()]);
  }, [refreshStatus, refreshBranches, refreshTags, refreshRemotes, refreshLog, refreshStashes]);

  const handleSaveLocalIdentity = useCallback(async (payload: Partial<GitIdentity>) => {
    await saveLocalIdentity(payload);
    await refreshAll();
  }, [saveLocalIdentity, refreshAll]);

  const handleSaveGlobalIdentity = useCallback(async (payload: Partial<GitIdentity>) => {
    await saveGlobalIdentity(payload);
    await refreshAll();
  }, [saveGlobalIdentity, refreshAll]);

  // Refresh all data when settings change (e.g. avatar provider toggle).
  const isFirstSettingsRevision = useRef(true);
  useEffect(() => {
    if (isFirstSettingsRevision.current) { isFirstSettingsRevision.current = false; return; }
    refreshAll();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsRevision]);

  // Watch the .git directory for external changes (other git clients, CLI).
  // Uses a ref so the listener always calls the latest refreshAll without
  // needing to re-subscribe when its dependencies change.
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;
  useEffect(() => {
    if (!repoPath) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    api.watchRepo(repoPath).catch(() => {/* ignore - watcher is best-effort */});

    listen("git-fs-changed", () => {
      refreshAllRef.current();
    }).then(fn => { if (cancelled) fn(); else unlisten = fn; });

    return () => {
      cancelled = true;
      api.unwatchRepo().catch(() => {});
      unlisten?.();
    };
  }, [repoPath]);

  const handleFileSelect = useCallback((path: string, staged: boolean) => {
    setSelectedSubmodulePath(null);
    setSelectedFile(path);
    setSelectedFileStaged(staged);
  }, []);

  const handleSubmoduleSelect = useCallback((path: string) => {
    setSelectedFile(null);
    setSelectedFileStaged(false);
    setSelectedSubmodulePath(path);
  }, []);

  const handleStageFile = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.stageFiles(repoPath, [path]);
      showToast(t("toast.stagedFiles", { count: 1, file: getFileName(path) }));
      appendResultLog("success", t("log.stagedFiles", { count: 1, path }), result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stageFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleStageFiles = useCallback(async (paths: string[]) => {
    if (!repoPath || paths.length === 0) return;
    try {
      const result = await api.stageFiles(repoPath, paths);
      showToast(t("toast.stagedFiles", { count: paths.length, file: getFileName(paths[0]) }));
      appendResultLog("success", t("log.stagedFiles", { count: paths.length, path: paths[0] }), result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stageFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleUnstageFile = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.unstageFile(repoPath, path);
      showToast(t("toast.unstagedFiles", { count: 1, file: getFileName(path) }), "info");
      appendResultLog("info", t("log.unstagedFiles", { count: 1, path }), result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.unstageFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleUnstageFiles = useCallback(async (paths: string[]) => {
    if (!repoPath || paths.length === 0) return;
    try {
      const results = await Promise.all(paths.map(path => api.unstageFile(repoPath, path)));
      showToast(t("toast.unstagedFiles", { count: paths.length, file: getFileName(paths[0]) }), "info");
      const backendUsed = results[0]?.backendUsed ?? "unknown";
      appendResultLog("info", t("log.unstagedFiles", { count: paths.length, path: paths[0] }), backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.unstageFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const doRevertFiles = useCallback(async (paths: string[]) => {
    if (!repoPath) return;
    try {
      let backendUsed: ResultLogEntry["backend"] = "unknown";
      for (const path of paths) {
        const result = await api.discardFile(repoPath, path);
        backendUsed = result.backendUsed;
      }
      if (paths.length === 1) {
        showToast(t("toast.revertedFiles", { count: 1, file: getFileName(paths[0]) }), "error");
        appendResultLog("info", t("log.revertedFiles", { count: 1, path: paths[0] }), backendUsed);
      } else {
        showToast(t("toast.revertedFiles", { count: paths.length }), "error");
        appendResultLog("info", t("log.revertedFiles", { count: paths.length }), backendUsed);
      }
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.revertFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleDiscardFile = useCallback((path: string) => {
    if (confirmRevert) { setRevertPendingPaths([path]); } else { void doRevertFiles([path]); }
  }, [confirmRevert, doRevertFiles]);

  const handleDiscardFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    if (confirmRevert || paths.length > 1) { setRevertPendingPaths(paths); } else { void doRevertFiles(paths); }
  }, [confirmRevert, doRevertFiles]);

  const handleDiscardAll = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    setRevertPendingPaths(paths);
  }, []);

  const handleDismissNoDiffToolWarning = useCallback((dontShowAgain: boolean) => {
    setShowNoDiffToolWarning(false);
    if (dontShowAgain) localStorage.setItem("gitmun.hideNoDiffToolWarning", "1");
  }, []);

  const handleRevertConfirm = useCallback(async (dontShowAgain: boolean) => {
    const paths = revertPendingPaths;
    setRevertPendingPaths(null);
    if (!paths) return;
    if (dontShowAgain) {
      onSetConfirmRevert(false);
      await api.setConfirmRevert(false).catch(() => {});
    }
    await doRevertFiles(paths);
  }, [revertPendingPaths, doRevertFiles, onSetConfirmRevert]);

  const handleStageAll = useCallback(async () => {
    if (!repoPath) return;
    try {
      const result = await api.stageAll(repoPath);
      showToast(t("toast.stagedAll"));
      appendResultLog("success", t("log.stagedAll"), result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stageAllFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleUnstageAll = useCallback(async () => {
    if (!repoPath) return;
    try {
      const result = await api.unstageAll(repoPath);
      showToast(t("toast.unstagedAll"), "info");
      appendResultLog("info", t("log.unstagedAll"), result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.unstageAllFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleSelectCommitAction = useCallback(async (action: CommitPrimaryAction) => {
    if (action === commitPrimaryAction) {
      return;
    }

    const previousAction = commitPrimaryAction;
    setCommitPrimaryActionState(action);
    try {
      const settings = await api.setCommitPrimaryAction(action);
      setCommitPrimaryActionState(settings.commitPrimaryAction ?? action);
    } catch (e) {
      setCommitPrimaryActionState(previousAction);
      showToast(String(e), "error");
      appendResultLog("error", t("log.saveCommitActionFailed", { message: String(e) }), "unknown");
    }
  }, [commitPrimaryAction, showToast, t]);

  const runCommitRequest = useCallback(async (message: string, amend: boolean) => {
    if (!repoPath) return false;
    if (rebaseInProgress) {
      showToast(t("toast.commitBlockedByRebase"), "error");
      return false;
    }
    if (cherryPickInProgress) {
      showToast(t("toast.commitBlockedByCherryPick"), "error");
      return false;
    }
    if (revertInProgress) {
      showToast(t("toast.commitBlockedByRevert"), "error");
      return false;
    }
    try {
      const result = await api.commitChanges(repoPath, message, amend);
      showToast(amend ? t("toast.amendedCommit") : t("toast.commitCreated"));
      appendResultLog("success", amend ? t("toast.amendedLatestCommit") : t("toast.createdCommit"), result.backendUsed);
      await refreshAll();
      return true;
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.commitFailed", { message: String(e) }), "unknown");
      return false;
    }
  }, [repoPath, rebaseInProgress, cherryPickInProgress, revertInProgress, refreshAll, showToast, t]);

  const handleCommit = useCallback(async (message: string, amend: boolean) => {
    setIsCommitting(true);
    try {
      await runCommitRequest(message, amend);
    } finally {
      setIsCommitting(false);
    }
  }, [runCommitRequest]);

  const handleFetch = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    try {
      const result = await api.fetchRemote(repoPath);
      showToast(t("toast.fetchComplete"));
      appendResultLog("success", t("toast.fetchComplete"), result.backendUsed);
      await refreshAll();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.fetchFailed", { message: String(e) }), "unknown"); }
    finally { setRemoteOp(null); }
  }, [repoPath, remoteOp, refreshAll, showToast, t]);

  const runPullWithStrategy = useCallback(async (strategy: PullStrategy) => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("pull");
    try {
      const result = await api.pullWithStrategy(repoPath, strategy);
      const conflictStarted = /conflict resolution flow|needs conflict resolution/i.test(result.message);
      if (conflictStarted) {
        showToast(result.message, "info");
        appendResultLog("info", result.message, result.backendUsed);
      } else if (strategy === "ff-only") {
        showToast(t("toast.pullComplete"));
        appendResultLog("success", result.message, result.backendUsed);
      } else {
        showToast(t("toast.integrationComplete"));
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.pullFailed", { message: String(e) }), "unknown"); }
    finally { setRemoteOp(null); }
  }, [repoPath, remoteOp, refreshAll, showToast, t]);

  const startPullFlow = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    try {
      const analysis = await api.analyzePull(repoPath);
      setPushRejectionAnalysis(null);
      switch (analysis.state) {
        case "up_to_date":
          showToast(t("toast.alreadyUpToDate"), "info");
          appendResultLog("info", analysis.message, "unknown");
          return;
        case "behind_only":
          await runPullWithStrategy("ff-only");
          return;
        case "ahead_only":
          showToast(analysis.message, "info");
          appendResultLog("info", analysis.message, "unknown");
          return;
        case "divergent":
          setDivergentPullAnalysis(analysis);
          return;
        case "no_upstream":
        case "detached_head":
        case "blocked_dirty_worktree":
        case "operation_in_progress":
          showToast(analysis.message, "error");
          appendResultLog("error", analysis.message, "unknown");
          return;
      }
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.pullAnalysisFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, remoteOp, runPullWithStrategy, showToast, t]);

  const handlePull = useCallback(async () => {
    await startPullFlow();
  }, [startPullFlow]);

  const handleDivergentPullConfirm = useCallback(async (strategy: PullStrategy) => {
    setDivergentPullAnalysis(null);
    await runPullWithStrategy(strategy);
  }, [runPullWithStrategy]);

  const handlePushFailure = useCallback((result: Awaited<ReturnType<typeof api.pushChanges>>) => {
    if (result.rejection && ["non-fast-forward", "no-upstream", "upstream-missing"].includes(result.rejection.kind)) {
      setPushRejectionAnalysis(result.rejection);
      showToast(result.rejection.message, "error");
      appendResultLog("error", result.rejection.message, result.backendUsed);
      return;
    }

    showToast(result.message, "error");
    appendResultLog("error", result.output?.trim() || result.message, result.backendUsed);
  }, [showToast]);

  const runPushRequest = useCallback(async (
    request: PushRequest,
    successToast: string,
    failurePrefix: string,
  ) => {
    if (!repoPath || remoteOp) {
      return;
    }

    setRemoteOp("push");
    try {
      const result = await api.pushChanges(request);
      if (!result.success) {
        handlePushFailure(result);
        return;
      }
      showToast(successToast);
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.pushFailed", { prefix: failurePrefix, message: String(e) }), "unknown");
    } finally {
      setRemoteOp(null);
    }
  }, [handlePushFailure, refreshAll, remoteOp, repoPath, showToast, t]);

  const handlePush = useCallback(async () => {
    if (!repoPath || remoteOp) {
      return;
    }

    if (remoteActionState.kind === "publish") {
      setPushRejectionAnalysis(null);
      setUpstreamDialogMode("publish");
      return;
    }
    if (remoteActionState.kind === "repair-upstream") {
      setPushRejectionAnalysis(null);
      setUpstreamDialogMode("repair");
      return;
    }
    if (remoteActionState.kind === "detached") {
      showToast(remoteActionTitle ?? t("toast.pushDetached"), "error");
      return;
    }

    await runPushRequest({
      repoPath,
      pushFollowTags,
    }, t("toast.pushComplete"), t("toast.pushFailed"));
  }, [remoteActionState, remoteActionTitle, repoPath, remoteOp, runPushRequest, showToast, pushFollowTags, t]);

  const handleCommitAndPush = useCallback(async (message: string, amend: boolean) => {
    setIsCommitting(true);
    try {
      const committed = await runCommitRequest(message, amend);
      if (!committed) {
        return;
      }
      await handlePush();
    } finally {
      setIsCommitting(false);
    }
  }, [handlePush, runCommitRequest]);

  const handleUpstreamDialogConfirm = useCallback(async (selection: { remote: string; remoteBranch: string }) => {
    if (!repoPath || !currentBranchInfo || !upstreamDialogMode) {
      return;
    }

    const mode = upstreamDialogMode;
    setUpstreamDialogMode(null);

    if (mode === "publish") {
      await runPushRequest({
        repoPath,
        remote: selection.remote,
        remoteBranch: selection.remoteBranch,
        setUpstream: true,
        pushFollowTags,
      }, t("toast.branchPublished"), t("toast.publishFailed"));
      return;
    }

    try {
      const result = await api.setBranchUpstream({
        repoPath,
        branchName: currentBranchInfo.name,
        remote: selection.remote,
        remoteBranch: selection.remoteBranch,
      });
      showToast(mode === "repair" ? t("toast.upstreamRepaired") : t("toast.upstreamChanged"));
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", mode === "repair"
        ? t("log.repairUpstreamFailed", { message: String(e) })
        : t("log.changeUpstreamFailed", { message: String(e) }), "unknown");
    }
  }, [currentBranchInfo, pushFollowTags, refreshAll, repoPath, runPushRequest, showToast, t, upstreamDialogMode]);

  const handlePushRejectedFetch = useCallback(async () => {
    setPushRejectionAnalysis(null);
    await handleFetch();
  }, [handleFetch]);

  const handlePushRejectedIntegrate = useCallback(async () => {
    setPushRejectionAnalysis(null);
    await handleFetch();
    await startPullFlow();
  }, [handleFetch, startPullFlow]);

  const handlePushRejectedPublish = useCallback(() => {
    setPushRejectionAnalysis(null);
    setUpstreamDialogMode("publish");
  }, []);

  const handlePushRejectedRepairUpstream = useCallback(() => {
    setPushRejectionAnalysis(null);
    setUpstreamDialogMode("repair");
  }, []);

  const handleStash = useCallback(() => {
    if (!repoPath) return;
    if (!hasWorkingTreeChanges) {
      showToast(t("toast.noLocalChangesToStash"), "info");
      return;
    }
    setShowStashDialog(true);
  }, [repoPath, hasWorkingTreeChanges, showToast, t]);

  const handleStashConfirm = useCallback(async (opts: {
    message: string | null;
    includeUntracked: boolean;
    paths: string[] | null;
  }) => {
    if (!repoPath) return;
    setShowStashDialog(false);
    try {
      const result = await api.stash(repoPath, opts.message, opts.includeUntracked, opts.paths ?? []);
      const output = result.output?.trim();
      const noChanges = output ? /no local changes to save/i.test(output) : false;
      if (noChanges) {
        showToast(t("toast.noLocalChangesToStash"), "info");
        appendResultLog("info", output ?? result.message, result.backendUsed);
      } else {
        showToast(t("toast.changesStashed"), "success");
        appendResultLog("success", output || result.message, result.backendUsed);
      }
      await Promise.all([refreshStatus(), refreshStashes()]);
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stashFailed", { message: String(e) }), "unknown"); }
  }, [repoPath, refreshStatus, refreshStashes, showToast, t]);

  const handleStashApply = useCallback(async (stashIndex: number) => {
    if (!repoPath || stashBusy) return;
    setStashBusy(true);
    try {
      const result = await api.stashApply(repoPath, stashIndex);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stashApplyFailed", { message: String(e) }), "unknown"); }
    finally { setStashBusy(false); }
  }, [repoPath, stashBusy, refreshStatus, showToast, t]);

  const handleStashPop = useCallback(async (stashIndex: number) => {
    if (!repoPath || stashBusy) return;
    setStashBusy(true);
    try {
      const result = await api.stashPop(repoPath, stashIndex);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await Promise.all([refreshStatus(), refreshStashes()]);
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stashPopFailed", { message: String(e) }), "unknown"); }
    finally { setStashBusy(false); }
  }, [repoPath, stashBusy, refreshStatus, refreshStashes, showToast, t]);

  const handleStashDrop = useCallback(async (stash: StashEntry) => {
    if (!repoPath || stashBusy) return;
    const confirmed = await ask(buildStashDropPrompt(stash, t), {
      title: t("ask.dropStash.title"), kind: "warning", okLabel: t("actions.drop"), cancelLabel: t("actions.cancel"),
    });
    if (!confirmed) return;
    setStashBusy(true);
    try {
      const result = await api.stashDrop(repoPath, stash.index);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshStashes();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", t("log.stashDropFailed", { message: String(e) }), "unknown"); }
    finally { setStashBusy(false); }
  }, [repoPath, stashBusy, refreshStashes, showToast, t]);

  const handleHunkAction = useCallback(async (hunkIndex: number) => {
    if (!repoPath || !selectedFile || hunkActionBusy) return;
    setHunkActionBusy(true);
    try {
      if (selectedFileStaged) {
        await api.unstageHunk(repoPath, selectedFile, hunkIndex);
        showToast(t("toast.unstagedHunk"));
      } else {
        await api.stageHunk(repoPath, selectedFile, hunkIndex);
        showToast(t("toast.stagedHunk"));
      }
      await refreshStatus();
      setDiffRefreshKey(prev => prev + 1);
    } catch (e) { showToast(String(e), "error"); }
    finally { setHunkActionBusy(false); }
  }, [repoPath, selectedFile, selectedFileStaged, hunkActionBusy, refreshStatus, showToast, t]);

  const handleOpenCommitFileDiff = useCallback(async (filePath: string) => {
    if (!repoPath || !selectedCommitHash) return;
    try {
      const result = await api.openExternalDiff(repoPath, selectedCommitHash, filePath);
      showToast(result.message || t("toast.openedDiffFor", { file: getFileName(filePath) }));
    } catch (e) { showToast(String(e), "error"); }
  }, [repoPath, selectedCommitHash, showToast, t]);

  const handleCompareCurrentFile = useCallback(async () => {
    if (!repoPath || !selectedFile) return;
    try {
      const result = await api.openWorkingTreeDiff(repoPath, selectedFile, selectedFileStaged);
      showToast(result.message || t("toast.openedDiffFor", { file: getFileName(selectedFile) }));
    } catch (e) { showToast(String(e), "error"); }
  }, [repoPath, selectedFile, selectedFileStaged, showToast, t]);

  const stashBeforeBranchSwitch = useCallback(async (targetRef: string): Promise<{ proceed: boolean; stashedRef: string | null }> => {
    if (!repoPath || !hasWorkingTreeChanges) {
      return { proceed: true, stashedRef: null };
    }

    const confirmed = await ask(
      t("ask.stashBeforeSwitch.message", { target: targetRef }),
      {
        title: t("ask.stashBeforeSwitch.title"),
        kind: "warning",
        okLabel: t("actions.stashAndSwitch"),
        cancelLabel: t("actions.cancel"),
      },
    );

    if (!confirmed) {
      return { proceed: false, stashedRef: null };
    }

    try {
      const stashResult = await api.stash(repoPath, null, false, []);
      const stashOutput = stashResult.output?.trim();
      const stashedRef = extractStashRef(stashOutput);
      const noChanges = stashOutput ? /no local changes to save/i.test(stashOutput) : false;

      if (noChanges) {
        appendResultLog("info", stashOutput ?? stashResult.message, stashResult.backendUsed);
      } else {
        appendResultLog("success", stashOutput || t("log.branchSwitchStash"), stashResult.backendUsed);
      }

      return { proceed: true, stashedRef };
    } catch (e) {
      showToast(t("toast.stashFailedBranchNotSwitched"), "error");
      appendResultLog("error", t("log.stashBeforeSwitchFailed", { message: String(e) }), "unknown");
      return { proceed: false, stashedRef: null };
    }
  }, [repoPath, hasWorkingTreeChanges, showToast, t]);

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast(t("toast.cannotSwitchDuringCherryPick"), "error");
      return;
    }
    if (rebaseInProgress) {
      showToast(t("toast.cannotSwitchDuringRebase"), "error");
      return;
    }
    if (mergeInProgress) {
      showToast(t("toast.cannotSwitchDuringMerge"), "error");
      return;
    }

    if (currentBranch === branchName) {
      return;
    }

    const { proceed, stashedRef } = await stashBeforeBranchSwitch(branchName);
    if (!proceed) {
      return;
    }

    try {
      const result = await api.switchBranch(repoPath, branchName);
      if (stashedRef) {
        showToast(t("toast.switchedWithStash", { message: result.message, stashRef: stashedRef }), "success");
      } else {
        showToast(result.message, "success");
      }
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      if (stashedRef) {
        const recoveryMessage = t("toast.switchFailedAfterStash", { stashRef: stashedRef });
        showToast(recoveryMessage, "error");
        appendResultLog("error", t("log.switchFailedAfterStash", { recoveryMessage, message: String(e) }), "unknown");
      } else if (hasWorkingTreeChanges) {
        const recoveryMessage = t("toast.switchFailedAfterGenericStash");
        showToast(recoveryMessage, "error");
        appendResultLog("error", t("log.switchFailedAfterStash", { recoveryMessage, message: String(e) }), "unknown");
      } else {
        showToast(String(e), "error");
        appendResultLog("error", t("log.switchBranchFailed", { message: String(e) }), "unknown");
      }
      await refreshStatus();
    }
  }, [repoPath, cherryPickInProgress, rebaseInProgress, mergeInProgress, currentBranch, hasWorkingTreeChanges, refreshAll, refreshStatus, showToast, stashBeforeBranchSwitch, t]);

  const handleCreateBranch = useCallback(async (request: CreateBranchRequest) => {
    if (!repoPath) return;
    try {
      const result = await api.createBranch(request);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.createBranchFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleOpenPublishDialog = useCallback(() => {
    setPushRejectionAnalysis(null);
    setUpstreamDialogMode("publish");
  }, []);

  const handleOpenRepairUpstreamDialog = useCallback(() => {
    setPushRejectionAnalysis(null);
    setUpstreamDialogMode("repair");
  }, []);

  const handleOpenChangeUpstreamDialog = useCallback(() => {
    setPushRejectionAnalysis(null);
    setUpstreamDialogMode("change");
  }, []);

  const handleDeleteBranch = useCallback(async (branchName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(t("ask.deleteBranch.message", { branch: branchName }), {
      title: t("ask.deleteBranch.title"), kind: "warning", okLabel: t("actions.delete"), cancelLabel: t("actions.cancel"),
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteBranch({ repoPath, branchName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.deleteBranchFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleBeginRenameBranch = useCallback((branchName: string) => {
    setRenamePendingBranch(branchName);
  }, []);

  const handleRenameBranchConfirm = useCallback(async (newName: string) => {
    if (!repoPath || !renamePendingBranch) return;
    const oldName = renamePendingBranch;
    setRenamePendingBranch(null);

    try {
      const result = await api.renameBranch({ repoPath, oldName, newName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.renameBranchFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, renamePendingBranch, refreshAll, showToast, t]);

  const handleForceDeleteBranch = useCallback(async (branchName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(
      t("ask.forceDeleteBranch.message", { branch: branchName }),
      { title: t("ask.forceDeleteBranch.title"), kind: "warning", okLabel: t("actions.forceDelete"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;
    try {
      const result = await api.deleteBranch({ repoPath, branchName, force: true });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.forceDeleteBranchFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleDeleteTag = useCallback(async (tagName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(t("ask.deleteTag.message", { tag: tagName }), {
      title: t("ask.deleteTag.title"), kind: "warning", okLabel: t("actions.delete"), cancelLabel: t("actions.cancel"),
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteTag({ repoPath, tagName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.deleteTagFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleCreateTag = useCallback(async (tagName: string, message: string | null) => {
    if (!repoPath) return;
    setShowCreateTagDialog(false);
    setCreateTagTarget(null);
    try {
      const result = await api.createTag({ repoPath, tagName, message, target: createTagTarget });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.createTagFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, createTagTarget, refreshAll, showToast, t]);

  const handlePushTag = useCallback(async (tagName: string) => {
    if (!repoPath) return;
    const remote = remotes[0]?.name;
    if (!remote) { showToast(t("toast.noRemotesConfigured"), "error"); return; }
    try {
      const result = await api.pushTag({ repoPath, remote, tagName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.pushTagFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, remotes, showToast, t]);

  const handleDeleteRemoteTag = useCallback(async (tagName: string) => {
    if (!repoPath) return;
    const remote = remotes[0]?.name;
    if (!remote) { showToast(t("toast.noRemotesConfigured"), "error"); return; }
    const confirmed = await ask(t("ask.deleteRemoteTag.message", { tag: tagName, remote }), {
      title: t("ask.deleteRemoteTag.title"), kind: "warning", okLabel: t("actions.delete"), cancelLabel: t("actions.cancel"),
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteRemoteTag({ repoPath, remote, tagName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.deleteRemoteTagFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, remotes, refreshAll, showToast, t]);

  const handleCreateBranchFromTag = useCallback((tagName: string) => {
    setCreateBranchFromTagName(tagName);
  }, []);

  const handleCreateTagAtCommit = useCallback((commitHash: string) => {
    setCreateTagTarget(commitHash);
    setShowCreateTagDialog(true);
  }, []);

  const handleCherryPickAtCommit = useCallback(async (commitHash: string) => {
    if (!repoPath) return;
    if (mergeInProgress) {
      showToast(t("toast.cannotCherryPickDuringMerge"), "error");
      return;
    }
    if (rebaseInProgress) {
      showToast(t("toast.cannotCherryPickDuringRebase"), "error");
      return;
    }
    if (cherryPickInProgress) {
      showToast(t("toast.cherryPickAlreadyInProgress"), "error");
      return;
    }
    if (hasWorkingTreeChanges) {
      showToast(t("toast.cherryPickBlockedByChanges"), "error");
      return;
    }

    const confirmed = await ask(
      t("ask.cherryPickCommit.message", { commit: commitHash.slice(0, 12), branch: currentBranch ?? t("labels.currentBranch") }),
      { title: t("ask.cherryPickCommit.title"), kind: "warning", okLabel: t("actions.cherryPick"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;

    setIsCherryPickActionRunning(true);
    try {
      const result = await api.cherryPickStart({ repoPath, commitHash });
      if (result.hasConflicts) {
        showToast(t("toast.cherryPickConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCentreTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.cherryPickFailed", { message: String(e) }), "unknown");
    } finally {
      setIsCherryPickActionRunning(false);
    }
  }, [repoPath, mergeInProgress, rebaseInProgress, cherryPickInProgress, hasWorkingTreeChanges, currentBranch, refreshAll, showToast, t]);

  const handleDeleteRemoteBranch = useCallback(async (remote: string, branch: string) => {
    if (!repoPath) return;
    const confirmed = await ask(t("ask.deleteRemoteBranch.message", { remote, branch }), {
      title: t("ask.deleteRemoteBranch.title"), kind: "warning", okLabel: t("actions.delete"), cancelLabel: t("actions.cancel"),
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteRemoteBranch({ repoPath, remote, branch });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.deleteRemoteBranchFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleCheckoutRemoteBranch = useCallback(async (remoteBranchName: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast(t("toast.cannotSwitchDuringCherryPick"), "error");
      return;
    }
    if (rebaseInProgress) {
      showToast(t("toast.cannotSwitchDuringRebase"), "error");
      return;
    }
    if (mergeInProgress) {
      showToast(t("toast.cannotSwitchDuringMerge"), "error");
      return;
    }

    const localBranchName = deriveLocalBranchName(remoteBranchName);
    if (!localBranchName) {
      showToast(t("toast.cannotCheckoutRemoteRef", { remoteBranch: remoteBranchName }), "error");
      return;
    }

    const existingLocal = branches.find(b => !b.isRemote && b.name === localBranchName);
    if (existingLocal) {
      await handleSwitchBranch(localBranchName);
      return;
    }

    const { proceed, stashedRef } = await stashBeforeBranchSwitch(remoteBranchName);
    if (!proceed) {
      return;
    }

    try {
      const result = await api.createBranch({
        repoPath,
        branchName: localBranchName,
        baseRef: remoteBranchName,
        checkoutAfterCreation: true,
        trackRemote: true,
        matchTrackingBranch: true,
      });
      if (stashedRef) {
        showToast(t("toast.switchedWithStash", { message: result.message, stashRef: stashedRef }), "success");
      } else {
        showToast(result.message, "success");
      }
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      if (stashedRef) {
        const recoveryMessage = t("toast.checkoutFailedAfterStash", { stashRef: stashedRef });
        showToast(recoveryMessage, "error");
        appendResultLog("error", t("log.switchFailedAfterStash", { recoveryMessage, message: String(e) }), "unknown");
      } else {
        showToast(String(e), "error");
        appendResultLog("error", t("log.checkoutFailed", { message: String(e) }), "unknown");
      }
      await refreshStatus();
    }
  }, [repoPath, cherryPickInProgress, rebaseInProgress, mergeInProgress, branches, handleSwitchBranch, refreshAll, refreshStatus, showToast, stashBeforeBranchSwitch, t]);

  const handleAddRemote = useCallback(async (name: string, url: string) => {
    if (!repoPath) return;
    setShowAddRemoteDialog(false);
    try {
      const result = await api.addRemote({ repoPath, name, url });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.addRemoteFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleRemoveRemote = useCallback(async (remoteName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(
      t("ask.removeRemote.message", { remote: remoteName }),
      { title: t("ask.removeRemote.title"), kind: "warning", okLabel: t("actions.remove"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;
    try {
      const result = await api.removeRemote({ repoPath, name: remoteName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.removeRemoteFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleEditRemoteConfirm = useCallback(async (newName: string, newUrl: string) => {
    if (!repoPath || !editingRemote) return;
    const remote = editingRemote;
    setEditingRemote(null);
    let renamedTo: string | null = null;
    try {
      if (remote.name !== newName) {
        const result = await api.renameRemote({ repoPath, oldName: remote.name, newName });
        renamedTo = newName;
        appendResultLog("success", result.message, result.backendUsed);
      }
      const effectiveName = renamedTo ?? remote.name;
      if (remote.url !== newUrl) {
        const result = await api.setRemoteUrl({ repoPath, name: effectiveName, url: newUrl });
        appendResultLog("success", result.message, result.backendUsed);
      }
      showToast(t("toast.remoteUpdated"), "success");
      await refreshAll();
    } catch (e) {
      const failureMessage = renamedTo
        ? t("log.remoteRenamedUrlFailed", { remote: renamedTo, message: String(e) })
        : t("log.editRemoteFailed", { message: String(e) });
      showToast(failureMessage, "error");
      appendResultLog("error", failureMessage, "unknown");
      await refreshAll();
    }
  }, [repoPath, editingRemote, refreshAll, showToast, t]);

  const handleFetchSingleRemote = useCallback(async (remoteName: string) => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    try {
      const result = await api.fetchRemote(repoPath, remoteName);
      showToast(t("toast.fetchedFrom", { remote: remoteName }), "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.fetchRemoteFailed", { remote: remoteName, message: String(e) }), "unknown");
    } finally {
      setRemoteOp(null);
    }
  }, [repoPath, remoteOp, refreshAll, showToast, t]);

  const handlePruneRemote = useCallback(async (remoteName: string) => {
    if (!repoPath) return;
    try {
      const result = await api.pruneRemote({ repoPath, name: remoteName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.pruneRemoteFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleExternalDiff = useCallback(async (path: string, staged: boolean) => {
    if (!repoPath) return;
    try {
      const result = await api.openWorkingTreeDiff(repoPath, path, staged);
      showToast(result.message || t("toast.openedDiffFor", { file: getFileName(path) }));
    } catch (e) { showToast(String(e), "error"); }
  }, [repoPath, showToast, t]);

  const runSubmoduleAction = useCallback(async (
    path: string,
    label: string,
    action: (request: { repoPath: string; path: string; recursive?: boolean }) => Promise<{ message: string; backendUsed: ResultLogEntry["backend"] }>,
  ) => {
    if (!repoPath) return;
    try {
      const result = await action({ repoPath, path, recursive: false });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshStatus();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.submoduleFailed", { action: label, message: String(e) }), "unknown");
    }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleSubmoduleInit = useCallback((path: string) => {
    void runSubmoduleAction(path, t("submoduleActions.initialise"), api.submoduleInit);
  }, [runSubmoduleAction, t]);

  const handleSubmoduleUpdate = useCallback((path: string) => {
    void runSubmoduleAction(path, t("submoduleActions.update"), api.submoduleUpdate);
  }, [runSubmoduleAction, t]);

  const handleSubmoduleSync = useCallback((path: string) => {
    void runSubmoduleAction(path, t("submoduleActions.sync"), api.submoduleSync);
  }, [runSubmoduleAction, t]);

  const handleSubmoduleFetch = useCallback((path: string) => {
    void runSubmoduleAction(path, t("submoduleActions.fetch"), api.submoduleFetch);
  }, [runSubmoduleAction, t]);

  const handleSubmodulePull = useCallback((path: string) => {
    void runSubmoduleAction(path, t("submoduleActions.pull"), api.submodulePull);
  }, [runSubmoduleAction, t]);

  const handleSubmoduleOpen = useCallback((path: string) => {
    if (!repoPath) return;
    const separator = repoPath.includes("\\") ? "\\" : "/";
    const base = repoPath.replace(/[\\/]+$/, "");
    const submodulePath = `${base}${separator}${path.replace(/\//g, separator)}`;
    onRepoSelect(submodulePath);
  }, [repoPath, onRepoSelect]);

  const handleMergeBranch = useCallback((branchName: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast(t("toast.cannotMergeDuringCherryPick"), "error");
      return;
    }
    if (rebaseInProgress) {
      showToast(t("toast.cannotMergeDuringRebase"), "error");
      return;
    }
    if (stagedFiles.length > 0 || unstagedFiles.length > 0 || unversionedFiles.length > 0) {
      showToast(t("toast.mergeBlockedByChanges"), "error");
      return;
    }
    setMergePendingBranch(branchName);
  }, [repoPath, cherryPickInProgress, rebaseInProgress, stagedFiles, unstagedFiles, unversionedFiles, showToast, t]);

  const handleRebaseBranch = useCallback(async (ontoBranch: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast(t("toast.cannotRebaseDuringCherryPick"), "error");
      return;
    }
    if (mergeInProgress) {
      showToast(t("toast.cannotRebaseDuringMerge"), "error");
      return;
    }
    if (rebaseInProgress) {
      showToast(t("toast.rebaseAlreadyInProgress"), "error");
      return;
    }
    if (!currentBranch || currentBranch === ontoBranch) {
      showToast(t("toast.chooseDifferentRebaseBranch"), "error");
      return;
    }
    if (hasWorkingTreeChanges) {
      showToast(t("toast.rebaseBlockedByChanges"), "error");
      return;
    }

    const confirmed = await ask(
      t("ask.startRebase.message", { branch: currentBranch, onto: ontoBranch }),
      { title: t("ask.startRebase.title"), kind: "warning", okLabel: t("actions.rebase"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;

    setIsRebaseActionRunning(true);
    try {
      const result = await api.rebaseStart({ repoPath, onto: ontoBranch });
      if (result.hasConflicts) {
        showToast(t("toast.rebaseConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCentreTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.rebaseFailed", { message: String(e) }), "unknown");
    } finally {
      setIsRebaseActionRunning(false);
    }
  }, [repoPath, cherryPickInProgress, mergeInProgress, rebaseInProgress, currentBranch, hasWorkingTreeChanges, refreshAll, showToast, t]);

  const handleRebaseContinue = useCallback(async () => {
    if (!repoPath || !rebaseInProgress) return;
    setIsRebaseActionRunning(true);
    try {
      const result = await api.rebaseContinue(repoPath);
      if (result.hasConflicts) {
        showToast(t("toast.rebaseConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCentreTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.rebaseContinueFailed", { message: String(e) }), "unknown");
    } finally {
      setIsRebaseActionRunning(false);
    }
  }, [repoPath, rebaseInProgress, refreshAll, showToast, t]);

  const handleRebaseAbort = useCallback(async () => {
    if (!repoPath || !rebaseInProgress) return;
    const confirmed = await ask(
      t("ask.abortRebase.message"),
      { title: t("ask.abortRebase.title"), kind: "warning", okLabel: t("actions.abort"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;

    setIsRebaseActionRunning(true);
    try {
      const result = await api.rebaseAbort(repoPath);
      showToast(result.message, "info");
      appendResultLog("info", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.rebaseAbortFailed", { message: String(e) }), "unknown");
    } finally {
      setIsRebaseActionRunning(false);
    }
  }, [repoPath, rebaseInProgress, refreshAll, showToast, t]);

  const handleCherryPickContinue = useCallback(async () => {
    if (!repoPath || !cherryPickInProgress) return;
    setIsCherryPickActionRunning(true);
    try {
      const result = await api.cherryPickContinue(repoPath);
      if (result.hasConflicts) {
        showToast(t("toast.cherryPickConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCentreTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.cherryPickContinueFailed", { message: String(e) }), "unknown");
    } finally {
      setIsCherryPickActionRunning(false);
    }
  }, [repoPath, cherryPickInProgress, refreshAll, showToast, t]);

  const handleCherryPickAbort = useCallback(async () => {
    if (!repoPath || !cherryPickInProgress) return;
    const confirmed = await ask(
      t("ask.abortCherryPick.message"),
      { title: t("ask.abortCherryPick.title"), kind: "warning", okLabel: t("actions.abort"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;

    setIsCherryPickActionRunning(true);
    try {
      const result = await api.cherryPickAbort(repoPath);
      showToast(result.message, "info");
      appendResultLog("info", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.cherryPickAbortFailed", { message: String(e) }), "unknown");
    } finally {
      setIsCherryPickActionRunning(false);
    }
  }, [repoPath, cherryPickInProgress, refreshAll, showToast, t]);

  const handleRevertAtCommit = useCallback(async (commitHash: string) => {
    if (!repoPath) return;
    if (mergeInProgress) {
      showToast(t("toast.cannotRevertDuringMerge"), "error");
      return;
    }
    if (rebaseInProgress) {
      showToast(t("toast.cannotRevertDuringRebase"), "error");
      return;
    }
    if (cherryPickInProgress) {
      showToast(t("toast.cannotRevertDuringCherryPick"), "error");
      return;
    }
    if (revertInProgress) {
      showToast(t("toast.revertAlreadyInProgress"), "error");
      return;
    }
    if (hasWorkingTreeChanges) {
      showToast(t("toast.revertBlockedByChanges"), "error");
      return;
    }

    const confirmed = await ask(
      t("ask.revertCommit.message", { commit: commitHash.slice(0, 12), branch: currentBranch ?? t("labels.currentBranch") }),
      { title: t("ask.revertCommit.title"), kind: "warning", okLabel: t("actions.revert"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;

    setIsRevertActionRunning(true);
    try {
      const result = await api.revertCommitStart(repoPath, commitHash);
      if (result.hasConflicts) {
        showToast(t("toast.revertConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCentreTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.revertFailed", { message: String(e) }), "unknown");
    } finally {
      setIsRevertActionRunning(false);
    }
  }, [repoPath, mergeInProgress, rebaseInProgress, cherryPickInProgress, revertInProgress, hasWorkingTreeChanges, currentBranch, refreshAll, showToast, t]);

  const handleRevertContinue = useCallback(async () => {
    if (!repoPath || !revertInProgress) return;
    setIsRevertActionRunning(true);
    try {
      const result = await api.revertContinue(repoPath);
      if (result.hasConflicts) {
        showToast(t("toast.revertConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCentreTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.revertContinueFailed", { message: String(e) }), "unknown");
    } finally {
      setIsRevertActionRunning(false);
    }
  }, [repoPath, revertInProgress, refreshAll, showToast, t]);

  const handleRevertAbort = useCallback(async () => {
    if (!repoPath || !revertInProgress) return;
    const confirmed = await ask(
      t("ask.abortRevert.message"),
      { title: t("ask.abortRevert.title"), kind: "warning", okLabel: t("actions.abort"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;

    setIsRevertActionRunning(true);
    try {
      const result = await api.revertAbort(repoPath);
      showToast(result.message, "info");
      appendResultLog("info", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.revertAbortFailed", { message: String(e) }), "unknown");
    } finally {
      setIsRevertActionRunning(false);
    }
  }, [repoPath, revertInProgress, refreshAll, showToast, t]);

  const handleResetToCommit = useCallback(async (commitHash: string, mode: "soft" | "mixed") => {
    if (!repoPath) return;
    const modeLabel = mode === "soft" ? t("ask.resetToCommit.softMode") : t("ask.resetToCommit.mixedMode");
    const modeDesc = mode === "soft"
      ? t("ask.resetToCommit.softDescription")
      : t("ask.resetToCommit.mixedDescription");
    const confirmed = await ask(
      t("ask.resetToCommit.message", { mode: modeLabel, commit: commitHash.slice(0, 12), description: modeDesc }),
      { title: t("ask.resetToCommit.title", { mode: modeLabel }), kind: "warning", okLabel: t("actions.reset"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;
    try {
      const result = await api.resetTo(repoPath, commitHash, mode);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.resetFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleMergeConfirm = useCallback(async (strategy: MergeStrategy) => {
    if (!repoPath || !mergePendingBranch) return;
    setMergePendingBranch(null);
    try {
      const options = {
        noFf: strategy === "no-ff",
        ffOnly: strategy === "ff-only",
      };
      const result = await api.mergeBranch(repoPath, mergePendingBranch, options);
      if (result.hasConflicts) {
        showToast(t("toast.mergeConflicts", { count: result.conflictedFiles.length }), "error");
        appendResultLog("error", result.message, result.backendUsed);
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
      setCentreTab("changes");
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.mergeFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, mergePendingBranch, refreshAll, showToast, t]);

  const handleMergeAbort = useCallback(async () => {
    if (!repoPath) return;
    const confirmed = await ask(
      t("ask.abortMerge.message"),
      { title: t("ask.abortMerge.title"), kind: "warning", okLabel: t("actions.abort"), cancelLabel: t("actions.cancel") },
    );
    if (!confirmed) return;
    try {
      const result = await api.mergeAbort(repoPath);
      showToast(result.message, "info");
      appendResultLog("info", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.mergeAbortFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshAll, showToast, t]);

  const handleConflictAcceptTheirs = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.conflictAcceptTheirs(repoPath, path);
      showToast(t("toast.acceptedTheirs", { file: getFileName(path) }));
      appendResultLog("success", t("log.acceptedTheirs", { path }), result.backendUsed);
      await refreshStatus();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.acceptTheirsFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleConflictAcceptOurs = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.conflictAcceptOurs(repoPath, path);
      showToast(t("toast.acceptedOurs", { file: getFileName(path) }));
      appendResultLog("success", t("log.acceptedOurs", { path }), result.backendUsed);
      await refreshStatus();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", t("log.acceptOursFailed", { message: String(e) }), "unknown");
    }
  }, [repoPath, refreshStatus, showToast, t]);

  const handleOpenMergeTool = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      await api.openMergeTool(repoPath, path);
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [repoPath, showToast]);

  const compareCurrentFileLabel = repoDiffToolName
    ? t("labels.compareInTool", { tool: repoDiffToolName })
    : t("labels.compareInDiffTool");

  useEffect(() => {
    const isMac = platform === "macos";
    const handler = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const target = e.target as HTMLElement;
      const inInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";

      if (mod && e.key === "Enter") { e.preventDefault(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "a") { e.preventDefault(); handleStageAll(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); handlePush(); return; }
      if (mod && e.key === ",") { e.preventDefault(); onSettingsClick(); return; }
      if (mod && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setCentreTab("log");
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); handleFetch(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === "l") { e.preventDefault(); handlePull(); return; }
      if (inInput) return;
      if (e.key === "s" && selectedFile && isUnstaged) { e.preventDefault(); handleStageFile(selectedFile); return; }
      if (e.key === "u" && selectedFile && !isUnstaged) { e.preventDefault(); handleUnstageFile(selectedFile); return; }
      if (e.key === "r") { e.preventDefault(); refreshAll(); return; }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [platform, selectedFile, isUnstaged, handleStageFile, handleUnstageFile, handleStageAll,
    handlePush, handleFetch, handlePull, onSettingsClick, refreshAll]);

  return (
    <>
      <IdentityPanel
        open={identityOpen}
        onClose={onIdentityToggle}
        localIdentity={localIdentity}
        globalIdentity={globalIdentity}
        localIdentitySaving={localIdentitySaving}
        globalIdentitySaving={globalIdentitySaving}
        onSaveLocalIdentity={handleSaveLocalIdentity}
        onSaveGlobalIdentity={handleSaveGlobalIdentity}
        onScopeChange={setIdentityScope}
      />

      {showNoDiffToolWarning && (
        <NoDiffToolWarning
          platform={platform}
          onDismiss={handleDismissNoDiffToolWarning}
          onOpenSettings={onSettingsClick}
        />
      )}

      {revertPendingPaths && (
        <ConfirmRevertDialog
          filePaths={revertPendingPaths}
          onConfirm={handleRevertConfirm}
          onCancel={() => setRevertPendingPaths(null)}
        />
      )}

      {mergePendingBranch && (
        <MergeDialog
          sourceBranch={mergePendingBranch}
          targetBranch={currentBranch ?? t("labels.currentBranch")}
          onConfirm={handleMergeConfirm}
          onCancel={() => setMergePendingBranch(null)}
        />
      )}

      {divergentPullAnalysis && (
        <DivergentPullDialog
          analysis={divergentPullAnalysis}
          onConfirm={handleDivergentPullConfirm}
          onCancel={() => setDivergentPullAnalysis(null)}
        />
      )}

      {pushRejectionAnalysis && (
        <PushRejectedDialog
          analysis={pushRejectionAnalysis}
          onFetch={handlePushRejectedFetch}
          onIntegrate={handlePushRejectedIntegrate}
          onPublish={handlePushRejectedPublish}
          onRepairUpstream={handlePushRejectedRepairUpstream}
          onCancel={() => setPushRejectionAnalysis(null)}
        />
      )}

      {upstreamDialogMode && currentBranchInfo && (
        <UpstreamDialog
          mode={upstreamDialogMode}
          branchName={currentBranchInfo.name}
          remotes={remotes}
          remoteBranches={remoteBranches}
          initialUpstream={currentBranchInfo.upstream}
          onConfirm={handleUpstreamDialogConfirm}
          onCancel={() => setUpstreamDialogMode(null)}
        />
      )}

      {renamePendingBranch && repoPath && (
        <RenameBranchDialog
          currentName={renamePendingBranch}
          existingBranchNames={branches.filter(b => !b.isRemote).map(b => b.name)}
          onConfirm={handleRenameBranchConfirm}
          onCancel={() => setRenamePendingBranch(null)}
        />
      )}

      {showAddRemoteDialog && repoPath && (
        <AddRemoteDialog
          existingRemoteNames={remotes.map(r => r.name)}
          onConfirm={handleAddRemote}
          onCancel={() => setShowAddRemoteDialog(false)}
        />
      )}

      {editingRemote && repoPath && (
        <EditRemoteDialog
          currentName={editingRemote.name}
          currentUrl={editingRemote.url}
          existingRemoteNames={remotes.map(r => r.name)}
          onConfirm={handleEditRemoteConfirm}
          onCancel={() => setEditingRemote(null)}
        />
      )}

      {showCreateTagDialog && repoPath && (
        <CreateTagDialog
          existingTagNames={tags.map(t => t.name)}
          targetCommit={createTagTarget}
          onConfirm={handleCreateTag}
          onCancel={() => { setShowCreateTagDialog(false); setCreateTagTarget(null); }}
        />
      )}

      {createBranchFromTagName && repoPath && (
        <CreateBranchDialog
          repoPath={repoPath}
          branches={branches}
          tags={tags}
          initialRevisionType="tag"
          initialRevision={createBranchFromTagName}
          onConfirm={handleCreateBranch}
          onCancel={() => setCreateBranchFromTagName(null)}
        />
      )}

      {showStashDialog && (
        <StashPushDialog
          stagedFiles={stagedFiles}
          unstagedFiles={unstagedFiles}
          unversionedFiles={unversionedFiles}
          onConfirm={handleStashConfirm}
          onCancel={() => setShowStashDialog(false)}
        />
      )}

      <div className="app__frame" style={{
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        flex: 1,
        borderRadius: winRadius,
        border: "none",
        boxShadow: "none",
      }}>
        <Titlebar
          platform={platform}
          native={isNative}
          repoPath={repoPath}
          currentBranch={currentBranch}
          branches={branches}
          identityInitials={initials}
          identityAvatarUrl={identityAvatar}
          onAboutClick={onAboutClick}
          onSettingsClick={onSettingsClick}
          onIdentityClick={onIdentityToggle}
          recentRepos={recentRepos}
          searchQuery={searchQuery}
          searchInputRef={searchInputRef}
          onSearchChange={(q) => {
            setSearchQuery(q);
            if (q) setCentreTab("log");
          }}
          onCloneClick={onCloneClick}
          onInitRepoClick={onInitRepoClick}
          onOpenExistingClick={onOpenExistingClick}
          onRepoSelect={onRepoSelect}
          onFetch={handleFetch}
          onPull={handlePull}
          onPush={handlePush}
          pushLabel={remoteActionLabel}
          pushDisabled={remoteActionState.disabled}
          pushTitle={remoteActionTitle}
          onStash={handleStash}
          remoteOp={remoteOp}
          identityOpen={identityOpen}
        />

        <div className="app__body" ref={appBodyRef}>
          {repoPath ? (
            <>
              {!leftPaneCollapsed && (
                <>
                  <div className="app__pane app__pane--left" style={{ width: leftPaneWidth }}>
                    <div className="app__pane app__pane--left-content">
                      <Sidebar
                        branches={branches}
                        tags={tags}
                        remotes={remotes}
                        stashes={stashes}
                        repoPath={repoPath}
                        onSwitchBranch={handleSwitchBranch}
                        onCreateBranch={handleCreateBranch}
                        onRenameBranch={handleBeginRenameBranch}
                        onDeleteBranch={handleDeleteBranch}
                        onForceDeleteBranch={handleForceDeleteBranch}
                        onPublishBranch={handleOpenPublishDialog}
                        onRepairUpstream={handleOpenRepairUpstreamDialog}
                        onChangeUpstream={handleOpenChangeUpstreamDialog}
                        onDeleteTag={handleDeleteTag}
                        onCreateTag={() => { setCreateTagTarget(null); setShowCreateTagDialog(true); }}
                        onPushTag={handlePushTag}
                        onDeleteRemoteTag={handleDeleteRemoteTag}
                        onCreateBranchFromTag={handleCreateBranchFromTag}
                        onMergeBranch={handleMergeBranch}
                        onRebaseBranch={handleRebaseBranch}
                        onCheckoutRemoteBranch={handleCheckoutRemoteBranch}
                        onDeleteRemoteBranch={handleDeleteRemoteBranch}
                        onAddRemote={() => setShowAddRemoteDialog(true)}
                        onFetchRemote={handleFetchSingleRemote}
                        onPruneRemote={handlePruneRemote}
                        onEditRemote={remote => setEditingRemote(remote)}
                        onRemoveRemote={handleRemoveRemote}
                        onStashApply={handleStashApply}
                        onStashPop={handleStashPop}
                        onStashDrop={handleStashDrop}
                        stashBusy={stashBusy}
                      />
                    </div>
                    <button
                      className="app__left-pane-toggle app__left-pane-toggle--hide"
                      type="button"
                      onClick={() => {
                        onSetDraggingPane(null);
                        onSetLeftPaneCollapsed(true);
                      }}
                      title={t("labels.hideSidebar")}
                      aria-label={t("labels.hideSidebar")}
                    >
                      &lt;
                    </button>
                  </div>

                  <div
                    className={`app__splitter ${draggingPane === "left" ? "app__splitter--active" : ""}`}
                    onMouseDown={() => onSetDraggingPane("left")}
                    role="separator"
                    aria-label={t("labels.resizeLeftPanel")}
                  />
                </>
              )}

              {leftPaneCollapsed && (
                <button
                  className="app__left-pane-toggle"
                  type="button"
                  onClick={() => onSetLeftPaneCollapsed(false)}
                  title={t("labels.showSidebar")}
                  aria-label={t("labels.showSidebar")}
                >
                  &gt;
                </button>
              )}

              <div className="app__pane app__pane--centre">
                <CentrePanel
                  repoPath={repoPath}
                  currentBranch={currentBranch}
                  stagedFiles={stagedFiles}
                  unstagedFiles={unstagedFiles}
                  unversionedFiles={unversionedFiles}
                  submodules={submodules}
                  conflictedFiles={conflictedFiles}
                  mergeInProgress={mergeInProgress}
                  mergeHeadBranch={mergeHeadBranch}
                  mergeMessage={mergeMessage}
                  rebaseInProgress={rebaseInProgress}
                  rebaseOnto={rebaseOnto}
                  cherryPickInProgress={cherryPickInProgress}
                  cherryPickHead={cherryPickHead}
                  revertInProgress={revertInProgress}
                  revertHead={revertHead}
                  commits={searchQuery
                    ? commits.filter(c => {
                        const q = searchQuery.toLowerCase();
                        return c.message.toLowerCase().includes(q)
                          || c.author.toLowerCase().includes(q)
                          || c.shortHash.toLowerCase().includes(q);
                      })
                    : commits}
                  loadMore={searchQuery ? () => {} : loadMore}
                  hasMore={searchQuery ? false : hasMore}
                  logLoading={logLoading}
                  logError={logError}
                  commitMarkers={commitMarkers}
                  logScope={logScope}
                  onLogScopeChange={setLogScope}
                  detachedHead={status?.detachedHead ?? false}
                  shallow={status?.shallow ?? false}
                  activeTab={centreTab}
                  onTabChange={setCentreTab}
                  selectedCommitHash={selectedCommitHash}
                  onSelectCommit={setSelectedCommitHash}
                  onCreateTagAtCommit={handleCreateTagAtCommit}
                  onCherryPickAtCommit={handleCherryPickAtCommit}
                  onRevertAtCommit={handleRevertAtCommit}
                  onResetToCommit={handleResetToCommit}
                  selectedFile={selectedFile}
                  selectedSubmodulePath={selectedSubmodulePath}
                  onFileSelect={handleFileSelect}
                  onSubmoduleSelect={handleSubmoduleSelect}
                  onSubmoduleInit={handleSubmoduleInit}
                  onSubmoduleUpdate={handleSubmoduleUpdate}
                  onSubmoduleSync={handleSubmoduleSync}
                  onSubmoduleFetch={handleSubmoduleFetch}
                  onSubmodulePull={handleSubmodulePull}
                  onSubmoduleOpen={handleSubmoduleOpen}
                  onStageFile={handleStageFile}
                  onStageFiles={handleStageFiles}
                  onUnstageFile={handleUnstageFile}
                  onUnstageFiles={handleUnstageFiles}
                  onDiscardFile={handleDiscardFile}
                  onDiscardFiles={handleDiscardFiles}
                  onDiscardAll={handleDiscardAll}
                  onExternalDiff={handleExternalDiff}
                  onStageAll={handleStageAll}
                  onUnstageAll={handleUnstageAll}
                  selectedCommitAction={effectiveCommitAction}
                  allowCommitAndPush={canCommitAndPush}
                  onSelectCommitAction={handleSelectCommitAction}
                  onCommit={(message, amend, action) => {
                    if (action === "commitAndPush") {
                      return handleCommitAndPush(message, amend);
                    }
                    return handleCommit(message, amend);
                  }}
                  onMergeAbort={handleMergeAbort}
                  onRebaseContinue={handleRebaseContinue}
                  onRebaseAbort={handleRebaseAbort}
                  onCherryPickContinue={handleCherryPickContinue}
                  onCherryPickAbort={handleCherryPickAbort}
                  onRevertContinue={handleRevertContinue}
                  onRevertAbort={handleRevertAbort}
                  onConflictAcceptTheirs={handleConflictAcceptTheirs}
                  onConflictAcceptOurs={handleConflictAcceptOurs}
                  onOpenMergeTool={handleOpenMergeTool}
                  isCommitting={isCommitting}
                  isRebaseActionRunning={isRebaseActionRunning}
                  isCherryPickActionRunning={isCherryPickActionRunning}
                  isRevertActionRunning={isRevertActionRunning}
                  lastCommitMessage={lastCommitMessage}
                />
              </div>

              <div
                className={`app__splitter ${draggingPane === "right" ? "app__splitter--active" : ""}`}
                onMouseDown={() => onSetDraggingPane("right")}
                role="separator"
                aria-label={t("labels.resizeRightPanel")}
              />

              <div className="app__pane app__pane--right" style={{ width: effectiveRightPaneWidth }}>
                <DiffPanel
                  mode={centreTab}
                  diff={diff}
                  loading={diffLoading}
                  selectedFile={selectedFile}
                  selectedSubmodule={selectedSubmodule}
                  selectedCommitHash={selectedCommitHash}
                  repoPath={repoPath}
                  commitFiles={commitFiles}
                  commitFilesLoading={commitFilesLoading}
                  compareCurrentFileLabel={compareCurrentFileLabel}
                  onCompareCurrentFile={handleCompareCurrentFile}
                  onOpenCommitFileDiff={handleOpenCommitFileDiff}
                  onSelectCommit={setSelectedCommitHash}
                  hunkAction={selectedFile && !selectedSubmodule ? (selectedFileStaged ? "unstage" : "stage") : null}
                  hunkActionBusy={hunkActionBusy}
                  wrapLines={wrapDiffLines}
                  onHunkAction={handleHunkAction}
                />
              </div>
            </>
          ) : (
            <div className="app__empty-state">
              <div className="app__empty-card">
                <div className="app__empty-icon">
                  <GitIcon size={20} />
                </div>
                <h1 className="app__empty-title">{t("emptyState.title")}</h1>
                <p className="app__empty-subtitle">{t("emptyState.subtitle")}</p>
                <div className="app__empty-actions">
                  <button className="app__empty-btn app__empty-btn--primary" onClick={onCloneClick}>
                    <GitIcon size={14} />
                    <span>{t("emptyState.clone")}</span>
                  </button>
                  <button className="app__empty-btn app__empty-btn--secondary" onClick={onInitRepoClick}>
                    <GitIcon size={14} />
                    <span>{t("emptyState.init")}</span>
                  </button>
                  <button className="app__empty-btn app__empty-btn--secondary" onClick={onOpenExistingClick}>
                    <FolderIcon size={14} />
                    <span>{t("emptyState.openExisting")}</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
