/**
 * ProjectView — all per-project state and logic.
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
import { Titlebar } from "./Titlebar";
import { Sidebar } from "./sidebar/Sidebar";
import { CenterPanel, type CenterTab } from "./center/CenterPanel";
import { DiffPanel } from "./diff/DiffPanel";
import { IdentityPanel } from "./identity/IdentityPanel";
import { ConfirmRevertDialog } from "./center/ConfirmRevertDialog";
import { NoDiffToolWarning } from "./NoDiffToolWarning";
import { MergeDialog, type MergeStrategy } from "./sidebar/MergeDialog";
import { AddRemoteDialog } from "./sidebar/AddRemoteDialog";
import { EditRemoteDialog } from "./sidebar/EditRemoteDialog";
import { CreateTagDialog } from "./sidebar/CreateTagDialog";
import { CreateBranchDialog } from "./sidebar/CreateBranchDialog";
import { RenameBranchDialog } from "./sidebar/RenameBranchDialog";
import { StashPushDialog } from "./sidebar/StashPushDialog";
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
import type { CommitMarkers, CreateBranchRequest, RemoteInfo } from "../types";
import { appendResultLog } from "../utils/resultLog";
import type { PlatformType } from "../hooks/usePlatform";
import type { ToastType } from "../hooks/useToast";

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

export type ProjectViewProps = {
  /** The active repository path. Changing this key causes a full remount. */
  repoPath: string | null;
  /** Increments each time settings are saved — triggers a full data refresh. */
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
  onSettingsClick: () => void;
  leftPaneWidth: number;
  rightPaneWidth: number;
  leftPaneCollapsed: boolean;
  onSetLeftPaneCollapsed: (collapsed: boolean) => void;
  draggingPane: "left" | "right" | null;
  onSetDraggingPane: (pane: "left" | "right" | null) => void;
  /** Ref pointing to div.app__body — owned by App for the resize observer. */
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
  const collapsedRightPaneBonus = leftPaneCollapsed
    ? Math.max(0, leftPaneWidth + 6 - 22)
    : 0;
  const effectiveRightPaneWidth = rightPaneWidth + collapsedRightPaneBonus;

  const { status, refresh: refreshStatus } = useGitStatus(repoPath);
  const { branches, refresh: refreshBranches } = useGitBranches(repoPath);
  const { tags, refresh: refreshTags } = useGitTags(repoPath);
  const { remotes, refresh: refreshRemotes } = useGitRemotes(repoPath);
  const { stashes, refresh: refreshStashes } = useGitStashes(repoPath);
  const { commits, loadMore, hasMore, refresh: refreshLog } = useGitLog(repoPath);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedFileStaged, setSelectedFileStaged] = useState(false);
  const [diffRefreshKey, setDiffRefreshKey] = useState(0);
  const [centerTab, setCenterTab] = useState<CenterTab>("changes");
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null);
  const [commitMarkers, setCommitMarkers] = useState<CommitMarkers>(EMPTY_COMMIT_MARKERS);
  const [repoDiffToolName, setRepoDiffToolName] = useState<string | null>(null);
  const [showNoDiffToolWarning, setShowNoDiffToolWarning] = useState(false);
  const { diff, loading: diffLoading } = useGitDiff(
    repoPath,
    selectedFile,
    selectedFileStaged,
    diffRefreshKey,
  );
  const { files: commitFiles, loading: commitFilesLoading } = useCommitFiles(
    repoPath,
    centerTab === "log" ? selectedCommitHash : null,
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
  const stagedFiles = status?.stagedFiles ?? [];
  const unstagedFiles = status?.changedFiles ?? [];
  const unversionedFiles = status?.unversionedFiles ?? [];
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
    stagedFiles.length > 0 || unstagedFiles.length > 0 || unversionedFiles.length > 0;
  const lastCommitMessage = commits[0]?.message ?? "";
  const currentBranchInfo = branches.find(b => b.isCurrent);
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
          setPushFollowTags(settings.pushFollowTags ?? false);
          setWrapDiffLines(settings.wrapDiffLines ?? false);
        }
      })
      .catch(() => {
        if (!cancelled) {
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

    api.watchRepo(repoPath).catch(() => {/* ignore — watcher is best-effort */});

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
    setSelectedFile(path);
    setSelectedFileStaged(staged);
  }, []);

  const handleStageFile = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.stageFiles(repoPath, [path]);
      showToast(`Staged ${path.split("/").pop()}`);
      appendResultLog("success", `Staged ${path}`, result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stage failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

  const handleStageFiles = useCallback(async (paths: string[]) => {
    if (!repoPath || paths.length === 0) return;
    try {
      const result = await api.stageFiles(repoPath, paths);
      showToast(paths.length === 1 ? `Staged ${paths[0].split("/").pop()}` : `Staged ${paths.length} files`);
      appendResultLog("success", paths.length === 1 ? `Staged ${paths[0]}` : `Staged ${paths.length} files`, result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stage failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

  const handleUnstageFile = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.unstageFile(repoPath, path);
      showToast(`Unstaged ${path.split("/").pop()}`, "info");
      appendResultLog("info", `Unstaged ${path}`, result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Unstage failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

  const handleUnstageFiles = useCallback(async (paths: string[]) => {
    if (!repoPath || paths.length === 0) return;
    try {
      const results = await Promise.all(paths.map(path => api.unstageFile(repoPath, path)));
      showToast(paths.length === 1 ? `Unstaged ${paths[0].split("/").pop()}` : `Unstaged ${paths.length} files`, "info");
      const backendUsed = results[0]?.backendUsed ?? "unknown";
      appendResultLog("info", paths.length === 1 ? `Unstaged ${paths[0]}` : `Unstaged ${paths.length} files`, backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Unstage failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

  const doRevertFiles = useCallback(async (paths: string[]) => {
    if (!repoPath) return;
    try {
      let backendUsed = "unknown";
      for (const path of paths) {
        const result = await api.discardFile(repoPath, path);
        backendUsed = result.backendUsed;
      }
      if (paths.length === 1) {
        showToast(`Reverted ${paths[0].split("/").pop()}`, "error");
        appendResultLog("info", `Reverted changes in ${paths[0]}`, backendUsed);
      } else {
        showToast(`Reverted ${paths.length} files`, "error");
        appendResultLog("info", `Reverted changes in ${paths.length} files`, backendUsed);
      }
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Revert failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

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
      showToast("Staged all files");
      appendResultLog("success", "Staged all files", result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stage all failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

  const handleUnstageAll = useCallback(async () => {
    if (!repoPath) return;
    try {
      const result = await api.unstageAll(repoPath);
      showToast("Unstaged all files", "info");
      appendResultLog("info", "Unstaged all files", result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Unstage all failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, showToast]);

  const handleCommit = useCallback(async (message: string, amend: boolean) => {
    if (!repoPath) return;
    if (rebaseInProgress) {
      showToast("Use Continue Rebase to proceed while rebasing", "error");
      return;
    }
    if (cherryPickInProgress) {
      showToast("Use Continue Cherry-pick to proceed while cherry-picking", "error");
      return;
    }
    if (revertInProgress) {
      showToast("Use Continue Revert to proceed while reverting", "error");
      return;
    }
    setIsCommitting(true);
    try {
      const result = await api.commitChanges(repoPath, message, amend);
      showToast(amend ? "Amended commit" : "Commit created");
      appendResultLog("success", amend ? "Amended latest commit" : "Created commit", result.backendUsed);
      await refreshAll();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Commit failed: ${String(e)}`, "unknown"); }
    finally { setIsCommitting(false); }
  }, [repoPath, rebaseInProgress, cherryPickInProgress, revertInProgress, refreshAll, showToast]);

  const handleFetch = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    try {
      const result = await api.fetchRemote(repoPath);
      showToast("Fetch complete");
      appendResultLog("success", "Fetch complete", result.backendUsed);
      await refreshAll();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Fetch failed: ${String(e)}`, "unknown"); }
    finally { setRemoteOp(null); }
  }, [repoPath, remoteOp, refreshAll, showToast]);

  const handlePull = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("pull");
    try {
      const result = await api.pullChanges(repoPath);
      showToast("Pull complete");
      appendResultLog("success", "Pull complete", result.backendUsed);
      await refreshAll();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Pull failed: ${String(e)}`, "unknown"); }
    finally { setRemoteOp(null); }
  }, [repoPath, remoteOp, refreshAll, showToast]);

  const handlePush = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("push");
    try {
      const result = await api.pushChanges(repoPath, false, pushFollowTags);
      showToast("Push complete");
      appendResultLog("success", "Push complete", result.backendUsed);
      await refreshAll();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Push failed: ${String(e)}`, "unknown"); }
    finally { setRemoteOp(null); }
  }, [repoPath, remoteOp, refreshAll, showToast, pushFollowTags]);

  const handleStash = useCallback(() => {
    if (!repoPath) return;
    if (!hasWorkingTreeChanges) {
      showToast("No local changes to stash", "info");
      return;
    }
    setShowStashDialog(true);
  }, [repoPath, hasWorkingTreeChanges, showToast]);

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
        showToast("No local changes to stash", "info");
        appendResultLog("info", output ?? result.message, result.backendUsed);
      } else {
        showToast("Changes stashed", "success");
        appendResultLog("success", output || result.message, result.backendUsed);
      }
      await Promise.all([refreshStatus(), refreshStashes()]);
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stash failed: ${String(e)}`, "unknown"); }
  }, [repoPath, refreshStatus, refreshStashes, showToast]);

  const handleStashApply = useCallback(async (stashIndex: number) => {
    if (!repoPath || stashBusy) return;
    setStashBusy(true);
    try {
      const result = await api.stashApply(repoPath, stashIndex);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshStatus();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stash apply failed: ${String(e)}`, "unknown"); }
    finally { setStashBusy(false); }
  }, [repoPath, stashBusy, refreshStatus, showToast]);

  const handleStashPop = useCallback(async (stashIndex: number) => {
    if (!repoPath || stashBusy) return;
    setStashBusy(true);
    try {
      const result = await api.stashPop(repoPath, stashIndex);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await Promise.all([refreshStatus(), refreshStashes()]);
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stash pop failed: ${String(e)}`, "unknown"); }
    finally { setStashBusy(false); }
  }, [repoPath, stashBusy, refreshStatus, refreshStashes, showToast]);

  const handleStashDrop = useCallback(async (stashIndex: number) => {
    if (!repoPath || stashBusy) return;
    const confirmed = await ask(`Drop stash@{${stashIndex}}? This cannot be undone.`, {
      title: "Drop Stash", kind: "warning", okLabel: "Drop", cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    setStashBusy(true);
    try {
      const result = await api.stashDrop(repoPath, stashIndex);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshStashes();
    } catch (e) { showToast(String(e), "error"); appendResultLog("error", `Stash drop failed: ${String(e)}`, "unknown"); }
    finally { setStashBusy(false); }
  }, [repoPath, stashBusy, refreshStashes, showToast]);

  const handleHunkAction = useCallback(async (hunkIndex: number) => {
    if (!repoPath || !selectedFile || hunkActionBusy) return;
    setHunkActionBusy(true);
    try {
      if (selectedFileStaged) {
        await api.unstageHunk(repoPath, selectedFile, hunkIndex);
        showToast("Unstaged hunk");
      } else {
        await api.stageHunk(repoPath, selectedFile, hunkIndex);
        showToast("Staged hunk");
      }
      await refreshStatus();
      setDiffRefreshKey(prev => prev + 1);
    } catch (e) { showToast(String(e), "error"); }
    finally { setHunkActionBusy(false); }
  }, [repoPath, selectedFile, selectedFileStaged, hunkActionBusy, refreshStatus, showToast]);

  const handleOpenCommitFileDiff = useCallback(async (filePath: string) => {
    if (!repoPath || !selectedCommitHash) return;
    try {
      const result = await api.openExternalDiff(repoPath, selectedCommitHash, filePath);
      showToast(result.message || `Opened diff for ${filePath.split("/").pop()}`);
    } catch (e) { showToast(String(e), "error"); }
  }, [repoPath, selectedCommitHash, showToast]);

  const handleCompareCurrentFile = useCallback(async () => {
    if (!repoPath || !selectedFile) return;
    try {
      const result = await api.openWorkingTreeDiff(repoPath, selectedFile, selectedFileStaged);
      showToast(result.message || `Opened diff for ${selectedFile.split("/").pop()}`);
    } catch (e) { showToast(String(e), "error"); }
  }, [repoPath, selectedFile, selectedFileStaged, showToast]);

  const stashBeforeBranchSwitch = useCallback(async (targetRef: string): Promise<{ proceed: boolean; stashedRef: string | null }> => {
    if (!repoPath || !hasWorkingTreeChanges) {
      return { proceed: true, stashedRef: null };
    }

    const confirmed = await ask(
      `You have uncommitted changes. Stash and switch to "${targetRef}"?`,
      {
        title: "Switch Branch",
        kind: "warning",
        okLabel: "Stash and Switch",
        cancelLabel: "Cancel",
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
        appendResultLog("success", stashOutput || "Stashed changes before branch switch", stashResult.backendUsed);
      }

      return { proceed: true, stashedRef };
    } catch (e) {
      showToast("Stash failed. Branch was not switched.", "error");
      appendResultLog("error", `Stash before switch failed: ${String(e)}`, "unknown");
      return { proceed: false, stashedRef: null };
    }
  }, [repoPath, hasWorkingTreeChanges, showToast]);

  const handleSwitchBranch = useCallback(async (branchName: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast("Cannot switch branch while a cherry-pick is in progress", "error");
      return;
    }
    if (rebaseInProgress) {
      showToast("Cannot switch branch while a rebase is in progress", "error");
      return;
    }
    if (mergeInProgress) {
      showToast("Cannot switch branch while a merge is in progress", "error");
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
        showToast(`${result.message} (saved changes as ${stashedRef})`, "success");
      } else {
        showToast(result.message, "success");
      }
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      if (stashedRef) {
        const recoveryMessage = `Switch failed after stashing ${stashedRef}. Recover with git stash apply ${stashedRef}.`;
        showToast(recoveryMessage, "error");
        appendResultLog("error", `${recoveryMessage} Original error: ${String(e)}`, "unknown");
      } else if (hasWorkingTreeChanges) {
        const recoveryMessage = "Switch failed after stashing changes. Recover with git stash pop or inspect git stash list.";
        showToast(recoveryMessage, "error");
        appendResultLog("error", `${recoveryMessage} Original error: ${String(e)}`, "unknown");
      } else {
        showToast(String(e), "error");
        appendResultLog("error", `Switch branch failed: ${String(e)}`, "unknown");
      }
      await refreshStatus();
    }
  }, [repoPath, cherryPickInProgress, rebaseInProgress, mergeInProgress, currentBranch, hasWorkingTreeChanges, refreshAll, refreshStatus, showToast, stashBeforeBranchSwitch]);

  const handleCreateBranch = useCallback(async (request: CreateBranchRequest) => {
    if (!repoPath) return;
    try {
      const result = await api.createBranch(request);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Create branch failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

  const handleDeleteBranch = useCallback(async (branchName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(`Delete branch "${branchName}"? This cannot be undone.`, {
      title: "Delete Branch", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteBranch({ repoPath, branchName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Delete branch failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

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
      appendResultLog("error", `Rename branch failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, renamePendingBranch, refreshAll, showToast]);

  const handleForceDeleteBranch = useCallback(async (branchName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(
      `Force delete branch "${branchName}"? This will delete it even if it has unmerged changes or is checked out in a worktree.`,
      { title: "Force Delete Branch", kind: "warning", okLabel: "Force Delete", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;
    try {
      const result = await api.deleteBranch({ repoPath, branchName, force: true });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Force delete branch failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

  const handleDeleteTag = useCallback(async (tagName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(`Delete tag "${tagName}"? This cannot be undone.`, {
      title: "Delete Tag", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteTag({ repoPath, tagName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Delete tag failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

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
      appendResultLog("error", `Create tag failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, createTagTarget, refreshAll, showToast]);

  const handlePushTag = useCallback(async (tagName: string) => {
    if (!repoPath) return;
    const remote = remotes[0]?.name;
    if (!remote) { showToast("No remotes configured", "error"); return; }
    try {
      const result = await api.pushTag({ repoPath, remote, tagName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Push tag failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, remotes, showToast]);

  const handleDeleteRemoteTag = useCallback(async (tagName: string) => {
    if (!repoPath) return;
    const remote = remotes[0]?.name;
    if (!remote) { showToast("No remotes configured", "error"); return; }
    const confirmed = await ask(`Delete tag "${tagName}" from remote "${remote}"? This cannot be undone.`, {
      title: "Delete Remote Tag", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteRemoteTag({ repoPath, remote, tagName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Delete remote tag failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, remotes, refreshAll, showToast]);

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
      showToast("Cannot start cherry-pick while a merge is in progress", "error");
      return;
    }
    if (rebaseInProgress) {
      showToast("Cannot start cherry-pick while a rebase is in progress", "error");
      return;
    }
    if (cherryPickInProgress) {
      showToast("A cherry-pick is already in progress", "error");
      return;
    }
    if (hasWorkingTreeChanges) {
      showToast("Commit or stash changes before cherry-picking", "error");
      return;
    }

    const confirmed = await ask(
      `Cherry-pick commit "${commitHash.slice(0, 12)}" onto "${currentBranch ?? "current branch"}"?`,
      { title: "Cherry-pick Commit", kind: "warning", okLabel: "Cherry-pick", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;

    setIsCherryPickActionRunning(true);
    try {
      const result = await api.cherryPickStart({ repoPath, commitHash });
      if (result.hasConflicts) {
        showToast(`Cherry-pick conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCenterTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Cherry-pick failed: ${String(e)}`, "unknown");
    } finally {
      setIsCherryPickActionRunning(false);
    }
  }, [repoPath, mergeInProgress, rebaseInProgress, cherryPickInProgress, hasWorkingTreeChanges, currentBranch, refreshAll, showToast]);

  const handleDeleteRemoteBranch = useCallback(async (remote: string, branch: string) => {
    if (!repoPath) return;
    const confirmed = await ask(`Delete remote branch "${remote}/${branch}"? This cannot be undone.`, {
      title: "Delete Remote Branch", kind: "warning", okLabel: "Delete", cancelLabel: "Cancel",
    });
    if (!confirmed) return;
    try {
      const result = await api.deleteRemoteBranch({ repoPath, remote, branch });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Delete remote branch failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

  const handleCheckoutRemoteBranch = useCallback(async (remoteBranchName: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast("Cannot switch branch while a cherry-pick is in progress", "error");
      return;
    }
    if (rebaseInProgress) {
      showToast("Cannot switch branch while a rebase is in progress", "error");
      return;
    }
    if (mergeInProgress) {
      showToast("Cannot switch branch while a merge is in progress", "error");
      return;
    }

    const localBranchName = deriveLocalBranchName(remoteBranchName);
    if (!localBranchName) {
      showToast(`Cannot checkout remote reference "${remoteBranchName}"`, "error");
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
        showToast(`${result.message} (saved changes as ${stashedRef})`, "success");
      } else {
        showToast(result.message, "success");
      }
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      if (stashedRef) {
        const recoveryMessage = `Checkout failed after stashing ${stashedRef}. Recover with git stash apply ${stashedRef}.`;
        showToast(recoveryMessage, "error");
        appendResultLog("error", `${recoveryMessage} Original error: ${String(e)}`, "unknown");
      } else {
        showToast(String(e), "error");
        appendResultLog("error", `Checkout remote branch failed: ${String(e)}`, "unknown");
      }
      await refreshStatus();
    }
  }, [repoPath, cherryPickInProgress, rebaseInProgress, mergeInProgress, branches, handleSwitchBranch, refreshAll, refreshStatus, showToast, stashBeforeBranchSwitch]);

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
      appendResultLog("error", `Add remote failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

  const handleRemoveRemote = useCallback(async (remoteName: string) => {
    if (!repoPath) return;
    const confirmed = await ask(
      `Remove remote "${remoteName}"? This will also delete all remote-tracking branches for this remote.`,
      { title: "Remove Remote", kind: "warning", okLabel: "Remove", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;
    try {
      const result = await api.removeRemote({ repoPath, name: remoteName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Remove remote failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

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
      showToast("Remote updated", "success");
      await refreshAll();
    } catch (e) {
      const prefix = renamedTo
        ? `Remote renamed to "${renamedTo}" but URL update failed: `
        : "Edit remote failed: ";
      showToast(`${prefix}${String(e)}`, "error");
      appendResultLog("error", `Edit remote failed: ${String(e)}`, "unknown");
      await refreshAll();
    }
  }, [repoPath, editingRemote, refreshAll, showToast]);

  const handleFetchSingleRemote = useCallback(async (remoteName: string) => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    try {
      const result = await api.fetchRemote(repoPath, remoteName);
      showToast(`Fetched from ${remoteName}`, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Fetch ${remoteName} failed: ${String(e)}`, "unknown");
    } finally {
      setRemoteOp(null);
    }
  }, [repoPath, remoteOp, refreshAll, showToast]);

  const handlePruneRemote = useCallback(async (remoteName: string) => {
    if (!repoPath) return;
    try {
      const result = await api.pruneRemote({ repoPath, name: remoteName });
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Prune remote failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

  const handleExternalDiff = useCallback(async (path: string, staged: boolean) => {
    if (!repoPath) return;
    try {
      const result = await api.openWorkingTreeDiff(repoPath, path, staged);
      showToast(result.message || `Opened diff for ${path.split("/").pop()}`);
    } catch (e) { showToast(String(e), "error"); }
  }, [repoPath, showToast]);

  const handleMergeBranch = useCallback((branchName: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast("Cannot merge while a cherry-pick is in progress", "error");
      return;
    }
    if (rebaseInProgress) {
      showToast("Cannot merge while a rebase is in progress", "error");
      return;
    }
    if (stagedFiles.length > 0 || unstagedFiles.length > 0 || unversionedFiles.length > 0) {
      showToast("Commit or stash changes before merging", "error");
      return;
    }
    setMergePendingBranch(branchName);
  }, [repoPath, cherryPickInProgress, rebaseInProgress, stagedFiles, unstagedFiles, unversionedFiles, showToast]);

  const handleRebaseBranch = useCallback(async (ontoBranch: string) => {
    if (!repoPath) return;
    if (cherryPickInProgress) {
      showToast("Cannot start rebase while a cherry-pick is in progress", "error");
      return;
    }
    if (mergeInProgress) {
      showToast("Cannot start rebase while a merge is in progress", "error");
      return;
    }
    if (rebaseInProgress) {
      showToast("A rebase is already in progress", "error");
      return;
    }
    if (!currentBranch || currentBranch === ontoBranch) {
      showToast("Choose a different branch to rebase onto", "error");
      return;
    }
    if (hasWorkingTreeChanges) {
      showToast("Commit or stash changes before rebasing", "error");
      return;
    }

    const confirmed = await ask(
      `Rebase "${currentBranch}" onto "${ontoBranch}"?`,
      { title: "Start Rebase", kind: "warning", okLabel: "Rebase", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;

    setIsRebaseActionRunning(true);
    try {
      const result = await api.rebaseStart({ repoPath, onto: ontoBranch });
      if (result.hasConflicts) {
        showToast(`Rebase conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCenterTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Rebase failed: ${String(e)}`, "unknown");
    } finally {
      setIsRebaseActionRunning(false);
    }
  }, [repoPath, cherryPickInProgress, mergeInProgress, rebaseInProgress, currentBranch, hasWorkingTreeChanges, refreshAll, showToast]);

  const handleRebaseContinue = useCallback(async () => {
    if (!repoPath || !rebaseInProgress) return;
    setIsRebaseActionRunning(true);
    try {
      const result = await api.rebaseContinue(repoPath);
      if (result.hasConflicts) {
        showToast(`Rebase conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCenterTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Rebase continue failed: ${String(e)}`, "unknown");
    } finally {
      setIsRebaseActionRunning(false);
    }
  }, [repoPath, rebaseInProgress, refreshAll, showToast]);

  const handleRebaseAbort = useCallback(async () => {
    if (!repoPath || !rebaseInProgress) return;
    const confirmed = await ask(
      "Abort the current rebase? All rebase progress will be discarded.",
      { title: "Abort Rebase", kind: "warning", okLabel: "Abort", cancelLabel: "Cancel" },
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
      appendResultLog("error", `Rebase abort failed: ${String(e)}`, "unknown");
    } finally {
      setIsRebaseActionRunning(false);
    }
  }, [repoPath, rebaseInProgress, refreshAll, showToast]);

  const handleCherryPickContinue = useCallback(async () => {
    if (!repoPath || !cherryPickInProgress) return;
    setIsCherryPickActionRunning(true);
    try {
      const result = await api.cherryPickContinue(repoPath);
      if (result.hasConflicts) {
        showToast(`Cherry-pick conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCenterTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Cherry-pick continue failed: ${String(e)}`, "unknown");
    } finally {
      setIsCherryPickActionRunning(false);
    }
  }, [repoPath, cherryPickInProgress, refreshAll, showToast]);

  const handleCherryPickAbort = useCallback(async () => {
    if (!repoPath || !cherryPickInProgress) return;
    const confirmed = await ask(
      "Abort the current cherry-pick? All cherry-pick progress will be discarded.",
      { title: "Abort Cherry-pick", kind: "warning", okLabel: "Abort", cancelLabel: "Cancel" },
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
      appendResultLog("error", `Cherry-pick abort failed: ${String(e)}`, "unknown");
    } finally {
      setIsCherryPickActionRunning(false);
    }
  }, [repoPath, cherryPickInProgress, refreshAll, showToast]);

  const handleRevertAtCommit = useCallback(async (commitHash: string) => {
    if (!repoPath) return;
    if (mergeInProgress) {
      showToast("Cannot start revert while a merge is in progress", "error");
      return;
    }
    if (rebaseInProgress) {
      showToast("Cannot start revert while a rebase is in progress", "error");
      return;
    }
    if (cherryPickInProgress) {
      showToast("Cannot start revert while a cherry-pick is in progress", "error");
      return;
    }
    if (revertInProgress) {
      showToast("A revert is already in progress", "error");
      return;
    }
    if (hasWorkingTreeChanges) {
      showToast("Commit or stash changes before reverting", "error");
      return;
    }

    const confirmed = await ask(
      `Revert commit "${commitHash.slice(0, 12)}" on "${currentBranch ?? "current branch"}"?`,
      { title: "Revert Commit", kind: "warning", okLabel: "Revert", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;

    setIsRevertActionRunning(true);
    try {
      const result = await api.revertCommitStart(repoPath, commitHash);
      if (result.hasConflicts) {
        showToast(`Revert conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCenterTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Revert failed: ${String(e)}`, "unknown");
    } finally {
      setIsRevertActionRunning(false);
    }
  }, [repoPath, mergeInProgress, rebaseInProgress, cherryPickInProgress, revertInProgress, hasWorkingTreeChanges, currentBranch, refreshAll, showToast]);

  const handleRevertContinue = useCallback(async () => {
    if (!repoPath || !revertInProgress) return;
    setIsRevertActionRunning(true);
    try {
      const result = await api.revertContinue(repoPath);
      if (result.hasConflicts) {
        showToast(`Revert conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
        setCenterTab("changes");
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Revert continue failed: ${String(e)}`, "unknown");
    } finally {
      setIsRevertActionRunning(false);
    }
  }, [repoPath, revertInProgress, refreshAll, showToast]);

  const handleRevertAbort = useCallback(async () => {
    if (!repoPath || !revertInProgress) return;
    const confirmed = await ask(
      "Abort the current revert? All revert progress will be discarded.",
      { title: "Abort Revert", kind: "warning", okLabel: "Abort", cancelLabel: "Cancel" },
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
      appendResultLog("error", `Revert abort failed: ${String(e)}`, "unknown");
    } finally {
      setIsRevertActionRunning(false);
    }
  }, [repoPath, revertInProgress, refreshAll, showToast]);

  const handleResetToCommit = useCallback(async (commitHash: string, mode: "soft" | "mixed") => {
    if (!repoPath) return;
    const modeLabel = mode === "soft" ? "Soft" : "Mixed";
    const modeDesc = mode === "soft"
      ? "HEAD will move to this commit; staged changes will be preserved."
      : "HEAD will move to this commit; staged changes will be unstaged.";
    const confirmed = await ask(
      `${modeLabel} reset to "${commitHash.slice(0, 12)}"?\n\n${modeDesc}`,
      { title: `${modeLabel} Reset`, kind: "warning", okLabel: "Reset", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;
    try {
      const result = await api.resetTo(repoPath, commitHash, mode);
      showToast(result.message, "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Reset failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

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
        showToast(`Merge conflicts in ${result.conflictedFiles.length} file(s) — resolve in the Changes tab`, "error");
        appendResultLog("error", result.message, result.backendUsed);
      } else {
        showToast(result.message, "success");
        appendResultLog("success", result.message, result.backendUsed);
      }
      await refreshAll();
      setCenterTab("changes");
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Merge failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, mergePendingBranch, refreshAll, showToast]);

  const handleMergeAbort = useCallback(async () => {
    if (!repoPath) return;
    const confirmed = await ask(
      "Abort the current merge? All merge changes will be discarded.",
      { title: "Abort Merge", kind: "warning", okLabel: "Abort", cancelLabel: "Cancel" },
    );
    if (!confirmed) return;
    try {
      const result = await api.mergeAbort(repoPath);
      showToast(result.message, "info");
      appendResultLog("info", result.message, result.backendUsed);
      await refreshAll();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Merge abort failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshAll, showToast]);

  const handleConflictAcceptTheirs = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.conflictAcceptTheirs(repoPath, path);
      showToast(`Accepted theirs for ${path.split("/").pop()}`);
      appendResultLog("success", `Accepted theirs for ${path}`, result.backendUsed);
      await refreshStatus();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Accept theirs failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshStatus, showToast]);

  const handleConflictAcceptOurs = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      const result = await api.conflictAcceptOurs(repoPath, path);
      showToast(`Accepted ours for ${path.split("/").pop()}`);
      appendResultLog("success", `Accepted ours for ${path}`, result.backendUsed);
      await refreshStatus();
    } catch (e) {
      showToast(String(e), "error");
      appendResultLog("error", `Accept ours failed: ${String(e)}`, "unknown");
    }
  }, [repoPath, refreshStatus, showToast]);

  const handleOpenMergeTool = useCallback(async (path: string) => {
    if (!repoPath) return;
    try {
      await api.openMergeTool(repoPath, path);
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [repoPath, showToast]);

  const compareCurrentFileLabel = repoDiffToolName ? `Compare in ${repoDiffToolName}` : "Compare in difftool";

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
        setCenterTab("log");
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
        onSaveLocalIdentity={saveLocalIdentity}
        onSaveGlobalIdentity={saveGlobalIdentity}
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
          targetBranch={currentBranch ?? "current branch"}
          onConfirm={handleMergeConfirm}
          onCancel={() => setMergePendingBranch(null)}
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
          onSettingsClick={onSettingsClick}
          onIdentityClick={onIdentityToggle}
          recentRepos={recentRepos}
          searchQuery={searchQuery}
          searchInputRef={searchInputRef}
          onSearchChange={(q) => {
            setSearchQuery(q);
            if (q) setCenterTab("log");
          }}
          onCloneClick={onCloneClick}
          onInitRepoClick={onInitRepoClick}
          onOpenExistingClick={onOpenExistingClick}
          onRepoSelect={onRepoSelect}
          onFetch={handleFetch}
          onPull={handlePull}
          onPush={handlePush}
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
                      title="Hide sidebar"
                      aria-label="Hide sidebar"
                    >
                      &lt;
                    </button>
                  </div>

                  <div
                    className={`app__splitter ${draggingPane === "left" ? "app__splitter--active" : ""}`}
                    onMouseDown={() => onSetDraggingPane("left")}
                    role="separator"
                    aria-label="Resize left panel"
                  />
                </>
              )}

              {leftPaneCollapsed && (
                <button
                  className="app__left-pane-toggle"
                  type="button"
                  onClick={() => onSetLeftPaneCollapsed(false)}
                  title="Show sidebar"
                  aria-label="Show sidebar"
                >
                  &gt;
                </button>
              )}

              <div className="app__pane app__pane--center">
                <CenterPanel
                  repoPath={repoPath}
                  currentBranch={currentBranch}
                  stagedFiles={stagedFiles}
                  unstagedFiles={unstagedFiles}
                  unversionedFiles={unversionedFiles}
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
                  commitMarkers={commitMarkers}
                  activeTab={centerTab}
                  onTabChange={setCenterTab}
                  selectedCommitHash={selectedCommitHash}
                  onSelectCommit={setSelectedCommitHash}
                  onCreateTagAtCommit={handleCreateTagAtCommit}
                  onCherryPickAtCommit={handleCherryPickAtCommit}
                  onRevertAtCommit={handleRevertAtCommit}
                  onResetToCommit={handleResetToCommit}
                  selectedFile={selectedFile}
                  onFileSelect={handleFileSelect}
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
                  onCommit={handleCommit}
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
                aria-label="Resize right panel"
              />

              <div className="app__pane app__pane--right" style={{ width: effectiveRightPaneWidth }}>
                <DiffPanel
                  mode={centerTab}
                  diff={diff}
                  loading={diffLoading}
                  selectedFile={selectedFile}
                  selectedCommitHash={selectedCommitHash}
                  commitFiles={commitFiles}
                  commitFilesLoading={commitFilesLoading}
                  compareCurrentFileLabel={compareCurrentFileLabel}
                  onCompareCurrentFile={handleCompareCurrentFile}
                  onOpenCommitFileDiff={handleOpenCommitFileDiff}
                  hunkAction={selectedFile ? (selectedFileStaged ? "unstage" : "stage") : null}
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
                <h1 className="app__empty-title">No repository open</h1>
                <p className="app__empty-subtitle">Clone a project, initialize a new repository, or open an existing one.</p>
                <div className="app__empty-actions">
                  <button className="app__empty-btn app__empty-btn--primary" onClick={onCloneClick}>
                    <GitIcon size={14} />
                    <span>Clone repository</span>
                  </button>
                  <button className="app__empty-btn app__empty-btn--secondary" onClick={onInitRepoClick}>
                    <GitIcon size={14} />
                    <span>Initialize repository</span>
                  </button>
                  <button className="app__empty-btn app__empty-btn--secondary" onClick={onOpenExistingClick}>
                    <FolderIcon size={14} />
                    <span>Open existing</span>
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
