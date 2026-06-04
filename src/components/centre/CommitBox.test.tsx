// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommitBox } from "./CommitBox";
import type { CommitPrimaryAction } from "../../types";
import "../../i18n";

const COMMIT_BOX_RATIO_KEY = "gitmun.commitBoxRatio";

function makeLocalStorage() {
  const store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

type RenderCommitBoxOptions = {
  selectedAction?: CommitPrimaryAction;
  commitMessageRecommendedLength?: number;
  allowCommitAndPush?: boolean;
  lastCommitMessage?: string;
  mergeMessage?: string | null;
  mergeInProgress?: boolean;
};

function renderCommitBox({
  selectedAction = "commit",
  commitMessageRecommendedLength = 72,
  allowCommitAndPush = true,
  lastCommitMessage = "",
  mergeMessage,
  mergeInProgress,
}: RenderCommitBoxOptions = {}) {
  const onCommit = vi.fn();
  const onSelectAction = vi.fn();

  const view = render(
    <div className="commit-box-test-host">
      <CommitBox
        stagedCount={2}
        selectedAction={selectedAction}
        commitMessageRecommendedLength={commitMessageRecommendedLength}
        allowCommitAndPush={allowCommitAndPush}
        onSelectAction={onSelectAction}
        onCommit={onCommit}
        isCommitting={false}
        lastCommitMessage={lastCommitMessage}
        mergeMessage={mergeMessage}
        mergeInProgress={mergeInProgress}
      />
    </div>,
  );

  return { ...view, onCommit, onSelectAction };
}

describe("CommitBox", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    localStorage.removeItem(COMMIT_BOX_RATIO_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows Commit as the default primary action", () => {
    renderCommitBox({selectedAction: "commit"});
    expect(screen.getByRole("button", { name: "Commit (2)" })).toBeInTheDocument();
  });

  it("updates the primary action label from props", () => {
    const { rerender, onCommit, onSelectAction } = renderCommitBox({selectedAction: "commit"});

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
    const { onSelectAction } = renderCommitBox({selectedAction: "commit"});

    fireEvent.click(screen.getByRole("button", { name: "Choose commit action" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Commit and Push" }));

    expect(onSelectAction).toHaveBeenCalledWith("commitAndPush");
  });

  it("submits the selected primary action", () => {
    const { onCommit } = renderCommitBox({selectedAction: "commitAndPush"});

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit and Push (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Ship it", false, "commitAndPush");
  });

  it("submits subject-only commit messages", () => {
    const { onCommit } = renderCommitBox();

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Subject" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Subject", false, "commit");
  });

  it("submits subject and body commit messages", () => {
    const { onCommit } = renderCommitBox();

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Subject" },
    });
    fireEvent.change(screen.getByPlaceholderText("Commit body..."), {
      target: { value: "Body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Subject\n\nBody", false, "commit");
  });

  it("keeps commit disabled when only the body is present", () => {
    const { onCommit } = renderCommitBox();

    fireEvent.change(screen.getByPlaceholderText("Commit body..."), {
      target: { value: "Body" },
    });

    expect(screen.getByRole("button", { name: "Commit (2)" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Commit (2)" }));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("trims outer whitespace while preserving internal body blank lines", () => {
    const { onCommit } = renderCommitBox();

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "  Subject  " },
    });
    fireEvent.change(screen.getByPlaceholderText("Commit body..."), {
      target: { value: "  Body line\n\nNext line  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Subject\n\nBody line\n\nNext line", false, "commit");
  });

  it("uses the configured recommended subject length", () => {
    renderCommitBox({selectedAction: "commit", commitMessageRecommendedLength: 10});

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Long subject" },
    });
    fireEvent.change(screen.getByPlaceholderText("Commit body..."), {
      target: { value: "This body is longer than the subject limit" },
    });

    expect(screen.getByText("Subject line exceeds 10 characters")).toBeInTheDocument();
    expect(screen.getByText("12/10")).toBeInTheDocument();
  });

  it("disables the subject length check when the recommended length is zero", () => {
    renderCommitBox({selectedAction: "commit", commitMessageRecommendedLength: 0});

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Long subject" },
    });

    expect(screen.queryByText(/Subject line exceeds/)).not.toBeInTheDocument();
    expect(screen.queryByText("12/0")).not.toBeInTheDocument();
  });

  it("hides the action menu when commit and push is unavailable", () => {
    renderCommitBox({
      selectedAction: "commitAndPush",
      commitMessageRecommendedLength: 72,
      allowCommitAndPush: false,
    });

    expect(screen.getByRole("button", { name: "Commit (2)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose commit action" })).not.toBeInTheDocument();
  });

  it("submits commit when commit and push is unavailable", () => {
    const { onCommit } = renderCommitBox({
      selectedAction: "commitAndPush",
      commitMessageRecommendedLength: 72,
      allowCommitAndPush: false,
    });

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Commit (2)" }));

    expect(onCommit).toHaveBeenCalledWith("Ship it", false, "commit");
  });

  it("keeps commit disabled until the message is present", () => {
    renderCommitBox();

    expect(screen.getByRole("button", { name: "Commit (2)" })).toBeDisabled();
    expect(screen.getByText("Message required to commit")).toBeInTheDocument();
  });

  it("prefills amend message from the latest commit", () => {
    const { onCommit } = renderCommitBox({
      lastCommitMessage: "Existing subject\n\nExisting body",
    });

    fireEvent.click(screen.getByText("Amend latest commit"));
    expect(screen.getByPlaceholderText("Amend commit subject...")).toHaveValue("Existing subject");
    expect(screen.getByPlaceholderText("Amend commit body...")).toHaveValue("Existing body");

    fireEvent.click(screen.getByRole("button", { name: "Amend (2)" }));
    expect(onCommit).toHaveBeenCalledWith("Existing subject\n\nExisting body", true, "commit");
  });

  it("prefills merge message without comment lines", () => {
    renderCommitBox({
      mergeInProgress: true,
      mergeMessage: "Merge branch 'feature'\n\nResolve conflicts\n# Please enter a commit message",
    });

    expect(screen.getByPlaceholderText("Commit subject...")).toHaveValue("Merge branch 'feature'");
    expect(screen.getByPlaceholderText("Commit body...")).toHaveValue("Resolve conflicts");
  });

  it("commits with Cmd or Ctrl Enter while the subject is focused", () => {
    const { onCommit } = renderCommitBox();

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Ship from subject" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Commit subject..."), {
      key: "Enter",
      metaKey: true,
    });

    expect(onCommit).toHaveBeenCalledWith("Ship from subject", false, "commit");
  });

  it("commits with Cmd or Ctrl Enter while the body is focused", () => {
    const { onCommit, unmount } = renderCommitBox();

    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Ship from body" },
    });
    fireEvent.change(screen.getByPlaceholderText("Commit body..."), {
      target: { value: "Body" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Commit body..."), {
      key: "Enter",
      metaKey: true,
    });

    expect(onCommit).toHaveBeenCalledWith("Ship from body\n\nBody", false, "commit");

    unmount();
    const second = renderCommitBox();
    fireEvent.change(screen.getByPlaceholderText("Commit subject..."), {
      target: { value: "Ship from ctrl" },
    });
    fireEvent.change(screen.getByPlaceholderText("Commit body..."), {
      target: { value: "Body" },
    });
    fireEvent.keyDown(screen.getByPlaceholderText("Commit body..."), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(second.onCommit).toHaveBeenCalledWith("Ship from ctrl\n\nBody", false, "commit");
  });

  it("scales the commit editor height from the saved ratio as the staging area changes", async () => {
    localStorage.setItem(COMMIT_BOX_RATIO_KEY, "0.4");
    let stagingHeight = 1000;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      if ((this as HTMLElement).classList.contains("commit-box-test-host")) {
        return {
          x: 0,
          y: 0,
          width: 420,
          height: stagingHeight,
          top: 0,
          right: 420,
          bottom: stagingHeight,
          left: 0,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    });

    const { container } = renderCommitBox();
    const commitBox = container.querySelector(".commit-box") as HTMLElement;

    await waitFor(() => {
      expect(commitBox.style.getPropertyValue("--commit-box-height")).toBe("400px");
    });

    stagingHeight = 1200;
    fireEvent(window, new Event("resize"));

    await waitFor(() => {
      expect(commitBox.style.getPropertyValue("--commit-box-height")).toBe("480px");
    });
  });

  it("saves the resized commit editor ratio after dragging the divider", () => {
    let commitBoxHeight = 214;
    const stagingHeight = 1000;
    const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const element = this as HTMLElement;
      if (element.classList.contains("commit-box-test-host")) {
        return {
          x: 0,
          y: 0,
          width: 420,
          height: stagingHeight,
          top: 0,
          right: 420,
          bottom: stagingHeight,
          left: 0,
          toJSON: () => ({}),
        };
      }
      if (element.classList.contains("commit-box")) {
        return {
          x: 0,
          y: stagingHeight - commitBoxHeight,
          width: 420,
          height: commitBoxHeight,
          top: stagingHeight - commitBoxHeight,
          right: 420,
          bottom: stagingHeight,
          left: 0,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    });

    renderCommitBox();

    fireEvent.mouseDown(screen.getByRole("separator", { name: "Resize commit message editor" }), {
      clientY: 500,
    });
    commitBoxHeight = 314;
    fireEvent.mouseMove(window, {
      clientY: 400,
    });
    fireEvent.mouseUp(window);

    expect(localStorage.getItem(COMMIT_BOX_RATIO_KEY)).toBe("0.314000");
  });
});
