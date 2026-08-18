// @vitest-environment jsdom

import {act, renderHook} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import "../i18n";
import {useRemoteOperations} from "./useRemoteOperations";

const mocks = vi.hoisted(() => ({
  fetchRemote: vi.fn(),
  appendResultLog: vi.fn(),
}));

vi.mock("../api/commands", () => ({
  analyzePull: vi.fn(),
  fetchRemote: mocks.fetchRemote,
  pullWithStrategy: vi.fn(),
  pushChanges: vi.fn(),
  setBranchUpstream: vi.fn(),
}));
vi.mock("../utils/resultLog", () => ({appendResultLog: mocks.appendResultLog}));

describe("useRemoteOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports a fetch result before refreshing repository data", async () => {
    mocks.fetchRemote.mockResolvedValue({backendUsed: "git-cli"});
    const showToast = vi.fn();
    const refreshAll = vi.fn(async () => {});
    const {result} = renderHook(() => useRemoteOperations({
      repoPath: "/repo",
      currentBranchInfo: null,
      remoteActionKind: "push",
      forceWithLeaseAfterRebase: false,
      pushFollowTags: false,
      refreshAll,
      showToast,
      onForcePushComplete: vi.fn(),
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
  });
});
