// @vitest-environment jsdom

import {act, renderHook, waitFor} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import {useAiConflictResolution} from "./useAiConflictResolution";

const mocks = vi.hoisted(() => ({
  getAiConfiguration: vi.fn(),
  getAiConflictEligibility: vi.fn(),
  resolveConflictWithAi: vi.fn(),
  cancelAiOperation: vi.fn(),
  applyAiConflictProposal: vi.fn(),
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock("@tauri-apps/api/event", () => ({listen: mocks.listen}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ask: vi.fn(async () => true)}));
vi.mock("./commands", () => ({
  applyAiConflictProposal: mocks.applyAiConflictProposal,
  cancelAiOperation: mocks.cancelAiOperation,
  getAiConfiguration: mocks.getAiConfiguration,
  getAiConflictContextPreview: vi.fn(),
  getAiConflictEligibility: mocks.getAiConflictEligibility,
  grantAiConsent: vi.fn(),
  regenerateAiConflictRegions: vi.fn(),
  resolveConflictWithAi: mocks.resolveConflictWithAi,
  undoAiConflictBatch: vi.fn(),
  undoAiConflictProposal: vi.fn(),
}));

describe("useAiConflictResolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cancelAiOperation.mockResolvedValue(undefined);
  });

  it("stays inert when the AI extension cannot initialise", async () => {
    mocks.getAiConfiguration.mockRejectedValue(new Error("extension unavailable"));
    const showToast = vi.fn();
    const {result} = renderHook(() => useAiConflictResolution({
      repoPath: "/repo",
      settingsRevision: 0,
      showToast,
      refreshStatus: vi.fn(async () => {}),
    }));

    await waitFor(() => expect(mocks.getAiConfiguration).toHaveBeenCalledOnce());
    expect(result.current.enabled).toBe(false);
    expect(result.current.configured).toBe(false);
    expect(result.current.isAvailable).toBe(false);

    await act(async () => {
      await result.current.resolveWithAi("conflicted.txt");
      await result.current.resolveAllWithAi(["conflicted.txt"]);
      await expect(result.current.getConflictEligibility("conflicted.txt"))
        .resolves.toEqual({eligible: false, reason: null});
    });

    expect(mocks.resolveConflictWithAi).not.toHaveBeenCalled();
    expect(mocks.getAiConflictEligibility).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("does not expose conflict actions when AI is disabled", async () => {
    mocks.getAiConfiguration.mockResolvedValue({enabled: false, configured: true});
    const {result} = renderHook(() => useAiConflictResolution({
      repoPath: "/repo",
      settingsRevision: 0,
      showToast: vi.fn(),
      refreshStatus: vi.fn(async () => {}),
    }));

    await waitFor(() => expect(result.current.configured).toBe(true));
    expect(result.current.isAvailable).toBe(false);

    await act(async () => {
      await result.current.resolveWithAi("conflicted.txt");
    });

    expect(mocks.resolveConflictWithAi).not.toHaveBeenCalled();
  });

  it("cancels the active conflict request with its operation ID", async () => {
    mocks.getAiConfiguration.mockResolvedValue({enabled: true, configured: true, consentRequired: false});
    let rejectResolution: (reason: unknown) => void = () => {};
    mocks.resolveConflictWithAi.mockReturnValue(new Promise((_resolve, reject) => {
      rejectResolution = reject;
    }));
    const {result} = renderHook(() => useAiConflictResolution({
      repoPath: "/repo",
      settingsRevision: 0,
      showToast: vi.fn(),
      refreshStatus: vi.fn(async () => {}),
    }));
    await waitFor(() => expect(result.current.isAvailable).toBe(true));

    let resolution: Promise<void> | undefined;
    act(() => {
      resolution = result.current.resolveWithAi("conflicted.txt");
    });
    await waitFor(() => expect(result.current.operationId).toMatch(/^conflict-/));
    const operationId = result.current.operationId;

    await act(async () => {
      await result.current.cancel();
    });
    expect(mocks.cancelAiOperation).toHaveBeenCalledWith(operationId);

    await act(async () => {
      rejectResolution({code: "operationCancelled"});
      await resolution;
    });
    expect(result.current.resolvingPath).toBeNull();
  });

  it("refreshes status only after a proposal is applied", async () => {
    mocks.getAiConfiguration.mockResolvedValue({enabled: true, configured: true});
    mocks.applyAiConflictProposal.mockResolvedValue({
      filePath: "conflicted.txt",
      markedResolved: true,
      resolvedRegions: 2,
    });
    const showToast = vi.fn();
    const refreshStatus = vi.fn(async () => {});
    const {result} = renderHook(() => useAiConflictResolution({
      repoPath: "/repo",
      settingsRevision: 0,
      showToast,
      refreshStatus,
    }));

    await act(async () => {
      await result.current.applyProposal("proposal-1", ["region-1", "region-2"]);
    });

    expect(mocks.applyAiConflictProposal).toHaveBeenCalledWith(
      "proposal-1",
      ["region-1", "region-2"],
    );
    expect(mocks.applyAiConflictProposal.mock.invocationCallOrder[0])
      .toBeLessThan(refreshStatus.mock.invocationCallOrder[0]);
  });
});
