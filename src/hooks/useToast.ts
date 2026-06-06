import { useState, useCallback, useEffect, useRef } from "react";

export type ToastType = "success" | "error" | "info";

const DEFAULT_TOAST_CLEAR_DELAY_MS = 2400;
const ERROR_TOAST_CLEAR_DELAY_MS = 8000;
const MIN_ERROR_TOAST_CLEAR_DELAY_MS = 1000;

function normaliseErrorToastClearDelayMs(value: number): number {
  return Number.isFinite(value) ? Math.max(MIN_ERROR_TOAST_CLEAR_DELAY_MS, Math.trunc(value)) : ERROR_TOAST_CLEAR_DELAY_MS;
}

export type ToastState = {
  message: string;
  type: ToastType;
  visible: boolean;
  persistent: boolean;
};

export function useToast(persistentErrorToasts = false, errorToastClearDelayMs = ERROR_TOAST_CLEAR_DELAY_MS) {
  const [toast, setToast] = useState<ToastState>({ message: "", type: "success", visible: false, persistent: false });
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const dismissToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    setToast(t => ({ ...t, visible: false }));
  }, []);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    const persistent = type === "error" && persistentErrorToasts;
    setToast({ message, type, visible: true, persistent });
    if (persistent) return;

    const delay = type === "error" ? normaliseErrorToastClearDelayMs(errorToastClearDelayMs) : DEFAULT_TOAST_CLEAR_DELAY_MS;
    timerRef.current = setTimeout(() => {
      setToast(t => ({ ...t, visible: false }));
      timerRef.current = undefined;
    }, delay);
  }, [errorToastClearDelayMs, persistentErrorToasts]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { toast, showToast, dismissToast };
}
