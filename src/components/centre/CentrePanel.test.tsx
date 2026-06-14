// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import type { CommitHistoryItem } from "../../types";
import "../../i18n";
import { CentrePanel } from "./CentrePanel";

vi.mock("./StagingView", () => ({
  StagingView: () => <div data-testid="staging-view" />,
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
    isCommitting: false,
    isRebaseActionRunning: false,
    isCherryPickActionRunning: false,
    isRevertActionRunning: false,
    lastCommitMessage: "",
    ...overrides,
  };

  return render(<CentrePanel {...props} />);
}

describe("CentrePanel commit graph toggle", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", makeLocalStorage());
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the commit graph by default and persists toggle changes", () => {
    const { container } = renderCentrePanel();

    expect(container.querySelector(".log-view__graph")).not.toBeNull();

    fireEvent.click(screen.getByLabelText("Hide commit graph"));

    expect(container.querySelector(".log-view__graph")).toBeNull();
    expect(localStorage.getItem("gitmun.showCommitGraph")).toBe("false");

    fireEvent.click(screen.getByLabelText("Show commit graph"));

    expect(container.querySelector(".log-view__graph")).not.toBeNull();
    expect(localStorage.getItem("gitmun.showCommitGraph")).toBe("true");
  });

  it("initialises the commit graph toggle from local storage", () => {
    localStorage.setItem("gitmun.showCommitGraph", "false");

    const { container } = renderCentrePanel();

    expect(container.querySelector(".log-view__graph")).toBeNull();
    expect(screen.getByLabelText("Show commit graph")).toBeInTheDocument();
  });
});
