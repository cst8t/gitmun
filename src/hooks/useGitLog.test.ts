// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useGitLog } from "./useGitLog";
import type { CommitLogScope } from "../types";

vi.mock("../api/commands", () => ({
  getCommitHistory: vi.fn(),
}));

import { getCommitHistory } from "../api/commands";
const mockGetCommitHistory = vi.mocked(getCommitHistory);

function makeCommits(count: number, startHash = 0) {
  return Array.from({ length: count }, (_, i) => ({
    hash: `hash${startHash + i}`,
    shortHash: `h${startHash + i}`,
    message: `commit ${startHash + i}`,
    author: "Test User",
    authorEmail: "test@example.com",
    date: "2024-01-01T00:00:00Z",
    parentHashes: [],
    refDecorations: [],
    signatureStatus: "none" as const,
    keyType: null,
  }));
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGitLog", () => {
  test("fetches first page on mount", async () => {
    mockGetCommitHistory.mockResolvedValue(makeCommits(3));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toHaveLength(3);
    expect(result.current.error).toBeNull();
  });

  test("hasMore is false when page is less than 100", async () => {
    mockGetCommitHistory.mockResolvedValue(makeCommits(50));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);
  });

  test("hasMore is true when page is exactly 100", async () => {
    mockGetCommitHistory.mockResolvedValue(makeCommits(100));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.pageSize).toBe(100);
  });

  test("loadMore appends next page", async () => {
    mockGetCommitHistory
      .mockResolvedValueOnce(makeCommits(100))
      .mockResolvedValueOnce(makeCommits(50, 100));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toHaveLength(100);

    act(() => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.loadingMore).toBe(false));
    expect(result.current.commits).toHaveLength(150);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.loadMoreError).toBeNull();
  });

  test("loadMore records a retryable error without clearing commits", async () => {
    mockGetCommitHistory
      .mockResolvedValueOnce(makeCommits(100))
      .mockRejectedValueOnce(new Error("next page failed"))
      .mockResolvedValueOnce(makeCommits(1, 100));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.loadMore(); });

    await waitFor(() => expect(result.current.loadMoreError).toContain("next page failed"));
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.commits).toHaveLength(100);
    expect(result.current.hasMore).toBe(true);

    act(() => { result.current.loadMore(); });

    await waitFor(() => expect(result.current.commits).toHaveLength(101));
    expect(result.current.loadMoreError).toBeNull();
  });

  test("loadMore appends when a refresh overlaps the request", async () => {
    const nextPage = deferred<ReturnType<typeof makeCommits>>();
    const refreshPage = deferred<ReturnType<typeof makeCommits>>();
    mockGetCommitHistory
      .mockResolvedValueOnce(makeCommits(100))
      .mockReturnValueOnce(nextPage.promise)
      .mockReturnValueOnce(refreshPage.promise);
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => { result.current.loadMore(); });
    await waitFor(() => expect(result.current.loadingMore).toBe(true));
    act(() => { result.current.refresh(); });

    await act(async () => {
      refreshPage.resolve(makeCommits(100));
      await refreshPage.promise;
    });
    expect(result.current.commits).toHaveLength(100);

    await act(async () => {
      nextPage.resolve(makeCommits(100, 100));
      await nextPage.promise;
    });

    await waitFor(() => expect(result.current.commits).toHaveLength(200));
    expect(result.current.commits[100].hash).toBe("hash100");
  });

  test("loadMore does nothing when hasMore is false", async () => {
    mockGetCommitHistory.mockResolvedValue(makeCommits(3));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    act(() => { result.current.loadMore(); });
    // getCommitHistory was only called once (on mount), not again
    expect(mockGetCommitHistory).toHaveBeenCalledTimes(1);
  });

  test("resets state when repoPath changes", async () => {
    mockGetCommitHistory.mockResolvedValue(makeCommits(5));
    const { result, rerender } = renderHook(
      ({ path }) => useGitLog(path),
      { initialProps: { path: "/repo-a" as string | null } },
    );
    await waitFor(() => expect(result.current.commits).toHaveLength(5));

    mockGetCommitHistory.mockResolvedValue(makeCommits(2, 100));
    rerender({ path: "/repo-b" });
    // Should reset immediately
    expect(result.current.commits).toHaveLength(0);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.loadMoreError).toBeNull();
    await waitFor(() => expect(result.current.commits).toHaveLength(2));
  });

  test("refetches when log scope changes", async () => {
    mockGetCommitHistory
      .mockResolvedValueOnce(makeCommits(1))
      .mockResolvedValueOnce(makeCommits(2, 10));
    const { result, rerender } = renderHook(
      ({ scope }) => useGitLog("/repo", scope),
      { initialProps: { scope: "currentCheckout" as CommitLogScope } },
    );
    await waitFor(() => expect(result.current.commits).toHaveLength(1));

    rerender({ scope: "allRefs" });
    expect(result.current.commits).toHaveLength(0);
    await waitFor(() => expect(result.current.commits).toHaveLength(2));
    expect(mockGetCommitHistory).toHaveBeenLastCalledWith("/repo", 100, undefined, undefined, "allRefs", false);
  });

  test("refetches with topo order when requested", async () => {
    mockGetCommitHistory
      .mockResolvedValueOnce(makeCommits(1))
      .mockResolvedValueOnce(makeCommits(2, 10));
    const { result, rerender } = renderHook(
      ({ topoOrder }) => useGitLog("/repo", "currentCheckout", true, topoOrder),
      { initialProps: { topoOrder: false } },
    );
    await waitFor(() => expect(result.current.commits).toHaveLength(1));
    expect(mockGetCommitHistory).toHaveBeenLastCalledWith("/repo", 100, undefined, undefined, "currentCheckout", false);

    rerender({ topoOrder: true });

    expect(result.current.commits).toHaveLength(0);
    await waitFor(() => expect(result.current.commits).toHaveLength(2));
    expect(mockGetCommitHistory).toHaveBeenLastCalledWith("/repo", 100, undefined, undefined, "currentCheckout", true);
  });

  test("sets error on fetch failure", async () => {
    mockGetCommitHistory.mockRejectedValue(new Error("git error"));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("git error");
  });

  test("defers refreshes while the window is not focused", async () => {
    mockGetCommitHistory
      .mockResolvedValueOnce(makeCommits(1))
      .mockResolvedValueOnce(makeCommits(2, 10));
    const { result, rerender } = renderHook(
      ({ focused }) => useGitLog("/repo", "currentCheckout", focused),
      { initialProps: { focused: true } },
    );
    await waitFor(() => expect(result.current.commits).toHaveLength(1));

    rerender({ focused: false });
    act(() => { result.current.refresh(); });

    expect(mockGetCommitHistory).toHaveBeenCalledTimes(1);
    expect(result.current.commits).toHaveLength(1);

    rerender({ focused: true });

    await waitFor(() => expect(result.current.commits).toHaveLength(2));
    expect(mockGetCommitHistory).toHaveBeenCalledTimes(2);
  });

  test("returns empty commits for null repoPath", async () => {
    const { result } = renderHook(() => useGitLog(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toHaveLength(0);
    expect(mockGetCommitHistory).not.toHaveBeenCalled();
  });
});
