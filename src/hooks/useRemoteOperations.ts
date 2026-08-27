import {useCallback, useState} from "react";
import {useTranslation} from "react-i18next";
import * as api from "../api/commands";
import type {
  BranchInfo,
  PullAnalysis,
  PullStrategy,
  PushRejectionAnalysis,
  PushRequest,
} from "../types";
import {buildPushFailureDisplay} from "../utils/gitErrorDisplay";
import {splitUpstreamRef, type RemoteActionKind} from "../utils/remoteActionState";
import {appendResultLog} from "../utils/resultLog";
import type {ToastType} from "./useToast";

const AUTO_FETCH_TIMEOUT_MS = 90_000;

type UpstreamDialogMode = "publish" | "repair" | "change";

type UseRemoteOperationsOptions = {
  repoPath: string | null;
  currentBranchInfo: BranchInfo | null | undefined;
  remoteActionKind: RemoteActionKind;
  remoteActionTitle?: string;
  forceWithLeaseAfterRebase: boolean;
  pushFollowTags: boolean;
  refreshAll: () => Promise<void>;
  showToast: (message: string, type?: ToastType) => void;
  onForcePushComplete: () => void;
  onFetchAttemptComplete: (repoPath: string) => void;
};

export function buildPushRequestForCurrentBranch(
  repoPath: string,
  currentBranchInfo: BranchInfo | null | undefined,
  forceWithLease: boolean,
  pushFollowTags: boolean,
): PushRequest {
  const request: PushRequest = {repoPath, forceWithLease, pushFollowTags};
  if (currentBranchInfo?.upstreamStatus !== "tracked") return request;

  const upstream = splitUpstreamRef(currentBranchInfo.upstream);
  if (!upstream) return request;

  return {
    ...request,
    remote: upstream.remote,
    remoteBranch: upstream.branch,
  };
}

