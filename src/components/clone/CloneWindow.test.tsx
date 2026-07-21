// @vitest-environment jsdom
import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CloneWindowStartupOptions, LocalCopyResult } from "../../types";
import "../../i18n";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(async () => true),
  close: vi.fn(async () => {}),
  emit: vi.fn(async () => {}),
  invoke: vi.fn(async (command: string) => {
    if (command === "get_settings") {
      return { themeMode: "Dark", uiTextScale: 1, defaultCloneDir: "/default", enableLocalCopy: mocks.localCopyEnabled };
    }
    if (command === "get_default_clone_dir") return "/default";
    return null;
  }),
  listeners: new Map<string, Array<(event: {payload: unknown}) => void>>(),
  localCopyEnabled: true,
  localCopyRepo: vi.fn<() => Promise<LocalCopyResult>>(async () => ({
    destinationPath: "/destination",
    backend: "git-cli",
    warning: null,
  })),
  open: vi.fn(async () => null),
  storage: new Map<string, string>(),
  takePending: vi.fn<() => Promise<CloneWindowStartupOptions | null>>(async () => null),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class<T> {
    onmessage?: (message: T) => void;
  },
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: mocks.emit,
  listen: vi.fn(async (event: string, callback: (event: {payload: unknown}) => void) => {
    const listeners = mocks.listeners.get(event) ?? [];
    listeners.push(callback);
    mocks.listeners.set(event, listeners);
    return vi.fn(() => {
      const current = mocks.listeners.get(event) ?? [];
      mocks.listeners.set(event, current.filter(listener => listener !== callback));
    });
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({close: mocks.close}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: mocks.ask,
  open: mocks.open,
}));

vi.mock("@tauri-apps/plugin-os", () => ({platform: () => "linux"}));

vi.mock("../../api/commands", () => ({
  localCopyRepo: mocks.localCopyRepo,
  takePendingCloneWindowOptions: mocks.takePending,
}));

import { CloneWindow } from "./CloneWindow";

function emitWindowOptionsUpdate() {
  for (const listener of mocks.listeners.get("clone-window-options-updated") ?? []) {
    listener({payload: undefined});
  }
}

