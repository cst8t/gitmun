import React, {useState, useCallback, useEffect, useRef} from "react";
import {useTranslation} from "react-i18next";
import {invoke} from "@tauri-apps/api/core";
import {listen} from "@tauri-apps/api/event";
import {ask, open} from "@tauri-apps/plugin-dialog";
import {Toast} from "./Toast";
import {ProjectView} from "./ProjectView";
import {UpdateDialog} from "./update/UpdateDialog";
import {useToast} from "../hooks/useToast";
import {useUpdateFlow} from "../hooks/useUpdateFlow";
import {usePlatform} from "../hooks/usePlatform";
import * as api from "../api/commands";
import type {AppAvailableUpdate, RepoOpenBehaviour, RepoOpenLocationKind, Settings, ShellStartupAction} from "../types";
import {appendResultLog, setResultLogRepoPath} from "../utils/resultLog";
import {applyThemeMode} from "../utils/theme";
import {applyUiTextScale} from "../utils/uiTextScale";
import {
    DEFAULT_LEFT_PANE_WIDTH,
    DEFAULT_RIGHT_PANE_WIDTH,
    LEFT_PANE_RATIO_KEY,
    LEFT_PANE_TOGGLE_WIDTH,
    RIGHT_PANE_RATIO_KEY,
    SPLITTER_WIDTH,
    clampPaneLayout,
    paneRatiosFromLayout,
    parsePaneRatio,
    resizePaneLayout,
    resolvePaneLayout,
    type PaneLayout,
    type PaneRatios,
} from "../utils/paneLayout";
import "./App.css";

const BACKEND_MODE_KEY = "gitmun.backendMode";
const SHOW_RESULT_LOG_KEY = "gitmun.showResultLog";
const THEME_MODE_KEY = "gitmun.themeMode";
const LEFT_PANE_COLLAPSED_KEY = "gitmun.leftPaneCollapsed";

function savePaneRatios(totalWidth: number, left: number, right: number): void {
    if (!Number.isFinite(totalWidth) || totalWidth <= 0) return;
    const ratios = paneRatiosFromLayout(totalWidth, {left, right});
    if (ratios.left != null) {
        localStorage.setItem(LEFT_PANE_RATIO_KEY, ratios.left.toFixed(6));
    }
    if (ratios.right != null) {
        localStorage.setItem(RIGHT_PANE_RATIO_KEY, ratios.right.toFixed(6));
    }
}

function isLikelyNotRepoError(error: unknown): boolean {
    return /not a git repository/i.test(String(error));
}

