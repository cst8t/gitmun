import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import type { CloneStartupOptions, CloneWindowStartupOptions, LocalCopyDestinationMode, LocalCopyError, LocalCopyMode, LocalCopyProgress, LocalCopyStartupOptions, OperationResult, Settings } from "../../types";
import { CloseIcon, FolderIcon } from "../icons";
import { appendResultLog } from "../../utils/resultLog";
import { getCloneRepoUrlError } from "../../utils/gitInputValidation";
import { localCopyRepo, takePendingCloneWindowOptions } from "../../api/commands";
import { applyThemeMode } from "../../utils/theme";
import { applyUiTextScale } from "../../utils/uiTextScale";
import "./CloneWindow.css";

const CLONE_BASE_KEY = "gitmun.cloneBaseDir";
const THEME_MODE_KEY = "gitmun.themeMode";
type OperationMode = "clone" | "copy";

function safePlatform(): string {
  try {
    return platform();
  } catch {
    return "linux";
  }
}

function parseRepoName(url: string): string {
  const s = url.trim().replace(/\.git$/, "").replace(":", "/");
  const parts = s.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function getBaseDir(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return lastSep > 0 ? path.slice(0, lastSep) : path;
}

function destinationForRepo(base: string, repoUrl: string): string {
  const name = parseRepoName(repoUrl);
  if (!name) return base;
  if (!base) return name;
  const sep = base.includes("\\") ? "\\" : "/";
  return base + sep + name;
}

export function CloneWindow() {
  const { t } = useTranslation("clone");
  const useNativeWindowBar = true;
  const [operationMode, setOperationMode] = useState<OperationMode>("clone");
  const [localCopyEnabled, setLocalCopyEnabled] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [copySource, setCopySource] = useState("");
  const [copyMode, setCopyMode] = useState<LocalCopyMode>("filesOnly");
  const [destinationMode, setDestinationMode] = useState<LocalCopyDestinationMode>("dropOnTop");
  const [destination, setDestination] = useState("");
  const [status, setStatus] = useState(() => t("log.ready"));
  const [cloning, setCloning] = useState(false);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [repoUrlError, setRepoUrlError] = useState<string | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const localCopyEnabledRef = useRef(false);
  // copyBusyRef: true while a copy or clone is in flight.  Prevents
  // auto-startCopy from launching a second operation while one is active,
  // and prevents the Escape key / close button from hiding the window
  // while work is in progress.
  const copyBusyRef = useRef(false);

  // isAutoRef: true when destination was last set by our logic (mount/URL change/browse),
  // false when user manually typed in the field. Controls whether URL changes update the path.
  const isAutoRef = useRef(true);
  // baseDirRef: the explicit base directory; auto-fill always appends the repo name to this
  // rather than stripping the last segment of whatever is currently in the destination field.
  const baseDirRef = useRef("");
  const os = safePlatform();
  const destinationPlaceholder = os === "windows"
    ? t("placeholders.destinationWindows")
    : os === "macos"
      ? t("placeholders.destinationMac")
      : t("placeholders.destinationLinux");

  const cloneWithValues = useCallback(async (repoUrlValue: string, destinationValue: string) => {
    if (!repoUrlValue.trim()) {
      setStatus(t("log.repoUrlRequired"));
      return;
    }
    const inputError = getCloneRepoUrlError(repoUrlValue);
    if (inputError) {
      setStatus(t(inputError, { ns: "git", defaultValue: inputError }));
      return;
    }
    copyBusyRef.current = true;
    setCloning(true);
    setStatus(t("log.cloning"));
    setProgressLines([]);

    const onProgress = new Channel<string>();
    onProgress.onmessage = line => {
      setProgressLines(prev => [...prev.slice(-99), line]);
    };

    try {
      const result = await invoke<OperationResult>("clone_repo", {
        request: { repoUrl: repoUrlValue, destination: destinationValue },
        onProgress,
      });

      // Persist the base dir (parent of what was cloned into) for next time.
      const lastSep = Math.max(destinationValue.lastIndexOf("/"), destinationValue.lastIndexOf("\\"));
      if (lastSep > 0) {
        localStorage.setItem(CLONE_BASE_KEY, destinationValue.slice(0, lastSep));
      }

      if (result.repoPath) {
        await emit("repository-selected", { repoPath: result.repoPath });
      }

      const outputDetails = result.output ? ` (${result.output})` : "";
      setStatus(`${result.message}${outputDetails}`);
      appendResultLog("success", result.message, result.backendUsed, result.repoPath ?? destinationValue);
      await getCurrentWindow().close();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        setStatus(t("log.cloneCancelled"));
      } else {
        const message = t("log.cloneFailed", { message: msg });
        setStatus(message);
        appendResultLog("error", message, "unknown", destinationValue);
      }
    } finally {
      copyBusyRef.current = false;
      setCloning(false);
    }
  }, [t]);

  const copyWithValues = useCallback(async (
    sourceValue: string,
    destinationValue: string,
    modeValue: LocalCopyMode,
    destinationModeValue: LocalCopyDestinationMode,
  ) => {
    if (!localCopyEnabledRef.current) {
      setStatus(t("errors.featureDisabled"));
      return;
    }
    if (!sourceValue.trim()) {
      setStatus(t("log.sourceRequired"));
      return;
    }
    if (!destinationValue.trim()) {
      setStatus(t("log.destinationRequired"));
      return;
    }
    if (modeValue === "filesOnly" && destinationModeValue === "deleteExisting") {
      const confirmed = await ask(t("ask.deleteExisting.message", { path: destinationValue }), {
        title: t("ask.deleteExisting.title"),
        kind: "warning",
        okLabel: t("actions.deleteExisting"),
        cancelLabel: t("actions.cancel"),
      });
      if (!confirmed) return;
    }
    // Require confirmation before overlaying an existing non-empty destination.
    const needsDropOnTopConfirm = modeValue === "filesOnly" && destinationModeValue === "dropOnTop";
    if (needsDropOnTopConfirm) {
      try {
        const exists = await invoke<boolean>("path_is_nonempty_dir", { path: destinationValue });
        if (exists) {
          const confirmed = await ask(t("ask.dropOnTopExisting.message", { path: destinationValue }), {
            title: t("ask.dropOnTopExisting.title"),
            kind: "warning",
            okLabel: t("actions.copy"),
            cancelLabel: t("actions.cancel"),
          });
          if (!confirmed) return;
        }
      } catch {
        // If we cannot check, proceed without confirmation.
      }
    }

    copyBusyRef.current = true;
    setCloning(true);
    setStatus(t("log.copying"));
    setProgressLines([]);

    const onProgress = new Channel<LocalCopyProgress>();
    onProgress.onmessage = progress => {
      const line = progress.kind === "externalOutput"
        ? progress.line
        : t(`progress.phases.${progress.phase}`);
      setProgressLines(prev => [...prev.slice(-99), line]);
    };

    let backendSuccess = false;
    let resultDestinationPath = destinationValue;
    try {
      const result = await localCopyRepo({
        source: sourceValue,
        destination: destinationValue,
        copyMode: modeValue,
        destinationMode: destinationModeValue,
      }, onProgress);
      backendSuccess = true;
      resultDestinationPath = result.destinationPath;

      // Post-success UI operations.  Failures here must not be reported as
      // copy failures because the filesystem work already completed.
      try {
        await emit("repository-selected", { repoPath: result.destinationPath });
      } catch {
        setStatus(t("log.copyCompleteCannotOpen", { path: result.destinationPath }));
        appendResultLog("success", t("log.copyComplete", { path: result.destinationPath }), result.backend, result.destinationPath);
        return;
      }
      const completionMessage = t("log.copyComplete", {path: result.destinationPath});
      appendResultLog("success", completionMessage, result.backend, result.destinationPath);
      if (result.warning) {
        const warningMessage = t(`warnings.${result.warning.code}`, {
          path: result.warning.path ?? result.destinationPath,
          defaultValue: t("warnings.unknown", {path: result.warning.path ?? result.destinationPath}),
        });
        setStatus(warningMessage);
        appendResultLog("info", warningMessage, result.backend, result.warning.path ?? result.destinationPath, result.warning.detail);
      } else {
        setStatus(completionMessage);
        try {
          await getCurrentWindow().close();
        } catch {
          // Window close failed but the copy succeeded.
        }
      }
    } catch (e) {
      if (backendSuccess) {
        // Backend succeeded but a post-success UI operation threw.
        const completionMessage = t("log.copyComplete", { path: resultDestinationPath });
        setStatus(completionMessage);
        appendResultLog("success", completionMessage, "git-cli", resultDestinationPath);
        try { await getCurrentWindow().close(); } catch { /* ignore */ }
        return;
      }
      const error: Partial<LocalCopyError> = typeof e === "object" && e !== null ? e : {};
      const errorCode = typeof error.code === "string" ? error.code : "unknown";
      if (errorCode === "cancelled") {
        setStatus(t("log.copyCancelled"));
      } else {
        const message = t(`errors.${errorCode}`, {
          path: error.path ?? destinationValue,
          defaultValue: t("errors.unknown"),
        });
        setStatus(message);
        appendResultLog("error", message, "unknown", error.path ?? destinationValue, error.detail);
      }
    } finally {
      copyBusyRef.current = false;
      setCloning(false);
    }
  }, [t]);

  const applyCloneOptions = useCallback((options: CloneStartupOptions, fallbackDestination: string) => {
    setOperationMode("clone");
    const nextRepoUrl = options.repoUrl ?? "";
    const nextDestination = options.destination
      ?? (nextRepoUrl ? destinationForRepo(fallbackDestination, nextRepoUrl) : fallbackDestination);

    if (options.repoUrl != null) {
      setRepoUrl(options.repoUrl);
    }
    if (nextDestination) {
      baseDirRef.current = options.destination ?? fallbackDestination;
      setDestination(nextDestination);
      isAutoRef.current = options.destination == null;
    }

    if (options.startClone) {
      void cloneWithValues(nextRepoUrl, nextDestination);
    }
  }, [cloneWithValues]);

  const applyCopyOptions = useCallback((options: LocalCopyStartupOptions, fallbackDestination: string) => {
    if (!localCopyEnabledRef.current) {
      setOperationMode("clone");
      setStatus(t("errors.featureDisabled"));
      return;
    }
    setOperationMode("copy");
    const nextSource = options.source ?? "";
    const nextCopyMode = options.copyMode ?? "filesOnly";
    // Never use the clone base as a runnable Files Only target.
    // Prefer <base>/<source-name> when a source name exists; otherwise
    // require an explicit destination.
    const derivedDestination = (() => {
      const sourceName = nextSource ? parseRepoName(nextSource) : null;
      if (options.destination) return options.destination;
      if (sourceName) return destinationForRepo(fallbackDestination, sourceName);
      return "";
    })();

    if (options.source != null) {
      setCopySource(options.source);
    }
    if (options.destination ?? nextSource) {
      setDestination(derivedDestination);
      isAutoRef.current = options.destination == null;
    }
    if (options.copyMode != null) {
      setCopyMode(options.copyMode);
    }
    if (nextCopyMode === "completeRepository") {
      setDestinationMode("dropOnTop");
    } else {
      setDestinationMode(options.destinationMode);
    }

    if (options.startCopy && !copyBusyRef.current) {
      void copyWithValues(
        nextSource,
        derivedDestination || (options.destination ?? fallbackDestination),
        nextCopyMode,
        options.destinationMode,
      );
    }
  }, [copyWithValues, t]);

  const applyWindowOptions = useCallback((startup: CloneWindowStartupOptions, fallbackDestination: string) => {
    if (startup.operationMode === "clone") {
      applyCloneOptions(startup.options, fallbackDestination);
    } else {
      applyCopyOptions(startup.options, fallbackDestination);
    }
  }, [applyCloneOptions, applyCopyOptions]);

  useEffect(() => {
    (async () => {
      try {
        const persistedTheme = localStorage.getItem(THEME_MODE_KEY);
        if (persistedTheme === "System" || persistedTheme === "Light" || persistedTheme === "Dark") {
          await invoke("set_theme_mode", { themeMode: persistedTheme });
        }
        const settings = await invoke<Settings>("get_settings");
        localCopyEnabledRef.current = settings.enableLocalCopy ?? false;
        setLocalCopyEnabled(localCopyEnabledRef.current);
        await applyThemeMode(settings.themeMode);
        applyUiTextScale(settings.uiTextScale);

        const lastUsed = localStorage.getItem(CLONE_BASE_KEY);
        const fallbackDestination = lastUsed || settings.defaultCloneDir || await invoke<string>("get_default_clone_dir");
        baseDirRef.current = fallbackDestination;
        setDestination(fallbackDestination);

        const pendingOptions = await takePendingCloneWindowOptions();
        if (pendingOptions) {
          applyWindowOptions(pendingOptions, fallbackDestination);
        }
      } catch (e) {
        setStatus(t("log.loadFailed", { message: String(e) }));
      }
    })();
  }, [applyWindowOptions, t]);

  useEffect(() => {
    let cancelled = false;
    const removeListeners: Array<() => void> = [];
    const updateLocalCopySetting = async (settings?: Settings) => {
      const currentSettings = settings ?? await invoke<Settings>("get_settings");
      if (cancelled) return;
      localCopyEnabledRef.current = currentSettings.enableLocalCopy ?? false;
      setLocalCopyEnabled(localCopyEnabledRef.current);
    };
    void (async () => {
      removeListeners.push(await listen<Settings>("settings-updated", event => {
        void updateLocalCopySetting(event.payload);
      }));
      removeListeners.push(await listen("instance-settings-updated", () => {
        void updateLocalCopySetting();
      }));
    })();
    return () => {
      cancelled = true;
      removeListeners.forEach(removeListener => removeListener());
    };
  }, []);

  useEffect(() => {
    if (!localCopyEnabled && !cloning && operationMode === "copy") {
      setOperationMode("clone");
      setStatus(t("errors.featureDisabled"));
    }
  }, [cloning, localCopyEnabled, operationMode, t]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen("clone-window-options-updated", async () => {
        const pendingOptions = await takePendingCloneWindowOptions();
        if (pendingOptions) {
          applyWindowOptions(pendingOptions, destination || baseDirRef.current);
        }
      });
      if (cancelled) fn(); else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyWindowOptions, destination]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !cloning) getCurrentWindow().close();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [cloning]);

  useEffect(() => {
    if (progressRef.current) {
      progressRef.current.scrollTop = progressRef.current.scrollHeight;
    }
  }, [progressLines]);

  useEffect(() => {
    setRepoUrlError(getCloneRepoUrlError(repoUrl));
  }, [repoUrl]);

  // When URL changes and destination is under auto-fill control, update destination
  // to baseDirRef + repo name (never strips the last segment of the base dir).
  useEffect(() => {
    if (!repoUrl.trim() || !isAutoRef.current) return;
    const name = parseRepoName(repoUrl);
    if (!name) return;
    const base = baseDirRef.current;
    if (!base) {
      setDestination(name);
      return;
    }
    setDestination(destinationForRepo(base, name));
  }, [repoUrl]);

  const handleRepoUrlChange = useCallback((val: string) => {
    setRepoUrl(val);
  }, []);

  const handleDestinationChange = useCallback((val: string) => {
    setDestination(val);
    // If user clears the field, re-enable auto-fill. Otherwise lock it.
    isAutoRef.current = !val;
  }, []);

  const handleBrowse = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("picker.destination"),
        defaultPath: destination ? getBaseDir(destination) : undefined,
      });
      if (typeof selected === "string") {
        const repoName = parseRepoName(repoUrl);
        const newDest = repoName ? destinationForRepo(selected, repoUrl) : selected;
        baseDirRef.current = selected;
        setDestination(newDest);
        isAutoRef.current = true;
        localStorage.setItem(CLONE_BASE_KEY, selected);
        setStatus(t("log.destinationSet", { path: selected }));
      }
    } catch (e) {
      setStatus(t("log.browseFailed", { message: String(e) }));
    }
  }, [destination, repoUrl, t]);

  const handleSourceBrowse = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("picker.source"),
        defaultPath: copySource || undefined,
      });
      if (typeof selected === "string") {
        setCopySource(selected);
        setStatus(t("log.sourceSet", { path: selected }));
      }
    } catch (e) {
      setStatus(t("log.browseFailed", { message: String(e) }));
    }
  }, [copySource, t]);

  const handleCopyDestinationBrowse = useCallback(async () => {
    try {
      // For Complete Repository, behave like the clone picker: select a
      // parent directory and derive a new child name from the source.
      const parentHint = copyMode === "completeRepository"
        ? (destination ? getBaseDir(destination) : destination || undefined)
        : (destination || undefined);
      const selected = await open({
        directory: true,
        multiple: false,
        title: t("picker.copyDestination"),
        defaultPath: parentHint,
      });
      if (typeof selected === "string") {
        if (copyMode === "completeRepository") {
          // Derive a new child directory name from the source.
          const sourceName = copySource
            ? parseRepoName(copySource) || "repository"
            : "repository";
          const newDest = destinationForRepo(selected, sourceName);
          setDestination(newDest);
          isAutoRef.current = true;
        } else {
          setDestination(selected);
          isAutoRef.current = false;
        }
        setStatus(t("log.destinationSet", { path: selected }));
      }
    } catch (e) {
      setStatus(t("log.browseFailed", { message: String(e) }));
    }
  }, [copyMode, copySource, destination, t]);

  const handleClone = useCallback(async () => {
    if (operationMode === "clone") {
      await cloneWithValues(repoUrl, destination);
    } else {
      await copyWithValues(copySource, destination, copyMode, destinationMode);
    }
  }, [cloneWithValues, copyMode, copySource, copyWithValues, destination, destinationMode, operationMode, repoUrl]);

  const handleCancel = useCallback(async () => {
    await invoke("cancel_clone");
    // The clone_repo promise will reject with "Clone cancelled." and the
    // catch block above will update the status and reset cloning state.
  }, []);

  const handleClose = useCallback(() => {
    getCurrentWindow().close();
  }, []);

  const canClone = operationMode === "clone"
    ? !cloning && !!repoUrl.trim() && !!destination.trim() && !repoUrlError
    : !cloning && !!copySource.trim() && !!destination.trim();
  const actionLabel = operationMode === "clone" ? t("actions.clone") : t("actions.copy");
  const busyLabel = operationMode === "clone" ? t("actions.cloning") : t("actions.copying");

  return (
    <div className="clone-window">
      {!useNativeWindowBar && (
        <div className="clone-window__header">
          <span className="clone-window__title">{t("labels.title")}</span>
          <button className="clone-window__close" onClick={handleClose}>
            <CloseIcon />
          </button>
        </div>
      )}

      <div className="clone-window__body">
        {localCopyEnabled && (
          <div className="clone-window__mode-tabs" role="tablist" aria-label={t("labels.operation")}>
            <button
              type="button"
              className={`clone-window__mode-tab${operationMode === "clone" ? " clone-window__mode-tab--active" : ""}`}
              onClick={() => setOperationMode("clone")}
              disabled={cloning}
            >
              {t("modes.clone")}
            </button>
            <button
              type="button"
              className={`clone-window__mode-tab${operationMode === "copy" ? " clone-window__mode-tab--active" : ""}`}
              onClick={() => setOperationMode("copy")}
              disabled={cloning}
            >
              {t("modes.copy")}
            </button>
          </div>
        )}

        {operationMode === "clone" ? (
          <div className="clone-window__row">
            <label className="clone-window__label">{t("labels.repositoryUrl")}</label>
            <input
              className="clone-window__input"
              type="text"
              value={repoUrl}
              onChange={e => handleRepoUrlChange(e.target.value)}
              placeholder={t("placeholders.url")}
              disabled={cloning}
            />
            {repoUrlError && <div className="clone-window__error">{t(repoUrlError, { ns: "git", defaultValue: repoUrlError })}</div>}
          </div>
        ) : (
          <>
            <div className="clone-window__row">
              <label className="clone-window__label">{t("labels.source")}</label>
              <div className="clone-window__inline-field">
                <input
                  className="clone-window__input"
                  type="text"
                  value={copySource}
                  onChange={e => setCopySource(e.target.value)}
                  placeholder={t("placeholders.source")}
                  disabled={cloning}
                />
                <button className="clone-window__browse-btn" onClick={handleSourceBrowse} disabled={cloning} title={t("actions.browse")}>
                  <FolderIcon />
                </button>
              </div>
            </div>

            <div className="clone-window__row">
              <label className="clone-window__label">{t("labels.copyMode")}</label>
              <div className="clone-window__option-grid">
                <button
                  type="button"
                  className={`clone-window__option${copyMode === "filesOnly" ? " clone-window__option--active" : ""}`}
                  onClick={() => setCopyMode("filesOnly")}
                  disabled={cloning}
                >
                  {t("copyModes.filesOnly")}
                </button>
                <button
                  type="button"
                  className={`clone-window__option${copyMode === "completeRepository" ? " clone-window__option--active" : ""}`}
                  onClick={() => { setCopyMode("completeRepository"); setDestinationMode("dropOnTop"); }}
                  disabled={cloning}
                >
                  {t("copyModes.completeRepository")}
                </button>
              </div>
              <div className="clone-window__option-description">
                {t(`copyModeDescriptions.${copyMode}`)}
              </div>
            </div>

            <div className="clone-window__row">
              <label className="clone-window__label">{t("labels.destinationMode")}</label>
              <div className={`clone-window__option-grid${copyMode === "completeRepository" ? " clone-window__option-grid--disabled" : ""}`}>
                <button
                  type="button"
                  className={`clone-window__option${destinationMode === "dropOnTop" ? " clone-window__option--active" : ""}`}
                  onClick={() => setDestinationMode("dropOnTop")}
                  disabled={cloning || copyMode === "completeRepository"}
                >
                  {t("destinationModes.dropOnTop")}
                </button>
                <button
                  type="button"
                  className={`clone-window__option${destinationMode === "deleteExisting" ? " clone-window__option--active" : ""}`}
                  onClick={() => setDestinationMode("deleteExisting")}
                  disabled={cloning || copyMode === "completeRepository"}
                >
                  {t("destinationModes.deleteExisting")}
                </button>
              </div>
              <div className="clone-window__option-description">
                {t(`destinationModeDescriptions.${destinationMode}`)}
              </div>
            </div>
          </>
        )}

        <div className="clone-window__row">
          <label className="clone-window__label">{t("labels.destination")}</label>
          <div className="clone-window__inline-field">
            <input
              className="clone-window__input"
              type="text"
              value={destination}
              onChange={e => handleDestinationChange(e.target.value)}
              placeholder={destinationPlaceholder}
              disabled={cloning}
            />
            <button
              className="clone-window__browse-btn"
              onClick={operationMode === "clone" ? handleBrowse : handleCopyDestinationBrowse}
              disabled={cloning}
              title={t("actions.browse")}
            >
              <FolderIcon />
            </button>
          </div>
        </div>

        <div className="clone-window__progress" ref={progressRef}>
          {!cloning && progressLines.length === 0
            ? <span className="clone-window__progress-idle">{t("placeholders.output")}</span>
            : progressLines.length === 0
              ? <span className="clone-window__progress-waiting">{t("progress.connecting")}</span>
              : progressLines.map((line, lineIndex) => (
                  <div key={lineIndex} className="clone-window__progress-line">{line}</div>
                ))
          }
        </div>
      </div>

      <div className="clone-window__footer">
        <div className="clone-window__actions">
          <button
            className="clone-window__btn clone-window__btn--primary"
            onClick={handleClone}
            disabled={!canClone}
          >
            {cloning && <span className="clone-window__spinner" />}
            {cloning ? busyLabel : actionLabel}
          </button>
          {cloning ? (
            <button className="clone-window__btn clone-window__btn--danger" onClick={handleCancel}>
              {t("actions.cancel")}
            </button>
          ) : (
            <button className="clone-window__btn clone-window__btn--secondary" onClick={handleClose}>
              {t("actions.close")}
            </button>
          )}
        </div>
        <span className="clone-window__status">{status}</span>
      </div>
    </div>
  );
}
