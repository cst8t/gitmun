import React from "react";
import { useTranslation } from "react-i18next";
import { CheckIcon, CloseIcon } from "./icons";
import type { ToastState } from "../hooks/useToast";
import "./Toast.css";

type ToastProps = ToastState & {
  onDismiss: () => void;
};

export function Toast({ message, type, visible, persistent, onDismiss }: ToastProps) {
  const { t } = useTranslation("common");

  return (
    <div className={`toast toast--${type} ${visible ? "toast--visible" : ""}`}>
      {type === "success" && <CheckIcon />}
      <span className="toast__message">{message}</span>
      {persistent && type === "error" && (
        <button className="toast__dismiss" type="button" onClick={onDismiss} aria-label={t("actions.dismiss")}>
          <CloseIcon />
        </button>
      )}
    </div>
  );
}
