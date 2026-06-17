// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitHistoryItem, CommitMarkers, Settings } from "../../types";
import "../../i18n";
import { LogView } from "./LogView";
import { verifyCommits } from "../../api/commands";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

const eventListeners = vi.hoisted(() => new Map<string, Array<(event: { payload: unknown }) => void>>());
const virtuosoRange = vi.hoisted(() => ({
  current: null as ((range: { startIndex: number; endIndex: number }) => void) | null,
}));
const virtuosoItemsRendered = vi.hoisted(() => ({
  current: null as ((items: Array<{ index: number }>) => void) | null,
}));
const virtuosoSetVisibleRange = vi.hoisted(() => ({
  current: null as ((range: { startIndex: number; endIndex: number }) => void) | null,
}));
const virtuosoEndReached = vi.hoisted(() => ({
  current: null as (() => void) | null,
}));
const virtuosoScrollToIndex = vi.hoisted(() => vi.fn());
const virtuosoCallbacksEnabled = vi.hoisted(() => ({
  current: true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, callback: (event: { payload: unknown }) => void) => {
    const listeners = eventListeners.get(event) ?? [];
    listeners.push(callback);
    eventListeners.set(event, listeners);
    return vi.fn(() => {
      const current = eventListeners.get(event) ?? [];
      eventListeners.set(event, current.filter(listener => listener !== callback));
    });
  }),
}));

vi.mock("../../api/commands", () => ({
  verifyCommits: vi.fn(async () => []),
}));

const mockVerifyCommits = vi.mocked(verifyCommits);

function emitEvent(event: string, payload: unknown = undefined) {
  for (const listener of eventListeners.get(event) ?? []) {
    listener({ payload });
  }
}

