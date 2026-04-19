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
    changedFiles: [],
    stagedFiles: [],
    unversionedFiles: [],
    submodules: [],
    currentBranch: "main",
    mergeInProgress: false,
    mergeHeadBranch: null,
    conflictedFiles: [],
    mergeMessage: null,
    rebaseInProgress: false,
    rebaseOnto: null,
    cherryPickInProgress: false,
    cherryPickHead: null,
    revertInProgress: false,
    revertHead: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useGitStatus", () => {
  test("fetches status on mount", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus({ currentBranch: "main" }));
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.status?.currentBranch).toBe("main");
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
    mockGetRepoStatus.mockResolvedValue(makeStatus({ currentBranch: "main" }));
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetRepoStatus.mockResolvedValue(makeStatus({ currentBranch: "feature" }));
    act(() => { result.current.refresh(); });
    await waitFor(() => expect(result.current.status?.currentBranch).toBe("feature"));
  });

  test("silent refresh skips loading state", async () => {
    mockGetRepoStatus.mockResolvedValue(makeStatus());
    const { result } = renderHook(() => useGitStatus("/repo"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    mockGetRepoStatus.mockResolvedValue(makeStatus({ currentBranch: "dev" }));
    act(() => { result.current.refresh({ silent: true }); });
    // loading must never become true during a silent refresh
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.status?.currentBranch).toBe("dev"));
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

    mockGetRepoStatus.mockResolvedValue(makeStatus({ currentBranch: "after-focus" }));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() =>
      expect(result.current.status?.currentBranch).toBe("after-focus"),
    );
  });
});