function repoNameFromPath(path: string): string {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function App() {
    const {t} = useTranslation("app");
    const platform = usePlatform();
    const {toast, showToast} = useToast();
    const {
        dialog: updateDialog,
        checkForUpdatesOnLaunch,
        showUpdatePrompt,
        installUpdate,
        closeDialog: closeUpdateDialog,
        remindLater: remindAboutUpdateLater,
        setDontShowAgain: setSuppressUpdatePrompt,
    } = useUpdateFlow();

    const [repoPath, setRepoPath] = useState<string | null>(null);
    const [ready, setReady] = useState(false);
    const [recentRepos, setRecentRepos] = useState<string[]>(() => {
        try {
            return JSON.parse(localStorage.getItem("gitmun.recentRepos") ?? "[]");
        } catch {
            return [];
        }
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
    const paneLayoutRef = useRef<PaneLayout>({
        left: DEFAULT_LEFT_PANE_WIDTH,
        right: DEFAULT_RIGHT_PANE_WIDTH,
    });
    const paneRatioRef = useRef<PaneRatios>({
        left: parsePaneRatio(localStorage.getItem(LEFT_PANE_RATIO_KEY)),
        right: parsePaneRatio(localStorage.getItem(RIGHT_PANE_RATIO_KEY)),
    });

    const pushRecentRepo = useCallback((path: string) => {
        setRecentRepos(prev => {
            const next = [path, ...prev.filter(p => p !== path)].slice(0, 10);
            localStorage.setItem("gitmun.recentRepos", JSON.stringify(next));
            return next;
        });
    }, []);

    useEffect(() => {
        paneLayoutRef.current = {left: leftPaneWidth, right: rightPaneWidth};
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
            const next = resizePaneLayout(totalWidth, paneRatioRef.current, paneLayoutRef.current);
            paneRatioRef.current = next.ratios;
            if (next.layout.left !== paneLayoutRef.current.left) setLeftPaneWidth(next.layout.left);
            if (next.layout.right !== paneLayoutRef.current.right) setRightPaneWidth(next.layout.right);
            paneLayoutRef.current = next.layout;
        };

        applyLayout();
        const observer = new ResizeObserver(applyLayout);
        observer.observe(root);
        window.addEventListener("resize", applyLayout);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", applyLayout);
        };
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
                await applyThemeMode(settings.themeMode);
                applyUiTextScale(settings.uiTextScale);
                const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
                const storedRatios = {
                    left: parsePaneRatio(localStorage.getItem(LEFT_PANE_RATIO_KEY)),
                    right: parsePaneRatio(localStorage.getItem(RIGHT_PANE_RATIO_KEY)),
                };
                const next = resolvePaneLayout(totalWidth, storedRatios, {
                    left: settings.leftPaneWidth,
                    right: settings.rightPaneWidth,
                });
                setLeftPaneWidth(next.layout.left);
                setRightPaneWidth(next.layout.right);
                paneLayoutRef.current = next.layout;
                paneRatioRef.current = next.ratios;
                if (totalWidth > 0) savePaneRatios(totalWidth, next.layout.left, next.layout.right);
                setConfirmRevert(settings.confirmRevert ?? true);
                if (settings.showResultLog) {
                    api.openResultLogWindow().catch(e => {
                        appendResultLog("error", t("log.resultLogWindowFailed", {message: String(e)}), "unknown");
                    });
                }

                if (settings.autoCheckForUpdatesOnLaunch) {
                    void checkForUpdatesOnLaunch();
                }
            } catch {
                document.documentElement.dataset.theme = "dark";
                applyUiTextScale(1);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [checkForUpdatesOnLaunch, t]);

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
                    showToast(t("toast.opened", {name: repoNameFromPath(path)}));
                    appendResultLog("info", t("log.openedRepository", {path}), "unknown", path);
                }).catch((e: unknown) => showToast(String(e), "error"));
            });
            if (cancelled) fn(); else unlisten = fn;
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [pushRecentRepo, showToast, t]);

    const handleShellAction = useCallback((action: ShellStartupAction) => {
        if (action.action === "openRepo") {
            api.validateRepoPath(action.path).then(() => {
                setRepoPath(action.path);
                pushRecentRepo(action.path);
                showToast(t("toast.opened", {name: repoNameFromPath(action.path)}));
                appendResultLog("info", t("log.openedRepositoryFromShell", {path: action.path}), "unknown", action.path);
            }).catch(async (e: unknown) => {
                if (isLikelyNotRepoError(e)) {
                    const confirmed = await ask(
                        t("ask.initialiseRepository.message", {name: repoNameFromPath(action.path)}),
                        {title: t("ask.initialiseRepository.title"), kind: "info", okLabel: t("actions.initialise", {ns: "common"}), cancelLabel: t("actions.cancel", {ns: "common"})},
                    );
                    if (confirmed) {
                        const result = await api.initRepo(action.path);
                        await api.validateRepoPath(action.path);
                        setRepoPath(action.path);
                        pushRecentRepo(action.path);
                        showToast(t("toast.repositoryInitialised"), "success");
                        appendResultLog("success", result.message, result.backendUsed, action.path);
                    }
                } else {
                    showToast(String(e), "error");
                }
            });
        } else if (action.action === "cloneHere") {
            api.openCloneWindowWithDestination(action.path).catch(e => {
                showToast(String(e), "error");
                appendResultLog("error", t("log.cloneWindowFailed", {message: String(e)}), "unknown");
            });
        }
    }, [pushRecentRepo, showToast, t]);

    useEffect(() => {
        api.getStartupAction().then((action) => {
            if (action) handleShellAction(action);
        }).catch(() => {});
    }, [handleShellAction]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | null = null;
        (async () => {
            const fn = await listen<string>("instance-open-repo", (event) => {
                const path = event.payload;
                if (!path) return;
                handleShellAction({action: "openRepo", path});
            });
            if (cancelled) fn(); else unlisten = fn;
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [handleShellAction]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | null = null;
        (async () => {
            const fn = await listen<Settings>("settings-updated", async (event) => {
                const settings = event.payload;
                await applyThemeMode(settings.themeMode);
                applyUiTextScale(settings.uiTextScale);
                localStorage.setItem(BACKEND_MODE_KEY, settings.backendMode);
                localStorage.setItem(SHOW_RESULT_LOG_KEY, String(settings.showResultLog));
                localStorage.setItem(THEME_MODE_KEY, settings.themeMode);
                const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
                const storedRatios = {
                    left: parsePaneRatio(localStorage.getItem(LEFT_PANE_RATIO_KEY)),
                    right: parsePaneRatio(localStorage.getItem(RIGHT_PANE_RATIO_KEY)),
                };
                const next = resolvePaneLayout(totalWidth, storedRatios, {
                    left: settings.leftPaneWidth,
                    right: settings.rightPaneWidth,
                });
                setLeftPaneWidth(next.layout.left);
                setRightPaneWidth(next.layout.right);
                paneLayoutRef.current = next.layout;
                paneRatioRef.current = next.ratios;
                if (totalWidth > 0) savePaneRatios(totalWidth, next.layout.left, next.layout.right);
                setSettingsRevision(r => r + 1);
                showToast(t("toast.settingsUpdated"));
                appendResultLog("info", t("log.settingsUpdated"), "unknown");
            });
            if (cancelled) fn(); else unlisten = fn;
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [showToast, t]);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | null = null;
        (async () => {
            const fn = await listen("instance-settings-updated", async () => {
                const settings = await api.getSettings();
                await applyThemeMode(settings.themeMode);
                applyUiTextScale(settings.uiTextScale);
                localStorage.setItem(BACKEND_MODE_KEY, settings.backendMode);
                localStorage.setItem(SHOW_RESULT_LOG_KEY, String(settings.showResultLog));
                localStorage.setItem(THEME_MODE_KEY, settings.themeMode);
                const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
                const storedRatios = {
                    left: parsePaneRatio(localStorage.getItem(LEFT_PANE_RATIO_KEY)),
                    right: parsePaneRatio(localStorage.getItem(RIGHT_PANE_RATIO_KEY)),
                };
                const next = resolvePaneLayout(totalWidth, storedRatios, {
                    left: settings.leftPaneWidth,
                    right: settings.rightPaneWidth,
                });
                setLeftPaneWidth(next.layout.left);
                setRightPaneWidth(next.layout.right);
                paneLayoutRef.current = next.layout;
                paneRatioRef.current = next.ratios;
                if (totalWidth > 0) savePaneRatios(totalWidth, next.layout.left, next.layout.right);
                setSettingsRevision(r => r + 1);
            });
            if (cancelled) fn(); else unlisten = fn;
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        let unlisten: (() => void) | null = null;
        (async () => {
            const fn = await listen<AppAvailableUpdate>("update-available", (event) => {
                showUpdatePrompt(event.payload);
            });
            if (cancelled) {
                fn();
            } else {
                unlisten = fn;
            }
        })();
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [showUpdatePrompt]);

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
            const desiredLeft = draggingPane === "left" ? event.clientX - rect.left : paneLayoutRef.current.left;
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
            const {left, right} = paneLayoutRef.current;
            api.setPanelLayout(Math.round(left), Math.round(right)).catch(() => {
            });
            const totalWidth = appBodyRef.current?.getBoundingClientRect().width ?? 0;
            if (totalWidth > 0) {
                paneRatioRef.current = paneRatiosFromLayout(totalWidth, {left, right});
                savePaneRatios(totalWidth, left, right);
            }
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
        // Plain launches start empty; shell actions handle explicit opens.
        setReady(true);
    }, []);

    useEffect(() => {
        if (ready) {
            invoke("show_window", {label: "main"}).catch(() => {});
        }
    }, [ready]);

    useEffect(() => {
        setResultLogRepoPath(repoPath);
        if (repoPath) {
            const repoName = repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
            api.setMainWindowTitle(`${repoName} - ${repoPath}`).catch(() => {
            });
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
            appendResultLog("error", t("log.settingsWindowFailed", {message: String(e)}), "unknown");
        });
    }, [showToast, t]);

    const handleCloneClick = useCallback(() => {
        api.openCloneWindow().catch(e => {
            showToast(String(e), "error");
            appendResultLog("error", t("log.cloneWindowFailed", {message: String(e)}), "unknown");
        });
    }, [showToast, t]);

    const maybeInitialiseRepo = useCallback(async (path: string, error: unknown): Promise<boolean> => {
        if (!isLikelyNotRepoError(error)) {
            return false;
        }

        const confirmed = await ask(
            t("ask.initialiseRepository.message", {name: repoNameFromPath(path)}),
            {title: t("ask.initialiseRepository.title"), kind: "info", okLabel: t("actions.initialise", {ns: "common"}), cancelLabel: t("actions.cancel", {ns: "common"})},
        );
        if (!confirmed) {
            return true;
        }

        const result = await api.initRepo(path);
        await api.validateRepoPath(path);
        setRepoPath(path);
        pushRecentRepo(path);
        showToast(t("toast.repositoryInitialised"), "success");
        appendResultLog("success", result.message, result.backendUsed, path);
        return true;
    }, [pushRecentRepo, showToast, t]);

    const shouldOpenRepoInNewWindow = useCallback(async (path: string): Promise<boolean> => {
        let behaviour: RepoOpenBehaviour = "Ask";
        try {
            behaviour = (await api.getSettings()).repoOpenBehaviour ?? "Ask";
        } catch {
            behaviour = "Ask";
        }

        if (behaviour === "NewWindow") {
            return true;
        }
        if (behaviour === "ExistingWindow") {
            return false;
        }

        return ask(
            `Open "${path.split(/[\\/]/).filter(Boolean).pop() ?? path}" in a new Gitmun window?`,
            {title: "Open Repository", kind: "info", okLabel: "New Window", cancelLabel: "This Window"},
        );
    }, []);

    const openRepoPath = useCallback(async (path: string) => {
        try {
            await api.validateRepoPath(path);
            if (repoPath && await shouldOpenRepoInNewWindow(path)) {
                await api.openRepoInNewWindow(path);
                return;
            }
            setRepoPath(path);
            pushRecentRepo(path);
        } catch (e) {
            if (await maybeInitialiseRepo(path, e)) return;
            showToast(String(e), "error");
        }
    }, [maybeInitialiseRepo, pushRecentRepo, repoPath, shouldOpenRepoInNewWindow, showToast]);

    const handleInitRepoClick = useCallback(async () => {
        try {
            const selected = await open({directory: true, multiple: false, title: t("picker.initialiseRepository")});
            if (typeof selected !== "string") {
                return;
            }
            const result = await api.initRepo(selected);
            await api.validateRepoPath(selected);
            if (repoPath && await shouldOpenRepoInNewWindow(selected)) {
                await api.openRepoInNewWindow(selected);
            } else {
                setRepoPath(selected);
                pushRecentRepo(selected);
            }
            showToast(t("toast.repositoryInitialised"), "success");
            appendResultLog("success", result.message, result.backendUsed, selected);
        } catch (e) {
            showToast(String(e), "error");
        }
    }, [pushRecentRepo, repoPath, shouldOpenRepoInNewWindow, showToast, t]);

    const handleOpenExistingClick = useCallback(async () => {
        let selected: string | null = null;
        try {
            const picked = await open({directory: true, multiple: false, title: t("picker.openExistingRepository")});
            if (typeof picked !== "string") {
                return;
            }
            selected = picked;
            await openRepoPath(selected);
        } catch (e) {
            if (selected && await maybeInitialiseRepo(selected, e)) return;
            showToast(String(e), "error");
        }
    }, [maybeInitialiseRepo, openRepoPath, showToast, t]);

    const handleRepoSelect = useCallback(async (path: string) => {
        await openRepoPath(path);
    }, [openRepoPath]);

    const handleOpenRepoLocation = useCallback(async (kind: RepoOpenLocationKind) => {
        if (!repoPath) return;
        try {
            const result = await api.openRepoLocation(repoPath, kind);
            showToast(result.message, "success");
            appendResultLog("info", result.message, result.backendUsed, repoPath);
        } catch (e) {
            showToast(String(e), "error");
            appendResultLog("error", t("log.openRepoLocationFailed", {message: String(e)}), "unknown", repoPath);
        }
    }, [repoPath, showToast, t]);

    const isNative = true;
    const winRadius = 0;

    return (
        <div className="app" style={{padding: 0}}>
            <Toast {...toast} />
            <UpdateDialog
                dialog={updateDialog}
                onClose={closeUpdateDialog}
                onRemindLater={remindAboutUpdateLater}
                onUpdateNow={() => void installUpdate()}
                onDontShowAgainChange={setSuppressUpdatePrompt}
            />
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
                onOpenRepoLocation={handleOpenRepoLocation}
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
