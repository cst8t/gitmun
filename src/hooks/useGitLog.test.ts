// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useGitLog } from "./useGitLog";

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
    signatureStatus: "none" as const,
    keyType: null,
  }));
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
    await waitFor(() => expect(result.current.commits).toHaveLength(2));
  });

  test("sets error on fetch failure", async () => {
    mockGetCommitHistory.mockRejectedValue(new Error("git error"));
    const { result } = renderHook(() => useGitLog("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("git error");
  });

  test("returns empty commits for null repoPath", async () => {
    const { result } = renderHook(() => useGitLog(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.commits).toHaveLength(0);
    expect(mockGetCommitHistory).not.toHaveBeenCalled();
  });
});
