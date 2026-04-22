// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CommitBox } from "./CommitBox";
import type { CommitPrimaryAction } from "../../types";

function renderCommitBox(selectedAction: CommitPrimaryAction = "commit") {
  const onCommit = vi.fn();
  const onSelectAction = vi.fn();

  const view = render(
    <CommitBox
      stagedCount={2}
      selectedAction={selectedAction}
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
});
