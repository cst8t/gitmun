// @vitest-environment jsdom
import React from "react";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import type {Settings} from "../../types";
import "../../i18n";

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    emit: vi.fn(async () => {}),
    openDialog: vi.fn(),
    openPath: vi.fn(),
    invoke: vi.fn(),
}));

const settings: Settings = {
    backendMode: "Default",
    showResultLog: false,
    themeMode: "System",
    uiTextScale: 1,
    wrapDiffLines: false,
    rowStriping: "Off",
    persistentErrorToasts: false,
    errorToastClearDelayMs: 8000,
    leftPaneWidth: 300,
    rightPaneWidth: 420,
    confirmRevert: true,
    avatarProvider: "Libravatar",
    tryPlatformFirst: true,
    defaultCloneDir: "",
    commitDateMode: "AuthorDate",
    commitPrimaryAction: "commit",
    commitMessageRecommendedLength: 72,
    pushFollowTags: false,
    autoCheckForUpdatesOnLaunch: true,
    autoInstallUpdates: false,
    updateEndpoint: "https://github.com/cst8t/gitmun/releases/latest/download/latest.json",
    linuxGraphicsMode: "Auto",
    linuxTerminalEmulator: "Auto",
    linuxTerminalCustomCommand: "",
    repoOpenBehaviour: "Ask",
    gitExecutablePath: "",
};

mocks.invoke.mockImplementation(async (command: string) => {
    switch (command) {
        case "get_settings":
            return settings;
        case "get_active_git_executable_path":
            return "/usr/bin/git";
        case "get_active_git_version":
            return "git version 2.45.0";
        case "get_global_diff_tool":
            return "Other";
        case "get_global_file_mode":
            return true;
        case "get_build_version":
            return "0.1.0";
        case "set_theme_mode":
        case "set_ui_text_scale":
        case "set_wrap_diff_lines":
        case "set_row_striping":
        case "set_persistent_error_toasts":
        case "set_error_toast_clear_delay_ms":
        case "set_git_executable_path":
        case "set_linux_graphics_mode":
        case "set_linux_terminal_emulator":
        case "set_linux_terminal_custom_command":
        case "set_repo_open_behaviour":
            return settings;
        default:
            return null;
    }
});

vi.mock("@tauri-apps/api/core", () => ({invoke: mocks.invoke}));
vi.mock("@tauri-apps/api/event", () => ({emit: mocks.emit}));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({close: mocks.close}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open: mocks.openDialog}));
vi.mock("@tauri-apps/plugin-opener", () => ({openPath: mocks.openPath}));
vi.mock("@tauri-apps/plugin-os", () => ({platform: () => "linux"}));
vi.mock("../../api/commands", () => ({
    getAppUpdateChannel: vi.fn(async () => "SystemManaged"),
    getConfigFilePath: vi.fn(async () => "/home/conor/.config/gitmun/config.toml"),
    getConfigFolderPath: vi.fn(async () => "/home/conor/.config/gitmun"),
    getGlobalDiffToolPath: vi.fn(async () => null),
    getGlobalGpgProgramPath: vi.fn(async () => null),
    getLinuxTerminalOptions: vi.fn(async () => [
        {emulator: "Auto", label: "Terminal"},
        {emulator: "Ghostty", label: "Ghostty"},
        {emulator: "Custom", label: "Terminal"},
    ]),
    openResultLogWindow: vi.fn(async () => {}),
    setGlobalDiffToolWithPath: vi.fn(async () => ({message: "Updated diff tool."})),
    setGlobalGpgProgram: vi.fn(async () => ({message: "Updated GPG executable."})),
    setUpdateEndpoint: vi.fn(async () => settings),
}));

import {SettingsWindow} from "./SettingsWindow";

describe("SettingsWindow", () => {
    beforeEach(() => {
        mocks.invoke.mockClear();
        mocks.emit.mockClear();
        mocks.close.mockClear();
        const store = new Map<string, string>();
        vi.stubGlobal("localStorage", {
            clear: vi.fn(() => store.clear()),
            getItem: vi.fn((key: string) => store.get(key) ?? null),
            removeItem: vi.fn((key: string) => {
                store.delete(key);
            }),
            setItem: vi.fn((key: string, value: string) => {
                store.set(key, value);
            }),
        });
        window.matchMedia = vi.fn().mockReturnValue({
            addEventListener: vi.fn(),
            addListener: vi.fn(),
            dispatchEvent: vi.fn(),
            matches: false,
            media: "",
            onchange: null,
            removeEventListener: vi.fn(),
            removeListener: vi.fn(),
        });
    });

    it("shows the Linux custom terminal command only for Custom", async () => {
        render(<SettingsWindow/>);

        expect(await screen.findByLabelText("Terminal")).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("my-terminal --working-directory {path}")).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Terminal"), {target: {value: "Custom"}});

        expect(screen.getByPlaceholderText("my-terminal --working-directory {path}")).toBeInTheDocument();
    });

    it("saves Linux terminal settings", async () => {
        render(<SettingsWindow/>);

        fireEvent.change(await screen.findByLabelText("Terminal"), {target: {value: "Custom"}});
        fireEvent.change(screen.getByPlaceholderText("my-terminal --working-directory {path}"), {
            target: {value: "kitty --directory {path}"},
        });
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_linux_terminal_emulator", {
                linuxTerminalEmulator: "Custom",
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_linux_terminal_custom_command", {
                linuxTerminalCustomCommand: "kitty --directory {path}",
            });
        });
    });

    it("loads persistent error messages off by default and saves changes", async () => {
        render(<SettingsWindow/>);

        const toggle = await screen.findByLabelText("Keep error messages open until dismissed");
        const delayInput = screen.getByLabelText("Error message auto-close delay (ms)");
        expect(toggle).not.toBeChecked();
        expect(delayInput).toHaveValue(8000);
        expect(delayInput).not.toBeDisabled();

        fireEvent.change(delayInput, {
            target: {value: "12000"},
        });

        fireEvent.click(toggle);
        expect(delayInput).toBeDisabled();
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_persistent_error_toasts", {
                persistentErrorToasts: true,
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_error_toast_clear_delay_ms", {
                errorToastClearDelayMs: 12000,
            });
        });
    });

    it("clamps the error message auto-close delay before saving", async () => {
        render(<SettingsWindow/>);

        const input = await screen.findByLabelText("Error message auto-close delay (ms)");
        fireEvent.change(input, {target: {value: "500"}});
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_error_toast_clear_delay_ms", {
                errorToastClearDelayMs: 1000,
            });
        });
    });
});
