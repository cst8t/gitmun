// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useGitBranches } from "./useGitBranches";
import type { BranchInfo } from "../types";

vi.mock("../api/commands", () => ({
  getBranches: vi.fn(),
}));

import { getBranches } from "../api/commands";
const mockGetBranches = vi.mocked(getBranches);

function makeBranch(name: string, overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name,
    isCurrent: false,
    isRemote: false,
    upstream: null,
    upstreamStatus: "none",
    ahead: 0,
    behind: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGitBranches", () => {
  test("fetches branches on mount", async () => {
    mockGetBranches.mockResolvedValue([
      makeBranch("main", { isCurrent: true }),
      makeBranch("dev"),
    ]);
    const { result } = renderHook(() => useGitBranches("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.branches).toHaveLength(2);
    expect(result.current.branches[0].name).toBe("main");
    expect(result.current.error).toBeNull();
  });

  test("returns empty branches for null repoPath", async () => {
    const { result } = renderHook(() => useGitBranches(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.branches).toHaveLength(0);
    expect(mockGetBranches).not.toHaveBeenCalled();
  });

  test("sets error when fetch fails", async () => {
    mockGetBranches.mockRejectedValue(new Error("not a repo"));
    const { result } = renderHook(() => useGitBranches("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("not a repo");
    expect(result.current.branches).toHaveLength(0);
  });

  test("clears branches immediately when repoPath changes", async () => {
    mockGetBranches.mockResolvedValue([
      makeBranch("main", { isCurrent: true }),
    ]);
    const { result, rerender } = renderHook(
      ({ path }) => useGitBranches(path),
      { initialProps: { path: "/repo-a" as string | null } },
    );
    await waitFor(() => expect(result.current.branches).toHaveLength(1));

    mockGetBranches.mockResolvedValue([]);
    await act(async () => { rerender({ path: "/repo-b" }); });
    // Branches should reset before the new fetch completes
    expect(result.current.branches).toHaveLength(0);
  });

  test("discards stale result when repo changes mid-fetch", async () => {
    let resolveFirst!: (v: typeof mockGetBranches extends (...args: any[]) => Promise<infer R> ? R : never) => void;
    const firstFetch = new Promise<Awaited<ReturnType<typeof getBranches>>>((res) => {
      resolveFirst = res;
    });
    mockGetBranches.mockReturnValueOnce(firstFetch);
    mockGetBranches.mockResolvedValue([]);

    const { result, rerender } = renderHook(
      ({ path }) => useGitBranches(path),
      { initialProps: { path: "/repo-a" as string | null } },
    );

    // Switch repo before first fetch resolves
    rerender({ path: "/repo-b" });
    await waitFor(() => expect(mockGetBranches).toHaveBeenCalledWith("/repo-b"));

    // Now resolve the stale /repo-a response
    act(() => {
      resolveFirst([makeBranch("stale")]);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Stale branches must not appear
    expect(result.current.branches.some((b) => b.name === "stale")).toBe(false);
  });

  test("refresh re-fetches branches", async () => {
    mockGetBranches.mockResolvedValue([
      makeBranch("main", { isCurrent: true }),
    ]);
    const { result } = renderHook(() => useGitBranches("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetBranches.mockResolvedValue([
      makeBranch("main", { isCurrent: true }),
      makeBranch("feature"),
    ]);
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.branches).toHaveLength(2));
  });
});
