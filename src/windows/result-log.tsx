import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { ResultLogWindow } from "../components/resultlog/ResultLogWindow";
import "../styles/tokens.css";
import "../styles/animations.css";
import "../styles/global.css";

window.addEventListener("error", (event) => {
  const details = `[result-log-window:error] ${event.message}\n${event.filename}:${event.lineno}:${event.colno}`;
  console.error(details, event.error);
  try {
    localStorage.setItem("gitmun.resultLogWindowError", details);
  } catch {
    // ignore storage failures
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const details = `[result-log-window:unhandledrejection] ${String(event.reason)}`;
  console.error(details);
  try {
    localStorage.setItem("gitmun.resultLogWindowError", details);
  } catch {
    // ignore storage failures
  }
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ResultLogWindow />);
  setTimeout(() => void invoke("show_window", { label: "result-log" }), 0);
}
