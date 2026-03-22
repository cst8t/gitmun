import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { SettingsWindow } from "../components/settings/SettingsWindow";
import "../styles/tokens.css";
import "../styles/animations.css";
import "../styles/global.css";

window.addEventListener("error", (event) => {
  const details = `[settings-window:error] ${event.message}\n${event.filename}:${event.lineno}:${event.colno}`;
  console.error(details, event.error);
  try {
    localStorage.setItem("gitmun.settingsWindowError", details);
  } catch {
    // ignore storage failures
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const details = `[settings-window:unhandledrejection] ${String(event.reason)}`;
  console.error(details);
  try {
    localStorage.setItem("gitmun.settingsWindowError", details);
  } catch {
    // ignore storage failures
  }
});

type BoundaryState = {
  error: Error | null;
};

class SettingsErrorBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    const details = `[settings-window] ${error.message}\n${error.stack ?? ""}\n${info.componentStack}`;
    console.error(details);
    try {
      localStorage.setItem("gitmun.settingsWindowError", details);
    } catch {
      // ignore storage failures
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
          Settings failed to render. See `gitmun.settingsWindowError` in localStorage for details.
          {"\n\n"}
          {this.state.error.message}
        </div>
      );
    }

    return this.props.children;
  }
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <SettingsErrorBoundary>
      <SettingsWindow />
    </SettingsErrorBoundary>,
  );
  setTimeout(() => void invoke("show_window", { label: "settings" }), 0);
}
