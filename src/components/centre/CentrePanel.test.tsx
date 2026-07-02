// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import type { CommitHistoryItem } from "../../types";
import "../../i18n";
import { CentrePanel } from "./CentrePanel";

vi.mock("./StagingView", () => ({
  StagingView: ({ inlineOperation }: { inlineOperation: { title: string; message: string } | null }) => (
    <div data-testid="staging-view">
      {inlineOperation && (
        <div data-testid="inline-operation">
          <div>{inlineOperation.title}</div>
          <div>{inlineOperation.message}</div>
        </div>
      )}
    </div>
  ),
}));

vi.mock("./LogView", () => ({
  LogView: ({ showCommitGraph }: { showCommitGraph: boolean }) => (
    <div data-testid="log-view">
      {showCommitGraph && <div className="log-view__graph" />}
    </div>
  ),
}));

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
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
  };
}

function commit(): CommitHistoryItem {
  return {
    hash: "hash-1".padEnd(40, "0"),
    shortHash: "hash-1",
    author: "Author 1",
    authorEmail: "author1@example.com",
    date: "2026-05-21T10:00:00Z",
    message: "Subject 1",
    parentHashes: [],
    refDecorations: [],
    signatureStatus: "none",
    keyType: null,
  };
}

function renderCentrePanel(overrides: Partial<React.ComponentProps<typeof CentrePanel>> = {}) {
  const props: React.ComponentProps<typeof CentrePanel> = {
    repoPath: "/repo",
    activeTab: "log",
    currentBranch: "main",
    stagedFiles: [],
    unstagedFiles: [],
    unversionedFiles: [],
    submodules: [],
    conflictedFiles: [],
    mergeInProgress: false,
    mergeHeadBranch: null,
    mergeMessage: null,
    rebaseInProgress: false,
    rebaseOnto: null,
    cherryPickInProgress: false,
    cherryPickHead: null,
    revertInProgress: false,
    revertHead: null,
    commits: [commit()],
    loadMore: vi.fn(),
    hasMore: false,
    loadingMore: false,
    loadMoreError: null,
    pageSize: 100,
    logLoading: false,
    logError: null,
    commitMarkers: { localHead: null, upstreamHead: null, upstreamRef: null },
    logScope: "currentCheckout",
    rowStriping: "Off",
    showCommitGraphButton: true,
    onLogScopeChange: vi.fn(),
    detachedHead: false,
    shallow: false,
    onTabChange: vi.fn(),
    selectedCommitHash: null,
    onSelectCommit: vi.fn(),
    selectedFile: null,
    selectedSubmodulePath: null,
    selectedStagedFiles: {},
    selectedUnstagedFiles: {},
    onSelectedStagedFilesChange: vi.fn(),
    onSelectedUnstagedFilesChange: vi.fn(),
    onFileSelect: vi.fn(),
    onSubmoduleSelect: vi.fn(),
    onSubmoduleInit: vi.fn(),
    onSubmoduleUpdate: vi.fn(),
    onSubmoduleSync: vi.fn(),
    onSubmoduleFetch: vi.fn(),
    onSubmodulePull: vi.fn(),
    onSubmoduleOpen: vi.fn(),
    onStageFile: vi.fn(),
    onStageFiles: vi.fn(),
    onUnstageFile: vi.fn(),
    onUnstageFiles: vi.fn(),
    onDiscardFile: vi.fn(),
    onDiscardFiles: vi.fn(),
    onDiscardAll: vi.fn(),
    onExternalDiff: vi.fn(),
    onStageAll: vi.fn(),
    onUnstageAll: vi.fn(),
    selectedCommitAction: "commit",
    commitMessageRecommendedLength: 72,
    allowCommitAndPush: true,
    onSelectCommitAction: vi.fn(),
    onCommit: vi.fn(),
    onMergeAbort: vi.fn(),
    onRebaseContinue: vi.fn(),
    onRebaseAbort: vi.fn(),
    onCherryPickContinue: vi.fn(),
    onCherryPickAbort: vi.fn(),
    onRevertContinue: vi.fn(),
    onRevertAbort: vi.fn(),
    onConflictAcceptTheirs: vi.fn(),
    onConflictAcceptOurs: vi.fn(),
    onOpenMergeTool: vi.fn(),
    stagingOperation: null,
    operationLock: null,
    isCommitting: false,
    isRebaseActionRunning: false,
    isCherryPickActionRunning: false,
    isRevertActionRunning: false,
    lastCommitMessage: "",
    ...overrides,
  };

  return {
    ...render(<CentrePanel {...props} />),
    props,
  };
}

