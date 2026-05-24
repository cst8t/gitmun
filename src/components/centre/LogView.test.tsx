// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitHistoryItem, CommitMarkers } from "../../types";
import "../../i18n";
import { LogView } from "./LogView";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("../../api/commands", () => ({
  verifyCommits: vi.fn(async () => []),
}));

vi.mock("react-virtuoso", () => ({
  Virtuoso: ({ data, itemContent, components: Components }: {
    data: CommitHistoryItem[];
    itemContent: (index: number, item: CommitHistoryItem) => React.ReactNode;
    components?: { EmptyPlaceholder?: React.ComponentType };
  }) => (
    <div>
      {data.length === 0 && Components?.EmptyPlaceholder ? <Components.EmptyPlaceholder /> : null}
      {data.map((item, index) => (
        <div key={item.hash}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

vi.mock("../shared/ContextMenu", () => ({
  ContextMenu: ({ items }: {
    items: Array<{ label: string; onClick: () => void } | { type: "separator" }>;
  }) => (
    <div role="menu">
      {items.map((item, index) => {
        if ("type" in item) return <div key={`separator-${index}`} role="separator" />;
        return (
          <button key={item.label} type="button" onClick={item.onClick}>
            {item.label}
          </button>
        );
      })}
    </div>
  ),
}));

const writeText = vi.fn(async () => {});

function commit(index: number, overrides: Partial<CommitHistoryItem> = {}): CommitHistoryItem {
  return {
    hash: `hash-${index}`.padEnd(40, "0"),
    shortHash: `hash-${index}`,
    author: `Author ${index}`,
    authorEmail: `author${index}@example.com`,
    date: `2026-05-2${index}T10:00:00Z`,
    message: `Subject ${index}`,
    signatureStatus: "none",
    keyType: null,
    ...overrides,
  };
}

function rowFor(subject: string): HTMLElement {
  const row = screen.getByText(subject).closest(".log-view__row");
  if (!row) throw new Error(`Missing row for ${subject}`);
  return row as HTMLElement;
}

function renderLog(overrides: Partial<React.ComponentProps<typeof LogView>> = {}) {
  const commits = overrides.commits ?? [commit(1), commit(2), commit(3)];
  const commitMarkers: CommitMarkers = {
    localHead: null,
    upstreamHead: null,
    upstreamRef: null,
  };

  return render(
    <LogView
      active
      repoPath={null}
      commits={commits}
      loadMore={vi.fn()}
      hasMore={false}
      logLoading={false}
      logError={null}
      commitMarkers={commitMarkers}
      logScope="currentCheckout"
      rowStriping="Off"
      detachedHead={false}
      shallow={false}
      selectedCommitHash={commits[0]?.hash ?? null}
      onSelectCommit={vi.fn()}
      {...overrides}
    />,
  );
}

describe("LogView commit selection", () => {
  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
  });

  it("selects one commit on plain click", () => {
    const onSelectCommit = vi.fn();
    renderLog({ onSelectCommit });

    fireEvent.click(rowFor("Subject 2"));

    expect(rowFor("Subject 1")).toHaveAttribute("aria-selected", "false");
    expect(rowFor("Subject 2")).toHaveAttribute("aria-selected", "true");
    expect(onSelectCommit).toHaveBeenCalledWith(commit(2).hash);
  });

  it("toggles multiple commits with Ctrl-click", () => {
    renderLog();

    fireEvent.click(rowFor("Subject 2"), { ctrlKey: true });

    expect(rowFor("Subject 1")).toHaveAttribute("aria-selected", "true");
    expect(rowFor("Subject 2")).toHaveAttribute("aria-selected", "true");
  });

  it("selects a contiguous range with Shift-click", () => {
    renderLog();

    fireEvent.click(rowFor("Subject 3"), { shiftKey: true });

    expect(rowFor("Subject 1")).toHaveAttribute("aria-selected", "true");
    expect(rowFor("Subject 2")).toHaveAttribute("aria-selected", "true");
    expect(rowFor("Subject 3")).toHaveAttribute("aria-selected", "true");
  });

  it("copies selected full hashes in log order", () => {
    renderLog();

    fireEvent.click(rowFor("Subject 2"), { ctrlKey: true });
    fireEvent.contextMenu(rowFor("Subject 1"));
    fireEvent.click(screen.getByText("Copy Commit Hash"));

    expect(writeText).toHaveBeenCalledWith(`${commit(1).hash}\n${commit(2).hash}`);
  });

  it("copies details for every selected commit", () => {
    renderLog();

    fireEvent.click(rowFor("Subject 2"), { ctrlKey: true });
    fireEvent.contextMenu(rowFor("Subject 1"));
    fireEvent.click(screen.getByText("Copy Details"));

    expect(writeText).toHaveBeenCalledWith([
      `commit ${commit(1).hash}`,
      "Author: Author 1 <author1@example.com>",
      "Date: 2026-05-21T10:00:00Z",
      "",
      "Subject 1",
      "",
      `commit ${commit(2).hash}`,
      "Author: Author 2 <author2@example.com>",
      "Date: 2026-05-22T10:00:00Z",
      "",
      "Subject 2",
    ].join("\n"));
  });

  it("right-clicking outside the selection selects only that commit", () => {
    renderLog();

    fireEvent.click(rowFor("Subject 2"), { ctrlKey: true });
    fireEvent.contextMenu(rowFor("Subject 3"));
    fireEvent.click(screen.getByText("Copy Commit Hash"));

    expect(rowFor("Subject 1")).toHaveAttribute("aria-selected", "false");
    expect(rowFor("Subject 2")).toHaveAttribute("aria-selected", "false");
    expect(rowFor("Subject 3")).toHaveAttribute("aria-selected", "true");
    expect(writeText).toHaveBeenCalledWith(commit(3).hash);
  });

  it("keeps single-commit actions out of the multi-select menu", () => {
    renderLog({ onCherryPickAtCommit: vi.fn() });

    fireEvent.click(rowFor("Subject 2"), { ctrlKey: true });
    fireEvent.contextMenu(rowFor("Subject 1"));

    expect(screen.queryByText("Cherry-pick Commit")).not.toBeInTheDocument();
  });

  it("separates copy items from single-commit actions", () => {
    renderLog({ onCherryPickAtCommit: vi.fn(), onCreateTagAtCommit: vi.fn() });

    fireEvent.contextMenu(rowFor("Subject 1"));

    const labelsAndSeparators = Array.from(screen.getByRole("menu").children).map(child => {
      if (child.getAttribute("role") === "separator") return "separator";
      return child.textContent;
    });
    expect(labelsAndSeparators).toEqual([
      "Copy Commit Hash",
      "Copy Short Hash",
      "Copy Subject",
      "Copy Details",
      "separator",
      "Cherry-pick Commit",
      "separator",
      "Create Tag Here...",
    ]);
  });
});
