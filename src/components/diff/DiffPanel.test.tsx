// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommitDetails } from "../../api/commands";
import "../../i18n";
import type { CommitDetails, CommitFileItem, RowStriping } from "../../types";
import { DiffPanel } from "./DiffPanel";

vi.mock("../../api/commands", () => ({
  getCommitDetails: vi.fn(),
}));

const mockGetCommitDetails = vi.mocked(getCommitDetails);

const baseDetails: CommitDetails = {
  hash: "0123456789abcdef0123456789abcdef01234567",
  author: "Author",
  authorEmail: "author@example.com",
  authorDate: "2026-06-25T10:00:00Z",
  committer: "Author",
  committerEmail: "author@example.com",
  committerDate: "2026-06-25T10:00:00Z",
  body: "",
  parentHashes: [],
  tags: [],
  trailers: [],
};

function renderCommitDetails(details: CommitDetails) {
  mockGetCommitDetails.mockResolvedValue(details);
  render(
    <DiffPanel
      mode="log"
      diff={null}
      loading={false}
      selectedFile={null}
      selectedSubmodule={null}
      selectedCommitHash={details.hash}
      repoPath="/repo"
      commitFiles={[]}
      commitFilesLoading={false}
      compareCurrentFileLabel=""
      onCompareCurrentFile={vi.fn()}
      onOpenCommitFileDiff={vi.fn()}
      hunkAction={null}
      hunkActionBusy={false}
      wrapLines={false}
      rowStriping="Off"
      onHunkAction={vi.fn()}
    />,
  );

  fireEvent.click(screen.getByTitle("Commit details"));
}

