// @vitest-environment jsdom
import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "./ContextMenu";

const { newMenu, newMenuItem, newSeparator } = vi.hoisted(() => ({
  newMenu: vi.fn(),
  newMenuItem: vi.fn(),
  newSeparator: vi.fn(),
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: newMenu },
  MenuItem: { new: newMenuItem },
  PredefinedMenuItem: { new: newSeparator },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function renderMenu(onClose = vi.fn()) {
  const onClick = vi.fn();
  const view = render(<ContextMenu x={20} y={40} onClose={onClose} items={[
    { label: "Copy hash", onClick },
    { type: "separator" },
    { label: "Copy subject", onClick: vi.fn() },
  ]} />);
  return { ...view, onClose, onClick };
}

describe("ContextMenu resource ownership", () => {
  let popup: ReturnType<typeof deferred<void>>;
  let menu: { popup: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  let resources: { close: ReturnType<typeof vi.fn> }[];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    popup = deferred<void>();
    resources = [];
    menu = { popup: vi.fn(() => popup.promise), close: vi.fn().mockResolvedValue(undefined) };
    newMenu.mockReset().mockResolvedValue(menu);
    const createItem = () => {
      const item = { close: vi.fn().mockResolvedValue(undefined) };
      resources.push(item);
      return Promise.resolve(item);
    };
    newMenuItem.mockReset().mockImplementation(createItem);
    newSeparator.mockReset().mockImplementation(createItem);
  });

  it("keeps actions alive while the popup is open and releases every resource afterwards", async () => {
    const view = renderMenu();
    await waitFor(() => expect(menu.popup).toHaveBeenCalled());
    expect(menu.close).not.toHaveBeenCalled();
    resources.forEach(item => expect(item.close).not.toHaveBeenCalled());

    newMenuItem.mock.calls[0][0].action();
    expect(view.onClick).toHaveBeenCalledOnce();
    await act(async () => popup.resolve());

    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    expect(menu.close).toHaveBeenCalledOnce();
    expect(resources).toHaveLength(3);
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
  });

  it("releases a cancelled popup without invoking an item action", async () => {
    const view = renderMenu();
    await waitFor(() => expect(menu.popup).toHaveBeenCalled());
    await act(async () => popup.resolve());
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    expect(view.onClick).not.toHaveBeenCalled();
    expect(menu.close).toHaveBeenCalledOnce();
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
  });

  it("releases partially created items when a later item cannot be created", async () => {
    const error = new Error("Item creation failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    newSeparator.mockRejectedValueOnce(error);
    const view = renderMenu();

    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    expect(resources).toHaveLength(1);
    expect(resources[0].close).toHaveBeenCalledOnce();
    expect(newMenu).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("releases items if creating the menu fails", async () => {
    const error = new Error("Menu creation failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    newMenu.mockRejectedValueOnce(error);
    const view = renderMenu();

    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
    expect(logged).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("releases all resources if showing the popup fails", async () => {
    const error = new Error("Popup failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const view = renderMenu();
    await waitFor(() => expect(menu.popup).toHaveBeenCalled());
    await act(async () => popup.reject(error));

    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    expect(menu.close).toHaveBeenCalledOnce();
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
    expect(logged).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("releases an item that finishes creation after unmount without opening a popup", async () => {
    const pending = deferred<{ close: ReturnType<typeof vi.fn> }>();
    const item = { close: vi.fn().mockResolvedValue(undefined) };
    newMenuItem.mockReturnValueOnce(pending.promise);
    const view = renderMenu();
    view.unmount();
    await act(async () => pending.resolve(item));

    await waitFor(() => expect(item.close).toHaveBeenCalledOnce());
    expect(newSeparator).not.toHaveBeenCalled();
    expect(newMenu).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it("keeps an open popup alive through unmount and cleans it up after dismissal", async () => {
    const view = renderMenu();
    await waitFor(() => expect(menu.popup).toHaveBeenCalled());
    view.unmount();
    expect(menu.close).not.toHaveBeenCalled();
    await act(async () => popup.resolve());

    await waitFor(() => expect(menu.close).toHaveBeenCalledOnce());
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it("releases a menu that finishes creation after unmount without showing it", async () => {
    const pending = deferred<typeof menu>();
    newMenu.mockReturnValueOnce(pending.promise);
    const view = renderMenu();
    await waitFor(() => expect(newMenu).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => pending.resolve(menu));

    await waitFor(() => expect(menu.close).toHaveBeenCalledOnce());
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
    expect(menu.popup).not.toHaveBeenCalled();
    expect(view.onClose).not.toHaveBeenCalled();
  });

  it("releases an abandoned Strict Mode effect without closing the live popup", async () => {
    const onClose = vi.fn();
    render(<React.StrictMode>
      <ContextMenu x={20} y={40} onClose={onClose} items={[
        { label: "Copy hash", onClick: vi.fn() },
      ]} />
    </React.StrictMode>);

    await waitFor(() => expect(menu.popup).toHaveBeenCalledOnce());
    expect(resources).toHaveLength(2);
    expect(resources[0].close).toHaveBeenCalledOnce();
    expect(resources[1].close).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => popup.resolve());

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(menu.close).toHaveBeenCalledOnce();
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
  });

  it("attempts every release even when closing one resource fails", async () => {
    const error = new Error("Release failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    menu.close.mockRejectedValueOnce(error);
    const view = renderMenu();
    await waitFor(() => expect(menu.popup).toHaveBeenCalled());
    await act(async () => popup.resolve());

    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    resources.forEach(item => expect(item.close).toHaveBeenCalledOnce());
    expect(logged).toHaveBeenCalledWith(expect.any(String), error);
  });
});