export function useRemoteOperations({
  repoPath,
  currentBranchInfo,
  remoteActionKind,
  remoteActionTitle,
  forceWithLeaseAfterRebase,
  pushFollowTags,
  refreshAll,
  showToast,
  onForcePushComplete,
  onFetchAttemptComplete,
}: UseRemoteOperationsOptions) {
  const {t} = useTranslation("projectView");
  const {t: tGitAdvice} = useTranslation("gitAdvice");
  const [remoteOp, setRemoteOp] = useState<"fetch" | "pull" | "push" | null>(null);
  const [divergentPullAnalysis, setDivergentPullAnalysis] = useState<PullAnalysis | null>(null);
  const [pushRejectionAnalysis, setPushRejectionAnalysis] = useState<PushRejectionAnalysis | null>(null);
  const [upstreamDialogMode, setUpstreamDialogMode] = useState<UpstreamDialogMode | null>(null);

  const fetchRemote = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    try {
      const result = await api.fetchRemote(repoPath);
      showToast(t("toast.fetchComplete"));
      appendResultLog("success", t("toast.fetchComplete"), result.backendUsed);
      await refreshAll();
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", t("log.fetchFailed", {message: String(error)}), "unknown");
    } finally {
      onFetchAttemptComplete(repoPath);
      setRemoteOp(null);
    }
  }, [onFetchAttemptComplete, repoPath, remoteOp, refreshAll, showToast, t]);

  const autoFetchRemote = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    const fetchPromise = api.fetchRemote(repoPath);
    let timeoutId: ReturnType<typeof setTimeout>;
    try {
      const result = await Promise.race([
        fetchPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(t("log.autoFetchTimedOut"))), AUTO_FETCH_TIMEOUT_MS);
        }),
      ]);
      appendResultLog("success", t("log.autoFetchComplete"), result.backendUsed);
      await refreshAll();
    } catch (error) {
      const message = String(error);
      appendResultLog("error", t("log.autoFetchFailed", {message}), "unknown");
    } finally {
      clearTimeout(timeoutId!);
      await fetchPromise.catch(() => undefined);
      onFetchAttemptComplete(repoPath);
      setRemoteOp(null);
    }
  }, [onFetchAttemptComplete, repoPath, remoteOp, refreshAll, t]);

  const fetchSingleRemote = useCallback(async (remoteName: string) => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("fetch");
    try {
      const result = await api.fetchRemote(repoPath, remoteName);
      showToast(t("toast.fetchedFrom", {remote: remoteName}), "success");
      appendResultLog("success", result.message, result.backendUsed);
      await refreshAll();
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", t("log.fetchRemoteFailed", {remote: remoteName, message: String(error)}), "unknown");
    } finally {
      onFetchAttemptComplete(repoPath);
      setRemoteOp(null);
    }
  }, [onFetchAttemptComplete, repoPath, remoteOp, refreshAll, showToast, t]);

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
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", t("log.pullFailed", {message: String(error)}), "unknown");
    } finally {
      onFetchAttemptComplete(repoPath);
      setRemoteOp(null);
    }
  }, [onFetchAttemptComplete, repoPath, remoteOp, refreshAll, showToast, t]);

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
      }
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", t("log.pullAnalysisFailed", {message: String(error)}), "unknown");
    }
  }, [repoPath, remoteOp, runPullWithStrategy, showToast, t]);

  const handlePushFailure = useCallback((result: Awaited<ReturnType<typeof api.pushChanges>>) => {
    const display = buildPushFailureDisplay(result, tGitAdvice);
    if (display.dialogRejection) {
      setPushRejectionAnalysis(display.dialogRejection);
      appendResultLog("error", display.logMessage, result.backendUsed, undefined, display.logDetails);
      return;
    }
    showToast(display.toastMessage ?? result.message, "error");
    appendResultLog("error", display.logMessage, result.backendUsed, undefined, display.logDetails);
  }, [showToast, tGitAdvice]);

  const runPushRequest = useCallback(async (
    request: PushRequest,
    successToast: string,
    failurePrefix: string,
  ) => {
    if (!repoPath || remoteOp) return;
    setRemoteOp("push");
    try {
      const result = await api.pushChanges(request);
      if (!result.success) {
        handlePushFailure(result);
        return;
      }
      showToast(successToast);
      appendResultLog("success", result.message, result.backendUsed);
      if (request.forceWithLease) onForcePushComplete();
      await refreshAll();
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", t("log.pushFailed", {prefix: failurePrefix, message: String(error)}), "unknown");
    } finally {
      setRemoteOp(null);
    }
  }, [handlePushFailure, onForcePushComplete, refreshAll, remoteOp, repoPath, showToast, t]);

  const push = useCallback(async () => {
    if (!repoPath || remoteOp) return;
    if (remoteActionKind === "publish") {
      setPushRejectionAnalysis(null);
      setUpstreamDialogMode("publish");
      return;
    }
    if (remoteActionKind === "repair-upstream") {
      setPushRejectionAnalysis(null);
      setUpstreamDialogMode("repair");
      return;
    }
    if (remoteActionKind === "detached") {
      showToast(remoteActionTitle ?? t("toast.pushDetached"), "error");
      return;
    }
    await runPushRequest(
      buildPushRequestForCurrentBranch(repoPath, currentBranchInfo, forceWithLeaseAfterRebase, pushFollowTags),
      t("toast.pushComplete"),
      t("toast.pushFailed"),
    );
  }, [currentBranchInfo, forceWithLeaseAfterRebase, pushFollowTags, remoteActionKind, remoteActionTitle, remoteOp, repoPath, runPushRequest, showToast, t]);

  const confirmUpstream = useCallback(async (selection: {remote: string; remoteBranch: string}) => {
    if (!repoPath || !currentBranchInfo || !upstreamDialogMode) return;
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
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", mode === "repair"
        ? t("log.repairUpstreamFailed", {message: String(error)})
        : t("log.changeUpstreamFailed", {message: String(error)}), "unknown");
    }
  }, [currentBranchInfo, pushFollowTags, refreshAll, repoPath, runPushRequest, showToast, t, upstreamDialogMode]);

  const openUpstreamDialog = useCallback((mode: UpstreamDialogMode) => {
    setPushRejectionAnalysis(null);
    setUpstreamDialogMode(mode);
  }, []);

  const confirmDivergentPull = useCallback(async (strategy: PullStrategy) => {
    setDivergentPullAnalysis(null);
    await runPullWithStrategy(strategy);
  }, [runPullWithStrategy]);

  const cancelDivergentPull = useCallback(() => setDivergentPullAnalysis(null), []);
  const cancelUpstream = useCallback(() => setUpstreamDialogMode(null), []);
  const openPublish = useCallback(() => openUpstreamDialog("publish"), [openUpstreamDialog]);
  const openRepairUpstream = useCallback(() => openUpstreamDialog("repair"), [openUpstreamDialog]);
  const openChangeUpstream = useCallback(() => openUpstreamDialog("change"), [openUpstreamDialog]);
  const pushRejectedFetch = useCallback(async () => {
    setPushRejectionAnalysis(null);
    await fetchRemote();
  }, [fetchRemote]);
  const pushRejectedIntegrate = useCallback(async () => {
    setPushRejectionAnalysis(null);
    await fetchRemote();
    await startPullFlow();
  }, [fetchRemote, startPullFlow]);
  const cancelPushRejection = useCallback(() => setPushRejectionAnalysis(null), []);

  return {
    remoteOp,
    divergentPullAnalysis,
    pushRejectionAnalysis,
    upstreamDialogMode,
    fetch: fetchRemote,
    autoFetch: autoFetchRemote,
    fetchSingleRemote,
    pull: startPullFlow,
    push,
    confirmDivergentPull,
    cancelDivergentPull,
    confirmUpstream,
    cancelUpstream,
    openPublish,
    openRepairUpstream,
    openChangeUpstream,
    pushRejectedFetch,
    pushRejectedIntegrate,
    pushRejectedPublish: openPublish,
    pushRejectedRepairUpstream: openRepairUpstream,
    cancelPushRejection,
  };
}
