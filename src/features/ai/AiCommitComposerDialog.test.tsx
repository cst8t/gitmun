// @vitest-environment jsdom
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import "../../i18n";
import {AiCommitComposerDialog} from "./AiCommitComposerDialog";

const generateAiCommitMessages = vi.fn();
const getAiCommitContextPreview = vi.fn();
const getAiRepositoryPolicy = vi.fn();
const setAiRepositoryPolicy = vi.fn();

const repositoryPolicy = {
    exclusions: ["vendor/**"],
    includeCommitHistory: null,
    conventionalCommits: true,
    commitMessageMode: "ConventionalCommits" as const,
    defaultCommitType: "docs",
    defaultCommitScope: "ai",
    defaultLanguage: "British English",
    commitPromptFile: ".gitmun/commit-prompt.txt",
    conflictPromptFile: ".gitmun/conflict-prompt.txt",
};

vi.mock("./commands", () => ({
    cancelAiOperation: vi.fn(async () => {}),
    generateAiCommitMessages: (...args: unknown[]) => generateAiCommitMessages(...args),
    getAiCommitContextPreview: (...args: unknown[]) => getAiCommitContextPreview(...args),
    getAiConfiguration: vi.fn(async () => ({consentRequired: false})),
    getAiRepositoryPolicy: (...args: unknown[]) => getAiRepositoryPolicy(...args),
    grantAiConsent: vi.fn(async () => {}),
    setAiRepositoryPolicy: (...args: unknown[]) => setAiRepositoryPolicy(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async () => () => {}),
}));

