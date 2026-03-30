import React, { useState, useCallback, useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { Toast } from "./Toast";
import { ProjectView } from "./ProjectView";
import { useToast } from "../hooks/useToast";
import { usePlatform } from "../hooks/usePlatform";
import * as api from "../api/commands";
import type { Settings, ThemeMode } from "../types";
import { appendResultLog } from "../utils/resultLog";
import "./App.css";

const REPO_STORAGE_KEY = "gitmun.activeRepoPath";
const BACKEND_MODE_KEY = "gitmun.backendMode";
const SHOW_RESULT_LOG_KEY = "gitmun.showResultLog";
const THEME_MODE_KEY = "gitmun.themeMode";
const LEFT_PANE_RATIO_KEY = "gitmun.leftPaneRatio";
const RIGHT_PANE_RATIO_KEY = "gitmun.rightPaneRatio";
const LEFT_PANE_COLLAPSED_KEY = "gitmun.leftPaneCollapsed";
const DEFAULT_LEFT_PANE_WIDTH = 300;
const DEFAULT_RIGHT_PANE_WIDTH = 480;
const DEFAULT_LEFT_PANE_RATIO = 0.22;
const DEFAULT_RIGHT_PANE_RATIO = 0.34;
const MIN_LEFT_PANE_WIDTH = 220;
const MIN_RIGHT_PANE_WIDTH = 360;
const MIN_CENTER_PANE_WIDTH = 420;
const SPLITTER_WIDTH = 6;
const LEFT_PANE_TOGGLE_WIDTH = 22;
const SPLITTER_SPACE = 12;

async function resolveTheme(mode: ThemeMode): Promise<"light" | "dark"> {
  if (mode === "Light") return "light";
  if (mode === "Dark") return "dark";
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  try {
    const hint = await api.getSystemThemeHint();
    return hint === "dark" ? "dark" : "light";
  } catch {
    return "dark";
  }
}

function isValidPaneWidth(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function parsePaneRatio(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0 || parsed >= 1) return null;
  return parsed;
}

function savePaneRatios(totalWidth: number, left: number, right: number): void {
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) return;
  const leftRatio = left / totalWidth;
  const rightRatio = right / totalWidth;
  if (Number.isFinite(leftRatio) && leftRatio > 0 && leftRatio < 1) {
    localStorage.setItem(LEFT_PANE_RATIO_KEY, leftRatio.toFixed(6));
  }
  if (Number.isFinite(rightRatio) && rightRatio > 0 && rightRatio < 1) {
    localStorage.setItem(RIGHT_PANE_RATIO_KEY, rightRatio.toFixed(6));
  }
}

function isLikelyNotRepoError(error: unknown): boolean {
  return /not a git repository/i.test(String(error));
}

function clampPaneLayout(totalWidth: number, desiredLeft: number, desiredRight: number): { left: number; right: number } {
  if (!Number.isFinite(totalWidth) || totalWidth <= 0) {
    return { left: DEFAULT_LEFT_PANE_WIDTH, right: DEFAULT_RIGHT_PANE_WIDTH };
  }

  const defaultLeft = Math.round(totalWidth * DEFAULT_LEFT_PANE_RATIO);
  const defaultRight = Math.round(totalWidth * DEFAULT_RIGHT_PANE_RATIO);
  let left = isValidPaneWidth(desiredLeft) ? desiredLeft : defaultLeft;
  let right = isValidPaneWidth(desiredRight) ? desiredRight : defaultRight;

  const targetSides = Math.max(0, totalWidth - MIN_CENTER_PANE_WIDTH - SPLITTER_SPACE);
  if (targetSides <= 0) {
    const half = Math.max(0, Math.floor((totalWidth - SPLITTER_SPACE) / 2));
    return { left: half, right: Math.max(0, totalWidth - SPLITTER_SPACE - half) };
  }

  const preferredMinLeft = Math.min(MIN_LEFT_PANE_WIDTH, targetSides);
  const preferredMinRight = Math.min(MIN_RIGHT_PANE_WIDTH, targetSides);

  left = Math.max(left, preferredMinLeft);
  right = Math.max(right, preferredMinRight);

  const sidesTotal = left + right;
  if (sidesTotal > targetSides) {
    let deficit = sidesTotal - targetSides;
    const rightShrink = Math.min(deficit, Math.max(0, right - preferredMinRight));
    right -= rightShrink;
    deficit -= rightShrink;

    const leftShrink = Math.min(deficit, Math.max(0, left - preferredMinLeft));
    left -= leftShrink;
    deficit -= leftShrink;

    if (deficit > 0) {
      const currentTotal = left + right;
      if (currentTotal > 0) {
        const scale = Math.max(0, (currentTotal - deficit) / currentTotal);
        left = Math.max(0, Math.floor(left * scale));
        right = Math.max(0, targetSides - left);
      }
    }
  }

  const rightMinVisible = Math.min(120, targetSides);
  const leftMax = Math.max(0, targetSides - rightMinVisible);
  left = Math.min(Math.max(0, left), leftMax);
  right = Math.min(Math.max(0, right), Math.max(0, targetSides - left));
  left = Math.min(Math.max(0, left), Math.max(0, targetSides - right));

  return { left: Math.round(left), right: Math.round(right) };
}

