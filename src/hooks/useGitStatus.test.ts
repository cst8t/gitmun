// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { useGitStatus } from "./useGitStatus";

vi.mock("../api/commands", () => ({
  getRepoStatus: vi.fn(),
}));

import { getRepoStatus } from "../api/commands";
const mockGetRepoStatus = vi.mocked(getRepoStatus);

function makeStatus(overrides = {}) {
  return {
    changed_files: [],
    staged_files: [],
    unversioned_files: [],
    current_branch: "main",
    merge_in_progress: false,
    merge_head_branch: null,
    conflicted_files: [],
    merge_message: null,
    rebase_in_progress: false,
    rebase_onto: null,
    cherry_pick_in_progress: false,
    cherry_pick_head: null,
    revert_in_progress: false,
    revert_head: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGitStatus", () => {
  test("fetches status on mount", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus({ current_branch: "main" }));
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.current_branch).toBe("main");
    expect(result.current.error).toBeNull();
  });

  test("returns null status for null repoPath", async () => {
    const { result } = renderHook(() => useGitStatus(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status).toBeNull();
    expect(mockGetRepoStatus).not.toHaveBeenCalled();
  });

  test("sets error when fetch fails", async () => {
    mockGetRepoStatus.mockRejectedValue(new Error("not a repo"));
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("not a repo");
    expect(result.current.status).toBeNull();
  });

  test("refresh re-fetches status", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus({ current_branch: "main" }));
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetRepoStatus.mockResolvedValue(makeStatus({ current_branch: "feature" }));
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.status?.current_branch).toBe("feature"));
  });

  test("silent refresh skips loading state", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus());
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetRepoStatus.mockResolvedValue(makeStatus({ current_branch: "dev" }));
    act(() => { result.current.refresh({ silent: true }); });
    // loading must never become true during a silent refresh
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.status?.current_branch).toBe("dev"));
    expect(result.current.loading).toBe(false);
  });

  test("resets status when repoPath changes", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus());
    const { result, rerender } = renderHook(
      ({ path }) => useGitStatus(path),
      { initialProps: { path: "/repo-a" as string | null } },
    );
    await waitFor(() => expect(result.current.status).not.toBeNull());

    // Hold the /repo-b fetch so we can observe the transient null
    let resolveRepoB!: (v: ReturnType<typeof makeStatus>) => void;
    mockGetRepoStatus.mockReturnValue(
      new Promise<ReturnType<typeof makeStatus>>((res) => { resolveRepoB = res; }) as any,
    );
    act(() => { rerender({ path: "/repo-b" }); });
    // Status must clear immediately before the new fetch settles
    expect(result.current.status).toBeNull();

    // Let the fetch complete so the hook isn't left in a loading state
    act(() => { resolveRepoB(makeStatus()); });
    await waitFor(() => expect(result.current.status).not.toBeNull());
  });

  test("refreshes on window focus event", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus());
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetRepoStatus.mockResolvedValue(makeStatus({ current_branch: "after-focus" }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.status?.current_branch).toBe("after-focus"),
    );
  });
});