describe("CloneWindow Local Copy startup", () => {
  beforeEach(() => {
    mocks.ask.mockClear();
    mocks.close.mockClear();
    mocks.emit.mockClear();
    mocks.invoke.mockClear();
    mocks.listeners.clear();
    mocks.localCopyEnabled = true;
    mocks.localCopyRepo.mockClear();
    mocks.open.mockClear();
    mocks.storage.clear();
    mocks.takePending.mockReset();
    mocks.takePending.mockResolvedValue(null);
    vi.stubGlobal("localStorage", {
      clear: vi.fn(() => mocks.storage.clear()),
      getItem: vi.fn((key: string) => mocks.storage.get(key) ?? null),
      removeItem: vi.fn((key: string) => mocks.storage.delete(key)),
      setItem: vi.fn((key: string, value: string) => mocks.storage.set(key, value)),
    });
  });

  it("applies pending Local Copy options without starting", async () => {
    mocks.takePending.mockResolvedValue({
      operationMode: "copy",
      options: {
        source: "/source",
        destination: "/destination",
        copyMode: "completeRepository",
        destinationMode: "dropOnTop",
      },
    });

    render(<CloneWindow />);

    expect(await screen.findByDisplayValue("/source")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/destination")).toBeInTheDocument();
    expect(screen.getByRole("button", {name: "Complete repository"}))
      .toHaveClass("clone-window__option--active");
    expect(screen.queryByPlaceholderText("https://example.com/user/repo.git or git@example.com:user/repo.git"))
      .not.toBeInTheDocument();
    expect(mocks.localCopyRepo).not.toHaveBeenCalled();
  });

  it("hides Local Copy when the experiment is disabled", async () => {
    mocks.localCopyEnabled = false;

    render(<CloneWindow />);

    expect(await screen.findByDisplayValue("/default")).toBeInTheDocument();
    expect(screen.queryByRole("tablist", {name: "Operation"})).not.toBeInTheDocument();
    expect(screen.queryByRole("button", {name: "Local Copy"})).not.toBeInTheDocument();
  });

  it("returns to Clone when Local Copy is disabled while idle", async () => {
    render(<CloneWindow />);
    fireEvent.click(await screen.findByRole("button", {name: "Local Copy"}));
    expect(screen.getByPlaceholderText("Repository URL, SSH path, or local folder")).toBeInTheDocument();

    mocks.localCopyEnabled = false;
    await act(async () => {
      for (const listener of mocks.listeners.get("settings-updated") ?? []) {
        listener({payload: {
          themeMode: "Dark",
          uiTextScale: 1,
          defaultCloneDir: "/default",
          enableLocalCopy: false,
        }});
      }
    });

    await waitFor(() => {
      expect(screen.queryByRole("button", {name: "Local Copy"})).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("https://example.com/user/repo.git or git@example.com:user/repo.git")).toBeInTheDocument();
    });
  });

  it("starts a Local Copy received from another instance", async () => {
    const view = render(<CloneWindow />);
    await waitFor(() => {
      expect(mocks.listeners.get("clone-window-options-updated")?.length).toBe(1);
    });

    mocks.takePending.mockResolvedValueOnce({
      operationMode: "copy",
      options: {
        source: "https://example.test/repo.git",
        destination: "/destination",
        copyMode: "filesOnly",
        destinationMode: "dropOnTop",
        startCopy: true,
      },
    });
    await act(async () => {
      emitWindowOptionsUpdate();
    });

    await waitFor(() => {
      expect(mocks.localCopyRepo).toHaveBeenCalledWith({
        source: "https://example.test/repo.git",
        destination: "/destination",
        copyMode: "filesOnly",
        destinationMode: "dropOnTop",
      }, expect.anything());
    });

    view.unmount();
    render(<CloneWindow />);
    await waitFor(() => expect(mocks.takePending).toHaveBeenCalledTimes(3));
    expect(mocks.localCopyRepo).toHaveBeenCalledOnce();
  });

  it("confirms before an automatic delete-existing copy", async () => {
    mocks.takePending.mockResolvedValue({
      operationMode: "copy",
      options: {
        source: "/source",
        destination: "/destination",
        copyMode: "filesOnly",
        destinationMode: "deleteExisting",
        startCopy: true,
      },
    });

    render(<CloneWindow />);

    await waitFor(() => expect(mocks.ask).toHaveBeenCalledOnce());
    expect(mocks.localCopyRepo).toHaveBeenCalledWith({
      source: "/source",
      destination: "/destination",
      copyMode: "filesOnly",
      destinationMode: "deleteExisting",
    }, expect.anything());
  });

  it("localises structured failures and keeps diagnostics out of the status", async () => {
    mocks.localCopyRepo.mockRejectedValueOnce({
      code: "unsupportedFileType",
      path: "/source/events.fifo",
      detail: "unsupported mode 010000",
    });
    render(<CloneWindow />);
    fireEvent.click(await screen.findByRole("button", {name: "Local Copy"}));
    fireEvent.change(screen.getByPlaceholderText("Repository URL, SSH path, or local folder"), {
      target: {value: "/source"},
    });
    fireEvent.click(screen.getByRole("button", {name: "Copy"}));

    expect(await screen.findByText(/socket, device, FIFO/)).toBeInTheDocument();
    expect(screen.queryByText(/unsupported mode/)).not.toBeInTheDocument();
  });

  it("shows structured cleanup warnings without closing the window", async () => {
    mocks.localCopyRepo.mockResolvedValueOnce({
      destinationPath: "/destination",
      backend: "git-cli",
      warning: {
        code: "backupCleanupFailed",
        path: "/destination-backup",
        detail: "permission denied",
      },
    });
    render(<CloneWindow />);
    fireEvent.click(await screen.findByRole("button", {name: "Local Copy"}));
    fireEvent.change(screen.getByPlaceholderText("Repository URL, SSH path, or local folder"), {
      target: {value: "/source"},
    });
    fireEvent.click(screen.getByRole("button", {name: "Copy"}));

    expect(await screen.findByText(/recovery data could not be removed/)).toBeInTheDocument();
    expect(mocks.close).not.toHaveBeenCalled();
  });
});