async function waitForSignatureSettingsListener() {
  await waitFor(() => expect(eventListeners.get("signature-settings-updated")?.length).toBe(1));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

vi.mock("react-virtuoso", () => ({
  Virtuoso: React.forwardRef(({ data, itemContent, components: Components, rangeChanged, itemsRendered, endReached }: {
    data: CommitHistoryItem[];
    itemContent: (index: number, item: CommitHistoryItem) => React.ReactNode;
    components?: { EmptyPlaceholder?: React.ComponentType; Footer?: React.ComponentType };
    rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
    itemsRendered?: (items: Array<{ index: number }>) => void;
    endReached?: () => void;
  }, ref: React.Ref<{ scrollToIndex: (location: { index: number; align?: string } | number) => void }>) => {
    const [visibleRange, setVisibleRange] = React.useState({ startIndex: 0, endIndex: Math.min(data.length - 1, 19) });
    const visibleStart = Math.min(visibleRange.startIndex, Math.max(data.length - 1, 0));
    const visibleEnd = Math.min(visibleRange.endIndex, Math.max(data.length - 1, 0));
    const visibleItems = React.useMemo(
      () => data.slice(visibleStart, visibleEnd + 1),
      [data, visibleEnd, visibleStart],
    );
    virtuosoRange.current = rangeChanged ?? null;
    virtuosoItemsRendered.current = itemsRendered ?? null;
    virtuosoSetVisibleRange.current = setVisibleRange;
    virtuosoEndReached.current = endReached ?? null;
    React.useImperativeHandle(ref, () => ({
      scrollToIndex: virtuosoScrollToIndex,
    }));
    React.useEffect(() => {
      setVisibleRange(current => ({
        startIndex: Math.min(current.startIndex, Math.max(data.length - 1, 0)),
        endIndex: Math.min(current.endIndex, Math.max(data.length - 1, 0)),
      }));
    }, [data.length]);
    React.useEffect(() => {
      if (!virtuosoCallbacksEnabled.current || data.length === 0) return;
      const range = { startIndex: visibleStart, endIndex: visibleEnd };
      rangeChanged?.(range);
      itemsRendered?.(visibleItems.map((_, offset) => ({
        index: visibleStart + offset,
        originalIndex: visibleStart + offset,
      })));
      return () => {
        if (virtuosoSetVisibleRange.current === setVisibleRange) virtuosoSetVisibleRange.current = null;
      };
    }, [data.length, itemsRendered, rangeChanged, visibleEnd, visibleItems, visibleStart]);
    return (
      <div>
        {data.length === 0 && Components?.EmptyPlaceholder ? <Components.EmptyPlaceholder /> : null}
        {visibleItems.map((item, offset) => {
          const index = visibleStart + offset;
          return (
            <div
              key={item.hash}
              data-index={index}
              data-testid={`virtuoso-item-${index}`}
            >
              {itemContent(index, item)}
            </div>
          );
        })}
        {Components?.Footer ? <Components.Footer /> : null}
      </div>
    );
  }),
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

const settingsPayload: Settings = {
  backendMode: "Default",
  showResultLog: false,
  themeMode: "System",
  uiTextScale: 1,
  wrapDiffLines: false,
  rowStriping: "Off",
  showCommitGraphButton: false,
  persistentErrorToasts: false,
  errorToastClearDelayMs: 5000,
  leftPaneWidth: 300,
  rightPaneWidth: 380,
  confirmRevert: true,
  avatarProvider: "Libravatar",
  tryPlatformFirst: true,
  defaultCloneDir: "",
  commitDateMode: "AuthorDate",
  commitPrimaryAction: "commit",
  commitMessageRecommendedLength: 72,
  pushFollowTags: false,
  autoCheckForUpdatesOnLaunch: true,
  autoInstallUpdates: false,
  updateEndpoint: "",
  linuxGraphicsMode: "Auto",
  linuxTerminalEmulator: "Auto",
  linuxTerminalCustomCommand: "",
  repoOpenBehaviour: "Ask",
  gitExecutablePath: "",
  gpgKeyserverVerificationEnabled: false,
};

function commit(index: number, overrides: Partial<CommitHistoryItem> = {}): CommitHistoryItem {
  return {
    hash: `hash-${index}`.padEnd(40, "0"),
    shortHash: `hash-${index}`,
    author: `Author ${index}`,
    authorEmail: `author${index}@example.com`,
    date: `2026-05-2${index}T10:00:00Z`,
    message: `Subject ${index}`,
    parentHashes: [],
    refDecorations: [],
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
      loadingMore={false}
      loadMoreError={null}
      pageSize={100}
      logLoading={false}
      logError={null}
      commitMarkers={commitMarkers}
      logScope="currentCheckout"
      rowStriping="Off"
      showCommitGraph
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
    eventListeners.clear();
    virtuosoRange.current = null;
    virtuosoItemsRendered.current = null;
    virtuosoSetVisibleRange.current = null;
    virtuosoEndReached.current = null;
    virtuosoScrollToIndex.mockClear();
    virtuosoCallbacksEnabled.current = true;
    mockVerifyCommits.mockReset();
    mockVerifyCommits.mockResolvedValue([]);
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

  it("moves commit selection with arrow keys", () => {
    const onSelectCommit = vi.fn();
    renderLog({ onSelectCommit });

    fireEvent.keyDown(screen.getByRole("listbox", { name: "Log" }), { key: "ArrowDown" });

    expect(rowFor("Subject 1")).toHaveAttribute("aria-selected", "false");
    expect(rowFor("Subject 2")).toHaveAttribute("aria-selected", "true");
    expect(onSelectCommit).toHaveBeenLastCalledWith(commit(2).hash);

    fireEvent.keyDown(screen.getByRole("listbox", { name: "Log" }), { key: "ArrowUp" });

    expect(rowFor("Subject 1")).toHaveAttribute("aria-selected", "true");
    expect(rowFor("Subject 2")).toHaveAttribute("aria-selected", "false");
    expect(onSelectCommit).toHaveBeenLastCalledWith(commit(1).hash);
  });

  it("reveals a keyboard-selected commit outside the visible range", () => {
    const onSelectCommit = vi.fn();
    const commits = Array.from({ length: 25 }, (_, index) => {
      const shortHash = `hash-${String(index + 1).padStart(2, "0")}`;
      return commit(index + 1, {
        hash: shortHash.padEnd(40, "0"),
        shortHash,
      });
    });
    renderLog({
      commits,
      selectedCommitHash: commits[19].hash,
      onSelectCommit,
    });

    fireEvent.keyDown(screen.getByRole("listbox", { name: "Log" }), { key: "ArrowDown" });

    expect(onSelectCommit).toHaveBeenCalledWith(commits[20].hash);
    expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: 20, align: "end" });
  });

  it("renders the commit graph beside log rows", () => {
    renderLog({
      commits: [
        commit(1, { parentHashes: [commit(2).hash] }),
        commit(2),
      ],
    });

    expect(rowFor("Subject 1").querySelector(".log-view__graph-node")).not.toBeNull();
  });

  it("does not draw a premature bottom vertical for a merge side parent", () => {
    const main = commit(3);
    const feature = commit(2, { parentHashes: [main.hash] });
    const merge = commit(1, { parentHashes: [main.hash, feature.hash] });
    renderLog({ commits: [merge, feature, main] });

    const mergeRow = rowFor("Subject 1");
    const sideConnector = mergeRow.querySelector(".log-view__graph-connectors line[x2='17']");
    const bottomLaneOffsets = Array.from(mergeRow.querySelectorAll<HTMLElement>(".log-view__graph-vertical--bottom"))
      .map(lane => lane.style.left);

    expect(sideConnector).toHaveAttribute("x1", "5");
    expect(sideConnector).toHaveAttribute("y2", "100");
    expect(bottomLaneOffsets).toContain("5px");
    expect(bottomLaneOffsets).not.toContain("17px");
  });

  it("keeps an active parent lane continuous through a branch join", () => {
    const main = commit(3);
    const feature = commit(2, { parentHashes: [main.hash] });
    const merge = commit(1, { parentHashes: [main.hash, feature.hash] });
    renderLog({ commits: [merge, feature, main] });

    const joinRow = rowFor("Subject 2");
    const bottomLaneOffsets = Array.from(joinRow.querySelectorAll<HTMLElement>(".log-view__graph-vertical--bottom"))
      .map(lane => lane.style.left);

    expect(bottomLaneOffsets).toContain("5px");
  });

  it("renders rows without the commit graph when hidden", () => {
    renderLog({
      showCommitGraph: false,
      commits: [
        commit(1, { parentHashes: [commit(2).hash] }),
        commit(2),
      ],
    });

    expect(rowFor("Subject 1").querySelector(".log-view__graph")).toBeNull();
  });

  it("renders commit ref decorations beside the subject", () => {
    renderLog({
      commits: [
        commit(1, {
          refDecorations: [
            { name: "main", kind: "localBranch" },
            { name: "v1.0.0", kind: "tag" },
          ],
        }),
      ],
    });

    expect(rowFor("Subject 1")).toHaveTextContent("main");
    expect(rowFor("Subject 1")).toHaveTextContent("v1.0.0");
  });

  it("renders commit ref decorations when the graph is hidden", () => {
    renderLog({
      showCommitGraph: false,
      commits: [
        commit(1, {
          refDecorations: [
            { name: "main", kind: "localBranch" },
          ],
        }),
      ],
    });

    expect(rowFor("Subject 1")).toHaveTextContent("main");
  });

  it("keeps commit ref decorations compact", () => {
    renderLog({
      commits: [
        commit(1, {
          refDecorations: [
            { name: "origin/main", kind: "remoteBranch" },
            { name: "v1.0.0", kind: "tag" },
            { name: "main", kind: "localBranch" },
          ],
        }),
      ],
    });

    expect(rowFor("Subject 1")).toHaveTextContent("main");
    expect(rowFor("Subject 1")).toHaveTextContent("v1.0.0");
    expect(rowFor("Subject 1")).toHaveTextContent("+1");
    expect(rowFor("Subject 1")).not.toHaveTextContent("origin/main");
  });

  it("counts head and upstream markers in the compact ref limit", () => {
    const targetCommit = commit(1, {
      refDecorations: [
        { name: "main", kind: "localBranch" },
        { name: "origin/main", kind: "remoteBranch" },
      ],
    });
    renderLog({
      commits: [targetCommit],
      commitMarkers: {
        localHead: targetCommit.hash,
        upstreamHead: targetCommit.hash,
        upstreamRef: "origin/main",
      },
    });

    const labels = Array.from(rowFor("Subject 1").querySelectorAll(".log-view__refs > span"))
      .map(label => label.textContent);

    expect(labels).toEqual(["HEAD", "origi...", "+1"]);
    expect(screen.getByTitle("origin/main")).toBeInTheDocument();
    expect(screen.getByTitle("1 more refs: main")).toBeInTheDocument();
  });

  it("abbreviates long commit ref labels", () => {
    renderLog({
      commits: [
        commit(1, {
          refDecorations: [
            { name: "0.8.0-develop", kind: "localBranch" },
          ],
        }),
      ],
    });

    expect(rowFor("Subject 1")).toHaveTextContent("0.8.0...");
    expect(rowFor("Subject 1")).not.toHaveTextContent("0.8.0-develop");
    expect(screen.getByTitle("Local branch 0.8.0-develop")).toBeInTheDocument();
  });

  it("renders an explicit load more footer instead of wiring automatic end reached loading", () => {
    const loadMore = vi.fn();
    renderLog({ hasMore: true, loadMore, pageSize: 100 });

    expect(virtuosoEndReached.current).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View next 100 commits" }));

    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it("reveals the first newly loaded commit after the next page is appended", async () => {
    const loadMore = vi.fn();
    const firstPage = [commit(1), commit(2), commit(3)];
    const { rerender } = renderLog({ commits: firstPage, hasMore: true, loadMore });

    fireEvent.click(screen.getByRole("button", { name: "View next 100 commits" }));

    rerender(
      <LogView
        active
        repoPath={null}
        commits={[...firstPage, commit(4), commit(5)]}
        loadMore={loadMore}
        hasMore
        loadingMore={false}
        loadMoreError={null}
        pageSize={100}
        logLoading={false}
        logError={null}
        commitMarkers={{ localHead: null, upstreamHead: null, upstreamRef: null }}
        logScope="currentCheckout"
        rowStriping="Off"
        showCommitGraph
        detachedHead={false}
        shallow={false}
        selectedCommitHash={firstPage[0].hash}
        onSelectCommit={vi.fn()}
      />,
    );

    await waitFor(() => expect(virtuosoScrollToIndex).toHaveBeenCalledWith({ index: 3, align: "start" }));
  });

  it("hides the load more footer when there are no more commits", () => {
    renderLog({ hasMore: false });

    expect(screen.queryByRole("button", { name: "View next 100 commits" })).not.toBeInTheDocument();
  });

  it("hides the load more footer while the first page is loading", () => {
    renderLog({ commits: [], hasMore: true, logLoading: true });

    expect(screen.getByText("Loading commit history...")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "View next 100 commits" })).not.toBeInTheDocument();
  });

  it("keeps the load more footer mounted while refreshing existing commits", () => {
    renderLog({ hasMore: true, logLoading: true });

    expect(screen.getByRole("button", { name: "View next 100 commits" })).toBeInTheDocument();
  });

  it("shows load more loading and error states", () => {
    const loadMore = vi.fn();
    renderLog({
      hasMore: true,
      loadingMore: true,
      loadMoreError: "next page failed",
      loadMore,
    });

    expect(screen.getByText("Could not load more commits: next page failed")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Loading more commits..." });
    expect(button).toBeDisabled();

    fireEvent.click(button);

    expect(loadMore).not.toHaveBeenCalled();
  });

  it("upgrades signed commits after verification", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    mockVerifyCommits.mockResolvedValue([
      {
        hash: signedCommit.hash,
        status: "verified",
        signer: "Test Signer",
        fingerprint: "SHA256:test",
      },
    ]);

    renderLog({ repoPath: "/repo", commits: [signedCommit] });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledWith("/repo", [signedCommit.hash]));
    expect(await screen.findByText("Verified")).toBeInTheDocument();
  });

  it("upgrades signed commits when the graph is hidden", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    mockVerifyCommits.mockResolvedValue([
      {
        hash: signedCommit.hash,
        status: "verified",
        signer: "Test Signer",
        fingerprint: "SHA256:test",
      },
    ]);

    renderLog({ repoPath: "/repo", commits: [signedCommit], showCommitGraph: false });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledWith("/repo", [signedCommit.hash]));
    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(rowFor("Subject 1").querySelector(".log-view__graph")).toBeNull();
  });

  it("does not reverify signed commits after unrelated settings change", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    mockVerifyCommits.mockResolvedValue([
      {
        hash: signedCommit.hash,
        status: "verified",
        signer: "Test Signer",
        fingerprint: "SHA256:test",
      },
    ]);

    renderLog({ repoPath: "/repo", commits: [signedCommit] });

    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(mockVerifyCommits).toHaveBeenCalledTimes(1);

    act(() => {
      emitEvent("settings-updated", settingsPayload);
    });

    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(mockVerifyCommits).toHaveBeenCalledTimes(1);
  });

  it("verifies signed commits again after signature settings change", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    const secondVerification = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    mockVerifyCommits.mockResolvedValueOnce([
      {
        hash: signedCommit.hash,
        status: "verified",
        signer: "Test Signer",
        fingerprint: "SHA256:test",
      },
    ]).mockReturnValueOnce(secondVerification.promise);

    renderLog({ repoPath: "/repo", commits: [signedCommit] });

    await screen.findByText("Verified");
    expect(mockVerifyCommits).toHaveBeenCalledTimes(1);
    await waitForSignatureSettingsListener();

    act(() => {
      emitEvent("signature-settings-updated");
    });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(2));
    expect(mockVerifyCommits).toHaveBeenLastCalledWith("/repo", [signedCommit.hash]);
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText("Signed")).not.toBeInTheDocument();

    await act(async () => {
      secondVerification.resolve([
        {
          hash: signedCommit.hash,
          status: "bad",
          signer: null,
          fingerprint: null,
        },
      ]);
      await secondVerification.promise;
    });

    expect(await screen.findByText("Bad signature")).toBeInTheDocument();
  });

  it("keeps an in-flight verification result if settings change while log is inactive", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    const firstVerification = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    mockVerifyCommits.mockReturnValueOnce(firstVerification.promise);

    const { rerender } = renderLog({ repoPath: "/repo", commits: [signedCommit] });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(1));

    rerender(
      <LogView
        active={false}
        repoPath="/repo"
        commits={[signedCommit]}
        loadMore={vi.fn()}
        hasMore={false}
        loadingMore={false}
        loadMoreError={null}
        pageSize={100}
        logLoading={false}
        logError={null}
        commitMarkers={{ localHead: null, upstreamHead: null, upstreamRef: null }}
        logScope="currentCheckout"
        rowStriping="Off"
        showCommitGraph
        detachedHead={false}
        shallow={false}
        selectedCommitHash={signedCommit.hash}
        onSelectCommit={vi.fn()}
      />,
    );

    act(() => {
      emitEvent("settings-updated", settingsPayload);
    });
    expect(mockVerifyCommits).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstVerification.resolve([
        {
          hash: signedCommit.hash,
          status: "verified",
          signer: "Test Signer",
          fingerprint: "SHA256:test",
        },
      ]);
      await firstVerification.promise;
    });

    expect(await screen.findByText("Verified")).toBeInTheDocument();
  });

  it("retries a rejected verification once on a later visible range event", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    mockVerifyCommits
      .mockRejectedValueOnce(new Error("verification failed"))
      .mockResolvedValueOnce([
        {
          hash: signedCommit.hash,
          status: "verified",
          signer: "Test Signer",
          fingerprint: "SHA256:test",
        },
      ]);

    renderLog({ repoPath: "/repo", commits: [signedCommit] });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(1));
    expect(screen.getByText("Signed")).toBeInTheDocument();

    await act(async () => {
      virtuosoRange.current?.({ startIndex: 0, endIndex: 0 });
    });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Verified")).toBeInTheDocument();

    await act(async () => {
      virtuosoRange.current?.({ startIndex: 0, endIndex: 0 });
    });

    expect(mockVerifyCommits).toHaveBeenCalledTimes(2);
  });

  it("verifies signed commits from rendered items when range changes are not emitted", async () => {
    const commits = Array.from({ length: 26 }, (_, index) => (
      commit(index + 1, {
        hash: String(index + 1).padStart(40, "0"),
        shortHash: String(index + 1).padStart(7, "0"),
        signatureStatus: index === 25 ? "signed" : "none",
      })
    ));
    mockVerifyCommits.mockResolvedValue([
      {
        hash: commits[25].hash,
        status: "verified",
        signer: "Test Signer",
        fingerprint: "SHA256:test",
      },
    ]);

    renderLog({ repoPath: "/repo", commits });

    expect(mockVerifyCommits).not.toHaveBeenCalled();

    await act(async () => {
      virtuosoItemsRendered.current?.([{ index: 25 }]);
    });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledWith("/repo", [commits[25].hash]));
    await act(async () => {
      virtuosoSetVisibleRange.current?.({ startIndex: 25, endIndex: 25 });
    });
    expect(await screen.findByText("Verified")).toBeInTheDocument();
  });

  it("verifies loaded signed commits beyond the visible window", async () => {
    const commits = Array.from({ length: 26 }, (_, index) => (
      commit(index + 1, {
        hash: String(index + 1).padStart(40, "0"),
        shortHash: String(index + 1).padStart(7, "0"),
        signatureStatus: index === 25 ? "signed" : "none",
      })
    ));
    mockVerifyCommits.mockResolvedValue([
      {
        hash: commits[25].hash,
        status: "verified",
        signer: "Test Signer",
        fingerprint: "SHA256:test",
      },
    ]);

    virtuosoCallbacksEnabled.current = false;
    renderLog({ repoPath: "/repo", commits });

    expect(mockVerifyCommits).not.toHaveBeenCalled();

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledWith("/repo", [commits[25].hash]));
    await act(async () => {
      virtuosoSetVisibleRange.current?.({ startIndex: 25, endIndex: 25 });
    });
    expect(await screen.findByText("Verified")).toBeInTheDocument();
  });

  it("keeps verified visible when a revalidation request rejects", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    mockVerifyCommits
      .mockResolvedValueOnce([
        {
          hash: signedCommit.hash,
          status: "verified",
          signer: "Test Signer",
          fingerprint: "SHA256:test",
        },
      ])
      .mockRejectedValueOnce(new Error("verification failed"));

    renderLog({ repoPath: "/repo", commits: [signedCommit] });

    expect(await screen.findByText("Verified")).toBeInTheDocument();
    await waitForSignatureSettingsListener();

    act(() => {
      emitEvent("signature-settings-updated");
    });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText("Signed")).not.toBeInTheDocument();
  });

  it("caps visible verification batches at twenty commits", async () => {
    const signedCommits = Array.from({ length: 25 }, (_, index) => (
      commit(index + 1, {
        hash: String(index + 1).padStart(40, "0"),
        shortHash: String(index + 1).padStart(7, "0"),
        signatureStatus: "signed",
      })
    ));
    const firstBatch = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    mockVerifyCommits.mockReturnValue(firstBatch.promise);

    renderLog({ repoPath: "/repo", commits: signedCommits });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(1));
    expect(mockVerifyCommits.mock.calls[0][1]).toHaveLength(20);
  });

  it("verifies SSH signatures before GPG signatures that may need keyserver lookup", async () => {
    const sshCommit = commit(1, { signatureStatus: "signed", keyType: "ssh" });
    const gpgCommit = commit(2, { signatureStatus: "signed", keyType: "gpg" });
    const sshVerification = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    mockVerifyCommits
      .mockReturnValueOnce(sshVerification.promise)
      .mockResolvedValueOnce([
        {
          hash: gpgCommit.hash,
          status: "unknownKey",
          signer: null,
          fingerprint: "B5690EEEBB952194",
        },
      ]);

    renderLog({ repoPath: "/repo", commits: [sshCommit, gpgCommit] });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(1));
    expect(mockVerifyCommits).toHaveBeenCalledWith("/repo", [sshCommit.hash]);

    await act(async () => {
      sshVerification.resolve([
        {
          hash: sshCommit.hash,
          status: "verified",
          signer: "Test Signer",
          fingerprint: "SHA256:test",
        },
      ]);
      await sshVerification.promise;
    });

    expect(await screen.findByText("Verified")).toBeInTheDocument();
    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(2));
    expect(mockVerifyCommits).toHaveBeenLastCalledWith("/repo", [gpgCommit.hash]);
  });

  it("ignores verification results from an older repo generation", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    const firstVerification = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    const secondVerification = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    mockVerifyCommits
      .mockReturnValueOnce(firstVerification.promise)
      .mockReturnValueOnce(secondVerification.promise);

    const { rerender } = renderLog({ repoPath: "/repo", commits: [signedCommit] });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(1));

    rerender(
      <LogView
        active
        repoPath="/other-repo"
        commits={[signedCommit]}
        loadMore={vi.fn()}
        hasMore={false}
        loadingMore={false}
        loadMoreError={null}
        pageSize={100}
        logLoading={false}
        logError={null}
        commitMarkers={{ localHead: null, upstreamHead: null, upstreamRef: null }}
        logScope="currentCheckout"
        rowStriping="Off"
        showCommitGraph
        detachedHead={false}
        shallow={false}
        selectedCommitHash={signedCommit.hash}
        onSelectCommit={vi.fn()}
      />,
    );
    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(2));

    await act(async () => {
      secondVerification.resolve([
        {
          hash: signedCommit.hash,
          status: "verified",
          signer: "Test Signer",
          fingerprint: "SHA256:test",
        },
      ]);
      await secondVerification.promise;
    });
    expect(await screen.findByText("Verified")).toBeInTheDocument();

    await act(async () => {
      firstVerification.resolve([
        {
          hash: signedCommit.hash,
          status: "bad",
          signer: null,
          fingerprint: null,
        },
      ]);
      await firstVerification.promise;
    });

    expect(screen.getByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText("Bad signature")).not.toBeInTheDocument();
  });

  it("keeps an earlier concrete verification result when a queued recheck returns nothing", async () => {
    const signedCommit = commit(1, { signatureStatus: "signed" });
    const firstVerification = deferred<Awaited<ReturnType<typeof verifyCommits>>>();
    mockVerifyCommits
      .mockReturnValueOnce(firstVerification.promise)
      .mockResolvedValueOnce([]);

    renderLog({ repoPath: "/repo", commits: [signedCommit] });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(1));
    await waitForSignatureSettingsListener();

    act(() => {
      emitEvent("signature-settings-updated");
    });

    await act(async () => {
      firstVerification.resolve([
        {
          hash: signedCommit.hash,
          status: "verified",
          signer: "Test Signer",
          fingerprint: "SHA256:test",
        },
      ]);
      await firstVerification.promise;
    });

    await waitFor(() => expect(mockVerifyCommits).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("Verified")).toBeInTheDocument();
    expect(screen.queryByText("Signed")).not.toBeInTheDocument();
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
