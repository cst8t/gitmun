import React, {useState, useEffect, useCallback} from "react";
import {invoke} from "@tauri-apps/api/core";
import {emit} from "@tauri-apps/api/event";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {open} from "@tauri-apps/plugin-dialog";
import {platform} from "@tauri-apps/plugin-os";
import type {
    AvatarProviderMode,
    BackendMode,
    CommitDateMode,
    ExternalDiffTool,
    LinuxGraphicsMode,
    Settings,
    ThemeMode
} from "../../types";
import {
    getSystemThemeHint,
    isUpdaterEnabled,
    openResultLogWindow,
    setUpdateEndpoint,
} from "../../api/commands";
import {CloseIcon, FolderIcon} from "../icons";
import "./SettingsWindow.css";

const BACKEND_MODE_KEY = "gitmun.backendMode";
const SHOW_RESULT_LOG_KEY = "gitmun.showResultLog";
const THEME_MODE_KEY = "gitmun.themeMode";
const DEFAULT_LEFT_PANE_WIDTH = 300;
const DEFAULT_RIGHT_PANE_WIDTH = 480;
const DEFAULT_UPDATE_ENDPOINT = "https://github.com/cst8t/gitmun/releases/latest/download/latest.json";

function supportedDiffTools(os: string): ExternalDiffTool[] {
    const tools: ExternalDiffTool[] = ["Other", "Meld", "VsCode", "VsCodium"];
    if (os === "linux") tools.push("Kompare");
    if (os === "windows") tools.push("WinMerge");
    return tools;
}

