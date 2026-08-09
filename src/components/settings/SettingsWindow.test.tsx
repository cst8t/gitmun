// @vitest-environment jsdom
import React from "react";
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Settings} from "../../types";
import "../../i18n";

const mocks = vi.hoisted(() => ({
    close: vi.fn(),
    connectOpenRouter: vi.fn(),
    discoverAiModelDetailsDraft: vi.fn(),
    discoverAiModelsDraft: vi.fn(),
    emit: vi.fn(async () => {}),
    getAppUpdateChannel: vi.fn(async () => "SystemManaged"),
    getAiConfiguration: vi.fn(),
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
    showCommitGraphButton: false,
    enableLocalCopy: false,
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
    linuxTerminalEmulator: "auto",
    linuxTerminalCustomCommand: "",
    repoOpenBehaviour: "Ask",
    gitExecutablePath: "",
    gpgKeyserverVerificationEnabled: false,
    extensions: {ai: {
        enabled: false,
        selectedProfileId: "",
        profiles: [],
        commitContextLimitKib: 24,
        conflictContextLimitKib: 48,
        commitMessageMaxTokens: 512,
        conflictResolutionMaxTokens: 4096,
        commitMessagePrompt: "Write a concise commit message.",
        conflictResolutionPrompt: "Resolve the conflict.",
        includeCommitHistory: true,
        globalExclusions: [],
        consentedDestinations: [],
        repositoryPolicies: {},
        usageHistory: [],
    }},
};

const defaultInvoke = async (command: string) => {
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
        case "set_show_commit_graph_button":
        case "set_enable_local_copy":
        case "set_persistent_error_toasts":
        case "set_error_toast_clear_delay_ms":
        case "set_git_executable_path":
        case "set_gpg_keyserver_verification_enabled":
        case "set_ai_commit_context_limit_kib":
        case "set_ai_conflict_context_limit_kib":
        case "set_ai_commit_message_max_tokens":
        case "set_ai_conflict_resolution_max_tokens":
        case "set_ai_commit_message_prompt":
        case "set_ai_conflict_resolution_prompt":
        case "set_linux_graphics_mode":
        case "set_linux_terminal_emulator":
        case "set_linux_terminal_custom_command":
        case "set_repo_open_behaviour":
            return settings;
        default:
            return null;
    }
};

mocks.invoke.mockImplementation(defaultInvoke);

vi.mock("@tauri-apps/api/core", () => ({invoke: mocks.invoke}));
vi.mock("@tauri-apps/api/event", () => ({emit: mocks.emit}));
vi.mock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({close: mocks.close}),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({open: mocks.openDialog}));
vi.mock("@tauri-apps/plugin-opener", () => ({openPath: mocks.openPath}));
vi.mock("@tauri-apps/plugin-os", () => ({platform: () => "linux"}));
vi.mock("../../api/commands", () => ({
    clearAiApiKey: vi.fn(async () => ({
        provider: "Disabled", endpoint: "", model: "", reasoningPreference: "Automatic",
        effortCapability: {status: "unknown"}, hasApiKey: false, configured: false, insecureTransport: false,
    })),
    connectOpenRouter: mocks.connectOpenRouter,
    getAiConfiguration: mocks.getAiConfiguration,
    getAppUpdateChannel: mocks.getAppUpdateChannel,
    getConfigFilePath: vi.fn(async () => "/home/conor/.config/gitmun/config.toml"),
    getConfigFolderPath: vi.fn(async () => "/home/conor/.config/gitmun"),
    getGlobalDiffToolPath: vi.fn(async () => null),
    getGlobalGpgProgramPath: vi.fn(async () => null),
    getLinuxTerminalOptions: vi.fn(async () => [
        {id: "auto", label: "Terminal"},
        {id: "ghostty", label: "Ghostty"},
        {id: "custom", label: "Terminal"},
    ]),
    discoverAiModelDetailsDraft: mocks.discoverAiModelDetailsDraft,
    discoverAiModelsDraft: mocks.discoverAiModelsDraft,
    openResultLogWindow: vi.fn(async () => {}),
    saveAiConfiguration: vi.fn(async (request) => ({
        ...request, effortCapability: {status: "unknown"}, hasApiKey: false,
        configured: false, insecureTransport: false,
        commitContextLimitKib: 24, conflictContextLimitKib: 48,
        commitMessageMaxTokens: 512, conflictResolutionMaxTokens: 4096,
        commitMessagePrompt: "Write a concise commit message.",
        conflictResolutionPrompt: "Resolve the conflict.", includeCommitHistory: true,
    })),
    setAiApiKey: vi.fn(async () => ({
        provider: "Disabled", endpoint: "", model: "", reasoningPreference: "Automatic",
        effortCapability: {status: "unknown"}, hasApiKey: true, configured: false, insecureTransport: false,
    })),
    setAiPrivacySettings: vi.fn(async () => {}),
    setGlobalDiffToolWithPath: vi.fn(async () => ({message: "Updated diff tool."})),
    setGlobalGpgProgram: vi.fn(async () => ({message: "Updated GPG executable."})),
    setUpdateEndpoint: vi.fn(async () => settings),
    testAiConnection: vi.fn(async () => ({
        effortCapability: {status: "accepted"},
        usage: {inputTokens: 1, outputTokens: 1, reasoningTokens: null},
        requestId: null,
    })),
    testAiConnectionDraft: vi.fn(async () => ({
        effortCapability: {status: "accepted"},
        usage: {inputTokens: 1, outputTokens: 1, reasoningTokens: null},
        requestId: null,
    })),
}));

