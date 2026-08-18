// @vitest-environment jsdom

import {renderHook} from "@testing-library/react";
import {describe, expect, it, vi} from "vitest";
import {useProjectKeyboardShortcuts} from "./useProjectKeyboardShortcuts";

function shortcutOptions() {
  const searchInput = document.createElement("input");
  return {
    platform: "gnome" as const,
    selectedFile: "src/harbour.ts",
    isUnstaged: true,
    searchInputRef: {current: searchInput},
    onShowLog: vi.fn(),
    onStageFile: vi.fn(),
    onUnstageFile: vi.fn(),
    onStageAll: vi.fn(),
    onPush: vi.fn(),
    onFetch: vi.fn(),
    onPull: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefresh: vi.fn(),
  };
}

describe("useProjectKeyboardShortcuts", () => {
  it("preserves global shortcut precedence and focused-input handling", () => {
    const options = shortcutOptions();
    const input = document.createElement("input");
    document.body.append(input);
    const {unmount} = renderHook(() => useProjectKeyboardShortcuts(options));

    input.dispatchEvent(new KeyboardEvent("keydown", {
      key: "a",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
    }));
    expect(options.onStageAll).toHaveBeenCalledOnce();

    input.dispatchEvent(new KeyboardEvent("keydown", {key: "s", bubbles: true}));
    expect(options.onStageFile).not.toHaveBeenCalled();

    document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "s", bubbles: true}));
    expect(options.onStageFile).toHaveBeenCalledWith("src/harbour.ts");

    unmount();
    document.body.dispatchEvent(new KeyboardEvent("keydown", {key: "r", bubbles: true}));
    expect(options.onRefresh).not.toHaveBeenCalled();
  });
});
