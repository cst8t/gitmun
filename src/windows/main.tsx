import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { App } from "../components/App";
import "../styles/tokens.css";
import "../styles/animations.css";
import "../styles/global.css";
import "../styles/dialog.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
  setTimeout(() => void invoke("show_window", { label: "main" }), 0);
}
