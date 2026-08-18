import {useCallback, useState} from "react";
import {useTranslation} from "react-i18next";
import * as api from "../api/commands";
import type {LongRunningOperation, StagingOperationKind} from "../types";
import type {ResultLogEntry} from "../utils/resultLog";
import {appendResultLog} from "../utils/resultLog";
import type {ToastType} from "./useToast";

type UseStagingOperationsOptions = {
  repoPath: string | null;
  confirmRevert: boolean;
  onSetConfirmRevert: (confirmRevert: boolean) => void;
  refreshStatus: () => Promise<void>;
  showToast: (message: string, type?: ToastType) => void;
  startOperation: (kind: StagingOperationKind, count?: number) => LongRunningOperation | null;
  finishOperation: (operation: LongRunningOperation) => void;
};

function getFileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function useStagingOperations({
  repoPath,
  confirmRevert,
  onSetConfirmRevert,
  refreshStatus,
  showToast,
  startOperation,
  finishOperation,
}: UseStagingOperationsOptions) {
  const {t} = useTranslation("projectView");
  const [revertPendingPaths, setRevertPendingPaths] = useState<string[] | null>(null);

  const runStagingOperation = useCallback(async (
    kind: StagingOperationKind,
    count: number | undefined,
    task: () => Promise<void>,
  ) => {
    const operation = startOperation(kind, count);
    if (!operation) {
      return;
    }

    try {
      await task();
    } finally {
      finishOperation(operation);
    }
  }, [finishOperation, startOperation]);

  const stageFile = useCallback(async (path: string) => {
    if (!repoPath) return;
    await runStagingOperation("stage", 1, async () => {
      const result = await api.stageFiles(repoPath, [path]);
      showToast(t("toast.stagedFiles", {count: 1, file: getFileName(path)}));
      appendResultLog("success", t("log.stagedFiles", {count: 1, path}), result.backendUsed);
      await refreshStatus();
    }).catch(error => {
      showToast(String(error), "error");
      appendResultLog("error", t("log.stageFailed", {message: String(error)}), "unknown");
    });
  }, [repoPath, refreshStatus, runStagingOperation, showToast, t]);

  const stageFiles = useCallback(async (paths: string[]) => {
    if (!repoPath || paths.length === 0) return;
    await runStagingOperation("stage", paths.length, async () => {
      const result = await api.stageFiles(repoPath, paths);
      showToast(t("toast.stagedFiles", {count: paths.length, file: getFileName(paths[0])}));
      appendResultLog("success", t("log.stagedFiles", {count: paths.length, path: paths[0]}), result.backendUsed);
      await refreshStatus();
    }).catch(error => {
      showToast(String(error), "error");
      appendResultLog("error", t("log.stageFailed", {message: String(error)}), "unknown");
    });
  }, [repoPath, refreshStatus, runStagingOperation, showToast, t]);

  const unstageFile = useCallback(async (path: string) => {
    if (!repoPath) return;
    await runStagingOperation("unstage", 1, async () => {
      const result = await api.unstageFile(repoPath, path);
      showToast(t("toast.unstagedFiles", {count: 1, file: getFileName(path)}), "info");
      appendResultLog("info", t("log.unstagedFiles", {count: 1, path}), result.backendUsed);
      await refreshStatus();
    }).catch(error => {
      showToast(String(error), "error");
      appendResultLog("error", t("log.unstageFailed", {message: String(error)}), "unknown");
    });
  }, [repoPath, refreshStatus, runStagingOperation, showToast, t]);

  const unstageFiles = useCallback(async (paths: string[]) => {
    if (!repoPath || paths.length === 0) return;
    await runStagingOperation("unstage", paths.length, async () => {
      const result = await api.unstageFiles(repoPath, paths);
      showToast(t("toast.unstagedFiles", {count: paths.length, file: getFileName(paths[0])}), "info");
      const backendUsed = result.backendUsed ?? "unknown";
      appendResultLog("info", t("log.unstagedFiles", {count: paths.length, path: paths[0]}), backendUsed);
      await refreshStatus();
    }).catch(error => {
      showToast(String(error), "error");
      appendResultLog("error", t("log.unstageFailed", {message: String(error)}), "unknown");
    });
  }, [repoPath, refreshStatus, runStagingOperation, showToast, t]);

  const revertFiles = useCallback(async (paths: string[]) => {
    if (!repoPath) return;
    try {
      let backendUsed: ResultLogEntry["backend"] = "unknown";
      for (const path of paths) {
        const result = await api.discardFile(repoPath, path);
        backendUsed = result.backendUsed;
      }
      if (paths.length === 1) {
        showToast(t("toast.revertedFiles", {count: 1, file: getFileName(paths[0])}), "error");
        appendResultLog("info", t("log.revertedFiles", {count: 1, path: paths[0]}), backendUsed);
      } else {
        showToast(t("toast.revertedFiles", {count: paths.length}), "error");
        appendResultLog("info", t("log.revertedFiles", {count: paths.length}), backendUsed);
      }
      await refreshStatus();
    } catch (error) {
      showToast(String(error), "error");
      appendResultLog("error", t("log.revertFailed", {message: String(error)}), "unknown");
    }
  }, [repoPath, refreshStatus, showToast, t]);

  const discardFile = useCallback((path: string) => {
    if (confirmRevert) {
      setRevertPendingPaths([path]);
    } else {
      void revertFiles([path]);
    }
  }, [confirmRevert, revertFiles]);

  const discardFiles = useCallback((paths: string[]) => {
    if (paths.length === 0) return;
    if (confirmRevert || paths.length > 1) {
      setRevertPendingPaths(paths);
    } else {
      void revertFiles(paths);
    }
  }, [confirmRevert, revertFiles]);

  const discardAll = useCallback((paths: string[]) => {
    if (paths.length > 0) setRevertPendingPaths(paths);
  }, []);

  const confirmDiscard = useCallback(async (dontShowAgain: boolean) => {
    const paths = revertPendingPaths;
    setRevertPendingPaths(null);
    if (!paths) return;
    if (dontShowAgain) {
      onSetConfirmRevert(false);
      await api.setConfirmRevert(false).catch(() => {});
    }
    await revertFiles(paths);
  }, [onSetConfirmRevert, revertFiles, revertPendingPaths]);

  const cancelDiscard = useCallback(() => setRevertPendingPaths(null), []);

  const stageAll = useCallback(async () => {
    if (!repoPath) return;
    await runStagingOperation("stageAll", undefined, async () => {
      const result = await api.stageAll(repoPath);
      showToast(t("toast.stagedAll"));
      appendResultLog("success", t("log.stagedAll"), result.backendUsed);
      await refreshStatus();
    }).catch(error => {
      showToast(String(error), "error");
      appendResultLog("error", t("log.stageAllFailed", {message: String(error)}), "unknown");
    });
  }, [repoPath, refreshStatus, runStagingOperation, showToast, t]);

  const unstageAll = useCallback(async () => {
    if (!repoPath) return;
    await runStagingOperation("unstageAll", undefined, async () => {
      const result = await api.unstageAll(repoPath);
      showToast(t("toast.unstagedAll"), "info");
      appendResultLog("info", t("log.unstagedAll"), result.backendUsed);
      await refreshStatus();
    }).catch(error => {
      showToast(String(error), "error");
      appendResultLog("error", t("log.unstageAllFailed", {message: String(error)}), "unknown");
    });
  }, [repoPath, refreshStatus, runStagingOperation, showToast, t]);

  return {
    revertPendingPaths,
    stageFile,
    stageFiles,
    unstageFile,
    unstageFiles,
    discardFile,
    discardFiles,
    discardAll,
    confirmDiscard,
    cancelDiscard,
    stageAll,
    unstageAll,
  };
}
