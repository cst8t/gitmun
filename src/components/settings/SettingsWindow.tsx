import React, {useState, useEffect, useCallback} from "react";
import {invoke} from "@tauri-apps/api/core";
import {emit} from "@tauri-apps/api/event";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {open as openDialog} from "@tauri-apps/plugin-dialog";
import {openPath} from "@tauri-apps/plugin-opener";
import {platform} from "@tauri-apps/plugin-os";
import {useTranslation} from "react-i18next";
import type {
    AvatarProviderMode,
    AppUpdateChannel,
    BackendMode,
    CommitDateMode,
    ExternalDiffTool,
    LinuxGraphicsMode,
    LinuxTerminalEmulator,
    LinuxTerminalOption,
    RepoOpenBehaviour,
    RowStriping,
    Settings,
    ThemeMode,
    UiTextScale
} from "../../types";
import {
    getAppUpdateChannel,
    getConfigFilePath,
    getConfigFolderPath,
    getGlobalDiffToolPath,
    getGlobalGpgProgramPath,
    getLinuxTerminalOptions,
    openResultLogWindow,
    setGlobalDiffToolWithPath,
    setGlobalGpgProgram as saveGlobalGpgProgram,
    setUpdateEndpoint,
} from "../../api/commands";
import {CloseIcon, FileIcon, FolderIcon} from "../icons";
import {SettingsSkeleton} from "./SettingsSkeleton";
import {applyThemeMode} from "../../utils/theme";
import {UI_TEXT_SCALE_VALUES, applyUiTextScale, normaliseUiTextScale} from "../../utils/uiTextScale";
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
const DEFAULT_ERROR_TOAST_CLEAR_DELAY_MS = 8000;
const MIN_ERROR_TOAST_CLEAR_DELAY_MS = 1000;
const DEFAULT_LINUX_TERMINAL_OPTIONS: LinuxTerminalOption[] = [
    {emulator: "Auto", label: "Terminal"},
    {emulator: "Custom", label: "Terminal"},
];

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

function safePlatform(): string {
    try {
        return platform();
    } catch {
        return "linux";
    }
}

type SettingsTab = "application" | "git";
type GitBooleanConfig = "" | "true" | "false";
type PullRebaseMode = "" | "false" | "true" | "merges" | "interactive";
type PullFastForwardMode = "" | "true" | "false" | "only";
type PushDefaultMode = "" | "nothing" | "current" | "upstream" | "simple" | "matching";
type LineEndingMode = "" | "false" | "true" | "input";
type SettingsLoadState =
    | {status: "loading"}
    | {status: "loaded"}
    | {status: "error"; message: string};

function GitConfigLabel({children, configKey}: {children: React.ReactNode; configKey: string}) {
    return (
        <span className="settings-window__label-content">
            <span>{children}</span>
            <code className="settings-window__git-config-key">{configKey}</code>
        </span>
    );
}

function SettingsLoadError({message, onRetry}: {message: string; onRetry: () => void}) {
    const {t} = useTranslation("settings");

    return (
        <div className="settings-window__load-error" role="alert">
            <h2 className="settings-window__load-error-title">{t("labels.loadErrorTitle")}</h2>
            <p className="settings-window__load-error-message">{message}</p>
            <div className="settings-window__load-error-actions">
                <button className="settings-window__btn settings-window__btn--secondary" type="button" onClick={onRetry}>
                    {t("actions.retry")}
                </button>
            </div>
        </div>
    );
}

async function saveGlobalConfigIfChanged(
    value: string,
    loadedValue: string,
    getCommand: string,
    setCommand: string,
    argName: string,
): Promise<string | null> {
    const desiredValue = value.trim();
    if (desiredValue === loadedValue) return null;

    const currentValue = await invoke<string | null>(getCommand);
    if (normaliseOptionalGitConfig(currentValue) === desiredValue) return null;

    const result = await invoke<{message: string}>(setCommand, {[argName]: desiredValue});
    return result.message;
}

function normaliseChoice<T extends string>(value: string | null, allowed: readonly T[]): T {
    return allowed.includes(value as T) ? value as T : allowed[0];
}

