import React, {useState, useEffect, useCallback} from "react";
import {invoke} from "@tauri-apps/api/core";
import {emit} from "@tauri-apps/api/event";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {open as openDialog} from "@tauri-apps/plugin-dialog";
import {platform} from "@tauri-apps/plugin-os";
import {open as openShell} from "@tauri-apps/plugin-shell";
import {useTranslation} from "react-i18next";
import type {
    AvatarProviderMode,
    BackendMode,
    CommitDateMode,
    ExternalDiffTool,
    LinuxGraphicsMode,
    RepoOpenBehaviour,
    Settings,
    ThemeMode
} from "../../types";
import {
    getConfigFilePath,
    getConfigFolderPath,
    getGlobalDiffToolPath,
    getGlobalGpgProgramPath,
    getSystemThemeHint,
    isUpdaterEnabled,
    openResultLogWindow,
    setGlobalDiffToolWithPath,
    setGlobalGpgProgram as saveGlobalGpgProgram,
    setUpdateEndpoint,
} from "../../api/commands";
import {CloseIcon, FileIcon, FolderIcon} from "../icons";
import "./SettingsWindow.css";

const BACKEND_MODE_KEY = "gitmun.backendMode";
const SHOW_RESULT_LOG_KEY = "gitmun.showResultLog";
const THEME_MODE_KEY = "gitmun.themeMode";
const DEFAULT_LEFT_PANE_WIDTH = 300;
const DEFAULT_RIGHT_PANE_WIDTH = 480;
const LEFT_PANE_RATIO_KEY = "gitmun.leftPaneRatio";
const RIGHT_PANE_RATIO_KEY = "gitmun.rightPaneRatio";
const DEFAULT_UPDATE_ENDPOINT = "https://github.com/cst8t/gitmun/releases/latest/download/latest.json";
const DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH = 72;

function normaliseOptionalGitConfig(value: string | null | undefined): string {
    return value?.trim() ?? "";
}

function supportedDiffTools(os: string): ExternalDiffTool[] {
    const tools: ExternalDiffTool[] = ["Other", "Meld", "VsCode", "VsCodium"];
    if (os === "linux") tools.push("Kompare");
    if (os === "windows") tools.push("WinMerge");
    return tools;
}

function requiresWindowsDiffToolPath(tool: ExternalDiffTool): boolean {
    return tool === "Meld" || tool === "WinMerge";
}

