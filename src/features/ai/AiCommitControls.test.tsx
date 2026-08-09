// @vitest-environment jsdom
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {ask} from "@tauri-apps/plugin-dialog";
import "../../i18n";
import {AiCommitControls} from "./AiCommitControls";

const cancelAiOperation = vi.fn();
const generateAiCommitMessages = vi.fn();
const getAiCommitContextPreview = vi.fn();
const getAiConfiguration = vi.fn();
const getAiRepositoryPolicy = vi.fn();
const grantAiConsent = vi.fn();

vi.mock("./commands", () => ({
    cancelAiOperation: (...args: unknown[]) => cancelAiOperation(...args),
    generateAiCommitMessages: (...args: unknown[]) => generateAiCommitMessages(...args),
    getAiCommitContextPreview: (...args: unknown[]) => getAiCommitContextPreview(...args),
    getAiConfiguration: (...args: unknown[]) => getAiConfiguration(...args),
    getAiRepositoryPolicy: (...args: unknown[]) => getAiRepositoryPolicy(...args),
    grantAiConsent: (...args: unknown[]) => grantAiConsent(...args),
    setAiRepositoryPolicy: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ask: vi.fn()}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async () => () => {}),
}));

const defaultPolicy = {
    exclusions: [],
    includeCommitHistory: null,
    conventionalCommits: true,
    commitMessageMode: null,
    defaultCommitType: "docs",
    defaultCommitScope: "ai",
    defaultLanguage: "British English",
    commitPromptFile: "",
    conflictPromptFile: "",
};

function renderControls(overrides: Partial<React.ComponentProps<typeof AiCommitControls>> = {}) {
    const props: React.ComponentProps<typeof AiCommitControls> = {
        enabled: true,
        configured: true,
        repoPath: "/work/repository",
        stagedCount: 2,
        subjectLimit: 72,
        workflow: "Normal",
        existingMessage: "",
        disabled: false,
        canUndo: false,
        onApplyMessage: vi.fn(),
        onUndo: vi.fn(),
        onConfigure: vi.fn(),
        onBusyChange: vi.fn(),
        ...overrides,
    };
    return {props, ...render(<AiCommitControls {...props}/>)};
}