describe("DiffPanel commit details", () => {
  beforeEach(() => {
    mockGetCommitDetails.mockReset();
  });

  it("shows seven-character commit hashes in the header", () => {
    renderCommitDetails(baseDetails);

    expect(screen.getByText("Commit 0123456")).toBeInTheDocument();
  });

  it("shows prose with preserved newlines separately from trailers", async () => {
    renderCommitDetails({
      ...baseDetails,
      body: "First paragraph.\n\nSecond paragraph.",
      trailers: [{ key: "Reviewed-by", value: "Alice <alice@example.com>" }],
    });

    const dialog = await screen.findByRole("dialog");
    const message = screen.getByText("First paragraph.", { exact: false });

    expect(screen.getByText("Message")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" }).querySelector("svg")).toBeInTheDocument();
    expect(message).toHaveClass("commit-details-popover__value--message");
    expect(message.textContent).toBe("First paragraph.\n\nSecond paragraph.");
    expect(dialog).toHaveTextContent("Reviewed-by");
    expect(screen.getAllByText("Alice <alice@example.com>")).toHaveLength(1);
    expect(message).not.toHaveTextContent("Reviewed-by");
  });

  it.each([
    ["empty", []],
    ["trailer-only", [{ key: "Signed-off-by", value: "Bob <bob@example.com>" }]],
  ])("omits the Message section for %s bodies", async (_case, trailers) => {
    renderCommitDetails({
      ...baseDetails,
      trailers,
    });

    await screen.findByRole("dialog");

    expect(screen.queryByText("Message")).not.toBeInTheDocument();
    if (trailers.length > 0) {
      expect(screen.getByText("Signed-off-by")).toBeInTheDocument();
      expect(screen.getByText("Bob <bob@example.com>")).toBeInTheDocument();
    }
  });
});

function commitFile(path: string, status = "Modified"): CommitFileItem {
  return { path, status };
}

function renderLog(options?: {
  commitFiles?: CommitFileItem[];
  commitFilesLoading?: boolean;
  selectedCommitHash?: string | null;
  rowStriping?: RowStriping;
}) {
  const onOpenCommitFileDiff = vi.fn();
  const view = render(
    <DiffPanel
      mode="log"
      diff={null}
      loading={false}
      selectedFile={null}
      selectedSubmodule={null}
      selectedCommitHash={options?.selectedCommitHash ?? baseDetails.hash}
      repoPath="/repo"
      commitFiles={options?.commitFiles ?? []}
      commitFilesLoading={options?.commitFilesLoading ?? false}
      compareCurrentFileLabel=""
      onCompareCurrentFile={vi.fn()}
      onOpenCommitFileDiff={onOpenCommitFileDiff}
      hunkAction={null}
      hunkActionBusy={false}
      wrapLines={false}
      rowStriping={options?.rowStriping ?? "Off"}
      onHunkAction={vi.fn()}
    />,
  );

  return { ...view, onOpenCommitFileDiff };
}

describe("DiffPanel commit file tree", () => {
  it("groups nested files under a compact folder row", () => {
    renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx"),
        commitFile("src/components/Icon.tsx"),
      ],
    });

    expect(screen.getByText("src/components")).toBeInTheDocument();
    expect(screen.getByText("2 files")).toBeInTheDocument();
    expect(screen.getByText("Button.tsx")).toBeInTheDocument();
    expect(screen.getByText("Icon.tsx")).toBeInTheDocument();
    expect(screen.queryByText("src/components/Button.tsx")).not.toBeInTheDocument();
  });

  it("selects on click and opens the external diff on double-click using the full path", () => {
    const { onOpenCommitFileDiff } = renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx"),
        commitFile("src/components/Icon.tsx"),
      ],
    });

    const button = screen.getByRole("button", { name: /Button\.tsx/ });
    fireEvent.click(button);

    expect(button).toHaveClass("diff-panel__commit-file-row--selected");
    expect(onOpenCommitFileDiff).not.toHaveBeenCalled();

    fireEvent.doubleClick(button);

    expect(onOpenCommitFileDiff).toHaveBeenCalledWith("src/components/Button.tsx");
    expect(button).toHaveAttribute("title", "src/components/Button.tsx");
  });

  it("hides nested files when a folder is collapsed and shows them again when expanded", () => {
    renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx"),
        commitFile("src/components/Icon.tsx"),
      ],
    });

    fireEvent.click(screen.getByLabelText("Collapse src/components"));

    expect(screen.queryByText("Button.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("Icon.tsx")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Expand src/components"));

    expect(screen.getByText("Button.tsx")).toBeInTheDocument();
    expect(screen.getByText("Icon.tsx")).toBeInTheDocument();
  });

  it("keeps status letters on file rows", () => {
    renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx", "Added"),
        commitFile("README.md", "Deleted"),
      ],
    });

    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  it("stripes only visible file rows and recalculates after collapse", () => {
    renderLog({
      commitFiles: [
        commitFile("lib/A.ts"),
        commitFile("B.ts"),
        commitFile("C.ts"),
      ],
      rowStriping: "Subtle",
    });

    expect(screen.getByRole("button", { name: /A\.ts/ })).not.toHaveClass("diff-panel__commit-file-row--striped-subtle");
    expect(screen.getByRole("button", { name: /B\.ts/ })).toHaveClass("diff-panel__commit-file-row--striped-subtle");
    expect(screen.getByRole("button", { name: /C\.ts/ })).not.toHaveClass("diff-panel__commit-file-row--striped-subtle");
    expect(screen.getByText("lib").closest(".diff-panel__commit-folder-row")).not.toHaveClass(
      "diff-panel__commit-file-row--striped-subtle",
    );

    fireEvent.click(screen.getByLabelText("Collapse lib"));

    expect(screen.queryByText("A.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /B\.ts/ })).not.toHaveClass("diff-panel__commit-file-row--striped-subtle");
    expect(screen.getByRole("button", { name: /C\.ts/ })).toHaveClass("diff-panel__commit-file-row--striped-subtle");
  });

  it("shows root-level files without a folder row", () => {
    renderLog({
      commitFiles: [commitFile("README.md")],
    });

    expect(screen.getByText("README.md")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Collapse /)).not.toBeInTheDocument();
  });

  it("clears folder expansion and file selection when the commit hash changes", () => {
    const { rerender, onOpenCommitFileDiff } = renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx"),
        commitFile("src/components/Icon.tsx"),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: /Button\.tsx/ }));
    fireEvent.click(screen.getByLabelText("Collapse src/components"));
    expect(screen.queryByText("Button.tsx")).not.toBeInTheDocument();

    rerender(
      <DiffPanel
        mode="log"
        diff={null}
        loading={false}
        selectedFile={null}
        selectedSubmodule={null}
        selectedCommitHash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        repoPath="/repo"
        commitFiles={[
          commitFile("src/components/Button.tsx"),
          commitFile("src/components/Icon.tsx"),
        ]}
        commitFilesLoading={false}
        compareCurrentFileLabel=""
        onCompareCurrentFile={vi.fn()}
        onOpenCommitFileDiff={onOpenCommitFileDiff}
        hunkAction={null}
        hunkActionBusy={false}
        wrapLines={false}
        rowStriping="Off"
        onHunkAction={vi.fn()}
      />,
    );

    const button = screen.getByRole("button", { name: /Button\.tsx/ });
    expect(button).not.toHaveClass("diff-panel__commit-file-row--selected");
    expect(screen.getByText("Icon.tsx")).toBeInTheDocument();
  });

  it("keeps loading and empty commit states unchanged", () => {
    const { rerender } = renderLog({ commitFilesLoading: true });

    expect(screen.getByText("Loading commit files...")).toBeInTheDocument();

    rerender(
      <DiffPanel
        mode="log"
        diff={null}
        loading={false}
        selectedFile={null}
        selectedSubmodule={null}
        selectedCommitHash={baseDetails.hash}
        repoPath="/repo"
        commitFiles={[]}
        commitFilesLoading={false}
        compareCurrentFileLabel=""
        onCompareCurrentFile={vi.fn()}
        onOpenCommitFileDiff={vi.fn()}
        hunkAction={null}
        hunkActionBusy={false}
        wrapLines={false}
        rowStriping="Off"
        onHunkAction={vi.fn()}
      />,
    );

    expect(screen.getByText("Select a commit to view changed files")).toBeInTheDocument();
  });

  it("filters commit files by path and keeps matching folders", () => {
    renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx"),
        commitFile("src/components/Icon.tsx"),
        commitFile("README.md"),
      ],
    });

    fireEvent.change(screen.getByLabelText("Search changed files..."), {
      target: { value: "button" },
    });

    expect(screen.getByText("Button.tsx")).toBeInTheDocument();
    expect(screen.getByText("src/components")).toBeInTheDocument();
    expect(screen.queryByText("Icon.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
  });

  it("shows an empty state when no commit files match the search", () => {
    renderLog({
      commitFiles: [commitFile("src/components/Button.tsx")],
    });

    fireEvent.change(screen.getByLabelText("Search changed files..."), {
      target: { value: "missing" },
    });

    expect(screen.getByText("No files match this search")).toBeInTheDocument();
    expect(screen.queryByText("Button.tsx")).not.toBeInTheDocument();
  });

  it("clears the file search when the commit hash changes", () => {
    const { rerender, onOpenCommitFileDiff } = renderLog({
      commitFiles: [
        commitFile("src/components/Button.tsx"),
        commitFile("README.md"),
      ],
    });

    fireEvent.change(screen.getByLabelText("Search changed files..."), {
      target: { value: "README" },
    });
    expect(screen.queryByText("Button.tsx")).not.toBeInTheDocument();

    rerender(
      <DiffPanel
        mode="log"
        diff={null}
        loading={false}
        selectedFile={null}
        selectedSubmodule={null}
        selectedCommitHash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        repoPath="/repo"
        commitFiles={[
          commitFile("src/components/Button.tsx"),
          commitFile("README.md"),
        ]}
        commitFilesLoading={false}
        compareCurrentFileLabel=""
        onCompareCurrentFile={vi.fn()}
        onOpenCommitFileDiff={onOpenCommitFileDiff}
        hunkAction={null}
        hunkActionBusy={false}
        wrapLines={false}
        rowStriping="Off"
        onHunkAction={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("Search changed files...")).toHaveValue("");
    expect(screen.getByText("Button.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });
});