async function resolveTheme(mode: ThemeMode): Promise<"light" | "dark"> {
    if (mode === "Light") return "light";
    if (mode === "Dark") return "dark";
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
    try {
        const hint = await getSystemThemeHint();
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

export function SettingsWindow() {
    const {t} = useTranslation("settings");
    const useNativeWindowBar = true;
    const [backendMode, setBackendMode] = useState<BackendMode>("Default");
    const [themeMode, setThemeMode] = useState<ThemeMode>("System");
    const [wrapDiffLines, setWrapDiffLines] = useState(false);
    const [openResultLogOnLaunch, setOpenResultLogOnLaunch] = useState(false);
    const [avatarProvider, setAvatarProvider] = useState<AvatarProviderMode>("Libravatar");
    const [tryPlatformFirst, setTryPlatformFirst] = useState(true);
    const [externalDiffTool, setExternalDiffTool] = useState<ExternalDiffTool>("Other");
    const [globalDefaultBranch, setGlobalDefaultBranch] = useState<string>("");
    const [loadedGlobalDefaultBranch, setLoadedGlobalDefaultBranch] = useState("");
    const [globalFileMode, setGlobalFileMode] = useState(true);
    const [loadedGlobalFileMode, setLoadedGlobalFileMode] = useState(true);
    const [allowedDiffTools, setAllowedDiffTools] = useState<ExternalDiffTool[]>(["Other", "Meld"]);
    const [defaultCloneDir, setDefaultCloneDir] = useState<string>("");
    const [commitDateMode, setCommitDateMode] = useState<CommitDateMode>("AuthorDate");
    const [commitMessageRecommendedLength, setCommitMessageRecommendedLength] = useState(String(DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH));
    const [pushFollowTags, setPushFollowTags] = useState(false);
    const [autoCheckForUpdatesOnLaunch, setAutoCheckForUpdatesOnLaunch] = useState(true);
    const [autoInstallUpdates, setAutoInstallUpdates] = useState(false);
    const [updateEndpoint, setUpdateEndpointState] = useState(DEFAULT_UPDATE_ENDPOINT);
    const [linuxGraphicsMode, setLinuxGraphicsMode] = useState<LinuxGraphicsMode>("Auto");
    const [repoOpenBehaviour, setRepoOpenBehaviour] = useState<RepoOpenBehaviour>("Ask");
    const [isLinux, setIsLinux] = useState(false);
    const [isWindows, setIsWindows] = useState(false);
    const [updaterSupported, setUpdaterSupported] = useState(false);
    const [configFilePath, setConfigFilePath] = useState<string>("");
    const [configFolderPath, setConfigFolderPath] = useState<string>("");
    const [buildVersion, setBuildVersion] = useState<string>("");
    const [externalDiffToolPath, setExternalDiffToolPath] = useState("");
    const [loadedExternalDiffTool, setLoadedExternalDiffTool] = useState<ExternalDiffTool>("Other");
    const [externalDiffToolPathEdited, setExternalDiffToolPathEdited] = useState(false);
    const [gitExecutablePath, setGitExecutablePath] = useState("");
    const [gitExecutableConfiguredPath, setGitExecutableConfiguredPath] = useState("");
    const [gitExecutableEdited, setGitExecutableEdited] = useState(false);
    const [gitVersion, setGitVersion] = useState("");
    const [globalGpgProgram, setGlobalGpgProgram] = useState("");
    const [globalGpgProgramConfigured, setGlobalGpgProgramConfigured] = useState("");
    const [globalGpgProgramEdited, setGlobalGpgProgramEdited] = useState(false);
    const [status, setStatus] = useState(() => t("status.ready"));
    const [saving, setSaving] = useState(false);
    const suggestedTools = allowedDiffTools.filter((tool) => tool !== "Other");
    const labelDiffTool = useCallback((tool: ExternalDiffTool): string => {
        switch (tool) {
            case "Other":
                return t("options.diffToolNone");
            case "VsCode":
                return t("options.vsCode");
            case "VsCodium":
                return t("options.vsCodium");
            default:
                return tool;
        }
    }, [t]);

    const refreshGitExecutable = useCallback(async () => {
        const activeGitPath = await invoke<string>("get_active_git_executable_path");
        setGitExecutablePath(activeGitPath);
        const activeGitVersion = await invoke<string>("get_active_git_version");
        setGitVersion(activeGitVersion);
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const persistedMode = localStorage.getItem(BACKEND_MODE_KEY);
                if (persistedMode === "Default" || persistedMode === "GitCliOnly") {
                    await invoke("set_backend_mode", {mode: persistedMode});
                }

                const persistedLog = localStorage.getItem(SHOW_RESULT_LOG_KEY);
                if (persistedLog === "true" || persistedLog === "false") {
                    await invoke("set_show_result_log", {showResultLog: persistedLog === "true"});
                }

                const persistedTheme = localStorage.getItem(THEME_MODE_KEY);
                if (persistedTheme === "System" || persistedTheme === "Light" || persistedTheme === "Dark") {
                    await invoke("set_theme_mode", {themeMode: persistedTheme});
                }

                const os = safePlatform();
                const supported = supportedDiffTools(os);
                setAllowedDiffTools(supported);
                setUpdaterSupported(await isUpdaterEnabled());
                setIsLinux(os === "linux");
                setIsWindows(os === "windows");

                const globalDiffTool = await invoke<ExternalDiffTool>("get_global_diff_tool");
                setExternalDiffTool(supported.includes(globalDiffTool) ? globalDiffTool : "Other");
                setLoadedExternalDiffTool(supported.includes(globalDiffTool) ? globalDiffTool : "Other");
                const defaultBranch = await invoke<string | null>("get_global_default_branch");
                setGlobalDefaultBranch(defaultBranch ?? "");
                setLoadedGlobalDefaultBranch(defaultBranch ?? "");

                const fileMode = await invoke<boolean | null>("get_global_file_mode");
                setGlobalFileMode(fileMode ?? true);
                setLoadedGlobalFileMode(fileMode ?? true);

                const configuredGpgProgram = await invoke<string | null>("get_global_gpg_program");
                setGlobalGpgProgramConfigured(configuredGpgProgram ?? "");
                setGlobalGpgProgramEdited(false);
                const gpgProgram = await getGlobalGpgProgramPath();
                setGlobalGpgProgram(gpgProgram ?? "");

                const settings = await invoke<Settings>("get_settings");
                const activeGitPath = await invoke<string>("get_active_git_executable_path");
                setGitExecutableConfiguredPath(settings.gitExecutablePath ?? "");
                setGitExecutablePath(settings.gitExecutablePath || activeGitPath);
                setGitExecutableEdited(false);
                const activeGitVersion = await invoke<string>("get_active_git_version");
                setGitVersion(activeGitVersion);
                setBackendMode(settings.backendMode);
                setThemeMode(settings.themeMode);
                setWrapDiffLines(settings.wrapDiffLines ?? false);
                setOpenResultLogOnLaunch(settings.showResultLog);
                setAvatarProvider(settings.avatarProvider);
                setTryPlatformFirst(settings.tryPlatformFirst);
                setDefaultCloneDir(settings.defaultCloneDir);
                setCommitDateMode(settings.commitDateMode ?? "AuthorDate");
                setCommitMessageRecommendedLength(String(settings.commitMessageRecommendedLength ?? DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH));
                setPushFollowTags(settings.pushFollowTags ?? false);
                setAutoCheckForUpdatesOnLaunch(settings.autoCheckForUpdatesOnLaunch ?? true);
                setAutoInstallUpdates(settings.autoInstallUpdates ?? false);
                setUpdateEndpointState(settings.updateEndpoint ?? DEFAULT_UPDATE_ENDPOINT);
                setLinuxGraphicsMode(settings.linuxGraphicsMode ?? "Auto");
                setRepoOpenBehaviour(settings.repoOpenBehaviour ?? "Ask");
                document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);

                const cfgPath = await getConfigFilePath();
                setConfigFilePath(cfgPath ?? "");
                const cfgFolderPath = await getConfigFolderPath();
                setConfigFolderPath(cfgFolderPath ?? "");

                const version = await invoke<string>("get_build_version");
                setBuildVersion(version);
                setStatus(t("status.loaded"));
            } catch (e) {
                setStatus(t("status.loadFailed", {message: String(e)}));
            }
        })();
    }, [refreshGitExecutable, t]);

    useEffect(() => {
        if (!isWindows || !requiresWindowsDiffToolPath(externalDiffTool)) {
            setExternalDiffToolPath("");
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                const path = await getGlobalDiffToolPath(externalDiffTool);
                if (!cancelled) {
                    setExternalDiffToolPath(path ?? "");
                    setExternalDiffToolPathEdited(false);
                }
            } catch (e) {
                if (!cancelled) {
                    setExternalDiffToolPath("");
                    setStatus(t("status.diffToolPathFailed", {message: String(e)}));
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [externalDiffTool, isWindows, t]);

    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") getCurrentWindow().close();
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, []);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            const gitConfigMessages: string[] = [];

            await invoke("set_backend_mode", {mode: backendMode});
            await invoke("set_show_result_log", {showResultLog: openResultLogOnLaunch});
            await invoke<Settings>("set_theme_mode", {themeMode});
            await invoke<Settings>("set_wrap_diff_lines", {wrapDiffLines});
            await invoke("set_avatar_provider", {avatarProvider});
            await invoke("set_try_platform_first", {tryPlatformFirst: avatarProvider !== "Off" && tryPlatformFirst});
            await invoke("set_default_clone_dir", {defaultCloneDir});
            await invoke<Settings>("set_git_executable_path", {
                gitExecutablePath: gitExecutableEdited ? gitExecutablePath : gitExecutableConfiguredPath,
            });

            const diffToolSettingChanged = externalDiffTool !== loadedExternalDiffTool || externalDiffToolPathEdited;
            const currentDiffTool = diffToolSettingChanged
                ? await invoke<ExternalDiffTool>("get_global_diff_tool")
                : loadedExternalDiffTool;
            const diffToolPath = isWindows && requiresWindowsDiffToolPath(externalDiffTool)
                ? externalDiffToolPath.trim()
                : "";
            let shouldSaveDiffTool = diffToolSettingChanged && currentDiffTool !== externalDiffTool;
            if (diffToolSettingChanged && isWindows && requiresWindowsDiffToolPath(externalDiffTool)) {
                const currentDiffToolPath = await getGlobalDiffToolPath(externalDiffTool);
                shouldSaveDiffTool ||= normaliseOptionalGitConfig(currentDiffToolPath) !== diffToolPath;
            }
            if (shouldSaveDiffTool) {
                const diffToolResult = await setGlobalDiffToolWithPath(
                    externalDiffTool,
                    diffToolPath || null,
                );
                gitConfigMessages.push(diffToolResult.message);
            }

            const desiredDefaultBranch = globalDefaultBranch.trim();
            if (desiredDefaultBranch !== loadedGlobalDefaultBranch) {
                const currentDefaultBranch = await invoke<string | null>("get_global_default_branch");
                if (normaliseOptionalGitConfig(currentDefaultBranch) !== desiredDefaultBranch) {
                    const result = await invoke<{message: string}>("set_global_default_branch", {defaultBranch: globalDefaultBranch});
                    gitConfigMessages.push(result.message);
                }
            }

            if (globalFileMode !== loadedGlobalFileMode) {
                const currentFileMode = await invoke<boolean | null>("get_global_file_mode");
                if ((currentFileMode ?? true) !== globalFileMode) {
                    const result = await invoke<{message: string}>("set_global_file_mode", {fileMode: globalFileMode});
                    gitConfigMessages.push(result.message);
                }
            }

            const desiredGpgProgram = globalGpgProgram.trim();
            if (globalGpgProgramEdited && desiredGpgProgram !== globalGpgProgramConfigured) {
                const currentGpgProgram = await invoke<string | null>("get_global_gpg_program");
                if (normaliseOptionalGitConfig(currentGpgProgram) !== desiredGpgProgram) {
                    const gpgProgramResult = await saveGlobalGpgProgram(globalGpgProgram);
                    gitConfigMessages.push(gpgProgramResult.message);
                }
            }

            const parsedCommitMessageRecommendedLength = Number.parseInt(commitMessageRecommendedLength, 10);
            const savedCommitMessageRecommendedLength = Number.isFinite(parsedCommitMessageRecommendedLength)
                ? Math.max(0, parsedCommitMessageRecommendedLength)
                : DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH;
            await invoke("set_commit_date_mode", {commitDateMode});
            await invoke("set_commit_message_recommended_length", {commitMessageRecommendedLength: savedCommitMessageRecommendedLength});
            await invoke("set_push_follow_tags", {pushFollowTags});
            await invoke("set_auto_check_for_updates_on_launch", {autoCheckForUpdatesOnLaunch});
            await invoke("set_auto_install_updates", {autoInstallUpdates});
            await setUpdateEndpoint(updateEndpoint);
            if (isLinux) await invoke("set_linux_graphics_mode", {mode: linuxGraphicsMode});
            await invoke("set_repo_open_behaviour", {repoOpenBehaviour});
            const settings = await invoke<Settings>("get_settings");
            setCommitMessageRecommendedLength(String(settings.commitMessageRecommendedLength ?? DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH));

            localStorage.setItem(BACKEND_MODE_KEY, settings.backendMode);
            localStorage.setItem(SHOW_RESULT_LOG_KEY, String(openResultLogOnLaunch));
            localStorage.setItem(THEME_MODE_KEY, settings.themeMode);
            document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);

            if (isWindows && requiresWindowsDiffToolPath(externalDiffTool)) {
                setExternalDiffToolPath(await getGlobalDiffToolPath(externalDiffTool) ?? "");
            }
            const savedDiffTool = await invoke<ExternalDiffTool>("get_global_diff_tool");
            setLoadedExternalDiffTool(savedDiffTool);
            setExternalDiffToolPathEdited(false);
            const savedDefaultBranch = await invoke<string | null>("get_global_default_branch");
            setLoadedGlobalDefaultBranch(savedDefaultBranch ?? "");
            const savedFileMode = await invoke<boolean | null>("get_global_file_mode");
            setLoadedGlobalFileMode(savedFileMode ?? true);
            setGitExecutableConfiguredPath(settings.gitExecutablePath ?? "");
            setGitExecutableEdited(false);
            await refreshGitExecutable();
            const savedGpgProgram = await invoke<string | null>("get_global_gpg_program");
            setGlobalGpgProgramConfigured(savedGpgProgram ?? "");
            setGlobalGpgProgramEdited(false);
            setGlobalGpgProgram(await getGlobalGpgProgramPath() ?? "");

            await emit("settings-updated", settings);
            setStatus(t("status.saved", {
                message: gitConfigMessages.length > 0
                    ? gitConfigMessages.join("; ")
                    : t("status.noGitConfigChanges"),
            }));
        } catch (e) {
            setStatus(t("status.saveFailed", {message: String(e)}));
        } finally {
            setSaving(false);
        }
    }, [
        backendMode,
        themeMode,
        openResultLogOnLaunch,
        wrapDiffLines,
        avatarProvider,
        tryPlatformFirst,
        defaultCloneDir,
        gitExecutableConfiguredPath,
        gitExecutablePath,
        gitExecutableEdited,
        externalDiffTool,
        loadedExternalDiffTool,
        externalDiffToolPathEdited,
        globalDefaultBranch,
        loadedGlobalDefaultBranch,
        globalFileMode,
        loadedGlobalFileMode,
        commitDateMode,
        commitMessageRecommendedLength,
        pushFollowTags,
        autoCheckForUpdatesOnLaunch,
        autoInstallUpdates,
        updateEndpoint,
        isLinux,
        isWindows,
        linuxGraphicsMode,
        repoOpenBehaviour,
        externalDiffToolPath,
        globalGpgProgram,
        globalGpgProgramConfigured,
        globalGpgProgramEdited,
        refreshGitExecutable,
        saveGlobalGpgProgram,
        t,
    ]);

    const handleOpenResultLog = useCallback(async () => {
        try {
            await openResultLogWindow();
            setStatus(t("status.openedResultLog"));
        } catch (e) {
            setStatus(t("status.openResultLogFailed", {message: String(e)}));
        }
    }, [t]);

    const handleResetLayout = useCallback(async () => {
        try {
            localStorage.removeItem(LEFT_PANE_RATIO_KEY);
            localStorage.removeItem(RIGHT_PANE_RATIO_KEY);
            const settings = await invoke<Settings>("set_panel_layout", {
                leftPaneWidth: DEFAULT_LEFT_PANE_WIDTH,
                rightPaneWidth: DEFAULT_RIGHT_PANE_WIDTH,
            });
            await emit("settings-updated", settings);
            setStatus(t("status.resetLayout"));
        } catch (e) {
            setStatus(t("status.resetLayoutFailed", {message: String(e)}));
        }
    }, [t]);

    const handleBrowseCloneDir = useCallback(async () => {
        try {
            const selected = await openDialog({
                directory: true,
                multiple: false,
                title: t("picker.cloneDestination"),
                defaultPath: defaultCloneDir || undefined,
            });
            if (typeof selected === "string") setDefaultCloneDir(selected);
        } catch (e) {
            setStatus(t("picker.cloneDestinationFailed", {message: String(e)}));
        }
    }, [defaultCloneDir, t]);

    const handleBrowseDiffToolPath = useCallback(async () => {
        try {
            const selected = await openDialog({
                directory: false,
                multiple: false,
                title: t("picker.diffToolExecutable", {tool: labelDiffTool(externalDiffTool)}),
                defaultPath: externalDiffToolPath || undefined,
                filters: [{name: t("picker.windowsExecutables"), extensions: ["exe"]}],
            });
            if (typeof selected === "string") {
                setExternalDiffToolPath(selected);
                setExternalDiffToolPathEdited(true);
            }
        } catch (e) {
            setStatus(t("picker.cloneDestinationFailed", {message: String(e)}));
        }
    }, [externalDiffTool, externalDiffToolPath, labelDiffTool, t]);

    const handleBrowseGitExecutable = useCallback(async () => {
        try {
            const selected = await openDialog({
                directory: false,
                multiple: false,
                title: t("picker.gitExecutable"),
                defaultPath: gitExecutablePath || undefined,
                ...(isWindows ? {filters: [{name: t("picker.windowsExecutables"), extensions: ["exe"]}]} : {}),
            });
            if (typeof selected === "string") {
                setGitExecutablePath(selected);
                setGitExecutableEdited(true);
            }
        } catch (e) {
            setStatus(t("picker.gitExecutableFailed", {message: String(e)}));
        }
    }, [gitExecutablePath, isWindows, t]);

    const handleResetGitExecutable = useCallback(async () => {
        try {
            const settings = await invoke<Settings>("set_git_executable_path", {gitExecutablePath: ""});
            setGitExecutableConfiguredPath("");
            setGitExecutableEdited(false);
            await refreshGitExecutable();
            await emit("settings-updated", settings);
            setStatus(t("status.gitExecutableReset"));
        } catch (e) {
            setStatus(t("status.gitExecutableResetFailed", {message: String(e)}));
        }
    }, [refreshGitExecutable, t]);

    const handleBrowseGpgProgram = useCallback(async () => {
        try {
            const options = {
                directory: false,
                multiple: false,
                title: t("picker.gpgExecutable"),
                defaultPath: globalGpgProgram || undefined,
                ...(isWindows ? {filters: [{name: t("picker.windowsExecutables"), extensions: ["exe"]}]} : {}),
            };
            const selected = await openDialog(options);
            if (typeof selected === "string") {
                setGlobalGpgProgram(selected);
                setGlobalGpgProgramEdited(true);
            }
        } catch (e) {
            setStatus(t("picker.gpgExecutableFailed", {message: String(e)}));
        }
    }, [globalGpgProgram, isWindows, t]);

    const handleOpenConfigFolder = useCallback(async () => {
        if (!configFolderPath) return;
        try {
            await openShell(configFolderPath);
            setStatus(t("status.openedConfigFolder"));
        } catch (e) {
            setStatus(t("status.openConfigFolderFailed", {message: String(e)}));
        }
    }, [configFolderPath, t]);

    const handleClose = useCallback(() => {
        getCurrentWindow().close();
    }, []);

    return (
        <div className="settings-window">
            {!useNativeWindowBar && (
                <div className="settings-window__header">
                    <span className="settings-window__title">{t("labels.settings")}</span>
                    <button className="settings-window__close" onClick={handleClose}>
                        <CloseIcon/>
                    </button>
                </div>
            )}

            <div className="settings-window__body">

                {/* Left column: Application */}
                <div className="settings-window__column">
                    <div className="settings-window__section-title">{t("labels.application")}</div>
                    {configFilePath && (
                        <div className="settings-window__section-note settings-window__path-note">
                            <span>{t("labels.configFile")}<code>{configFilePath}</code></span>
                            <button
                                className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                title={t("actions.openConfigFolder")}
                                aria-label={t("actions.openConfigFolder")}
                                onClick={handleOpenConfigFolder}
                                disabled={!configFolderPath}>
                                <FolderIcon/>
                            </button>
                        </div>
                    )}
                    {buildVersion && (
                        <div className="settings-window__section-note">
                            {t("labels.buildVersion")}<code>{buildVersion}</code>
                        </div>
                    )}

                    <div className="settings-window__row">
                        <label className="settings-window__label">Open repositories</label>
                        <select
                            className="settings-window__select"
                            value={repoOpenBehaviour}
                            onChange={e => setRepoOpenBehaviour(e.target.value as RepoOpenBehaviour)}
                        >
                            <option value="Ask">Ask each time (default)</option>
                            <option value="ExistingWindow">Reuse this window</option>
                            <option value="NewWindow">Always open a new window</option>
                        </select>
                        <div className="settings-window__section-note">
                            Controls in-app repository opens, including recent repositories. Shell and file manager
                            launches always open a new window.
                        </div>
                    </div>

                    {updaterSupported ? (
                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.updates")}</label>
                            <div className="settings-window__sub-section">
                                <label className="settings-window__switch-row">
                  <span className="settings-window__switch">
                    <input
                        type="checkbox"
                        checked={autoCheckForUpdatesOnLaunch}
                        onChange={e => setAutoCheckForUpdatesOnLaunch(e.target.checked)}
                    />
                    <span className="settings-window__switch-track"/>
                  </span>
                                    <span className="settings-window__switch-label">{t("switches.autoCheckUpdates")}</span>
                                </label>
                                <div className="settings-window__section-note">
                                    {t("notes.autoUpdates")}
                                </div>

                                <div className="settings-window__row">
                                    <label className="settings-window__label">{t("labels.updateFeedUrl")}</label>
                                    <div className="settings-window__sub-section">
                                        <input
                                            className="settings-window__input"
                                            type="url"
                                            value={updateEndpoint}
                                            onChange={e => setUpdateEndpointState(e.target.value)}
                                            spellCheck={false}
                                            autoCapitalize="off"
                                            autoCorrect="off"
                                        />
                                        <div className="settings-window__section-note">
                                            {t("notes.updateEndpoint")}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.updates")}</label>
                            <div className="settings-window__section-note">
                                {t("notes.updatesManaged")}
                            </div>
                        </div>
                    )}

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.gitBackendMode")}</label>
                        <select
                            className="settings-window__select"
                            value={backendMode}
                            onChange={e => setBackendMode(e.target.value as BackendMode)}
                        >
                            <option value="Default">{t("options.backendDefault")}</option>
                            <option value="GitCliOnly">{t("options.backendGitCli")}</option>
                        </select>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.gitExecutable")}</label>
                        <div className="settings-window__inline-controls" style={{gap: "6px", flexWrap: "nowrap"}}>
                            <input
                                className="settings-window__input"
                                type="text"
                                value={gitExecutablePath}
                                onChange={e => {
                                    setGitExecutablePath(e.target.value);
                                    setGitExecutableEdited(true);
                                }}
                                placeholder={t("placeholders.gitExecutable")}
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                            <button
                                className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                title={t("actions.browse")}
                                aria-label={t("actions.browse")}
                                onClick={handleBrowseGitExecutable}>
                                <FileIcon/>
                            </button>
                            <button
                                className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                title={t("actions.resetGitExecutable")}
                                aria-label={t("actions.resetGitExecutable")}
                                onClick={handleResetGitExecutable}>
                                <CloseIcon/>
                            </button>
                        </div>
                        <div className="settings-window__section-note">
                            {t("notes.gitExecutable")}
                            {gitVersion && <><br/>{t("labels.gitVersion")}<code>{gitVersion}</code></>}
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.theme")}</label>
                        <select
                            className="settings-window__select"
                            value={themeMode}
                            onChange={e => setThemeMode(e.target.value as ThemeMode)}
                        >
                            <option value="System">{t("options.themeSystem")}</option>
                            <option value="Light">{t("options.themeLight")}</option>
                            <option value="Dark">{t("options.themeDark")}</option>
                        </select>
                    </div>

                    {isLinux && (
                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.graphicsMode")}</label>
                            <select
                                className="settings-window__select"
                                value={linuxGraphicsMode}
                                onChange={e => setLinuxGraphicsMode(e.target.value as LinuxGraphicsMode)}
                            >
                                <option value="Auto">{t("options.graphicsAuto")}</option>
                                <option value="Safe">{t("options.graphicsSafe")}</option>
                                <option value="Native">{t("options.graphicsNative")}</option>
                            </select>
                            <div className="settings-window__section-note">
                                {t("notes.linuxGraphics")}
                            </div>
                        </div>
                    )}

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.diffPanel")}</label>
                        <label className="settings-window__switch-row">
              <span className="settings-window__switch">
                <input
                    type="checkbox"
                    checked={wrapDiffLines}
                    onChange={e => setWrapDiffLines(e.target.checked)}
                />
                <span className="settings-window__switch-track"/>
              </span>
                            <span className="settings-window__switch-label">{t("switches.wrapDiffLines")}</span>
                        </label>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.resultLog")}</label>
                        <div className="settings-window__sub-section">
                            <button className="settings-window__btn settings-window__btn--secondary"
                                    onClick={handleOpenResultLog}>
                                {t("actions.openResultLog")}
                            </button>
                            <label className="settings-window__switch-row">
                <span className="settings-window__switch">
                  <input
                      type="checkbox"
                      checked={openResultLogOnLaunch}
                      onChange={e => setOpenResultLogOnLaunch(e.target.checked)}
                  />
                  <span className="settings-window__switch-track"/>
                </span>
                                <span className="settings-window__switch-label">{t("labels.openAtLaunch")}</span>
                            </label>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.layout")}</label>
                        <div className="settings-window__inline-controls">
                            <button className="settings-window__btn settings-window__btn--secondary"
                                    onClick={handleResetLayout}>
                                {t("actions.resetLayout")}
                            </button>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.cloneDestination")}</label>
                        <div className="settings-window__inline-controls" style={{gap: "6px", flexWrap: "nowrap"}}>
                            <input
                                className="settings-window__input"
                                type="text"
                                value={defaultCloneDir}
                                onChange={e => setDefaultCloneDir(e.target.value)}
                                placeholder={t("placeholders.defaultCloneDestination")}
                            />
                            <button
                                className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                onClick={handleBrowseCloneDir}>
                                <FolderIcon/>
                            </button>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.avatars")}</label>
                        <div className="settings-window__sub-section">
                            <select
                                className="settings-window__select"
                                value={avatarProvider}
                                onChange={e => setAvatarProvider(e.target.value as AvatarProviderMode)}
                            >
                                <option value="Libravatar">{t("options.avatarLibravatar")}</option>
                                <option value="Off">{t("options.avatarDisabled")}</option>
                            </select>
                            <label
                                className="settings-window__switch-row"
                                style={{
                                    opacity: avatarProvider === "Off" ? 0.4 : 1,
                                    cursor: avatarProvider === "Off" ? "default" : "pointer",
                                    pointerEvents: avatarProvider === "Off" ? "none" : "auto",
                                }}
                            >
                <span className="settings-window__switch">
                  <input
                      type="checkbox"
                      checked={tryPlatformFirst}
                      disabled={avatarProvider === "Off"}
                      onChange={e => setTryPlatformFirst(e.target.checked)}
                  />
                  <span className="settings-window__switch-track"/>
                </span>
                                <span className="settings-window__switch-label">
                  {t("switches.platformAvatars")}
                </span>
                            </label>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.commitLogDate")}</label>
                        <select
                            className="settings-window__select"
                            value={commitDateMode}
                            onChange={e => setCommitDateMode(e.target.value as CommitDateMode)}
                        >
                            <option value="AuthorDate">{t("options.commitDateAuthor")}</option>
                            <option value="CommitterDate">{t("options.commitDateCommitter")}</option>
                        </select>
                    </div>

                </div>

                {/* Right column: Git */}
                <div className="settings-window__column">
                    <div className="settings-window__section-title">{t("labels.git")}</div>
                    <div className="settings-window__section-note">
                        {t("notes.gitOptions")}
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.pushBehaviour")}</label>
                        <label className="settings-window__switch-row">
              <span className="settings-window__switch">
                <input
                    type="checkbox"
                    checked={pushFollowTags}
                    onChange={e => setPushFollowTags(e.target.checked)}
                />
                <span className="settings-window__switch-track"/>
              </span>
                            <span className="settings-window__switch-label">{t("switches.followTags")}</span>
                        </label>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.commitMessageRecommendedLength")}</label>
                        <input
                            className="settings-window__input"
                            type="number"
                            min={0}
                            step={1}
                            value={commitMessageRecommendedLength}
                            onChange={e => {
                                if (/^\d*$/.test(e.target.value)) {
                                    setCommitMessageRecommendedLength(e.target.value);
                                }
                            }}
                            onBlur={() => {
                                const next = Number.parseInt(commitMessageRecommendedLength, 10);
                                setCommitMessageRecommendedLength(String(Number.isFinite(next) ? Math.max(0, next) : DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH));
                            }}
                        />
                        <div className="settings-window__section-note">
                            {t("notes.commitMessageRecommendedLength")}
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">{t("labels.globalGitConfiguration")}</label>
                        <div className="settings-window__sub-section">
                            <div className="settings-window__section-note">
                                {t("notes.gitConfiguration")}
                            </div>

                            <div className="settings-window__row">
                                <label className="settings-window__label">{t("labels.diffTool")}</label>
                                <select
                                    className="settings-window__select"
                                    value={externalDiffTool}
                                    onChange={e => setExternalDiffTool(e.target.value as ExternalDiffTool)}
                                >
                                    {allowedDiffTools.map(tool => (
                                        <option key={tool} value={tool}>{labelDiffTool(tool)}</option>
                                    ))}
                                </select>
                                {externalDiffTool === "Other" && (
                                    <div className="settings-window__warning">
                                        {t("notes.diffToolNotConfigured")}
                                        {suggestedTools.length > 0 && t("notes.diffToolSuggestion", {tools: suggestedTools.map(labelDiffTool).join(", ")})}
                                    </div>
                                )}
                                {(externalDiffTool === "VsCode" || externalDiffTool === "VsCodium") && (
                                    <div className="settings-window__note">
                                        {t("notes.vscodeMergeEditor", {tool: labelDiffTool(externalDiffTool)})}
                                    </div>
                                )}
                                {isWindows && requiresWindowsDiffToolPath(externalDiffTool) && (
                                    <div className="settings-window__row">
                                        <label className="settings-window__label">{t("labels.diffToolExecutable")}</label>
                                        <div className="settings-window__inline-controls"
                                             style={{gap: "6px", flexWrap: "nowrap"}}>
                                            <input
                                                className="settings-window__input"
                                                type="text"
                                                value={externalDiffToolPath}
                                                onChange={e => {
                                                    setExternalDiffToolPath(e.target.value);
                                                    setExternalDiffToolPathEdited(true);
                                                }}
                                                placeholder={t("placeholders.diffToolPath", {tool: labelDiffTool(externalDiffTool)})}
                                                spellCheck={false}
                                                autoCapitalize="off"
                                                autoCorrect="off"
                                            />
                                            <button
                                                className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                                onClick={handleBrowseDiffToolPath}>
                                                <FolderIcon/>
                                            </button>
                                        </div>
                                        <div className="settings-window__section-note">
                                            {t("notes.toolPathSearch")}
                                        </div>
                                        {!externalDiffToolPath && (
                                            <div className="settings-window__warning">
                                                {t("notes.toolPathMissing", {tool: labelDiffTool(externalDiffTool)})}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="settings-window__row">
                                <label className="settings-window__label">{t("labels.defaultBranch")}</label>
                                <input
                                    className="settings-window__input"
                                    type="text"
                                    value={globalDefaultBranch}
                                    onChange={e => setGlobalDefaultBranch(e.target.value)}
                                    placeholder={t("placeholders.defaultBranch")}
                                />
                            </div>

                            <div className="settings-window__row">
                                <label className="settings-window__label">{t("labels.gpgProgram")}</label>
                                <div className="settings-window__inline-controls"
                                     style={{gap: "6px", flexWrap: "nowrap"}}>
                                    <input
                                        className="settings-window__input"
                                        type="text"
                                        value={globalGpgProgram}
                                        onChange={e => {
                                            setGlobalGpgProgram(e.target.value);
                                            setGlobalGpgProgramEdited(true);
                                        }}
                                        placeholder={t("placeholders.gpgProgram")}
                                        spellCheck={false}
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                    />
                                    <button
                                        className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                        onClick={handleBrowseGpgProgram}>
                                        <FileIcon/>
                                    </button>
                                </div>
                                <div className="settings-window__section-note">
                                    {t("notes.gpgProgram")}
                                </div>
                            </div>

                            <div className="settings-window__row">
                                <label className="settings-window__label">{t("labels.fileMode")}</label>
                                <label className="settings-window__switch-row">
                                    <span className="settings-window__switch">
                                        <input
                                            type="checkbox"
                                            checked={globalFileMode}
                                            onChange={e => setGlobalFileMode(e.target.checked)}
                                        />
                                        <span className="settings-window__switch-track"/>
                                    </span>
                                    <span className="settings-window__switch-label">{t("switches.trackFilePermissions")}</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

            </div>

            <div className="settings-window__footer">
                <div className="settings-window__actions">
                    <button className="settings-window__btn settings-window__btn--primary" onClick={handleSave}
                            disabled={saving}>
                        {saving ? t("actions.saving") : t("actions.save")}
                    </button>
                    <button className="settings-window__btn settings-window__btn--secondary" onClick={handleClose}>
                        {t("actions.close")}
                    </button>
                </div>
                <span className="settings-window__status">{status}</span>
            </div>
        </div>
    );
}
