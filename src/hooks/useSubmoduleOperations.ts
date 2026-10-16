import {useCallback, useEffect, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import * as api from "../api/commands";
import type {LongRunningOperation, OperationResult, SubmoduleAction, SubmoduleOperationState, SubmoduleRemotePreview} from "../types";
import {appendResultLog} from "../utils/resultLog";
import type {ToastType} from "./useToast";

type Options = {
  repoPath: string | null;
  refreshStatus: () => Promise<void>;
  showToast: (message: string, type?: ToastType) => void;
  startOperation: () => LongRunningOperation | null;
  finishOperation: (operation: LongRunningOperation) => void;
  openRepository: (path: string) => Promise<void> | void;
};

export function useSubmoduleOperations({repoPath, refreshStatus, showToast, startOperation, finishOperation, openRepository}: Options) {
  const {t} = useTranslation("projectView");
  const [states, setStates] = useState<Record<string, SubmoduleOperationState>>({});
  const [recursive, setRecursive] = useState(true);
  const [preview, setPreview] = useState<SubmoduleRemotePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const currentRepo = useRef(repoPath);
  currentRepo.current = repoPath;
  const mounted = useRef(true);
  const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      timers.current.forEach(clearTimeout);
    };
  }, []);
  useEffect(() => {
    setStates({});
    setPreview(null);
    setRecursive(true);
  }, [repoPath]);

  const run = useCallback(async <T extends OperationResult | SubmoduleRemotePreview | void>(
    paths: string[], action: SubmoduleAction, task: () => Promise<T>,
  ): Promise<T | undefined> => {
    if (!repoPath || locked.current) return;
    const operation = startOperation();
    if (!operation) return;
    locked.current = true;
    setBusy(true);
    const startedAt = Date.now();
    const active = () => mounted.current && currentRepo.current === repoPath;
    const update = (state: Omit<SubmoduleOperationState, "action" | "startedAt">) => {
      if (active()) setStates(previous => ({...previous, ...Object.fromEntries(paths.map(path => [path, {action, startedAt, ...state}]))}));
    };
    update({phase: "running", message: t(`submoduleFeedback.running.${action}`)});
    let result: T | undefined;
    let failure: unknown;
    try {
      result = await task();
    } catch (error) {
      failure = error;
    }
    let refreshFailure: unknown;
    if (action !== "open") {
      update({phase: "refreshing", message: t("submoduleFeedback.refreshing")});
      try { await refreshStatus(); } catch (error) { refreshFailure = error; }
    }
    if (failure || refreshFailure) {
      const error = failure ?? refreshFailure;
      const structured = typeof error === "object" && error !== null ? error as {code?: string; message?: string; details?: string} : null;
      const code = structured?.code ?? String(error).match(/SUBMODULE_[A-Z_]+/)?.[0];
      const message = failure
        ? t(`submoduleFeedback.errors.${code ?? "failed"}`, {defaultValue: t("submoduleFeedback.failed"), action: t(`submoduleFeedback.actions.${action}`)})
        : t("submoduleFeedback.refreshFailed");
      const diagnostic = structured?.details ?? structured?.message ?? String(error);
      update({phase: "error", message, error: diagnostic + (failure && refreshFailure ? `\n${t("submoduleFeedback.refreshFailed")}: ${String(refreshFailure)}` : "")});
      appendResultLog("error", `${message}: ${diagnostic}`, "git-cli", repoPath);
      if (active()) showToast(message, "error");
    } else {
      const outcome = result && "message" in result ? result.message : undefined;
      const message = t(`submoduleFeedback.outcomes.${outcome ?? action}`, {defaultValue: t(`submoduleFeedback.success.${action}`)});
      update({phase: "success", message});
      appendResultLog("success", message, "git-cli", repoPath);
      if (active()) showToast(message, "success");
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        if (active()) setStates(previous => {
          const next = {...previous};
          paths.forEach(path => { if (next[path]?.startedAt === startedAt && next[path]?.phase === "success") delete next[path]; });
          return next;
        });
      }, 4000);
      if (mounted.current) timers.current.add(timer); else clearTimeout(timer);
    }
    locked.current = false;
    if (mounted.current) setBusy(false);
    finishOperation(operation);
    return failure ? undefined : result;
  }, [repoPath, refreshStatus, startOperation, finishOperation, showToast, t]);

  const perform = useCallback((path: string, action: "initialise" | "checkout" | "sync" | "fetch" | "pull") => {
    const commands = {initialise: api.submoduleInit, checkout: api.submoduleUpdate, sync: api.submoduleSync, fetch: api.submoduleFetch, pull: api.submodulePull};
    const includeNested = action !== "pull" && recursive;
    return run([path], action, () => commands[action]({repoPath: repoPath!, path, recursive: includeNested}));
  }, [repoPath, recursive, run]);

  const prepare = useCallback(async (path: string) => {
    const origin = repoPath;
    const result = await run([path], "prepareRemote", () => api.submodulePrepareUpdate({repoPath: repoPath!, path, recursive}));
    if (result && mounted.current && currentRepo.current === origin) setPreview(result);
  }, [repoPath, recursive, run]);

  const apply = useCallback(async (path: string, includeNested: boolean) => {
    if (!preview || preview.path !== path) return;
    const origin = repoPath;
    const result = await run([path], "applyRemote", () => api.submoduleApplyUpdate({
      repoPath: repoPath!, path, recursive: includeNested,
      currentCommit: preview.currentCommit, targetCommit: preview.targetCommit,
      indexCommit: preview.indexCommit, parentHeadCommit: preview.parentHeadCommit,
      remote: preview.remote, branch: preview.branch, configurationToken: preview.configurationToken,
    }));
    if (result && mounted.current && currentRepo.current === origin) setPreview(null);
  }, [repoPath, preview, run]);

  const open = useCallback((path: string) => run([path], "open", async () => {
    const separator = repoPath!.includes("\\") ? "\\" : "/";
    await openRepository(`${repoPath!.replace(/[\\/]+$/, "")}${separator}${path.replace(/\//g, separator)}`);
  }), [repoPath, openRepository, run]);

  const dismiss = (path: string) => setStates(previous => {
    if (previous[path]?.phase !== "error") return previous;
    const next = {...previous};
    delete next[path];
    return next;
  });

  return {dismiss, states, busy, recursive, setRecursive, preview, closePreview: () => { if (!locked.current) setPreview(null); }, run, perform, prepare, apply, open};
}