export function SettingsWindow() {
    const {t} = useTranslation("settings");
    const [loadState, setLoadState] = useState<SettingsLoadState>({status: "loading"});
    const [tab, setTab] = useState<SettingsTab>("application");
    const useNativeWindowBar = true;
    const os = safePlatform();
    const cloneDestinationPlaceholder = os === "windows"
        ? t("placeholders.defaultCloneDestinationWindows")
        : os === "macos"
            ? t("placeholders.defaultCloneDestinationMac")
            : t("placeholders.defaultCloneDestinationLinux");
    const [backendMode, setBackendMode] = useState<BackendMode>("Default");
    const [themeMode, setThemeMode] = useState<ThemeMode>("System");
    const [uiTextScale, setUiTextScale] = useState<UiTextScale>(1);
    const [wrapDiffLines, setWrapDiffLines] = useState(false);
    const [rowStriping, setRowStriping] = useState<RowStriping>("Off");
    const [persistentErrorToasts, setPersistentErrorToasts] = useState(false);
    const [errorToastClearDelayMs, setErrorToastClearDelayMs] = useState(String(DEFAULT_ERROR_TOAST_CLEAR_DELAY_MS));
    const [openResultLogOnLaunch, setOpenResultLogOnLaunch] = useState(false);
    const [avatarProvider, setAvatarProvider] = useState<AvatarProviderMode>("Libravatar");
    const [tryPlatformFirst, setTryPlatformFirst] = useState(true);
    const [externalDiffTool, setExternalDiffTool] = useState<ExternalDiffTool>("Other");
    const [globalDefaultBranch, setGlobalDefaultBranch] = useState<string>("");
    const [loadedGlobalDefaultBranch, setLoadedGlobalDefaultBranch] = useState("");
    const [globalFileMode, setGlobalFileMode] = useState(true);
    const [loadedGlobalFileMode, setLoadedGlobalFileMode] = useState(true);
    const [globalPullRebase, setGlobalPullRebase] = useState<PullRebaseMode>("");
    const [loadedGlobalPullRebase, setLoadedGlobalPullRebase] = useState("");
    const [globalPullFastForward, setGlobalPullFastForward] = useState<PullFastForwardMode>("");
    const [loadedGlobalPullFastForward, setLoadedGlobalPullFastForward] = useState("");
    const [globalPullAutostash, setGlobalPullAutostash] = useState<GitBooleanConfig>("");
    const [loadedGlobalPullAutostash, setLoadedGlobalPullAutostash] = useState("");
    const [globalFetchPrune, setGlobalFetchPrune] = useState<GitBooleanConfig>("");
    const [loadedGlobalFetchPrune, setLoadedGlobalFetchPrune] = useState("");
    const [globalPushDefault, setGlobalPushDefault] = useState<PushDefaultMode>("");
    const [loadedGlobalPushDefault, setLoadedGlobalPushDefault] = useState("");
    const [globalPushAutoSetupRemote, setGlobalPushAutoSetupRemote] = useState<GitBooleanConfig>("");
    const [loadedGlobalPushAutoSetupRemote, setLoadedGlobalPushAutoSetupRemote] = useState("");
    const [globalCoreEditor, setGlobalCoreEditor] = useState("");
    const [loadedGlobalCoreEditor, setLoadedGlobalCoreEditor] = useState("");
    const [globalLineEndings, setGlobalLineEndings] = useState<LineEndingMode>("");
    const [loadedGlobalLineEndings, setLoadedGlobalLineEndings] = useState("");
    const [globalCredentialHelper, setGlobalCredentialHelper] = useState("");
    const [loadedGlobalCredentialHelper, setLoadedGlobalCredentialHelper] = useState("");
    const [allowedDiffTools, setAllowedDiffTools] = useState<ExternalDiffTool[]>(["Other", "Meld"]);
    const [defaultCloneDir, setDefaultCloneDir] = useState<string>("");
    const [commitDateMode, setCommitDateMode] = useState<CommitDateMode>("AuthorDate");
    const [commitMessageRecommendedLength, setCommitMessageRecommendedLength] = useState(String(DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH));
    const [pushFollowTags, setPushFollowTags] = useState(false);
    const [autoCheckForUpdatesOnLaunch, setAutoCheckForUpdatesOnLaunch] = useState(true);
    const [autoInstallUpdates, setAutoInstallUpdates] = useState(false);
    const [updateEndpoint, setUpdateEndpointState] = useState(DEFAULT_UPDATE_ENDPOINT);
    const [linuxGraphicsMode, setLinuxGraphicsMode] = useState<LinuxGraphicsMode>("Auto");
    const [linuxTerminalOptions, setLinuxTerminalOptions] = useState<LinuxTerminalOption[]>(DEFAULT_LINUX_TERMINAL_OPTIONS);
    const [linuxTerminalEmulator, setLinuxTerminalEmulator] = useState<LinuxTerminalEmulator>("Auto");
    const [linuxTerminalCustomCommand, setLinuxTerminalCustomCommand] = useState("");
    const [repoOpenBehaviour, setRepoOpenBehaviour] = useState<RepoOpenBehaviour>("Ask");
    const [isLinux, setIsLinux] = useState(false);
    const [isWindows, setIsWindows] = useState(false);
    const [updateChannel, setUpdateChannel] = useState<AppUpdateChannel>("SystemManaged");
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
    const [gpgKeyserverVerificationEnabled, setGpgKeyserverVerificationEnabledState] = useState(false);
    const [loadedGpgKeyserverVerificationEnabled, setLoadedGpgKeyserverVerificationEnabled] = useState(false);
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
    const labelLinuxTerminal = useCallback((option: LinuxTerminalOption): string => {
        switch (option.emulator) {
            case "Auto":
                return t("options.linuxTerminalAuto");
            case "Custom":
                return t("options.linuxTerminalCustom");
            default:
                return option.label;
        }
    }, [t]);

    const refreshGitExecutable = useCallback(async () => {
        const activeGitPath = await invoke<string>("get_active_git_executable_path");
        setGitExecutablePath(activeGitPath);
        const activeGitVersion = await invoke<string>("get_active_git_version");
        setGitVersion(activeGitVersion);
    }, []);

    const loadSettings = useCallback(async () => {
        setLoadState({status: "loading"});
        setStatus(t("status.ready"));

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
            setUpdateChannel(await getAppUpdateChannel());
            setIsLinux(os === "linux");
            setIsWindows(os === "windows");
            if (os === "linux") {
                setLinuxTerminalOptions(await getLinuxTerminalOptions());
            }

            const globalDiffTool = await invoke<ExternalDiffTool>("get_global_diff_tool");
            setExternalDiffTool(supported.includes(globalDiffTool) ? globalDiffTool : "Other");
            setLoadedExternalDiffTool(supported.includes(globalDiffTool) ? globalDiffTool : "Other");
            const defaultBranch = await invoke<string | null>("get_global_default_branch");
            setGlobalDefaultBranch(defaultBranch ?? "");
            setLoadedGlobalDefaultBranch(defaultBranch ?? "");

            const fileMode = await invoke<boolean | null>("get_global_file_mode");
            setGlobalFileMode(fileMode ?? true);
            setLoadedGlobalFileMode(fileMode ?? true);

            const pullRebase = normaliseChoice<PullRebaseMode>(
                await invoke<string | null>("get_global_pull_rebase"),
                ["", "false", "true", "merges", "interactive"],
            );
            setGlobalPullRebase(pullRebase);
            setLoadedGlobalPullRebase(pullRebase);
            const pullFastForward = normaliseChoice<PullFastForwardMode>(
                await invoke<string | null>("get_global_pull_ff"),
                ["", "true", "false", "only"],
            );
            setGlobalPullFastForward(pullFastForward);
            setLoadedGlobalPullFastForward(pullFastForward);
            const pullAutostash = normaliseChoice<GitBooleanConfig>(
                await invoke<string | null>("get_global_pull_autostash"),
                ["", "true", "false"],
            );
            setGlobalPullAutostash(pullAutostash);
            setLoadedGlobalPullAutostash(pullAutostash);
            const fetchPrune = normaliseChoice<GitBooleanConfig>(
                await invoke<string | null>("get_global_fetch_prune"),
                ["", "true", "false"],
            );
            setGlobalFetchPrune(fetchPrune);
            setLoadedGlobalFetchPrune(fetchPrune);
            const pushDefault = normaliseChoice<PushDefaultMode>(
                await invoke<string | null>("get_global_push_default"),
                ["", "nothing", "current", "upstream", "simple", "matching"],
            );
            setGlobalPushDefault(pushDefault);
            setLoadedGlobalPushDefault(pushDefault);
            const pushAutoSetupRemote = normaliseChoice<GitBooleanConfig>(
                await invoke<string | null>("get_global_push_auto_setup_remote"),
                ["", "true", "false"],
            );
            setGlobalPushAutoSetupRemote(pushAutoSetupRemote);
            setLoadedGlobalPushAutoSetupRemote(pushAutoSetupRemote);
            const coreEditor = await invoke<string | null>("get_global_core_editor");
            setGlobalCoreEditor(coreEditor ?? "");
            setLoadedGlobalCoreEditor(coreEditor ?? "");
            const lineEndings = normaliseChoice<LineEndingMode>(
                await invoke<string | null>("get_global_core_autocrlf"),
                ["", "false", "true", "input"],
            );
            setGlobalLineEndings(lineEndings);
            setLoadedGlobalLineEndings(lineEndings);
            const credentialHelper = await invoke<string | null>("get_global_credential_helper");
            setGlobalCredentialHelper(credentialHelper ?? "");
            setLoadedGlobalCredentialHelper(credentialHelper ?? "");

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
            setUiTextScale(normaliseUiTextScale(settings.uiTextScale));
            setWrapDiffLines(settings.wrapDiffLines ?? false);
            setRowStriping(settings.rowStriping ?? "Off");
            setPersistentErrorToasts(settings.persistentErrorToasts ?? false);
            setErrorToastClearDelayMs(String(settings.errorToastClearDelayMs ?? DEFAULT_ERROR_TOAST_CLEAR_DELAY_MS));
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
            setLinuxTerminalEmulator(settings.linuxTerminalEmulator ?? "Auto");
            setLinuxTerminalCustomCommand(settings.linuxTerminalCustomCommand ?? "");
            setRepoOpenBehaviour(settings.repoOpenBehaviour ?? "Ask");
            setGpgKeyserverVerificationEnabledState(settings.gpgKeyserverVerificationEnabled ?? false);
            setLoadedGpgKeyserverVerificationEnabled(settings.gpgKeyserverVerificationEnabled ?? false);
            await applyThemeMode(settings.themeMode);
            applyUiTextScale(settings.uiTextScale);

            const cfgPath = await getConfigFilePath();
            setConfigFilePath(cfgPath ?? "");
            const cfgFolderPath = await getConfigFolderPath();
            setConfigFolderPath(cfgFolderPath ?? "");

            const version = await invoke<string>("get_build_version");
            setBuildVersion(version);
            setStatus(t("status.loaded"));
            setLoadState({status: "loaded"});
        } catch (e) {
            const message = t("status.loadFailed", {message: String(e)});
            console.error("Failed to load settings", e);
            setStatus(message);
            setLoadState({status: "error", message});
        }
    }, [t]);

    useEffect(() => {
        void loadSettings();
    }, [loadSettings]);

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
            const desiredGpgProgram = globalGpgProgram.trim();
            const signatureSettingsChanged = (gitExecutableEdited && gitExecutablePath !== gitExecutableConfiguredPath)
                || (globalGpgProgramEdited && desiredGpgProgram !== globalGpgProgramConfigured)
                || gpgKeyserverVerificationEnabled !== loadedGpgKeyserverVerificationEnabled;

            await invoke("set_backend_mode", {mode: backendMode});
            await invoke("set_show_result_log", {showResultLog: openResultLogOnLaunch});
            await invoke<Settings>("set_theme_mode", {themeMode});
            await invoke<Settings>("set_ui_text_scale", {uiTextScale});
            await invoke<Settings>("set_wrap_diff_lines", {wrapDiffLines});
            await invoke<Settings>("set_row_striping", {rowStriping});
            await invoke<Settings>("set_persistent_error_toasts", {persistentErrorToasts});
            const parsedErrorToastClearDelayMs = Number.parseInt(errorToastClearDelayMs, 10);
            const savedErrorToastClearDelayMs = Number.isFinite(parsedErrorToastClearDelayMs)
                ? Math.max(MIN_ERROR_TOAST_CLEAR_DELAY_MS, parsedErrorToastClearDelayMs)
                : DEFAULT_ERROR_TOAST_CLEAR_DELAY_MS;
            await invoke<Settings>("set_error_toast_clear_delay_ms", {errorToastClearDelayMs: savedErrorToastClearDelayMs});
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

            const optionalGitConfigSaves = [
                await saveGlobalConfigIfChanged(globalPullRebase, loadedGlobalPullRebase, "get_global_pull_rebase", "set_global_pull_rebase", "pullRebase"),
                await saveGlobalConfigIfChanged(globalPullFastForward, loadedGlobalPullFastForward, "get_global_pull_ff", "set_global_pull_ff", "pullFf"),
                await saveGlobalConfigIfChanged(globalPullAutostash, loadedGlobalPullAutostash, "get_global_pull_autostash", "set_global_pull_autostash", "pullAutostash"),
                await saveGlobalConfigIfChanged(globalFetchPrune, loadedGlobalFetchPrune, "get_global_fetch_prune", "set_global_fetch_prune", "fetchPrune"),
                await saveGlobalConfigIfChanged(globalPushDefault, loadedGlobalPushDefault, "get_global_push_default", "set_global_push_default", "pushDefault"),
                await saveGlobalConfigIfChanged(globalPushAutoSetupRemote, loadedGlobalPushAutoSetupRemote, "get_global_push_auto_setup_remote", "set_global_push_auto_setup_remote", "pushAutoSetupRemote"),
                await saveGlobalConfigIfChanged(globalCoreEditor, loadedGlobalCoreEditor, "get_global_core_editor", "set_global_core_editor", "coreEditor"),
                await saveGlobalConfigIfChanged(globalLineEndings, loadedGlobalLineEndings, "get_global_core_autocrlf", "set_global_core_autocrlf", "coreAutocrlf"),
                await saveGlobalConfigIfChanged(globalCredentialHelper, loadedGlobalCredentialHelper, "get_global_credential_helper", "set_global_credential_helper", "credentialHelper"),
            ];
            gitConfigMessages.push(...optionalGitConfigSaves.filter((message): message is string => message != null));

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
            await invoke<Settings>("set_gpg_keyserver_verification_enabled", {
                enabled: gpgKeyserverVerificationEnabled,
            });
            if (isLinux) {
                await invoke("set_linux_graphics_mode", {mode: linuxGraphicsMode});
                await invoke("set_linux_terminal_emulator", {linuxTerminalEmulator});
                await invoke("set_linux_terminal_custom_command", {linuxTerminalCustomCommand});
            }
            await invoke("set_repo_open_behaviour", {repoOpenBehaviour});
            const settings = await invoke<Settings>("get_settings");
            setCommitMessageRecommendedLength(String(settings.commitMessageRecommendedLength ?? DEFAULT_COMMIT_MESSAGE_RECOMMENDED_LENGTH));
            setErrorToastClearDelayMs(String(settings.errorToastClearDelayMs ?? DEFAULT_ERROR_TOAST_CLEAR_DELAY_MS));
            setUiTextScale(normaliseUiTextScale(settings.uiTextScale));

            localStorage.setItem(BACKEND_MODE_KEY, settings.backendMode);
            localStorage.setItem(SHOW_RESULT_LOG_KEY, String(openResultLogOnLaunch));
            localStorage.setItem(THEME_MODE_KEY, settings.themeMode);
            await applyThemeMode(settings.themeMode);
            applyUiTextScale(settings.uiTextScale);

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
            const savedPullRebase = normaliseChoice<PullRebaseMode>(
                await invoke<string | null>("get_global_pull_rebase"),
                ["", "false", "true", "merges", "interactive"],
            );
            setGlobalPullRebase(savedPullRebase);
            setLoadedGlobalPullRebase(savedPullRebase);
            const savedPullFastForward = normaliseChoice<PullFastForwardMode>(
                await invoke<string | null>("get_global_pull_ff"),
                ["", "true", "false", "only"],
            );
            setGlobalPullFastForward(savedPullFastForward);
            setLoadedGlobalPullFastForward(savedPullFastForward);
            const savedPullAutostash = normaliseChoice<GitBooleanConfig>(
                await invoke<string | null>("get_global_pull_autostash"),
                ["", "true", "false"],
            );
            setGlobalPullAutostash(savedPullAutostash);
            setLoadedGlobalPullAutostash(savedPullAutostash);
            const savedFetchPrune = normaliseChoice<GitBooleanConfig>(
                await invoke<string | null>("get_global_fetch_prune"),
                ["", "true", "false"],
            );
            setGlobalFetchPrune(savedFetchPrune);
            setLoadedGlobalFetchPrune(savedFetchPrune);
            const savedPushDefault = normaliseChoice<PushDefaultMode>(
                await invoke<string | null>("get_global_push_default"),
                ["", "nothing", "current", "upstream", "simple", "matching"],
            );
            setGlobalPushDefault(savedPushDefault);
            setLoadedGlobalPushDefault(savedPushDefault);
            const savedPushAutoSetupRemote = normaliseChoice<GitBooleanConfig>(
                await invoke<string | null>("get_global_push_auto_setup_remote"),
                ["", "true", "false"],
            );
            setGlobalPushAutoSetupRemote(savedPushAutoSetupRemote);
            setLoadedGlobalPushAutoSetupRemote(savedPushAutoSetupRemote);
            const savedCoreEditor = await invoke<string | null>("get_global_core_editor");
            setGlobalCoreEditor(savedCoreEditor ?? "");
            setLoadedGlobalCoreEditor(savedCoreEditor ?? "");
            const savedLineEndings = normaliseChoice<LineEndingMode>(
                await invoke<string | null>("get_global_core_autocrlf"),
                ["", "false", "true", "input"],
            );
            setGlobalLineEndings(savedLineEndings);
            setLoadedGlobalLineEndings(savedLineEndings);
            const savedCredentialHelper = await invoke<string | null>("get_global_credential_helper");
            setGlobalCredentialHelper(savedCredentialHelper ?? "");
            setLoadedGlobalCredentialHelper(savedCredentialHelper ?? "");
            setGitExecutableConfiguredPath(settings.gitExecutablePath ?? "");
            setGitExecutableEdited(false);
            await refreshGitExecutable();
            const savedGpgProgram = await invoke<string | null>("get_global_gpg_program");
            setGlobalGpgProgramConfigured(savedGpgProgram ?? "");
            setGlobalGpgProgramEdited(false);
            setGlobalGpgProgram(await getGlobalGpgProgramPath() ?? "");
            setLoadedGpgKeyserverVerificationEnabled(settings.gpgKeyserverVerificationEnabled ?? false);

            await emit("settings-updated", settings);
            if (signatureSettingsChanged) {
                await emit("signature-settings-updated");
            }
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
        uiTextScale,
        openResultLogOnLaunch,
        wrapDiffLines,
        rowStriping,
        persistentErrorToasts,
        errorToastClearDelayMs,
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
        globalPullRebase,
        loadedGlobalPullRebase,
        globalPullFastForward,
        loadedGlobalPullFastForward,
        globalPullAutostash,
        loadedGlobalPullAutostash,
        globalFetchPrune,
        loadedGlobalFetchPrune,
        globalPushDefault,
        loadedGlobalPushDefault,
        globalPushAutoSetupRemote,
        loadedGlobalPushAutoSetupRemote,
        globalCoreEditor,
        loadedGlobalCoreEditor,
        globalLineEndings,
        loadedGlobalLineEndings,
        globalCredentialHelper,
        loadedGlobalCredentialHelper,
        commitDateMode,
        commitMessageRecommendedLength,
        pushFollowTags,
        autoCheckForUpdatesOnLaunch,
        autoInstallUpdates,
        updateEndpoint,
        isLinux,
        isWindows,
        linuxGraphicsMode,
        linuxTerminalEmulator,
        linuxTerminalCustomCommand,
        repoOpenBehaviour,
        gpgKeyserverVerificationEnabled,
        externalDiffToolPath,
        globalGpgProgram,
        globalGpgProgramConfigured,
        globalGpgProgramEdited,
        loadedGpgKeyserverVerificationEnabled,
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

    const handleUiTextScaleChange = useCallback((value: string) => {
        const scale = UI_TEXT_SCALE_VALUES[Number(value)] ?? 1;
        setUiTextScale(scale);
        applyUiTextScale(scale);
    }, []);

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
            await emit("signature-settings-updated");
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
            await openPath(configFolderPath);
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

            <div className="settings-window__body" aria-busy={loadState.status === "loading"}>

                <div className="settings-window__tabs">
                    <button
                        className={`settings-window__tab ${tab === "application" ? "settings-window__tab--active" : ""}`}
                        onClick={() => setTab("application")}
                    >
                        {t("labels.application")}
                    </button>
                    <button
                        className={`settings-window__tab ${tab === "git" ? "settings-window__tab--active" : ""}`}
                        onClick={() => setTab("git")}
                    >
                        {t("labels.git")}
                    </button>
                </div>

                {loadState.status === "loading" && (
                    <SettingsSkeleton
                        tab={tab}
                        isLinux={os === "linux"}
                    />
                )}

                {loadState.status === "error" && (
                    <SettingsLoadError message={loadState.message} onRetry={loadSettings}/>
                )}

                {loadState.status === "loaded" && tab === "application" && (
                <div className="settings-window__column">
                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.appGroupGeneral")}</div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.openRepositories")}</label>
                            <select
                                className="settings-window__select"
                                value={repoOpenBehaviour}
                                onChange={e => setRepoOpenBehaviour(e.target.value as RepoOpenBehaviour)}
                            >
                                <option value="Ask">{t("options.repoOpenAsk")}</option>
                                <option value="ExistingWindow">{t("options.repoOpenExisting")}</option>
                                <option value="NewWindow">{t("options.repoOpenNew")}</option>
                            </select>
                            <div className="settings-window__section-note">
                                {t("notes.repoOpenBehaviour")}
                            </div>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.errorMessages")}</label>
                            <label className="settings-window__switch-row">
                  <span className="settings-window__switch">
                    <input
                        type="checkbox"
                        checked={persistentErrorToasts}
                        onChange={e => setPersistentErrorToasts(e.target.checked)}
                    />
                    <span className="settings-window__switch-track"/>
                  </span>
                                <span className="settings-window__switch-label">{t("switches.persistentErrorToasts")}</span>
                            </label>
                            <div className="settings-window__section-note">
                                {t("notes.persistentErrorToasts")}
                            </div>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label" htmlFor="settings-error-toast-delay">
                                {t("labels.errorToastClearDelayMs")}
                            </label>
                            <input
                                id="settings-error-toast-delay"
                                className="settings-window__input"
                                type="number"
                                min={MIN_ERROR_TOAST_CLEAR_DELAY_MS}
                                step={500}
                                disabled={persistentErrorToasts}
                                value={errorToastClearDelayMs}
                                onChange={e => {
                                    if (/^\d*$/.test(e.target.value)) {
                                        setErrorToastClearDelayMs(e.target.value);
                                    }
                                }}
                                onBlur={() => {
                                    const next = Number.parseInt(errorToastClearDelayMs, 10);
                                    setErrorToastClearDelayMs(String(Number.isFinite(next)
                                        ? Math.max(MIN_ERROR_TOAST_CLEAR_DELAY_MS, next)
                                        : DEFAULT_ERROR_TOAST_CLEAR_DELAY_MS));
                                }}
                            />
                            <div className="settings-window__section-note">
                                {t("notes.errorToastClearDelayMs")}
                            </div>
                        </div>

                        {isLinux && (
                            <div className="settings-window__row">
                                <label className="settings-window__label" htmlFor="settings-linux-terminal">
                                    {t("labels.terminal")}
                                </label>
                                <select
                                    id="settings-linux-terminal"
                                    className="settings-window__select"
                                    value={linuxTerminalEmulator}
                                    onChange={e => setLinuxTerminalEmulator(e.target.value as LinuxTerminalEmulator)}
                                >
                                    {linuxTerminalOptions.map(option => (
                                        <option key={option.emulator} value={option.emulator}>{labelLinuxTerminal(option)}</option>
                                    ))}
                                </select>
                                {linuxTerminalEmulator === "Custom" && (
                                    <input
                                        className="settings-window__input"
                                        type="text"
                                        value={linuxTerminalCustomCommand}
                                        onChange={e => setLinuxTerminalCustomCommand(e.target.value)}
                                        placeholder={t("placeholders.linuxTerminalCustomCommand")}
                                        spellCheck={false}
                                        autoCapitalize="off"
                                        autoCorrect="off"
                                    />
                                )}
                                <div className="settings-window__section-note">
                                    {t("notes.linuxTerminal")}
                                </div>
                            </div>
                        )}

                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.cloneDestination")}</label>
                            <div className="settings-window__inline-controls" style={{gap: "6px", flexWrap: "nowrap"}}>
                                <input
                                    className="settings-window__input"
                                    type="text"
                                    value={defaultCloneDir}
                                    onChange={e => setDefaultCloneDir(e.target.value)}
                                    placeholder={cloneDestinationPlaceholder}
                                />
                                <button
                                    className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                    onClick={handleBrowseCloneDir}>
                                    <FolderIcon/>
                                </button>
                            </div>
                        </div>

                        {updateChannel === "SelfManaged" ? (
                            <div className="settings-window__row">
                                <label className="settings-window__label">{t("labels.updates")}</label>
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
                        ) : updateChannel === "MicrosoftStore" ? (
                            <div className="settings-window__row">
                                <label className="settings-window__label">{t("labels.updates")}</label>
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
                                    {t("notes.updatesMicrosoftStore")}
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
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.appGroupAppearance")}</div>

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

                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.textScale")}</label>
                            <div className="settings-window__range-row">
                                <input
                                    className="settings-window__range"
                                    type="range"
                                    min={0}
                                    max={UI_TEXT_SCALE_VALUES.length - 1}
                                    step={1}
                                    value={UI_TEXT_SCALE_VALUES.indexOf(uiTextScale)}
                                    onChange={e => handleUiTextScaleChange(e.target.value)}
                                    aria-valuetext={t(`options.textScale.${String(uiTextScale).replace(".", "_")}`)}
                                />
                                <span className="settings-window__range-value">
                                {t(`options.textScale.${String(uiTextScale).replace(".", "_")}`)}
                            </span>
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
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.appGroupViews")}</div>

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

                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.rowStriping")}</label>
                            <select
                                className="settings-window__select"
                                value={rowStriping}
                                onChange={e => setRowStriping(e.target.value as RowStriping)}
                            >
                                <option value="Off">{t("options.rowStripingOff")}</option>
                                <option value="Subtle">{t("options.rowStripingSubtle")}</option>
                                <option value="Strong">{t("options.rowStripingStrong")}</option>
                            </select>
                            <div className="settings-window__section-note">
                                {t("notes.rowStriping")}
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
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.appGroupDiagnostics")}</div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">{t("labels.resultLog")}</label>
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
                    </section>
                </div>
                )}

                {loadState.status === "loaded" && tab === "git" && (
                <div className="settings-window__column">
                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.gitGroupRuntime")}</div>

                        <div className="settings-window__section-note">
                            {t("notes.gitOptions")}
                        </div>

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
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.gitGroupGitmunBehaviour")}</div>

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
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.gitGroupCore")}</div>
                        <div className="settings-window__section-note">
                            {t("notes.gitConfiguration")}
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="core.editor">{t("labels.gitEditor")}</GitConfigLabel>
                            </label>
                            <input
                                className="settings-window__input"
                                type="text"
                                value={globalCoreEditor}
                                onChange={e => setGlobalCoreEditor(e.target.value)}
                                placeholder={t("placeholders.gitEditor")}
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="core.autocrlf">{t("labels.lineEndings")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalLineEndings}
                                onChange={e => setGlobalLineEndings(e.target.value as LineEndingMode)}
                            >
                                <option value="">{t("options.lineEndingsDefault")}</option>
                                <option value="false">{t("options.lineEndingsFalse")}</option>
                                <option value="input">{t("options.lineEndingsInput")}</option>
                                <option value="true">{t("options.lineEndingsTrue")}</option>
                            </select>
                            <div className="settings-window__section-note">
                                {t("notes.lineEndings")}
                            </div>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="core.fileMode">{t("labels.fileMode")}</GitConfigLabel>
                            </label>
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
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.gitGroupSetup")}</div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="credential.helper">{t("labels.credentialHelper")}</GitConfigLabel>
                            </label>
                            <input
                                className="settings-window__input"
                                type="text"
                                value={globalCredentialHelper}
                                onChange={e => setGlobalCredentialHelper(e.target.value)}
                                placeholder={t("placeholders.credentialHelper")}
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                            <div className="settings-window__section-note">
                                {t("notes.credentialHelper")}
                            </div>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="init.defaultBranch">{t("labels.defaultBranch")}</GitConfigLabel>
                            </label>
                            <input
                                className="settings-window__input"
                                type="text"
                                value={globalDefaultBranch}
                                onChange={e => setGlobalDefaultBranch(e.target.value)}
                                placeholder={t("placeholders.defaultBranch")}
                            />
                        </div>
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.gitGroupTools")}</div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="diff.tool / merge.tool">{t("labels.diffTool")}</GitConfigLabel>
                            </label>
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
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="gpg.program">{t("labels.gpgProgram")}</GitConfigLabel>
                            </label>
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
                            <label className="settings-window__label">{t("labels.gpgKeyserverVerification")}</label>
                            <label className="settings-window__switch-row">
                                <span className="settings-window__switch">
                                    <input
                                        type="checkbox"
                                        checked={gpgKeyserverVerificationEnabled}
                                        onChange={e => setGpgKeyserverVerificationEnabledState(e.target.checked)}
                                    />
                                    <span className="settings-window__switch-track"/>
                                </span>
                                <span className="settings-window__switch-label">{t("switches.gpgKeyserverVerification")}</span>
                            </label>
                            <div className="settings-window__section-note">
                                {t("notes.gpgKeyserverVerification")}
                            </div>
                        </div>
                    </section>

                    <section className="settings-window__section">
                        <div className="settings-window__section-title">{t("labels.gitGroupSync")}</div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="pull.rebase">{t("labels.pullRebase")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalPullRebase}
                                onChange={e => setGlobalPullRebase(e.target.value as PullRebaseMode)}
                            >
                                <option value="">{t("options.pullRebaseDefault")}</option>
                                <option value="false">{t("options.pullRebaseFalse")}</option>
                                <option value="true">{t("options.pullRebaseTrue")}</option>
                                <option value="merges">{t("options.pullRebaseMerges")}</option>
                                <option value="interactive">{t("options.pullRebaseInteractive")}</option>
                            </select>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="pull.ff">{t("labels.pullFastForward")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalPullFastForward}
                                onChange={e => setGlobalPullFastForward(e.target.value as PullFastForwardMode)}
                            >
                                <option value="">{t("options.pullFastForwardDefault")}</option>
                                <option value="true">{t("options.pullFastForwardTrue")}</option>
                                <option value="false">{t("options.pullFastForwardFalse")}</option>
                                <option value="only">{t("options.pullFastForwardOnly")}</option>
                            </select>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="pull.autostash">{t("labels.pullAutostash")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalPullAutostash}
                                onChange={e => setGlobalPullAutostash(e.target.value as GitBooleanConfig)}
                            >
                                <option value="">{t("options.booleanDefault")}</option>
                                <option value="true">{t("options.booleanTrue")}</option>
                                <option value="false">{t("options.booleanFalse")}</option>
                            </select>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="fetch.prune">{t("labels.fetchBehaviour")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalFetchPrune}
                                onChange={e => setGlobalFetchPrune(e.target.value as GitBooleanConfig)}
                            >
                                <option value="">{t("options.booleanDefault")}</option>
                                <option value="true">{t("options.booleanTrue")}</option>
                                <option value="false">{t("options.booleanFalse")}</option>
                            </select>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="push.default">{t("labels.pushDefault")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalPushDefault}
                                onChange={e => setGlobalPushDefault(e.target.value as PushDefaultMode)}
                            >
                                <option value="">{t("options.pushDefaultDefault")}</option>
                                <option value="simple">{t("options.pushDefaultSimple")}</option>
                                <option value="current">{t("options.pushDefaultCurrent")}</option>
                                <option value="upstream">{t("options.pushDefaultUpstream")}</option>
                                <option value="nothing">{t("options.pushDefaultNothing")}</option>
                                <option value="matching">{t("options.pushDefaultMatching")}</option>
                            </select>
                        </div>

                        <div className="settings-window__row">
                            <label className="settings-window__label">
                                <GitConfigLabel configKey="push.autoSetupRemote">{t("labels.pushUpstream")}</GitConfigLabel>
                            </label>
                            <select
                                className="settings-window__select"
                                value={globalPushAutoSetupRemote}
                                onChange={e => setGlobalPushAutoSetupRemote(e.target.value as GitBooleanConfig)}
                            >
                                <option value="">{t("options.booleanDefault")}</option>
                                <option value="true">{t("options.booleanTrue")}</option>
                                <option value="false">{t("options.booleanFalse")}</option>
                            </select>
                        </div>
                    </section>
                </div>
                )}

            </div>

            <div className="settings-window__footer">
                <div className="settings-window__actions">
                    <button className="settings-window__btn settings-window__btn--primary" onClick={handleSave}
                            disabled={saving || loadState.status !== "loaded"}>
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
