// @vitest-environment jsdom
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import "../../i18n";
import {AiWritingDialog} from "./AiWritingDialog";

const getAiConfiguration = vi.fn();
const getAiWritingContextPreview = vi.fn();
const generateAiWriting = vi.fn();
const setAiRepositoryPolicy = vi.fn();

vi.mock("./commands", () => ({
    cancelAiOperation: vi.fn(async () => {}),
    generateAiWriting: (...args: unknown[]) => generateAiWriting(...args),
    getAiConfiguration: (...args: unknown[]) => getAiConfiguration(...args),
    getAiRepositoryPolicy: vi.fn(async () => ({
        exclusions: [],
        includeCommitHistory: null,
        conventionalCommits: false,
        commitMessageMode: null,
        defaultCommitType: "",
        defaultCommitScope: "",
        defaultLanguage: "",
        commitPromptFile: "",
        conflictPromptFile: "",
    })),
    getAiWritingContextPreview: (...args: unknown[]) => getAiWritingContextPreview(...args),
    grantAiConsent: vi.fn(async () => {}),
    setAiRepositoryPolicy: (...args: unknown[]) => setAiRepositoryPolicy(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
    listen: vi.fn(async () => () => {}),
}));

describe("AiWritingDialog", () => {
    beforeEach(() => {
        getAiConfiguration.mockResolvedValue({consentRequired: false});
        getAiWritingContextPreview.mockResolvedValue({
            provider: "OpenAi",
            destinationAuthority: "api.openai.com",
            task: "stagedReview",
            files: ["src/report.ts"],
            contextSizeKib: 2,
            contextLimitKib: 24,
            includesCommitHistory: false,
        });
        generateAiWriting.mockResolvedValue({
            content: "No actionable findings.",
            usage: {},
            requestId: null,
            generationId: null,
            routedProvider: null,
            routedModel: null,
        });
        setAiRepositoryPolicy.mockReset();
        setAiRepositoryPolicy.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it("requires a context preview and keeps generated content preview-only", async () => {
        render(<AiWritingDialog repoPath="/work/repository" onClose={vi.fn()}/>);

        fireEvent.click(screen.getByText("Repository AI policy"));
        const conventionalCommits = await screen.findByRole("button", {name: "Default to Conventional Commits"});
        expect(conventionalCommits).toHaveAttribute("aria-pressed", "false");
        fireEvent.click(conventionalCommits);
        expect(conventionalCommits).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(screen.getByRole("button", {name: "Save repository policy"}));
        await waitFor(() => expect(setAiRepositoryPolicy).toHaveBeenCalledWith(
            "/work/repository",
            expect.objectContaining({
                conventionalCommits: true,
                commitMessageMode: "ConventionalCommits",
            }),
        ));
        expect(screen.getByRole("button", {name: "Generate"})).toBeDisabled();
        fireEvent.click(screen.getByRole("button", {name: "Preview context"}));

        expect(await screen.findByText("OpenAi via api.openai.com")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", {name: "Generate"}));

        expect(await screen.findByText("No actionable findings.")).toBeInTheDocument();
        await waitFor(() => {
            expect(generateAiWriting).toHaveBeenCalledWith(expect.objectContaining({
                repoPath: "/work/repository",
                task: "StagedReview",
            }));
        });
    });
});
