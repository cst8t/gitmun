// @vitest-environment jsdom

import {act, renderHook} from "@testing-library/react";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import "../i18n";
import {useRemoteOperations} from "./useRemoteOperations";

const mocks = vi.hoisted(() => ({
  fetchRemote: vi.fn(),
  analyzePull: vi.fn(),
  pullWithStrategy: vi.fn(),
  pushChanges: vi.fn(),
  appendResultLog: vi.fn(),
}));

vi.mock("../api/commands", () => ({
  analyzePull: mocks.analyzePull,
  fetchRemote: mocks.fetchRemote,
  pullWithStrategy: mocks.pullWithStrategy,
  pushChanges: mocks.pushChanges,
  setBranchUpstream: vi.fn(),
}));
vi.mock("../utils/resultLog", () => ({appendResultLog: mocks.appendResultLog}));

describe("useRemoteOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  it("reports a fetch result before refreshing repository data", async () => {
    mocks.fetchRemote.mockResolvedValue({backendUsed: "git-cli"});
    const showToast = vi.fn();
    const refreshAll = vi.fn(async () => {});
    const onFetchAttemptComplete = vi.fn();
    const {result} = renderHook(() => useRemoteOperations({
      repoPath: "/repo",
      currentBranchInfo: null,
      remoteActionKind: "push",
      forceWithLeaseAfterRebase: false,
      pushFollowTags: false,
      refreshAll,
      showToast,
      onForcePushComplete: vi.fn(),
      onFetchAttemptComplete,
    }));

    await act(async () => {
      await result.current.fetch();
    });

    expect(mocks.fetchRemote).toHaveBeenCalledWith("/repo");
    expect(showToast).toHaveBeenCalledWith("Fetch complete");
    expect(mocks.appendResultLog).toHaveBeenCalledWith("success", "Fetch complete", "git-cli");
    expect(mocks.fetchRemote.mock.invocationCallOrder[0]).toBeLessThan(showToast.mock.invocationCallOrder[0]);
    expect(showToast.mock.invocationCallOrder[0]).toBeLessThan(mocks.appendResultLog.mock.invocationCallOrder[0]);
    expect(mocks.appendResultLog.mock.invocationCallOrder[0]).toBeLessThan(refreshAll.mock.invocationCallOrder[0]);
    expect(onFetchAttemptComplete).toHaveBeenCalledWith("/repo");
  });

  it("throttles failed automatic fetch attempts without showing a toast", async () => {
    mocks.fetchRemote.mockRejectedValue(new Error("offline"));
    const showToast = vi.fn();
    const onFetchAttemptComplete = vi.fn();
    const {result} = renderHook(() => useRemoteOperations({
      repoPath: "/offline-repo",
      currentBranchInfo: null,
      remoteActionKind: "push",
      forceWithLeaseAfterRebase: false,
      pushFollowTags: false,
      refreshAll: vi.fn(async () => {}),
      showToast,
      onForcePushComplete: vi.fn(),
      onFetchAttemptComplete,
    }));

    await act(async () => {
      await result.current.autoFetch();
    });

    expect(showToast).not.toHaveBeenCalled();
    expect(onFetchAttemptComplete).toHaveBeenCalledWith("/offline-repo");
  });

  it("keeps remote operations locked after an automatic fetch timeout", async () => {
    vi.useFakeTimers();
    let finishFetch!: (value: {backendUsed: string}) => void;
    mocks.fetchRemote.mockReturnValue(new Promise(resolve => { finishFetch = resolve; }));
    const onFetchAttemptComplete = vi.fn();
    const {result} = renderHook(() => useRemoteOperations({
      repoPath: "/slow-repo",
      currentBranchInfo: null,
      remoteActionKind: "push",
      forceWithLeaseAfterRebase: false,
      pushFollowTags: false,
      refreshAll: vi.fn(async () => {}),
      showToast: vi.fn(),
      onForcePushComplete: vi.fn(),
      onFetchAttemptComplete,
    }));

    let autoFetchPromise!: Promise<void>;
    act(() => {
      autoFetchPromise = result.current.autoFetch();
    });
    await act(() => vi.advanceTimersByTimeAsync(90_000));

    expect(result.current.remoteOp).toBe("fetch");
    expect(mocks.appendResultLog).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("Automatic fetch timed out"),
      "unknown",
    );
    expect(onFetchAttemptComplete).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.fetch();
    });
    expect(mocks.fetchRemote).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishFetch({backendUsed: "git-cli"});
      await autoFetchPromise;
    });
    expect(result.current.remoteOp).toBeNull();
    expect(onFetchAttemptComplete).toHaveBeenCalledWith("/slow-repo");
  });

  it("throttles failed manual and successful single-remote fetches", async () => {
    mocks.fetchRemote.mockRejectedValueOnce(new Error("offline"));
    const onFetchAttemptComplete = vi.fn();
    const {result} = renderHook(() => useRemoteOperations({
      repoPath: "/manual-repo",
      currentBranchInfo: null,
      remoteActionKind: "push",
      forceWithLeaseAfterRebase: false,
      pushFollowTags: false,
      refreshAll: vi.fn(async () => {}),
      showToast: vi.fn(),
      onForcePushComplete: vi.fn(),
      onFetchAttemptComplete,
    }));

    await act(async () => {
      await result.current.fetch();
    });
    expect(onFetchAttemptComplete).toHaveBeenLastCalledWith("/manual-repo");

    mocks.fetchRemote.mockResolvedValueOnce({message: "Fetched upstream", backendUsed: "git-cli"});
    await act(async () => {
      await result.current.fetchSingleRemote("upstream");
    });
    expect(onFetchAttemptComplete).toHaveBeenCalledTimes(2);
  });

  it("throttles pull attempts but not push attempts", async () => {
    mocks.analyzePull.mockResolvedValue({state: "behind_only"});
    mocks.pullWithStrategy.mockResolvedValue({message: "Pulled", backendUsed: "git-cli"});
    mocks.pushChanges.mockResolvedValue({success: true, message: "Pushed", backendUsed: "git-cli"});
    const onFetchAttemptComplete = vi.fn();
    const {result} = renderHook(() => useRemoteOperations({
      repoPath: "/repo",
      currentBranchInfo: null,
      remoteActionKind: "push",
      forceWithLeaseAfterRebase: false,
      pushFollowTags: false,
      refreshAll: vi.fn(async () => {}),
      showToast: vi.fn(),
      onForcePushComplete: vi.fn(),
      onFetchAttemptComplete,
    }));

    await act(async () => {
      await result.current.pull();
    });
    expect(onFetchAttemptComplete).toHaveBeenCalledWith("/repo");

    onFetchAttemptComplete.mockClear();
    await act(async () => {
      await result.current.push();
    });
    expect(onFetchAttemptComplete).not.toHaveBeenCalled();
  });
});