function diffToolLabel(tool: ExternalDiffTool): string {
    switch (tool) {
        case "Other":
            return "None / Other";
        case "VsCode":
            return "VS Code";
        case "VsCodium":
            return "VS Codium";
        default:
            return tool;
    }
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
    const useNativeWindowBar = true;
    const [backendMode, setBackendMode] = useState<BackendMode>("Default");
    const [themeMode, setThemeMode] = useState<ThemeMode>("System");
    const [wrapDiffLines, setWrapDiffLines] = useState(false);
    const [openResultLogOnLaunch, setOpenResultLogOnLaunch] = useState(false);
    const [avatarProvider, setAvatarProvider] = useState<AvatarProviderMode>("Libravatar");
    const [tryPlatformFirst, setTryPlatformFirst] = useState(true);
    const [externalDiffTool, setExternalDiffTool] = useState<ExternalDiffTool>("Other");
    const [globalDefaultBranch, setGlobalDefaultBranch] = useState<string>("");
    const [allowedDiffTools, setAllowedDiffTools] = useState<ExternalDiffTool[]>(["Other", "Meld"]);
    const [defaultCloneDir, setDefaultCloneDir] = useState<string>("");
    const [commitDateMode, setCommitDateMode] = useState<CommitDateMode>("AuthorDate");
    const [pushFollowTags, setPushFollowTags] = useState(false);
    const [autoCheckForUpdatesOnLaunch, setAutoCheckForUpdatesOnLaunch] = useState(true);
    const [autoInstallUpdates, setAutoInstallUpdates] = useState(false);
    const [updateEndpoint, setUpdateEndpointState] = useState(DEFAULT_UPDATE_ENDPOINT);
    const [linuxGraphicsMode, setLinuxGraphicsMode] = useState<LinuxGraphicsMode>("Auto");
    const [isLinux, setIsLinux] = useState(false);
    const [updaterSupported, setUpdaterSupported] = useState(false);
    const [configFilePath, setConfigFilePath] = useState<string>("");
    const [buildVersion, setBuildVersion] = useState<string>("");
    const [status, setStatus] = useState("Ready.");
    const [saving, setSaving] = useState(false);
    const suggestedTools = allowedDiffTools.filter((tool) => tool !== "Other");

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

                const globalDiffTool = await invoke<ExternalDiffTool>("get_global_diff_tool");
                setExternalDiffTool(supported.includes(globalDiffTool) ? globalDiffTool : "Other");
                const defaultBranch = await invoke<string | null>("get_global_default_branch");
                setGlobalDefaultBranch(defaultBranch ?? "");

                const settings = await invoke<Settings>("get_settings");
                setBackendMode(settings.backendMode);
                setThemeMode(settings.themeMode);
                setWrapDiffLines(settings.wrapDiffLines ?? false);
                setOpenResultLogOnLaunch(settings.showResultLog);
                setAvatarProvider(settings.avatarProvider);
                setTryPlatformFirst(settings.tryPlatformFirst);
                setDefaultCloneDir(settings.defaultCloneDir);
                setCommitDateMode(settings.commitDateMode ?? "AuthorDate");
                setPushFollowTags(settings.pushFollowTags ?? false);
                setAutoCheckForUpdatesOnLaunch(settings.autoCheckForUpdatesOnLaunch ?? true);
                setAutoInstallUpdates(settings.autoInstallUpdates ?? false);
                setUpdateEndpointState(settings.updateEndpoint ?? DEFAULT_UPDATE_ENDPOINT);
                setLinuxGraphicsMode(settings.linuxGraphicsMode ?? "Auto");
                document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);

                const cfgPath = await invoke<string | null>("get_config_file_path");
                setConfigFilePath(cfgPath ?? "");

                const version = await invoke<string>("get_build_version");
                setBuildVersion(version);
                setStatus("Loaded settings (including global Git config).");
            } catch (e) {
                setStatus(`Failed to load settings: ${e}`);
            }
        })();
    }, []);

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
            await invoke("set_backend_mode", {mode: backendMode});
            await invoke("set_show_result_log", {showResultLog: openResultLogOnLaunch});
            await invoke<Settings>("set_theme_mode", {themeMode});
            await invoke<Settings>("set_wrap_diff_lines", {wrapDiffLines});
            await invoke("set_avatar_provider", {avatarProvider});
            await invoke("set_try_platform_first", {tryPlatformFirst: avatarProvider !== "Off" && tryPlatformFirst});
            await invoke("set_default_clone_dir", {defaultCloneDir});
            await invoke("set_global_diff_tool", {tool: externalDiffTool});
            await invoke("set_global_default_branch", {defaultBranch: globalDefaultBranch});
            await invoke("set_commit_date_mode", {commitDateMode});
            await invoke("set_push_follow_tags", {pushFollowTags});
            await invoke("set_auto_check_for_updates_on_launch", {autoCheckForUpdatesOnLaunch});
            await invoke("set_auto_install_updates", {autoInstallUpdates});
            await setUpdateEndpoint(updateEndpoint);
            if (isLinux) await invoke("set_linux_graphics_mode", {mode: linuxGraphicsMode});
            const settings = await invoke<Settings>("get_settings");

            localStorage.setItem(BACKEND_MODE_KEY, settings.backendMode);
            localStorage.setItem(SHOW_RESULT_LOG_KEY, String(openResultLogOnLaunch));
            localStorage.setItem(THEME_MODE_KEY, settings.themeMode);
            document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);

            await emit("settings-updated", settings);
            setStatus("Saved settings and updated global Git configuration.");
        } catch (e) {
            setStatus(`Save failed: ${e}`);
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
        externalDiffTool,
        globalDefaultBranch,
        commitDateMode,
        pushFollowTags,
        autoCheckForUpdatesOnLaunch,
        autoInstallUpdates,
        updateEndpoint,
        isLinux,
        linuxGraphicsMode,
    ]);

    const handleOpenResultLog = useCallback(async () => {
        try {
            await openResultLogWindow();
            setStatus("Opened result log window.");
        } catch (e) {
            setStatus(`Failed to open result log: ${e}`);
        }
    }, []);

    const handleResetLayout = useCallback(async () => {
        try {
            const settings = await invoke<Settings>("set_panel_layout", {
                leftPaneWidth: DEFAULT_LEFT_PANE_WIDTH,
                rightPaneWidth: DEFAULT_RIGHT_PANE_WIDTH,
            });
            await emit("settings-updated", settings);
            setStatus("Reset panel layout to defaults.");
        } catch (e) {
            setStatus(`Failed to reset layout: ${e}`);
        }
    }, []);

    const handleBrowseCloneDir = useCallback(async () => {
        try {
            const selected = await open({
                directory: true,
                multiple: false,
                title: "Select default clone destination",
                defaultPath: defaultCloneDir || undefined,
            });
            if (typeof selected === "string") setDefaultCloneDir(selected);
        } catch (e) {
            setStatus(`Browse failed: ${e}`);
        }
    }, [defaultCloneDir]);

    const handleClose = useCallback(() => {
        getCurrentWindow().close();
    }, []);

    return (
        <div className="settings-window">
            {!useNativeWindowBar && (
                <div className="settings-window__header">
                    <span className="settings-window__title">Settings</span>
                    <button className="settings-window__close" onClick={handleClose}>
                        <CloseIcon/>
                    </button>
                </div>
            )}

            <div className="settings-window__body">

                {/* Left column: Application */}
                <div className="settings-window__column">
                    <div className="settings-window__section-title">Application</div>
                    {configFilePath && (
                        <div className="settings-window__section-note">
                            Config file: <code>{configFilePath}</code>
                        </div>
                    )}
                    {buildVersion && (
                        <div className="settings-window__section-note">
                            Build version: <code>{buildVersion}</code>
                        </div>
                    )}

                    {updaterSupported ? (
                        <div className="settings-window__row">
                            <label className="settings-window__label">Updates</label>
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
                                    <span className="settings-window__switch-label">Automatically check for updates on launch</span>
                                </label>
                                <div className="settings-window__section-note">
                                    Use About to check manually. Automatic checks only show the updater prompt on launch when this is enabled.
                                </div>

                                <div className="settings-window__row">
                                    <label className="settings-window__label">Update feed URL</label>
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
                                            Advanced setting. Gitmun checks this <code>latest.json</code> URL for
                                            updates.
                                            Do not change this unless you know what you&apos;re doing.
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div className="settings-window__row">
                            <label className="settings-window__label">Updates</label>
                            <div className="settings-window__section-note">
                                Updates are managed by this platform package channel.
                            </div>
                        </div>
                    )}

                    <div className="settings-window__row">
                        <label className="settings-window__label">Git backend mode</label>
                        <select
                            className="settings-window__select"
                            value={backendMode}
                            onChange={e => setBackendMode(e.target.value as BackendMode)}
                        >
                            <option value="Default">Default (gix-assisted)</option>
                            <option value="GitCliOnly">Git CLI only</option>
                        </select>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Theme</label>
                        <select
                            className="settings-window__select"
                            value={themeMode}
                            onChange={e => setThemeMode(e.target.value as ThemeMode)}
                        >
                            <option value="System">System</option>
                            <option value="Light">Light</option>
                            <option value="Dark">Dark</option>
                        </select>
                    </div>

                    {isLinux && (
                        <div className="settings-window__row">
                            <label className="settings-window__label">Graphics mode</label>
                            <select
                                className="settings-window__select"
                                value={linuxGraphicsMode}
                                onChange={e => setLinuxGraphicsMode(e.target.value as LinuxGraphicsMode)}
                            >
                                <option value="Auto">Compatibility (default)</option>
                                <option value="Safe">Maximum compatibility</option>
                                <option value="Native">Native (hardware acceleration)</option>
                            </select>
                            <div className="settings-window__section-note">
                                Takes effect on next launch. Use "Maximum compatibility" if you see rendering crashes or
                                a blank window.
                            </div>
                        </div>
                    )}

                    <div className="settings-window__row">
                        <label className="settings-window__label">Diff panel</label>
                        <label className="settings-window__switch-row">
              <span className="settings-window__switch">
                <input
                    type="checkbox"
                    checked={wrapDiffLines}
                    onChange={e => setWrapDiffLines(e.target.checked)}
                />
                <span className="settings-window__switch-track"/>
              </span>
                            <span className="settings-window__switch-label">Wrap long lines in diff view</span>
                        </label>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Result log</label>
                        <div className="settings-window__sub-section">
                            <button className="settings-window__btn settings-window__btn--secondary"
                                    onClick={handleOpenResultLog}>
                                Open result log window
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
                                <span className="settings-window__switch-label">Open at launch</span>
                            </label>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Layout</label>
                        <div className="settings-window__inline-controls">
                            <button className="settings-window__btn settings-window__btn--secondary"
                                    onClick={handleResetLayout}>
                                Reset panel layout
                            </button>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Default clone destination</label>
                        <div className="settings-window__inline-controls" style={{gap: "6px", flexWrap: "nowrap"}}>
                            <input
                                className="settings-window__input"
                                type="text"
                                value={defaultCloneDir}
                                onChange={e => setDefaultCloneDir(e.target.value)}
                                placeholder="Leave blank to use ~/GitmunProjects"
                            />
                            <button
                                className="settings-window__btn settings-window__btn--secondary settings-window__icon-btn"
                                onClick={handleBrowseCloneDir}>
                                <FolderIcon/>
                            </button>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Avatars</label>
                        <div className="settings-window__sub-section">
                            <select
                                className="settings-window__select"
                                value={avatarProvider}
                                onChange={e => setAvatarProvider(e.target.value as AvatarProviderMode)}
                            >
                                <option value="Libravatar">Libravatar (default)</option>
                                <option value="Off">Disabled</option>
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
                  Try platform-specific avatars first (e.g. GitHub for github.com remotes)
                </span>
                            </label>
                        </div>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Commit log date</label>
                        <select
                            className="settings-window__select"
                            value={commitDateMode}
                            onChange={e => setCommitDateMode(e.target.value as CommitDateMode)}
                        >
                            <option value="AuthorDate">Author date (default)</option>
                            <option value="CommitterDate">Committer date (GitHub-style)</option>
                        </select>
                    </div>
                </div>

                {/* Right column: Git */}
                <div className="settings-window__column">
                    <div className="settings-window__section-title">Git</div>
                    <div className="settings-window__section-note">
                        These options control Git behavior in Gitmun.
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Push behavior</label>
                        <label className="settings-window__switch-row">
              <span className="settings-window__switch">
                <input
                    type="checkbox"
                    checked={pushFollowTags}
                    onChange={e => setPushFollowTags(e.target.checked)}
                />
                <span className="settings-window__switch-track"/>
              </span>
                            <span className="settings-window__switch-label">Include annotated tags when pushing (`--follow-tags`)</span>
                        </label>
                    </div>

                    <div className="settings-window__row">
                        <label className="settings-window__label">Global Git configuration</label>
                        <div className="settings-window__sub-section">
                            <div className="settings-window__section-note">
                                These options update your global Git configuration (equivalent to `git config --global
                                ...`).
                            </div>

                            <div className="settings-window__row">
                                <label className="settings-window__label">External difftool (`diff.tool`)</label>
                                <select
                                    className="settings-window__select"
                                    value={externalDiffTool}
                                    onChange={e => setExternalDiffTool(e.target.value as ExternalDiffTool)}
                                >
                                    {allowedDiffTools.map(tool => (
                                        <option key={tool} value={tool}>{diffToolLabel(tool)}</option>
                                    ))}
                                </select>
                                {externalDiffTool === "Other" && (
                                    <div className="settings-window__warning">
                                        No known difftool is configured. Compare actions may not work unless you have
                                        configured one manually in your git config.
                                        {suggestedTools.length > 0 && ` You can set one here (e.g. ${suggestedTools.map(diffToolLabel).join(", ")}).`}
                                    </div>
                                )}
                                {(externalDiffTool === "VsCode" || externalDiffTool === "VsCodium") && (
                                    <div className="settings-window__note">
                                        {diffToolLabel(externalDiffTool)}'s merge editor writes the result file when
                                        closed, so conflicts will be marked as resolved even if you close without
                                        explicitly accepting a side. Use the Accept buttons inside the editor to choose
                                        which version to keep.
                                    </div>
                                )}
                            </div>

                            <div className="settings-window__row">
                                <label className="settings-window__label">Default branch name
                                    (`init.defaultBranch`)</label>
                                <input
                                    className="settings-window__input"
                                    type="text"
                                    value={globalDefaultBranch}
                                    onChange={e => setGlobalDefaultBranch(e.target.value)}
                                    placeholder="Leave blank to use Git's default"
                                />
                            </div>
                        </div>
                    </div>
                </div>

            </div>

            <div className="settings-window__footer">
                <div className="settings-window__actions">
                    <button className="settings-window__btn settings-window__btn--primary" onClick={handleSave}
                            disabled={saving}>
                        {saving ? "Saving..." : "Save"}
                    </button>
                    <button className="settings-window__btn settings-window__btn--secondary" onClick={handleClose}>
                        Close
                    </button>
                </div>
                <span className="settings-window__status">{status}</span>
            </div>
        </div>
    );
}