export function App() {
  const platform = usePlatform();
  const { toast, showToast } = useToast();

  const [repoPath, setRepoPath] = useState<string | null>(null);
  const [recentRepos, setRecentRepos] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem("gitmun.recentRepos") ?? "[]"); }
    catch { return []; }
  });
  const [identityOpen, setIdentityOpen] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(true);
  const [settingsRevision, setSettingsRevision] = useState(0);

  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(DEFAULT_LEFT_PANE_WIDTH);
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(DEFAULT_RIGHT_PANE_WIDTH);
  const [leftPaneCollapsed, setLeftPaneCollapsed] = useState<boolean>(() => {
    return localStorage.getItem(LEFT_PANE_COLLAPSED_KEY) === "true";
  });
  const [draggingPane, setDraggingPane] = useState<"left" | "right" | null>(null);
  const appBodyRef = useRef<HTMLDivElement | null>(null);
  const paneLayoutRef = useRef<{ left: number; right: number }>({
    left: DEFAULT_LEFT_PANE_WIDTH,
    right: DEFAULT_RIGHT_PANE_WIDTH,
  });

  const pushRecentRepo = useCallback((path: string) => {
    setRecentRepos(prev => {
      const next = [path, ...prev.filter(p => p !== path)].slice(0, 10);
      localStorage.setItem("gitmun.recentRepos", JSON.stringify(next));
      return next;
    });
  }, []);

  const checkForUpdatesOnLaunch = useCallback(async (autoInstallUpdates: boolean) => {
    try {
      const update = await check();
      if (!update) {
        return;
      }

      showToast(`Update ${update.version} is available.`, "info");

      if (!autoInstallUpdates) {
        return;
      }

      showToast(`Downloading update ${update.version}...`, "info");
      await update.downloadAndInstall();
      showToast("Update installed. Restart Gitmun to finish applying it.", "success");
    } catch {
      return;
    }
  }, [showToast]);

  useEffect(() => {
    paneLayoutRef.current = { left: leftPaneWidth, right: rightPaneWidth };
  }, [leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    localStorage.setItem(LEFT_PANE_COLLAPSED_KEY, String(leftPaneCollapsed));
  }, [leftPaneCollapsed]);

  useEffect(() => {
    const root = appBodyRef.current;
    if (!root) return;

    const applyLayout = () => {
      const totalWidth = root.getBoundingClientRect().width;
      if (totalWidth <= 0) return;
      const next = clampPaneLayout(totalWidth, paneLayoutRef.current.left, paneLayoutRef.current.right);
      if (next.left !== paneLayoutRef.current.left) setLeftPaneWidth(next.left);
      if (next.right !== paneLayoutRef.current.right) setRightPaneWidth(next.right);
      paneLayoutRef.current = next;
    };

    applyLayout();
    const observer = new ResizeObserver(applyLayout);
    observer.observe(root);
    window.addEventListener("resize", applyLayout);
    return () => { observer.disconnect(); window.removeEventListener("resize", applyLayout); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]); // re-run after ProjectView remounts for a new repo

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const persistedMode = localStorage.getItem(BACKEND_MODE_KEY);
        if (persistedMode === "Default" || persistedMode === "GitCliOnly") {
          await api.setBackendMode(persistedMode);
        }
        const persistedLog = localStorage.getItem(SHOW_RESULT_LOG_KEY);
        if (persistedLog === "true" || persistedLog === "false") {
          await api.setShowResultLog(persistedLog === "true");
        }
        const persistedTheme = localStorage.getItem(THEME_MODE_KEY);
        if (persistedTheme === "System" || persistedTheme === "Light" || persistedTheme === "Dark") {
          await api.setThemeMode(persistedTheme);
        }
        const settings = await api.getSettings();
        if (cancelled) return;
        document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);
        const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
        const leftRatio = parsePaneRatio(localStorage.getItem(LEFT_PANE_RATIO_KEY));
        const rightRatio = parsePaneRatio(localStorage.getItem(RIGHT_PANE_RATIO_KEY));
        const desiredLeft = isValidPaneWidth(settings.leftPaneWidth)
          ? settings.leftPaneWidth : DEFAULT_LEFT_PANE_WIDTH;
        const desiredRight = isValidPaneWidth(settings.rightPaneWidth)
          ? settings.rightPaneWidth : DEFAULT_RIGHT_PANE_WIDTH;
        const ratioLeft  = totalWidth > 0 && leftRatio  != null ? totalWidth * leftRatio  : desiredLeft;
        const ratioRight = totalWidth > 0 && rightRatio != null ? totalWidth * rightRatio : desiredRight;
        const nextLayout = totalWidth > 0
          ? clampPaneLayout(totalWidth, ratioLeft, ratioRight)
          : { left: desiredLeft, right: desiredRight };
        setLeftPaneWidth(nextLayout.left);
        setRightPaneWidth(nextLayout.right);
        paneLayoutRef.current = nextLayout;
        if (totalWidth > 0) savePaneRatios(totalWidth, nextLayout.left, nextLayout.right);
        setConfirmRevert(settings.confirmRevert ?? true);
        if (settings.showResultLog) {
          api.openResultLogWindow().catch(e => {
            appendResultLog("error", `Result log window failed to open: ${String(e)}`, "unknown");
          });
        }

        if (settings.autoCheckForUpdatesOnLaunch && await api.isUpdaterEnabled()) {
          void checkForUpdatesOnLaunch(settings.autoInstallUpdates ?? false);
        }
      } catch {
        document.documentElement.dataset.theme = "dark";
      }
    })();
    return () => { cancelled = true; };
  }, [checkForUpdatesOnLaunch]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen<{ repoPath?: string }>("repository-selected", (event) => {
        const path = event.payload?.repoPath;
        if (!path) return;
        api.validateRepoPath(path).then(() => {
          setRepoPath(path);
          pushRecentRepo(path);
          showToast(`Opened ${path.split("/").pop()}`);
          appendResultLog("info", `Opened repository ${path}`, "unknown");
        }).catch((e: unknown) => showToast(String(e), "error"));
      });
      if (cancelled) fn(); else unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [pushRecentRepo, showToast]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen<Settings>("settings-updated", async (event) => {
        const settings = event.payload;
        document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);
        localStorage.setItem(BACKEND_MODE_KEY, settings.backendMode);
        localStorage.setItem(SHOW_RESULT_LOG_KEY, String(settings.showResultLog));
        localStorage.setItem(THEME_MODE_KEY, settings.themeMode);
        const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
        const desiredLeft = isValidPaneWidth(settings.leftPaneWidth)
          ? settings.leftPaneWidth : paneLayoutRef.current.left;
        const desiredRight = isValidPaneWidth(settings.rightPaneWidth)
          ? settings.rightPaneWidth : paneLayoutRef.current.right;
        const nextLayout = totalWidth > 0
          ? clampPaneLayout(totalWidth, desiredLeft, desiredRight)
          : { left: desiredLeft, right: desiredRight };
        setLeftPaneWidth(nextLayout.left);
        setRightPaneWidth(nextLayout.right);
        paneLayoutRef.current = nextLayout;
        if (totalWidth > 0) savePaneRatios(totalWidth, nextLayout.left, nextLayout.right);
        setSettingsRevision(r => r + 1);
        showToast("Settings updated");
        appendResultLog("info", "Settings updated", "unknown");
      });
      if (cancelled) fn(); else unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [showToast]);

  useEffect(() => {
    if (!draggingPane) return;

    const onMouseMove = (event: MouseEvent) => {
      const root = appBodyRef.current;
      if (!root) return;
      const rect = root.getBoundingClientRect();
      const totalWidth = rect.width;
      const collapseBonus = leftPaneCollapsed
        ? Math.max(0, paneLayoutRef.current.left + SPLITTER_WIDTH - LEFT_PANE_TOGGLE_WIDTH)
        : 0;
      const desiredLeft  = draggingPane === "left"  ? event.clientX - rect.left  : paneLayoutRef.current.left;
      const desiredRight = draggingPane === "right"
        ? Math.max(0, (rect.right - event.clientX) - collapseBonus)
        : paneLayoutRef.current.right;
      const next = clampPaneLayout(totalWidth, desiredLeft, desiredRight);
      paneLayoutRef.current = next;
      setLeftPaneWidth(next.left);
      setRightPaneWidth(next.right);
    };

    const onMouseUp = () => {
      setDraggingPane(null);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const { left, right } = paneLayoutRef.current;
      api.setPanelLayout(Math.round(left), Math.round(right)).catch(() => {});
      const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
      if (totalWidth > 0) savePaneRatios(totalWidth, left, right);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [draggingPane, leftPaneCollapsed]);

  useEffect(() => {
    const stored = localStorage.getItem(REPO_STORAGE_KEY);
    if (!stored) return;
    api.validateRepoPath(stored).then(() => {
      setRepoPath(stored);
    }).catch(() => {
      localStorage.removeItem(REPO_STORAGE_KEY);
      setRecentRepos(prev => {
        const next = prev.filter(p => p !== stored);
        localStorage.setItem("gitmun.recentRepos", JSON.stringify(next));
        return next;
      });
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (repoPath) {
      localStorage.setItem(REPO_STORAGE_KEY, repoPath);
      const repoName = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
      api.setMainWindowTitle(`${repoName} - ${repoPath}`).catch(() => {});
    }
  }, [repoPath]);

  const handleAboutClick = useCallback(() => {
    api.openAboutWindow().catch(e => {
      showToast(String(e), "error");
    });
  }, [showToast]);

  const handleSettingsClick = useCallback(() => {
    api.openSettingsWindow().catch(e => {
      showToast(String(e), "error");
      appendResultLog("error", `Settings window failed to open: ${String(e)}`, "unknown");
    });
  }, [showToast]);

  const handleCloneClick = useCallback(() => {
    api.openCloneWindow().catch(e => {
      showToast(String(e), "error");
      appendResultLog("error", `Clone window failed to open: ${String(e)}`, "unknown");
    });
  }, [showToast]);

  const maybeInitializeRepo = useCallback(async (path: string, error: unknown): Promise<boolean> => {
    if (!isLikelyNotRepoError(error)) {
      return false;
    }

    const confirmed = await ask(
      `"${path.split("/").pop()}" is not a Git repository yet. Initialize a new repository here?`,
      { title: "Initialize Repository", kind: "info", okLabel: "Initialize", cancelLabel: "Cancel" },
    );
    if (!confirmed) {
      return true;
    }

    const result = await api.initRepo(path);
    await api.validateRepoPath(path);
    setRepoPath(path);
    pushRecentRepo(path);
    showToast("Repository initialized", "success");
    appendResultLog("success", result.message, result.backendUsed);
    return true;
  }, [pushRecentRepo, showToast]);

  const handleInitRepoClick = useCallback(async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "Initialize repository in folder" });
      if (typeof selected !== "string") {
        return;
      }
      const result = await api.initRepo(selected);
      await api.validateRepoPath(selected);
      setRepoPath(selected);
      pushRecentRepo(selected);
      showToast("Repository initialized", "success");
      appendResultLog("success", result.message, result.backendUsed);
    } catch (e) {
      showToast(String(e), "error");
    }
  }, [pushRecentRepo, showToast]);

  const handleOpenExistingClick = useCallback(async () => {
    let selected: string | null = null;
    try {
      const picked = await open({ directory: true, multiple: false, title: "Open existing repository" });
      if (typeof picked !== "string") {
        return;
      }
      selected = picked;
      await api.validateRepoPath(selected);
      setRepoPath(selected);
      pushRecentRepo(selected);
    } catch (e) {
      if (selected && await maybeInitializeRepo(selected, e)) return;
      showToast(String(e), "error");
    }
  }, [maybeInitializeRepo, pushRecentRepo, showToast]);

  const handleRepoSelect = useCallback(async (path: string) => {
    try {
      await api.validateRepoPath(path);
      setRepoPath(path);
      pushRecentRepo(path);
    } catch (e) {
      if (await maybeInitializeRepo(path, e)) return;
      showToast(String(e), "error");
    }
  }, [maybeInitializeRepo, pushRecentRepo, showToast]);

  const isNative = true;
  const winRadius = 0;

  return (
    <div className="app" style={{ padding: 0 }}>
      <Toast {...toast} />
      <ProjectView
        key={repoPath ?? "__no_repo__"}
        repoPath={repoPath}
        settingsRevision={settingsRevision}
        platform={platform}
        showToast={showToast}
        recentRepos={recentRepos}
        identityOpen={identityOpen}
        onIdentityToggle={() => setIdentityOpen(v => !v)}
        onRepoSelect={handleRepoSelect}
        onOpenExistingClick={handleOpenExistingClick}
        onCloneClick={handleCloneClick}
        onInitRepoClick={handleInitRepoClick}
        onAboutClick={handleAboutClick}
        onSettingsClick={handleSettingsClick}
        leftPaneWidth={leftPaneWidth}
        rightPaneWidth={rightPaneWidth}
        leftPaneCollapsed={leftPaneCollapsed}
        onSetLeftPaneCollapsed={setLeftPaneCollapsed}
        draggingPane={draggingPane}
        onSetDraggingPane={setDraggingPane}
        appBodyRef={appBodyRef}
        confirmRevert={confirmRevert}
        onSetConfirmRevert={setConfirmRevert}
        isNative={isNative}
        winRadius={winRadius}
      />
    </div>
  );
}
