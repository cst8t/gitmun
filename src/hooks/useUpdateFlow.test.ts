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
  requestMicrosoftStoreUpdateWithProgress: vi.fn(),
  downloadAndInstallAppUpdateWithProgress: vi.fn(),
}));

import {
  checkMicrosoftStoreUpdate,
  getAppUpdateChannel,
  requestMicrosoftStoreUpdateWithProgress,
} from "../api/commands";

const mockGetAppUpdateChannel = vi.mocked(getAppUpdateChannel);
const mockCheckMicrosoftStoreUpdate = vi.mocked(checkMicrosoftStoreUpdate);
const mockRequestMicrosoftStoreUpdateWithProgress = vi.mocked(requestMicrosoftStoreUpdateWithProgress);

const storage = new Map<string, string>();

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => storage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storage.set(key, value);
      }),
      clear: vi.fn(() => storage.clear()),
    },
  });
});

describe("useUpdateFlow", () => {
  const storeUpdate = {
    source: "microsoftStore" as const,
    currentVersion: "1.0.0",
    packageCount: 1,
    mandatory: false,
    queueStatus: null,
  };

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

  test("shows Microsoft Store download progress below install threshold", async () => {
    mockRequestMicrosoftStoreUpdateWithProgress.mockImplementation(async (onProgress) => {
      onProgress({
        event: "Progress",
        data: {
          packageDownloadProgress: 0.5,
          totalDownloadProgress: 0.4,
          packageBytesDownloaded: 400,
          packageDownloadSizeInBytes: 1000,
          packageUpdateState: "Unknown",
        },
      });
      return {status: "Unknown", queueStatus: {state: "Active", extendedState: "ActiveDownloading", progress: null}};
    });

    const { result } = renderHook(() => useUpdateFlow());

    act(() => {
      result.current.showUpdatePrompt(storeUpdate);
    });
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.dialog.phase).toBe("downloading");
    expect(result.current.dialog.downloadedBytes).toBe(400);
    expect(result.current.dialog.contentLength).toBe(1000);
  });

  test("shows Microsoft Store install progress at install threshold", async () => {
    mockRequestMicrosoftStoreUpdateWithProgress.mockImplementation(async (onProgress) => {
      onProgress({
        event: "Progress",
        data: {
          packageDownloadProgress: 1,
          totalDownloadProgress: 0.85,
          packageBytesDownloaded: 1000,
          packageDownloadSizeInBytes: 1000,
          packageUpdateState: "Unknown",
        },
      });
      return {status: "Unknown", queueStatus: {state: "Active", extendedState: "ActiveInstalling", progress: null}};
    });

    const { result } = renderHook(() => useUpdateFlow());

    act(() => {
      result.current.showUpdatePrompt(storeUpdate);
    });
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.dialog.phase).toBe("installing");
    expect(result.current.dialog.downloadedBytes).toBe(850);
    expect(result.current.dialog.contentLength).toBe(1000);
  });

  test("maps Microsoft Store cancellation to deferred", async () => {
    mockRequestMicrosoftStoreUpdateWithProgress.mockResolvedValue({status: "Canceled", queueStatus: null});

    const { result } = renderHook(() => useUpdateFlow());

    act(() => {
      result.current.showUpdatePrompt(storeUpdate);
    });
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.dialog.phase).toBe("storeDeferred");
    expect(result.current.statusMessage).toBe("Microsoft Store update deferred.");
  });

  test("maps Microsoft Store queue errors to Store error", async () => {
    mockRequestMicrosoftStoreUpdateWithProgress.mockResolvedValue({
      status: "OtherError",
      queueStatus: {state: "Error", extendedState: "PausedLowBattery", progress: null},
    });

    const { result } = renderHook(() => useUpdateFlow());

    act(() => {
      result.current.showUpdatePrompt(storeUpdate);
    });
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.dialog.phase).toBe("storeError");
    expect(result.current.dialog.errorMessage).toBe("PausedLowBattery");
    expect(result.current.statusMessage).toBe("Microsoft Store update failed: PausedLowBattery");
  });
});
