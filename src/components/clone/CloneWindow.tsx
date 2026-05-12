import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { platform } from "@tauri-apps/plugin-os";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import type { OperationResult, Settings, ThemeMode } from "../../types";
import { CloseIcon, FolderIcon } from "../icons";
import { appendResultLog } from "../../utils/resultLog";
import { getCloneRepoUrlError } from "../../utils/gitInputValidation";
import { takePendingCloneDestination } from "../../api/commands";
import { applyUiTextScale } from "../../utils/uiTextScale";
import "./CloneWindow.css";

const CLONE_BASE_KEY = "gitmun.cloneBaseDir";
const THEME_MODE_KEY = "gitmun.themeMode";

async function resolveTheme(mode: ThemeMode): Promise<"light" | "dark"> {
  if (mode === "Light") return "light";
  if (mode === "Dark") return "dark";
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  try {
    const hint = await invoke<string>("get_system_theme_hint");
    return hint === "dark" ? "dark" : "light";
  } catch {
    return "dark";
  }
}

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

export function CloneWindow() {
  const { t } = useTranslation("clone");
  const useNativeWindowBar = true;
  const [repoUrl, setRepoUrl] = useState("");
  const [destination, setDestination] = useState("");
  const [status, setStatus] = useState(() => t("log.ready"));
  const [cloning, setCloning] = useState(false);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [repoUrlError, setRepoUrlError] = useState<string | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    (async () => {
      try {
        const persistedTheme = localStorage.getItem(THEME_MODE_KEY);
        if (persistedTheme === "System" || persistedTheme === "Light" || persistedTheme === "Dark") {
          await invoke("set_theme_mode", { themeMode: persistedTheme });
        }
        const settings = await invoke<Settings>("get_settings");
        document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);
        applyUiTextScale(settings.uiTextScale);

        // Initialise destination: pending shell destination > last-used dir > settings default > OS default.
        const pendingDestination = await takePendingCloneDestination();
        if (pendingDestination) {
          baseDirRef.current = pendingDestination;
          setDestination(pendingDestination);
          isAutoRef.current = false;
        } else {
          const lastUsed = localStorage.getItem(CLONE_BASE_KEY);
          if (lastUsed) {
            baseDirRef.current = lastUsed;
            setDestination(lastUsed);
          } else if (settings.defaultCloneDir) {
            baseDirRef.current = settings.defaultCloneDir;
            setDestination(settings.defaultCloneDir);
          } else {
            const dir = await invoke<string>("get_default_clone_dir");
            baseDirRef.current = dir;
            setDestination(dir);
          }
        }
      } catch (e) {
        setStatus(t("log.loadFailed", { message: String(e) }));
      }
    })();
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen<string>("clone-destination-updated", (event) => {
        const path = event.payload;
        if (!path) return;
        baseDirRef.current = path;
        setDestination(path);
        isAutoRef.current = false;
      });
      if (cancelled) fn(); else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
    const sep = base.includes("\\") ? "\\" : "/";
    setDestination(base + sep + name);
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
        const sep = selected.includes("\\") ? "\\" : "/";
        const newDest = repoName ? selected + sep + repoName : selected;
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

  const handleClone = useCallback(async () => {
    if (!repoUrl.trim()) {
      setStatus(t("log.repoUrlRequired"));
      return;
    }
    const inputError = getCloneRepoUrlError(repoUrl);
    if (inputError) {
      setStatus(t(inputError, { ns: "git", defaultValue: inputError }));
      return;
    }
    setCloning(true);
    setStatus(t("log.cloning"));
    setProgressLines([]);

    const onProgress = new Channel<string>();
    onProgress.onmessage = line => {
      setProgressLines(prev => [...prev.slice(-99), line]);
    };

    try {
      const result = await invoke<OperationResult>("clone_repo", {
        request: { repoUrl, destination },
        onProgress,
      });

      // Persist the base dir (parent of what was cloned into) for next time.
      const lastSep = Math.max(destination.lastIndexOf("/"), destination.lastIndexOf("\\"));
      if (lastSep > 0) {
        localStorage.setItem(CLONE_BASE_KEY, destination.slice(0, lastSep));
      }

      if (result.repoPath) {
        await emit("repository-selected", { repoPath: result.repoPath });
      }

      const outputDetails = result.output ? ` (${result.output})` : "";
      setStatus(`${result.message}${outputDetails}`);
      appendResultLog("success", result.message, result.backendUsed, result.repoPath ?? destination);
      await getCurrentWindow().close();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("cancelled")) {
        setStatus(t("log.cloneCancelled"));
      } else {
        const message = t("log.cloneFailed", { message: msg });
        setStatus(message);
        appendResultLog("error", message, "unknown", destination);
      }
    } finally {
      setCloning(false);
    }
  }, [repoUrl, destination, t]);

  const handleCancel = useCallback(async () => {
    await invoke("cancel_clone");
    // The clone_repo promise will reject with "Clone cancelled." and the
    // catch block above will update the status and reset cloning state.
  }, []);

  const handleClose = useCallback(() => {
    getCurrentWindow().close();
  }, []);

  const canClone = !cloning && !!repoUrl.trim() && !!destination.trim() && !repoUrlError;

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
            <button className="clone-window__browse-btn" onClick={handleBrowse} disabled={cloning}>
              <FolderIcon />
            </button>
          </div>
        </div>

        <div className="clone-window__progress" ref={progressRef}>
          {!cloning && progressLines.length === 0
            ? <span className="clone-window__progress-idle">{t("placeholders.output")}</span>
            : progressLines.length === 0
              ? <span className="clone-window__progress-waiting">{t("progress.connecting")}</span>
              : progressLines.map((line, i) => (
                  <div key={i} className="clone-window__progress-line">{line}</div>
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
            {cloning ? t("actions.cloning") : t("actions.clone")}
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