describe("AiCommitControls", () => {
    beforeEach(() => {
        cancelAiOperation.mockReset();
        cancelAiOperation.mockResolvedValue(undefined);
        generateAiCommitMessages.mockReset();
        generateAiCommitMessages.mockResolvedValue({
            candidates: [{message: "docs(ai): add quick generation"}],
        });
        getAiCommitContextPreview.mockReset();
        getAiCommitContextPreview.mockResolvedValue({
            provider: "OpenRouter",
            destinationAuthority: "https://openrouter.ai",
            task: "commitMessage",
            files: ["src/example.ts"],
            contextSizeKib: 2,
            contextLimitKib: 24,
            includesCommitHistory: true,
        });
        getAiConfiguration.mockReset();
        getAiConfiguration.mockResolvedValue({consentRequired: false});
        getAiRepositoryPolicy.mockReset();
        getAiRepositoryPolicy.mockResolvedValue(defaultPolicy);
        grantAiConsent.mockReset();
        grantAiConsent.mockResolvedValue(undefined);
        vi.mocked(ask).mockReset();
        vi.mocked(ask).mockResolvedValue(true);
    });

    it("hides all controls when the extension is disabled", () => {
        renderControls({enabled: false});

        expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("shows only configuration when the extension is enabled but unavailable", () => {
        const onConfigure = vi.fn();
        renderControls({configured: false, onConfigure});

        fireEvent.click(screen.getByRole("button", {name: "Configure AI"}));

        expect(onConfigure).toHaveBeenCalledOnce();
        expect(screen.queryByRole("button", {name: "AI commit message options"})).not.toBeInTheDocument();
    });

    it("uses quick generation as the primary action and keeps the composer in its menu", async () => {
        renderControls();

        expect(screen.getByRole("button", {name: "Generate"})).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", {name: "AI commit message options"}));
        fireEvent.click(screen.getByRole("menuitem", {name: "Open composer..."}));

        expect(await screen.findByRole("dialog", {name: "Generate commit message"})).toBeInTheDocument();
    });

    it("generates one message with the effective repository defaults", async () => {
        const onApplyMessage = vi.fn();
        renderControls({onApplyMessage});

        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        await waitFor(() => expect(onApplyMessage).toHaveBeenCalledWith(
            "docs(ai): add quick generation",
        ));
        expect(generateAiCommitMessages).toHaveBeenCalledWith(expect.objectContaining({
            repoPath: "/work/repository",
            subjectLimit: 72,
            candidateCount: 1,
            mode: "ConventionalCommits",
            commitType: "docs",
            scope: "ai",
            language: "British English",
            issueKey: "",
            additionalInstruction: "",
            workflow: "Normal",
            existingMessage: "",
        }));
    });

    it("confirms existing text before collecting context", async () => {
        vi.mocked(ask).mockResolvedValueOnce(false);
        renderControls({existingMessage: "Keep this message"});

        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        await waitFor(() => expect(ask).toHaveBeenCalledOnce());
        expect(getAiCommitContextPreview).not.toHaveBeenCalled();
        expect(generateAiCommitMessages).not.toHaveBeenCalled();
    });

    it("requires destination consent before generation", async () => {
        getAiConfiguration.mockResolvedValueOnce({consentRequired: true});
        renderControls();

        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        await waitFor(() => expect(grantAiConsent).toHaveBeenCalledOnce());
        expect(grantAiConsent.mock.invocationCallOrder[0]).toBeLessThan(
            generateAiCommitMessages.mock.invocationCallOrder[0],
        );
    });

    it("does not generate when destination consent is refused", async () => {
        getAiConfiguration.mockResolvedValueOnce({consentRequired: true});
        vi.mocked(ask).mockResolvedValueOnce(false);
        renderControls();

        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        await waitFor(() => expect(ask).toHaveBeenCalledOnce());
        expect(grantAiConsent).not.toHaveBeenCalled();
        expect(generateAiCommitMessages).not.toHaveBeenCalled();
    });

    it("does not generate when cancelled while destination consent is being saved", async () => {
        let finishConsent: (() => void) | undefined;
        getAiConfiguration.mockResolvedValueOnce({consentRequired: true});
        grantAiConsent.mockReturnValueOnce(new Promise<void>(resolve => {
            finishConsent = resolve;
        }));
        renderControls();

        fireEvent.click(screen.getByRole("button", {name: "Generate"}));
        await waitFor(() => expect(grantAiConsent).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole("button", {name: "Cancel"}));
        finishConsent?.();

        await waitFor(() => expect(screen.getByRole("button", {name: "Generate"})).toBeInTheDocument());
        expect(generateAiCommitMessages).not.toHaveBeenCalled();
    });

    it("omits saved type and scope outside Conventional Commit mode", async () => {
        getAiRepositoryPolicy.mockResolvedValueOnce({
            ...defaultPolicy,
            conventionalCommits: false,
            commitMessageMode: "FreeForm",
        });
        renderControls();

        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        await waitFor(() => expect(generateAiCommitMessages).toHaveBeenCalledWith(
            expect.objectContaining({
                mode: "FreeForm",
                commitType: "",
                scope: "",
            }),
        ));
    });

    it("cancels and ignores the result when the editor changes during generation", async () => {
        let finishGeneration: ((result: {candidates: Array<{message: string}>}) => void) | undefined;
        generateAiCommitMessages.mockReturnValueOnce(new Promise(resolve => {
            finishGeneration = resolve;
        }));
        const onApplyMessage = vi.fn();
        const view = renderControls({onApplyMessage});
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));
        await waitFor(() => expect(generateAiCommitMessages).toHaveBeenCalledOnce());

        view.rerender(<AiCommitControls {...view.props} existingMessage="Typed while waiting"/>);

        await waitFor(() => expect(cancelAiOperation).toHaveBeenCalledOnce());
        finishGeneration?.({candidates: [{message: "Late response"}]});
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
            "The commit message changed while Gitmun was generating. Generate again.",
        ));
        expect(onApplyMessage).not.toHaveBeenCalled();
    });

    it("allows an active quick request to be cancelled", async () => {
        generateAiCommitMessages.mockReturnValueOnce(new Promise(() => {}));
        renderControls();
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));
        const cancelButton = await screen.findByRole("button", {name: "Cancel"});

        fireEvent.click(cancelButton);

        await waitFor(() => expect(cancelAiOperation).toHaveBeenCalledOnce());
        expect(screen.getByRole("button", {name: "Generate"})).toBeInTheDocument();
    });

    it("cancels generation when the staged file count drops to zero", async () => {
        generateAiCommitMessages.mockReturnValueOnce(new Promise(() => {}));
        const view = renderControls();
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));
        await waitFor(() => expect(generateAiCommitMessages).toHaveBeenCalledOnce());

        view.rerender(<AiCommitControls {...view.props} stagedCount={0}/>);

        await waitFor(() => expect(cancelAiOperation).toHaveBeenCalledOnce());
    });

    it("exposes undo after insertion", async () => {
        const onApplyMessage = vi.fn();
        const onUndo = vi.fn();
        const view = renderControls({onApplyMessage, onUndo});
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));
        await waitFor(() => expect(onApplyMessage).toHaveBeenCalledOnce());

        view.rerender(<AiCommitControls {...view.props} canUndo/>);
        fireEvent.click(screen.getByRole("button", {name: "Undo AI message"}));

        expect(onUndo).toHaveBeenCalledOnce();
    });
});
