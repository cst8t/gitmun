import { useState, useCallback, useRef } from "react";

export type ToastType = "success" | "error" | "info";

export type ToastState = {
  message: string;
  type: ToastType;
  visible: boolean;
};

export function useToast() {
  const [toast, setToast] = useState<ToastState>({ message: "", type: "success", visible: false });
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((message: string, type: ToastType = "success") => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type, visible: true });
    timerRef.current = setTimeout(() => {
      setToast(t => ({ ...t, visible: false }));
    }, 2400);
  }, []);

  return { toast, showToast };
}
