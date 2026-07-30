// @vitest-environment jsdom
import {fireEvent, render, screen, waitFor} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import "../../i18n";
import {AiConflictProposalDialog} from "./AiConflictProposalDialog";
import type {AiConflictOperation, AiConflictProposalResult} from "./types";

const proposal: AiConflictProposalResult = {
    proposalId: "proposal-1",
    filePath: "docs/reports/inspection-report.txt",
    regions: [
        {
            id: "region-1",
            original: "<<<<<<< HEAD\nOurs\n=======\nTheirs\n>>>>>>> branch",
            ours: "Ours",
            theirs: "Theirs",
            ancestor: null,
            proposed: "Proposed one",
            explanation: "The first proposal keeps the current status.",
        },
        {
            id: "region-2",
            original: "<<<<<<< HEAD\nCurrent\n||||||| base\nBase\n=======\nIncoming\n>>>>>>> branch",
            ours: "Current",
            theirs: "Incoming",
            ancestor: "Base",
            proposed: "Proposed two",
            explanation: null,
        },
    ],
    usage: {
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        cachedTokens: null,
        cost: null,
        byok: null,
    },
    requestId: null,
    generationId: null,
    routedProvider: null,
    routedModel: null,
};

const secondProposal: AiConflictProposalResult = {
    ...proposal,
    proposalId: "proposal-2",
    filePath: "src/payment.ts",
    regions: [{
        ...proposal.regions[0],
        id: "payment-region",
        proposed: "Payment proposal",
        explanation: null,
    }],
};

function renderDialog(operation: AiConflictOperation = null, overrides: Partial<React.ComponentProps<typeof AiConflictProposalDialog>> = {}) {
    const props: React.ComponentProps<typeof AiConflictProposalDialog> = {
        items: [{status: "ready", filePath: proposal.filePath, proposal}],
        operation,
        onApply: vi.fn(async (_proposalId, regionIds) => ({
            filePath: proposal.filePath,
            resolvedRegions: regionIds.length,
            markedResolved: true,
        })),
        onRegenerate: vi.fn(async () => {}),
        onRetry: vi.fn(async () => {}),
        onUndo: vi.fn(async () => {}),
        onClose: vi.fn(),
        ...overrides,
    };
    return {props, ...render(<AiConflictProposalDialog {...props}/>)};
}

