// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useToast } from "./useToast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useToast", () => {
  test("toast starts hidden", () => {
    const { result } = renderHook(() => useToast());
    expect(result.current.toast.visible).toBe(false);
  });

  test("showToast makes toast visible with message and type", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("saved!", "success");
    });
    expect(result.current.toast.visible).toBe(true);
    expect(result.current.toast.message).toBe("saved!");
    expect(result.current.toast.type).toBe("success");
  });

  test("toast auto-hides after 2400ms", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("hello");
    });
    expect(result.current.toast.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(result.current.toast.visible).toBe(false);
  });

  test("showing a second toast cancels the first timer", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("first");
    });
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      result.current.showToast("second");
    });
    // 2400ms from the second call - first toast's timer should not fire
    act(() => {
      vi.advanceTimersByTime(2399);
    });
    expect(result.current.toast.visible).toBe(true);
    expect(result.current.toast.message).toBe("second");
  });

  test("defaults type to success when omitted", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("msg");
    });
    expect(result.current.toast.type).toBe("success");
  });
});
