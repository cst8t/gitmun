// @vitest-environment jsdom

import {act, renderHook} from "@testing-library/react";
import {beforeEach, describe, expect, it, vi} from "vitest";
import "../i18n";
import {useStagingOperations} from "./useStagingOperations";
import type {LongRunningOperation} from "../types";

const mocks = vi.hoisted(() => ({
  stageFiles: vi.fn(),
  appendResultLog: vi.fn(),
}));

vi.mock("../api/commands", () => ({
  discardFile: vi.fn(),
  setConfirmRevert: vi.fn(),
  stageAll: vi.fn(),
  stageFiles: mocks.stageFiles,
  unstageAll: vi.fn(),
  unstageFile: vi.fn(),
  unstageFiles: vi.fn(),
}));
vi.mock("../utils/resultLog", () => ({appendResultLog: mocks.appendResultLog}));

describe("useStagingOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps stage result reporting and status refresh ordering", async () => {
    const operation: LongRunningOperation = {id: 1, kind: "stage", count: 1, startedAt: 1};
    const startOperation = vi.fn(() => operation);
    const finishOperation = vi.fn();
    const showToast = vi.fn();
    const refreshStatus = vi.fn(async () => {});
    mocks.stageFiles.mockResolvedValue({backendUsed: "git-cli"});
    const {result} = renderHook(() => useStagingOperations({
      repoPath: "/repo",
      confirmRevert: true,
      onSetConfirmRevert: vi.fn(),
      refreshStatus,
      showToast,
      startOperation,
      finishOperation,
    }));

    await act(async () => {
      await result.current.stageFile("src/harbour.ts");
    });

    expect(startOperation).toHaveBeenCalledWith("stage", 1);
    expect(mocks.stageFiles).toHaveBeenCalledWith("/repo", ["src/harbour.ts"]);
    expect(showToast).toHaveBeenCalledWith("Staged harbour.ts");
    expect(mocks.appendResultLog).toHaveBeenCalledWith(
      "success",
      "Staged src/harbour.ts",
      "git-cli",
    );
    expect(mocks.stageFiles.mock.invocationCallOrder[0]).toBeLessThan(showToast.mock.invocationCallOrder[0]);
    expect(showToast.mock.invocationCallOrder[0]).toBeLessThan(mocks.appendResultLog.mock.invocationCallOrder[0]);
    expect(mocks.appendResultLog.mock.invocationCallOrder[0]).toBeLessThan(refreshStatus.mock.invocationCallOrder[0]);
    expect(refreshStatus.mock.invocationCallOrder[0]).toBeLessThan(finishOperation.mock.invocationCallOrder[0]);
  });
});