describe("AiConflictProposalDialog", () => {
    it("uses tabs to switch between explicit region comparisons", () => {
        renderDialog();

        expect(screen.getByText("docs/reports/inspection-report.txt")).toHaveClass("ai-conflict-dialog__path");
        expect(screen.getByRole("tablist", {name: "Conflict regions"})).toBeInTheDocument();
        expect(screen.getByRole("tab", {name: "Region 1, selected"})).toHaveAttribute("aria-selected", "true");
        expect(screen.getByRole("tab", {name: "Region 2, selected"})).toHaveAttribute("aria-selected", "false");
        expect(screen.getByText("Original conflict").closest("section")).toHaveClass(
            "ai-conflict-version--original",
        );
        expect(screen.getByRole("heading", {name: "Ours"}).closest("section")).toHaveClass("ai-conflict-version--ours");
        expect(screen.getByRole("heading", {name: "Theirs"}).closest("section")).toHaveClass("ai-conflict-version--theirs");
        expect(screen.queryByText("Ancestor")).not.toBeInTheDocument();
        expect(screen.getByText("Proposed resolution").closest("section")).toHaveClass(
            "ai-conflict-version--proposed",
        );

        const firstCheckbox = screen.getByRole("checkbox", {name: "Conflict region 1"});
        expect(firstCheckbox).toBeInstanceOf(HTMLInputElement);
        expect(firstCheckbox.parentElement).toHaveClass("ai-conflict-region__checkbox");
        expect(firstCheckbox.nextElementSibling).toHaveClass("ai-conflict-region__checkbox-indicator");
        expect(firstCheckbox.nextElementSibling?.querySelector("svg")).toBeInTheDocument();
        expect(screen.getByRole("button", {name: "Regenerate region"}).closest("header")).toHaveClass(
            "ai-conflict-region__header",
        );

        fireEvent.click(screen.getByRole("tab", {name: "Region 2, selected"}));

        expect(screen.getByRole("tab", {name: "Region 2, selected"})).toHaveAttribute("aria-selected", "true");
        expect(screen.getByText("Ancestor").closest("section")).toHaveClass("ai-conflict-version--ancestor");
        expect(screen.getByText("Proposed two")).toBeInTheDocument();
        expect(screen.queryByText("Proposed one")).not.toBeInTheDocument();
    });

    it("supports keyboard navigation between region tabs", () => {
        renderDialog();
        const firstTab = screen.getByRole("tab", {name: "Region 1, selected"});
        const secondTab = screen.getByRole("tab", {name: "Region 2, selected"});

        firstTab.focus();
        fireEvent.keyDown(firstTab, {key: "ArrowRight"});

        expect(secondTab).toHaveFocus();
        expect(secondTab).toHaveAttribute("aria-selected", "true");
        expect(screen.getByText("Proposed two")).toBeInTheDocument();

        fireEvent.keyDown(secondTab, {key: "Home"});
        expect(firstTab).toHaveFocus();
        expect(firstTab).toHaveAttribute("aria-selected", "true");
    });

    it("groups proposals by file while keeping application scoped to the active file", async () => {
        const onApply = vi.fn(async (_proposalId: string, regionIds: string[]) => ({
            filePath: secondProposal.filePath,
            resolvedRegions: regionIds.length,
            markedResolved: true,
        }));
        renderDialog(null, {
            items: [
                {status: "ready", filePath: proposal.filePath, proposal},
                {status: "ready", filePath: secondProposal.filePath, proposal: secondProposal},
            ],
            onApply,
        });

        expect(screen.getByText("Reviewing 2 conflict files")).toBeInTheDocument();
        expect(screen.getByRole("complementary", {name: "Conflict files"})).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", {name: /src\/payment\.ts/}));

        expect(screen.getByText("Payment proposal")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", {name: "Apply and mark resolved"}));

        await waitFor(() => expect(onApply).toHaveBeenCalledWith("proposal-2", ["payment-region"]));
        expect(screen.getByRole("button", {name: /src\/payment\.ts.*Resolved/})).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", {name: "Next file"}));
        expect(screen.getByText("Proposed one")).toBeInTheDocument();
    });

    it("keeps a failed first file in its original position and allows retrying it", async () => {
        const onRetry = vi.fn(async () => {});
        renderDialog(null, {
            items: [
                {status: "failed", filePath: "src/checkout-policy.ts", message: "The provider returned an invalid response."},
                {status: "ready", filePath: secondProposal.filePath, proposal: secondProposal},
            ],
            onRetry,
        });

        expect(screen.getByText("Reviewing 2 conflict files")).toBeInTheDocument();
        expect(screen.getByRole("button", {name: /src\/checkout-policy\.ts.*No proposal/})).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("heading", {name: "No AI proposal was generated for this file"})).toBeInTheDocument();
        expect(screen.getByText("The provider returned an invalid response.")).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", {name: "Retry file"}));
        await waitFor(() => expect(onRetry).toHaveBeenCalledWith("src/checkout-policy.ts"));
    });

    it("uses the stable conflict-review dialog footprint", () => {
        renderDialog();

        expect(screen.getByRole("dialog", {name: "Review AI conflict proposal"})).toHaveClass(
            "ai-dialog--conflict",
        );
    });

    it("marks applied regions and permits only remaining regions to be applied", async () => {
        const onApply = vi.fn(async (_proposalId: string, regionIds: string[]) => ({
            filePath: proposal.filePath,
            resolvedRegions: regionIds[0] === "region-2" ? 2 : 1,
            markedResolved: regionIds[0] === "region-2",
        }));
        const onClose = vi.fn();
        renderDialog(null, {onApply, onClose});
        fireEvent.click(screen.getByRole("tab", {name: "Region 2, selected"}));
        let secondRegion = screen.getByRole("checkbox", {name: "Conflict region 2"});
        fireEvent.click(secondRegion);

        fireEvent.click(screen.getByRole("button", {name: "Apply selected region"}));

        await waitFor(() => expect(onApply).toHaveBeenCalledWith("proposal-1", ["region-1"]));
        expect(await screen.findByText("1 region applied")).toBeInTheDocument();
        expect(screen.getByRole("tab", {name: "Region 1, applied"})).toBeInTheDocument();
        fireEvent.click(screen.getByRole("tab", {name: "Region 1, applied"}));
        expect(screen.getByText("Applied")).toBeInTheDocument();
        expect(screen.getByRole("checkbox", {name: "Conflict region 1"})).toBeDisabled();
        fireEvent.click(screen.getByRole("tab", {name: "Region 2, not selected"}));
        secondRegion = screen.getByRole("checkbox", {name: "Conflict region 2"});
        expect(secondRegion).not.toBeDisabled();
        expect(screen.getByRole("button", {name: "Close"})).toBeInTheDocument();
        expect(screen.getByRole("button", {name: "Undo applied changes"})).toBeInTheDocument();
        for (const regenerateButton of screen.getAllByRole("button", {name: /Regenerate/})) {
            expect(regenerateButton).toBeDisabled();
        }

        fireEvent.click(secondRegion);
        fireEvent.click(screen.getByRole("button", {name: "Apply and mark resolved"}));

        await waitFor(() => expect(onApply).toHaveBeenLastCalledWith("proposal-1", ["region-2"]));
        expect(await screen.findByText("File marked resolved")).toBeInTheDocument();
        expect(screen.queryByRole("button", {name: /Apply .*selected region/})).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", {name: "Done"}));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("reports the active operation without mislabelling regeneration as application", () => {
        const onClose = vi.fn();
        const view = renderDialog("regenerate", {onClose});
        const dialog = screen.getByRole("dialog", {name: "Review AI conflict proposal"});

        expect(screen.getByText("Regenerating conflict proposal...")).toBeInTheDocument();
        expect(screen.queryByText("Applying selected regions...")).not.toBeInTheDocument();
        expect(screen.getByRole("button", {name: "Discard"})).toBeDisabled();
        fireEvent.keyDown(dialog, {key: "Escape"});
        expect(onClose).not.toHaveBeenCalled();

        view.rerender(<AiConflictProposalDialog {...view.props} operation={null}/>);
        fireEvent.keyDown(dialog, {key: "Escape"});
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", {name: "Discard"}));
        expect(onClose).toHaveBeenCalledOnce();
    });

    it("contains keyboard focus and restores the initiating control on close", () => {
        const initiatingButton = document.createElement("button");
        document.body.appendChild(initiatingButton);
        initiatingButton.focus();
        const view = renderDialog();
        const dialog = screen.getByRole("dialog", {name: "Review AI conflict proposal"});
        const firstTab = screen.getByRole("tab", {name: "Region 1, selected"});
        const applyButton = screen.getByRole("button", {name: "Apply and mark resolved"});

        expect(screen.queryByRole("button", {name: "Close AI dialog"})).not.toBeInTheDocument();
        expect(dialog).toHaveFocus();
        fireEvent.keyDown(dialog, {key: "Tab"});
        expect(firstTab).toHaveFocus();
        fireEvent.keyDown(firstTab, {key: "Tab", shiftKey: true});
        expect(applyButton).toHaveFocus();
        fireEvent.keyDown(applyButton, {key: "Tab"});
        expect(firstTab).toHaveFocus();

        view.unmount();
        expect(initiatingButton).toHaveFocus();
        initiatingButton.remove();
    });
});
