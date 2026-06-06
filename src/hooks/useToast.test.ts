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

  test("success and info toasts auto-hide after 2400ms", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("hello");
    });
    expect(result.current.toast.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(result.current.toast.visible).toBe(false);

    act(() => {
      result.current.showToast("still here", "info");
    });
    expect(result.current.toast.visible).toBe(true);
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(result.current.toast.visible).toBe(false);
  });

  test("error toast auto-hides after 8000ms by default", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("failed", "error");
    });

    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(result.current.toast.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toast.visible).toBe(false);
  });

  test("error toast uses the configured auto-hide delay", () => {
    const { result } = renderHook(() => useToast(false, 12000));
    act(() => {
      result.current.showToast("failed", "error");
    });

    act(() => {
      vi.advanceTimersByTime(11999);
    });
    expect(result.current.toast.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toast.visible).toBe(false);
  });

  test("error toast delay has a minimum of 1000ms", () => {
    const { result } = renderHook(() => useToast(false, 0));
    act(() => {
      result.current.showToast("failed", "error");
    });

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(result.current.toast.visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.toast.visible).toBe(false);
  });

  test("persistent error toast remains visible past 8000ms", () => {
    const { result } = renderHook(() => useToast(true, 1000));
    act(() => {
      result.current.showToast("failed", "error");
    });

    expect(result.current.toast.persistent).toBe(true);
    act(() => {
      vi.advanceTimersByTime(8000);
    });
    expect(result.current.toast.visible).toBe(true);
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
    act(() => {
      vi.advanceTimersByTime(2399);
    });
    expect(result.current.toast.visible).toBe(true);
    expect(result.current.toast.message).toBe("second");
  });

  test("showing another toast clears the persistent error timer state", () => {
    const { result } = renderHook(() => useToast(true));
    act(() => {
      result.current.showToast("first", "error");
    });
    act(() => {
      result.current.showToast("second", "info");
    });

    expect(result.current.toast.persistent).toBe(false);
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(result.current.toast.visible).toBe(false);
  });

  test("dismiss hides a persistent error toast", () => {
    const { result } = renderHook(() => useToast(true));
    act(() => {
      result.current.showToast("failed", "error");
    });
    expect(result.current.toast.visible).toBe(true);

    act(() => {
      result.current.dismissToast();
    });

    expect(result.current.toast.visible).toBe(false);
  });

  test("defaults type to success when omitted", () => {
    const { result } = renderHook(() => useToast());
    act(() => {
      result.current.showToast("msg");
    });
    expect(result.current.toast.type).toBe("success");
  });
});