import {SettingsWindow} from "./SettingsWindow";

function openAiSettings() {
    const toggle = screen.getByLabelText<HTMLInputElement>("Enable experimental AI extension");
    if (!toggle.checked) fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", {name: "AI"}));
}

describe("SettingsWindow", () => {
    beforeEach(() => {
        mocks.getAiConfiguration.mockReset();
        mocks.getAiConfiguration.mockResolvedValue({
            provider: "Disabled", endpoint: "", model: "", reasoningPreference: "Automatic",
            effortCapability: {status: "unknown"}, hasApiKey: false, configured: false, insecureTransport: false,
            commitContextLimitKib: 24, conflictContextLimitKib: 48,
            commitMessageMaxTokens: 512, conflictResolutionMaxTokens: 4096,
            commitMessagePrompt: "Write a concise commit message.",
            conflictResolutionPrompt: "Resolve the conflict.", includeCommitHistory: true,
        });
        mocks.discoverAiModelDetailsDraft.mockReset();
        mocks.discoverAiModelsDraft.mockReset();
        mocks.discoverAiModelsDraft.mockResolvedValue({models: [], page: 1, pageSize: 100, hasMore: false});
        mocks.connectOpenRouter.mockReset();
        mocks.connectOpenRouter.mockResolvedValue({
            enabled: true,
            selectedProfileId: "openrouter-profile",
            profiles: [],
            provider: "OpenRouter",
            endpoint: "https://openrouter.ai/api/v1",
            model: "",
            reasoningPreference: "Automatic",
            effortCapability: {status: "unknown"},
            commitContextLimitKib: 24,
            conflictContextLimitKib: 48,
            commitMessageMaxTokens: 512,
            conflictResolutionMaxTokens: 4096,
            commitMessagePrompt: "Write a concise commit message.",
            conflictResolutionPrompt: "Resolve the conflict.",
            includeCommitHistory: true,
            hasApiKey: true,
            credentialManagedByEnvironment: false,
            configured: false,
            insecureTransport: false,
            sources: {},
            environmentFields: [],
            consentRequired: true,
        });
        mocks.invoke.mockClear();
        mocks.invoke.mockImplementation(defaultInvoke);
        mocks.emit.mockClear();
        mocks.getAppUpdateChannel.mockClear();
        mocks.getAppUpdateChannel.mockResolvedValue("SystemManaged");
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

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows a skeleton while settings are loading", () => {
        mocks.getAppUpdateChannel.mockReturnValue(new Promise(() => {}));

        render(<SettingsWindow/>);

        expect(screen.getByText("Application")).toBeInTheDocument();
        expect(screen.getByText("Git")).toBeInTheDocument();
        expect(screen.queryByRole("button", {name: "AI"})).not.toBeInTheDocument();
        expect(screen.getByTestId("settings-skeleton")).toBeInTheDocument();
        expect(screen.queryByLabelText("Terminal")).not.toBeInTheDocument();
    });

    it("renders settings once config has loaded", async () => {
        render(<SettingsWindow/>);

        expect(await screen.findByLabelText("Terminal")).toBeInTheDocument();
        expect(screen.getByText("Experimental")).toBeInTheDocument();
        expect(screen.getByLabelText("Enable experimental AI extension")).not.toBeChecked();
        expect(screen.queryByRole("button", {name: "AI"})).not.toBeInTheDocument();
        expect(screen.queryByTestId("settings-skeleton")).not.toBeInTheDocument();
    });

    it("shows the AI settings tab only while the experimental AI extension is enabled", async () => {
        render(<SettingsWindow/>);

        const toggle = await screen.findByLabelText("Enable experimental AI extension");
        expect(screen.queryByRole("button", {name: "AI"})).not.toBeInTheDocument();

        fireEvent.click(toggle);
        expect(screen.getByRole("button", {name: "AI"})).toBeInTheDocument();

        fireEvent.click(toggle);
        expect(screen.queryByRole("button", {name: "AI"})).not.toBeInTheDocument();
    });

    it("uses the shared field styling for global AI exclusions", async () => {
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();

        expect(screen.getByLabelText("Global excluded paths")).toHaveClass(
            "settings-window__input",
            "settings-window__textarea",
        );
    });

    it("lets the user choose an AI provider, endpoint, model, and reasoning level", async () => {
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();
        fireEvent.change(screen.getByLabelText("AI provider"), {target: {value: "OpenAiCompatible"}});

        const provider = screen.getByLabelText("AI provider");
        const apiKey = screen.getByLabelText("API key");
        const endpoint = screen.getByLabelText("Base URL");
        expect(provider.compareDocumentPosition(apiKey) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(apiKey.compareDocumentPosition(endpoint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(endpoint).toHaveValue("");
        fireEvent.change(screen.getByLabelText("Model"), {target: {value: "selected-model"}});
        fireEvent.change(screen.getByLabelText("Reasoning level"), {target: {value: "High"}});
        expect(screen.getByLabelText("Model")).toHaveValue("selected-model");
        expect(screen.getByLabelText("Reasoning level")).toHaveValue("High");
    });

    it("defaults new profiles to OpenRouter and provides Bedrock regional endpoints", async () => {
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();

        const provider = screen.getByLabelText<HTMLSelectElement>("AI provider");
        expect(provider).toHaveValue("OpenRouter");
        expect(screen.getByLabelText("Base URL")).toHaveValue("https://openrouter.ai/api/v1");
        expect(Array.from(provider.options, option => option.text)).toEqual([
            "Amazon Bedrock",
            "Azure OpenAI",
            "Claude",
            "Google Gemini",
            "LM Studio",
            "Mistral",
            "Ollama",
            "OpenAI",
            "OpenAI-compatible (advanced)",
            "OpenRouter",
        ]);

        fireEvent.change(provider, {target: {value: "Bedrock"}});
        const bedrockEndpoint = screen.getByLabelText<HTMLSelectElement>("Amazon Bedrock runtime endpoint");
        expect(bedrockEndpoint).toHaveValue("https://bedrock-runtime.eu-west-2.amazonaws.com");
        expect(screen.queryByLabelText("Base URL")).not.toBeInTheDocument();

        fireEvent.change(bedrockEndpoint, {target: {value: "custom"}});
        expect(screen.getByLabelText("Custom endpoint")).toHaveValue("");
    });

    it("updates credential controls when changing or creating an AI profile", async () => {
        const profileDefaults = {
            apiStyle: "ChatCompletions",
            requestPath: "",
            modelsPath: "",
            authMode: "Bearer",
            authHeader: "",
            maxTokensField: "",
            azureDeployment: "",
            azureApiVersion: "2024-10-21",
            reasoningPreference: "Automatic",
            effortCapability: {status: "unknown"},
            openRouter: {
                privacy: "NoDataCollection",
                allowFallbacks: true,
                requireParameters: true,
                routingStrategy: "Default",
                maxPromptPrice: "",
                maxCompletionPrice: "",
                preferredProviders: [],
                allowedProviders: [],
                ignoredProviders: [],
                preferredMaxLatency: "",
                preferredMinThroughput: "",
                diagnostics: false,
            },
        };
        const profiles = [
            {
                ...profileDefaults,
                id: "openai-profile",
                name: "OpenAI profile",
                provider: "OpenAi",
                endpoint: "https://api.openai.com/v1",
                model: "gpt-5",
            },
            {
                ...profileDefaults,
                id: "claude-profile",
                name: "Claude profile",
                provider: "Claude",
                endpoint: "https://api.anthropic.com/v1",
                model: "claude-sonnet-4-5",
                authMode: "Header",
                authHeader: "x-api-key",
                maxTokensField: "max_tokens",
            },
        ];
        const configuredProfile = {
            enabled: true,
            selectedProfileId: "openai-profile",
            profiles,
            provider: "OpenAi",
            endpoint: "https://api.openai.com/v1",
            model: "gpt-5",
            reasoningPreference: "Automatic",
            effortCapability: {status: "unknown"},
            commitContextLimitKib: 24,
            conflictContextLimitKib: 48,
            commitMessageMaxTokens: 512,
            conflictResolutionMaxTokens: 4096,
            commitMessagePrompt: "Write a concise commit message.",
            conflictResolutionPrompt: "Resolve the conflict.",
            includeCommitHistory: true,
            hasApiKey: true,
            credentialManagedByEnvironment: false,
            configured: true,
            insecureTransport: false,
            sources: {},
            environmentFields: [],
            consentRequired: false,
        };
        mocks.getAiConfiguration
            .mockResolvedValueOnce(configuredProfile)
            .mockResolvedValueOnce({
                ...configuredProfile,
                selectedProfileId: "claude-profile",
                provider: "Claude",
                endpoint: "https://api.anthropic.com/v1",
                model: "claude-sonnet-4-5",
                hasApiKey: false,
                configured: false,
            });

        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();
        expect(screen.getByRole("button", {name: "Replace key"})).toBeInTheDocument();
        fireEvent.change(screen.getByLabelText("Profile"), {target: {value: "claude-profile"}});

        expect(screen.getByRole("button", {name: "Store key"})).toBeInTheDocument();
        expect(screen.queryByRole("button", {name: "Clear API key"})).not.toBeInTheDocument();
        await waitFor(() => expect(mocks.getAiConfiguration).toHaveBeenLastCalledWith("claude-profile"));

        fireEvent.click(screen.getByRole("button", {name: "New profile"}));
        expect(screen.getByRole("button", {name: "Store key"})).toBeInTheDocument();
        expect(screen.queryByRole("button", {name: "Clear API key"})).not.toBeInTheDocument();
    });

    it("formats OpenRouter model prices and performance with matching filter units", async () => {
        mocks.discoverAiModelsDraft.mockResolvedValueOnce({
            models: [{
                id: "nvidia/nemotron-3-ultra-550b-a55b",
                canonicalSlug: "nvidia/nemotron-3-ultra-550b-a55b",
                name: "NVIDIA: Nemotron 3 Ultra",
                description: null,
                contextLength: 512288,
                maximumCompletionTokens: null,
                inputModalities: ["text"],
                outputModalities: ["text"],
                supportedParameters: ["reasoning", "response_format"],
                promptPrice: "0.0000005",
                completionPrice: "0.0000022",
                requestPrice: null,
                cacheReadPrice: null,
                cacheWritePrice: null,
                reasoning: true,
                structuredOutput: true,
                availableProviders: [],
                quantisations: [],
                latency: 0.28,
                throughput: 74.25,
                uptime: 99.93280607445571,
                codingScore: null,
                zeroDataRetention: null,
                created: null,
            }],
            page: 1,
            pageSize: 100,
            hasMore: false,
        });
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();
        fireEvent.change(screen.getByLabelText("AI provider"), {target: {value: "OpenRouter"}});
        const modelSearch = screen.getByLabelText("Model catalogue");
        const discoverModels = screen.getByRole("button", {name: "Discover models"});
        expect(modelSearch.parentElement).toBe(discoverModels.parentElement);
        fireEvent.click(screen.getByText("Filters"));
        const programmingFilter = screen.getByRole("button", {name: "Programming models only"});
        expect(programmingFilter).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(programmingFilter);
        expect(programmingFilter).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByText("1 active")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", {name: "Allow provider fallback"}).parentElement).toHaveClass("settings-window__switch");
        fireEvent.change(screen.getByLabelText("Maximum input price per million tokens"), {target: {value: "0.50"}});
        fireEvent.change(screen.getByLabelText("Maximum output price per million tokens"), {target: {value: "2.20"}});
        expect(screen.getByText("3 active")).toBeInTheDocument();
        fireEvent.click(discoverModels);

        expect(await screen.findByText("512,288 context tokens · reasoning · structured output")).toBeInTheDocument();
        expect(screen.getByText("Input $0.50 / 1M tokens · output $2.20 / 1M tokens")).toBeInTheDocument();
        expect(screen.getByText("Latency 0.28 s · throughput 74.3 tok/s · uptime 99.93%")).toBeInTheDocument();
        expect(mocks.discoverAiModelsDraft).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                programmingOnly: true,
                maximumPromptPrice: 0.0000005,
                maximumCompletionPrice: 0.0000022,
            }),
        );
    });

    it("connects an OpenRouter profile through the browser OAuth flow", async () => {
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();
        fireEvent.change(screen.getByLabelText("AI provider"), {target: {value: "OpenRouter"}});
        fireEvent.click(screen.getByRole("button", {name: "Sign in with OpenRouter"}));

        await waitFor(() => {
            expect(mocks.connectOpenRouter).toHaveBeenCalledWith(
                "OpenRouter authorisation was received. Return to Gitmun to finish connecting.",
            );
        });
        expect(screen.getByText("Connected the current profile to OpenRouter.")).toBeInTheDocument();
        const reconnectButton = screen.getByRole("button", {name: "Reconnect OpenRouter"});
        const apiKeyInput = screen.getByLabelText("API key");
        const replaceButton = screen.getByRole("button", {name: "Replace key"});
        const clearButton = screen.getByRole("button", {name: "Clear API key"});
        expect(reconnectButton.parentElement).toHaveClass("settings-window__credential-sign-in");
        expect(screen.getByText("or use an API key")).toBeInTheDocument();
        expect(apiKeyInput.parentElement).toHaveClass("settings-window__credential-entry");
        expect(replaceButton.parentElement).toBe(apiKeyInput.parentElement);
        expect(clearButton.parentElement).toHaveClass("settings-window__credential-footer");
        expect(apiKeyInput).toHaveValue("");
    });

    it("tests a loopback OpenAI-compatible endpoint without an API key", async () => {
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();
        fireEvent.change(screen.getByLabelText("AI provider"), {target: {value: "OpenAiCompatible"}});
        fireEvent.change(screen.getByLabelText("Model"), {target: {value: "gemma4:latest"}});
        expect(screen.getByText("Test connection")).toBeDisabled();

        fireEvent.change(screen.getByLabelText("Base URL"), {
            target: {value: "http://127.0.0.1:11434/v1"},
        });

        expect(screen.getByText("No API key is required for this local endpoint.")).toBeInTheDocument();
        expect(screen.getByText("Test connection")).toBeEnabled();
        fireEvent.click(screen.getByText("Test connection"));
        expect(await screen.findByText("AI connection succeeded (2 reported tokens).")).toBeInTheDocument();
    });

    it("loads, warns about, clamps, and saves AI context limits", async () => {
        render(<SettingsWindow/>);
        await screen.findByLabelText("Terminal");

        openAiSettings();
        fireEvent.change(screen.getByLabelText("AI provider"), {target: {value: "OpenAiCompatible"}});

        const commitLimit = screen.getByLabelText("Commit message context limit (KiB)");
        const conflictLimit = screen.getByLabelText("Conflict resolution context limit (KiB)");
        const commitMaxTokens = screen.getByLabelText("Commit message output limit (tokens)");
        const conflictMaxTokens = screen.getByLabelText("Conflict resolution output limit (tokens)");
        expect(commitLimit).toHaveValue(24);
        expect(conflictLimit).toHaveValue(48);
        expect(commitMaxTokens).toHaveValue(512);
        expect(conflictMaxTokens).toHaveValue(4096);
        const commitPrompt = screen.getByLabelText("Commit message prompt");
        const conflictPrompt = screen.getByLabelText("Conflict resolution prompt");
        expect(commitPrompt).toHaveValue("Write a concise commit message.");
        expect(conflictPrompt).toHaveValue("Resolve the conflict.");

        fireEvent.change(commitLimit, {target: {value: "300"}});
        expect(screen.getByText(/Large limits may increase provider costs/)).toBeInTheDocument();
        fireEvent.change(conflictLimit, {target: {value: "5000"}});
        fireEvent.blur(conflictLimit);
        expect(conflictLimit).toHaveValue(1024);
        fireEvent.change(commitMaxTokens, {target: {value: "1024"}});
        fireEvent.change(conflictMaxTokens, {target: {value: "100000"}});
        fireEvent.blur(conflictMaxTokens);
        expect(conflictMaxTokens).toHaveValue(65536);
        fireEvent.change(commitPrompt, {target: {value: "Match our release style."}});
        fireEvent.change(conflictPrompt, {target: {value: "Preserve both intended changes."}});

        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_ai_commit_context_limit_kib", {
                aiCommitContextLimitKib: 300,
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_ai_conflict_context_limit_kib", {
                aiConflictContextLimitKib: 1024,
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_ai_commit_message_max_tokens", {
                aiCommitMessageMaxTokens: 1024,
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_ai_conflict_resolution_max_tokens", {
                aiConflictResolutionMaxTokens: 65536,
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_ai_commit_message_prompt", {
                aiCommitMessagePrompt: "Match our release style.",
            });
            expect(mocks.invoke).toHaveBeenCalledWith("set_ai_conflict_resolution_prompt", {
                aiConflictResolutionPrompt: "Preserve both intended changes.",
            });
        });
    });

    it("loads the commit graph button setting off by default and saves changes", async () => {
        render(<SettingsWindow/>);

        const toggle = await screen.findByLabelText("Show commit graph button");
        expect(toggle).not.toBeChecked();

        fireEvent.click(toggle);
        await waitFor(() => expect(toggle).toBeChecked());
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_show_commit_graph_button", {
                showCommitGraphButton: true,
            });
            expect(mocks.emit).toHaveBeenCalledWith("settings-updated", settings);
        });
    });

    it("loads Local Copy off by default and saves changes", async () => {
        render(<SettingsWindow/>);

        const toggle = await screen.findByLabelText("Enable Local Copy");
        expect(toggle).not.toBeChecked();

        fireEvent.click(toggle);
        await waitFor(() => expect(toggle).toBeChecked());
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_enable_local_copy", {
                enableLocalCopy: true,
            });
        });
    });

    it("shows an error when settings fail to load", async () => {
        const loadError = new Error("config unavailable");
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        mocks.invoke.mockImplementation((command: string) => {
            if (command === "get_settings") {
                return Promise.reject(loadError);
            }

            return defaultInvoke(command);
        });

        render(<SettingsWindow/>);

        expect(await screen.findByRole("alert")).toHaveTextContent("Settings could not be loaded");
        expect(screen.getByRole("button", {name: "Retry"})).toBeInTheDocument();
        expect(screen.queryByTestId("settings-skeleton")).not.toBeInTheDocument();
        expect(consoleError).toHaveBeenCalledWith("Failed to load settings", loadError);
    });

    it("retries loading settings when retry is clicked", async () => {
        const loadError = new Error("config unavailable");
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
        let getSettingsCalls = 0;
        mocks.invoke.mockImplementation((command: string) => {
            if (command === "get_settings") {
                getSettingsCalls += 1;
                if (getSettingsCalls === 1) {
                    return Promise.reject(loadError);
                }
            }

            return defaultInvoke(command);
        });

        render(<SettingsWindow/>);

        fireEvent.click(await screen.findByRole("button", {name: "Retry"}));

        expect(await screen.findByLabelText("Terminal")).toBeInTheDocument();
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
        expect(getSettingsCalls).toBe(2);
        expect(consoleError).toHaveBeenCalledWith("Failed to load settings", loadError);
    });

    it("shows the Linux custom terminal command only for Custom", async () => {
        render(<SettingsWindow/>);

        expect(await screen.findByLabelText("Terminal")).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("my-terminal --working-directory {path}")).not.toBeInTheDocument();

        fireEvent.change(screen.getByLabelText("Terminal"), {target: {value: "custom"}});

        expect(screen.getByPlaceholderText("my-terminal --working-directory {path}")).toBeInTheDocument();
    });

    it("saves Linux terminal settings", async () => {
        render(<SettingsWindow/>);

        fireEvent.change(await screen.findByLabelText("Terminal"), {target: {value: "custom"}});
        fireEvent.change(screen.getByPlaceholderText("my-terminal --working-directory {path}"), {
            target: {value: "kitty --directory {path}"},
        });
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_linux_terminal_emulator", {
                linuxTerminalEmulator: "custom",
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

    it("loads and saves GPG keyserver verification", async () => {
        render(<SettingsWindow/>);

        fireEvent.click(screen.getByText("Git"));
        const toggle = await screen.findByLabelText("Fetch missing GPG public keys during verification");
        expect(toggle).not.toBeChecked();

        fireEvent.click(toggle);
        fireEvent.click(screen.getByText("Save"));

        await waitFor(() => {
            expect(mocks.invoke).toHaveBeenCalledWith("set_gpg_keyserver_verification_enabled", {
                enabled: true,
            });
        });
    });
});
