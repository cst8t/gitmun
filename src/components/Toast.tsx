import React from "react";
import { CheckIcon } from "./icons";
import type { ToastState } from "../hooks/useToast";
import "./Toast.css";

export function Toast({ message, type, visible }: ToastState) {
  return (
    <div className={`toast toast--${type} ${visible ? "toast--visible" : ""}`}>
      {type === "success" && <CheckIcon />}
      {message}
    </div>
  );
}
