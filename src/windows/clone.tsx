import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { CloneWindow } from "../components/clone/CloneWindow";
import "../styles/tokens.css";
import "../styles/animations.css";
import "../styles/global.css";

window.addEventListener("error", (event) => {
  const details = `[clone-window:error] ${event.message}\n${event.filename}:${event.lineno}:${event.colno}`;
  console.error(details, event.error);
  try {
    localStorage.setItem("gitmun.cloneWindowError", details);
  } catch {
    // ignore storage failures
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const details = `[clone-window:unhandledrejection] ${String(event.reason)}`;
  console.error(details);
  try {
    localStorage.setItem("gitmun.cloneWindowError", details);
  } catch {
    // ignore storage failures
  }
});

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<CloneWindow />);
  setTimeout(() => void invoke("show_window", { label: "clone-repository" }), 0);
}
