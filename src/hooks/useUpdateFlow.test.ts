// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import "../i18n";
import { useUpdateFlow } from "./useUpdateFlow";

vi.mock("../api/commands", () => ({
  getAppUpdateChannel: vi.fn(),
  checkMicrosoftStoreUpdate: vi.fn(),
  checkForAppUpdate: vi.fn(),
  requestMicrosoftStoreUpdate: vi.fn(),
  downloadAndInstallAppUpdateWithProgress: vi.fn(),
}));

import { checkMicrosoftStoreUpdate, getAppUpdateChannel } from "../api/commands";

const mockGetAppUpdateChannel = vi.mocked(getAppUpdateChannel);
const mockCheckMicrosoftStoreUpdate = vi.mocked(checkMicrosoftStoreUpdate);

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("useUpdateFlow", () => {
  test("checks Microsoft Store updates on each launch check", async () => {
    localStorage.setItem("gitmun.microsoftStoreUpdateAutoCheckedAt", String(Date.now()));
    mockGetAppUpdateChannel.mockResolvedValue("MicrosoftStore");
    mockCheckMicrosoftStoreUpdate.mockResolvedValue(null);

    const { result } = renderHook(() => useUpdateFlow());

    await act(async () => {
      await result.current.checkForUpdatesOnLaunch();
    });

    await waitFor(() => {
      expect(mockCheckMicrosoftStoreUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
