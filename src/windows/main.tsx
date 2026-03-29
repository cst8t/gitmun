import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "../components/App";
import "../styles/tokens.css";
import "../styles/animations.css";
import "../styles/global.css";
import "../styles/dialog.css";

document.addEventListener("contextmenu", (e) => {
  if (!(e.target as Element)?.closest?.("[data-allow-native-context-menu='true']")) {
    e.preventDefault();
  }
}, true);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
  setTimeout(() => void invoke("show_window", { label: "main" }), 0);
}
