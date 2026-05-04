// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommitBox } from "./CommitBox";
import type { CommitPrimaryAction } from "../../types";
import "../../i18n";

function renderCommitBox(selectedAction: CommitPrimaryAction = "commit", commitMessageRecommendedLength = 72, allowCommitAndPush = true) {
  const onCommit = vi.fn();
  const onSelectAction = vi.fn();

  const view = render(
    <CommitBox
      stagedCount={2}
      selectedAction={selectedAction}
      commitMessageRecommendedLength={commitMessageRecommendedLength}
      allowCommitAndPush={allowCommitAndPush}
      onSelectAction={onSelectAction}
      onCommit={onCommit}
      isCommitting={false}
      lastCommitMessage=""
    />,
  );

  return { ...view, onCommit, onSelectAction };
}

describe("CommitBox", () => {
  it("shows Commit as the default primary action", () => {
    renderCommitBox("commit");
    expect(screen.getByRole("button", { name: "Commit (2)" })).toBeInTheDocument();
  });

  it("updates the primary action label from props", () => {
    const { rerender, onCommit, onSelectAction } = renderCommitBox("commit");

    rerender(
      <CommitBox
        stagedCount={2}
        selectedAction="commitAndPush"
        commitMessageRecommendedLength={72}
        allowCommitAndPush
        onSelectAction={onSelectAction}
        onCommit={onCommit}
        isCommitting={false}
        lastCommitMessage=""
      />,
    );

    expect(screen.getByRole("button", { name: "Commit and Push (2)" })).toBeInTheDocument();
  });

  it("calls onSelectAction when the user chooses a different default action", () => {
    const { onSelectAction } = renderCommitBox("commit");

    fireEvent.click(screen.getByRole("button", { name: "Choose commit action" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Commit and Push" }));

    expect(onSelectAction).toHaveBeenCalledWith("commitAndPush");
  });

  it("submits the selected primary action", () => {
    const { onCommit } = renderCommitBox("commitAndPush");

    fireEvent.change(screen.getByPlaceholderText("Commit message..."), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit and Push (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Ship it", false, "commitAndPush");
  });

  it("uses the configured recommended subject length", () => {
    renderCommitBox("commit", 10);

    fireEvent.change(screen.getByPlaceholderText("Commit message..."), {
      target: { value: "Long subject" },
    });

    expect(screen.getByText("Subject line exceeds 10 characters")).toBeInTheDocument();
    expect(screen.getByText("12/10")).toBeInTheDocument();
  });

  it("disables the subject length check when the recommended length is zero", () => {
    renderCommitBox("commit", 0);

    fireEvent.change(screen.getByPlaceholderText("Commit message..."), {
      target: { value: "Long subject" },
    });

    expect(screen.queryByText(/Subject line exceeds/)).not.toBeInTheDocument();
    expect(screen.queryByText("12/0")).not.toBeInTheDocument();
  });

  it("hides the action menu when commit and push is unavailable", () => {
    renderCommitBox("commitAndPush", 72, false);

    expect(screen.getByRole("button", { name: "Commit (2)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose commit action" })).not.toBeInTheDocument();
  });

  it("submits commit when commit and push is unavailable", () => {
    const { onCommit } = renderCommitBox("commitAndPush", 72, false);

    fireEvent.change(screen.getByPlaceholderText("Commit message..."), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Ship it", false, "commit");
  });
});
