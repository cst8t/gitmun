// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import "../i18n";
import { useUpdateFlow } from "./useUpdateFlow";

vi.mock("../api/commands", () => ({
  getAppUpdateChannel: vi.fn(),
  checkMicrosoftStoreUpdate: vi.fn(),
  checkForAppUpdate: vi.fn(),
  openMicrosoftStoreUpdatePage: vi.fn(),
  downloadAndInstallAppUpdateWithProgress: vi.fn(),
}));

import {
  checkMicrosoftStoreUpdate,
  getAppUpdateChannel,
  openMicrosoftStoreUpdatePage,
} from "../api/commands";

const mockGetAppUpdateChannel = vi.mocked(getAppUpdateChannel);
const mockCheckMicrosoftStoreUpdate = vi.mocked(checkMicrosoftStoreUpdate);
const mockOpenMicrosoftStoreUpdatePage = vi.mocked(openMicrosoftStoreUpdatePage);

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

  test("opens Microsoft Store page from update prompt", async () => {
    mockOpenMicrosoftStoreUpdatePage.mockResolvedValue();

    const { result } = renderHook(() => useUpdateFlow());

    act(() => {
      result.current.showUpdatePrompt(storeUpdate);
    });
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(mockOpenMicrosoftStoreUpdatePage).toHaveBeenCalledTimes(1);
    expect(result.current.dialog.phase).toBe("storeOpened");
    expect(result.current.dialog.phase).not.toBe("downloading");
    expect(result.current.dialog.phase).not.toBe("installing");
    expect(result.current.statusMessage).toBe("Microsoft Store opened.");
  });

  test("maps Microsoft Store open failure to Store error", async () => {
    mockOpenMicrosoftStoreUpdatePage.mockRejectedValue(new Error("Store unavailable"));

    const { result } = renderHook(() => useUpdateFlow());

    act(() => {
      result.current.showUpdatePrompt(storeUpdate);
    });
    await act(async () => {
      await result.current.installUpdate();
    });

    expect(result.current.dialog.phase).toBe("storeError");
    expect(result.current.dialog.errorMessage).toBe("Store unavailable");
    expect(result.current.statusMessage).toBe("Microsoft Store update failed: Store unavailable");
  });
});