describe("AiCommitComposerDialog", () => {
    beforeEach(() => {
        generateAiCommitMessages.mockReset();
        generateAiCommitMessages.mockResolvedValue({
            candidates: [
                {message: "First candidate", requestId: "first"},
                {message: "Second candidate", requestId: "second"},
            ],
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
        getAiRepositoryPolicy.mockReset();
        getAiRepositoryPolicy.mockResolvedValue(repositoryPolicy);
        setAiRepositoryPolicy.mockReset();
        setAiRepositoryPolicy.mockResolvedValue(undefined);
    });

    it("explains when source context will be summarised to meet the request limit", async () => {
        getAiCommitContextPreview.mockResolvedValueOnce({
            provider: "OpenRouter",
            destinationAuthority: "https://openrouter.ai",
            task: "commitMessage",
            files: Array.from({length: 46}, (_, index) => `src/file-${index}.ts`),
            contextSizeKib: 566,
            contextLimitKib: 512,
            includesCommitHistory: true,
        });
        render(<AiCommitComposerDialog
            repoPath="/work/repository"
            subjectLimit={72}
            workflow="Normal"
            existingMessage=""
            otherBusy={false}
            onAccept={vi.fn(async () => true)}
            onClose={vi.fn()}
            onBusyChange={vi.fn()}
        />);

        expect(await screen.findByText(
            "566 KiB of source context. Gitmun will summarise it to fit the 512 KiB per-request limit.",
        )).toBeInTheDocument();
        const filesSummary = screen.getByText("46 files included");
        fireEvent.click(filesSummary);
        expect(filesSummary.closest("details")).toHaveClass("ai-context-preview__files");
        expect(screen.getByRole("list")).toBeVisible();
    });

    it("uses the shared close icon in its centred close control", async () => {
        render(<AiCommitComposerDialog
            repoPath="/work/repository"
            subjectLimit={72}
            workflow="Normal"
            existingMessage=""
            otherBusy={false}
            onAccept={vi.fn(async () => true)}
            onClose={vi.fn()}
            onBusyChange={vi.fn()}
        />);

        await screen.findByText("OpenRouter via https://openrouter.ai");
        const closeButton = screen.getByRole("button", {name: "Close AI dialog"});
        expect(closeButton).toHaveClass("ai-dialog__close");
        expect(closeButton.querySelector("svg")).toBeInTheDocument();
        expect(closeButton).not.toHaveTextContent("×");
    });

    it("uses selectable candidate cards without native radio controls", async () => {
        render(<AiCommitComposerDialog
            repoPath="/work/repository"
            subjectLimit={72}
            workflow="Normal"
            existingMessage=""
            otherBusy={false}
            onAccept={vi.fn(async () => true)}
            onClose={vi.fn()}
            onBusyChange={vi.fn()}
        />);

        await screen.findByText("OpenRouter via https://openrouter.ai");
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        const firstCandidate = await screen.findByRole("button", {name: /Candidate 1/});
        const secondCandidate = screen.getByRole("button", {name: /Candidate 2/});
        expect(screen.queryByRole("radio")).not.toBeInTheDocument();
        expect(firstCandidate).toHaveAttribute("aria-pressed", "true");
        expect(secondCandidate).toHaveAttribute("aria-pressed", "false");

        fireEvent.click(secondCandidate);

        expect(firstCandidate).toHaveAttribute("aria-pressed", "false");
        expect(secondCandidate).toHaveAttribute("aria-pressed", "true");
    });

    it("does not show a selection control for a single candidate", async () => {
        generateAiCommitMessages.mockResolvedValueOnce({
            candidates: [{message: "Only candidate", requestId: "only"}],
        });
        render(<AiCommitComposerDialog
            repoPath="/work/repository"
            subjectLimit={72}
            workflow="Normal"
            existingMessage=""
            otherBusy={false}
            onAccept={vi.fn(async () => true)}
            onClose={vi.fn()}
            onBusyChange={vi.fn()}
        />);

        await screen.findByText("OpenRouter via https://openrouter.ai");
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        expect(await screen.findByText("Only candidate")).toBeInTheDocument();
        expect(screen.queryByRole("radio")).not.toBeInTheDocument();
        expect(screen.queryByRole("button", {name: /Candidate 1/})).not.toBeInTheDocument();
    });

    it("disables generate while another AI operation is busy", async () => {
        render(<AiCommitComposerDialog
            repoPath="/work/repository"
            subjectLimit={72}
            workflow="Normal"
            existingMessage=""
            otherBusy={true}
            onAccept={vi.fn(async () => true)}
            onClose={vi.fn()}
            onBusyChange={vi.fn()}
        />);

        await screen.findByText("OpenRouter via https://openrouter.ai");
        expect(screen.getByRole("button", {name: "Generate"})).toBeDisabled();
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));
        expect(generateAiCommitMessages).not.toHaveBeenCalled();
    });

    it("loads and saves repository composer defaults without replacing the rest of the policy", async () => {
        render(<AiCommitComposerDialog
            repoPath="/work/repository"
            subjectLimit={72}
            workflow="Normal"
            existingMessage=""
            otherBusy={false}
            onAccept={vi.fn(async () => true)}
            onClose={vi.fn()}
            onBusyChange={vi.fn()}
        />);

        await waitFor(() => {
            expect(screen.getByLabelText("Style")).toHaveValue("ConventionalCommits");
        });
        expect(screen.getByLabelText("Type")).toHaveValue("docs");
        expect(screen.getByLabelText("Scope")).toHaveValue("ai");
        expect(screen.getByLabelText("Language")).toHaveValue("British English");

        fireEvent.change(screen.getByLabelText("Type"), {target: {value: "feat"}});
        fireEvent.change(screen.getByLabelText("Scope"), {target: {value: "composer"}});
        fireEvent.change(screen.getByLabelText("Language"), {target: {value: "English"}});
        fireEvent.click(screen.getByRole("button", {name: "Save as repository defaults"}));

        expect(setAiRepositoryPolicy).toHaveBeenCalledWith("/work/repository", {
            ...repositoryPolicy,
            conventionalCommits: true,
            commitMessageMode: "ConventionalCommits",
            defaultCommitType: "feat",
            defaultCommitScope: "composer",
            defaultLanguage: "English",
        });
        expect(await screen.findByText("Repository commit defaults saved")).toBeInTheDocument();
    });
});
