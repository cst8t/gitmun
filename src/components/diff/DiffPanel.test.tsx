// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCommitDetails } from "../../api/commands";
import "../../i18n";
import type { CommitDetails } from "../../types";
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

  it("shows prose with preserved newlines separately from trailers", async () => {
    renderCommitDetails({
      ...baseDetails,
      body: "First paragraph.\n\nSecond paragraph.",
      trailers: [{ key: "Reviewed-by", value: "Alice <alice@example.com>" }],
    });

    const dialog = await screen.findByRole("dialog");
    const message = screen.getByText("First paragraph.", { exact: false });

    expect(screen.getByText("Message")).toBeInTheDocument();
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