describe("CentrePanel commit graph toggle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides the commit graph by default and persists toggle changes", () => {
    const { container } = renderCentrePanel();

    expect(container.querySelector(".log-view__graph")).toBeNull();
    expect(screen.getByLabelText("Show commit graph")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Show commit graph"));

    expect(container.querySelector(".log-view__graph")).not.toBeNull();
    expect(localStorage.getItem("gitmun.showCommitGraph")).toBe("true");

    fireEvent.click(screen.getByLabelText("Hide commit graph"));

    expect(container.querySelector(".log-view__graph")).toBeNull();
    expect(localStorage.getItem("gitmun.showCommitGraph")).toBe("false");
  });

  it("initialises the commit graph toggle from local storage", () => {
    localStorage.setItem("gitmun.showCommitGraph", "true");

    const { container } = renderCentrePanel();

    expect(container.querySelector(".log-view__graph")).not.toBeNull();
    expect(screen.getByLabelText("Hide commit graph")).toBeInTheDocument();
  });

  it("hides the graph button and forces the graph hidden when the setting is off", () => {
    localStorage.setItem("gitmun.showCommitGraph", "true");

    const { container } = renderCentrePanel({ showCommitGraphButton: false });

    expect(screen.queryByLabelText("Hide commit graph")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Show commit graph")).not.toBeInTheDocument();
    expect(container.querySelector(".log-view__graph")).toBeNull();
    expect(localStorage.getItem("gitmun.showCommitGraph")).toBe("true");
  });
});

describe("CentrePanel operation feedback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows no visible feedback for a fast operation under 500ms", () => {
    renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "stage", count: 42, startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(499);
    });

    expect(screen.queryByTestId("inline-operation")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows inline feedback after 500ms", () => {
    renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "stage", count: 42, startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByTestId("inline-operation")).toHaveTextContent("Staging changes");
    expect(screen.getByTestId("inline-operation")).toHaveTextContent("Gitmun is staging 42 files.");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("escalates to the popup after 2500ms", () => {
    renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "stage", count: 42, startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Staging changes");
    expect(screen.getByRole("status")).toHaveTextContent("This operation is still running.");
  });

  it("clears feedback when the operation completes", () => {
    const { props, rerender } = renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "stage", count: 42, startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    rerender(<CentrePanel {...props} operationLock={null} />);

    expect(screen.queryByTestId("inline-operation")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("resets delayed feedback for a new operation id", () => {
    const { props, rerender } = renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "stage", count: 1, startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("inline-operation")).toHaveTextContent("Staging changes");

    rerender(<CentrePanel {...props} operationLock={{ id: 2, kind: "unstage", count: 1, startedAt: 500 }} />);
    expect(screen.queryByTestId("inline-operation")).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByTestId("inline-operation")).toHaveTextContent("Unstaging changes");
  });

  it("uses delayed feedback for commit and push", () => {
    renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "commitAndPush", startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(screen.getByTestId("inline-operation")).toHaveTextContent("Committing and pushing");
    expect(screen.getByTestId("inline-operation")).toHaveTextContent("Gitmun is creating the commit and pushing it to the remote.");
  });

  it("uses delayed feedback for commit", () => {
    renderCentrePanel({
      activeTab: "changes",
      operationLock: { id: 1, kind: "commit", startedAt: 0 },
    });

    act(() => {
      vi.advanceTimersByTime(2500);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Creating commit");
    expect(screen.getByRole("status")).toHaveTextContent("This operation is still running.");
  });
});
