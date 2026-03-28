import React from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { AboutWindow } from "../components/about/AboutWindow";
import "../styles/tokens.css";
import "../styles/animations.css";
import "../styles/global.css";

window.addEventListener("error", (event) => {
  const details = `[about-window:error] ${event.message}\n${event.filename}:${event.lineno}:${event.colno}`;
  console.error(details, event.error);
});

window.addEventListener("unhandledrejection", (event) => {
  console.error(`[about-window:unhandledrejection] ${String(event.reason)}`);
});

type BoundaryState = { error: Error | null };

class AboutErrorBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[about-window] ${error.message}\n${error.stack ?? ""}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 16, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}>
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
    <AboutErrorBoundary>
      <AboutWindow />
    </AboutErrorBoundary>,
  );
  setTimeout(() => void invoke("show_window", { label: "about" }), 0);
}
