import React, { useState, useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { GithubLogoIcon, GlobeIcon } from "../icons";
import { checkForAppUpdate, getBuildVersion, getCommitHash, isUpdaterEnabled, openAttributionsWindow } from "../../api/commands";
import "./AboutWindow.css";

export function AboutWindow() {
  const [version, setVersion] = useState<string | null>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [updaterSupported, setUpdaterSupported] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    Promise.all([getBuildVersion(), getCommitHash(), isUpdaterEnabled()])
      .then(([v, h, updaterEnabled]) => {
        setVersion(v);
        setCommitHash(h);
        setUpdaterSupported(updaterEnabled);
      })
      .catch(() => {});
  }, []);

  async function handleCheckForUpdates() {
    setChecking(true);
    try {
      const update = await checkForAppUpdate();
      if (!update) {
        setStatusMessage("You're already running the latest version.");
        return;
      }

      await emit("update-available", update);
      await getCurrentWindow().close();
    } catch (error) {
      setStatusMessage(`Update check failed: ${String(error)}`);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="about">
      <img className="about__icon" src="/icon.svg" alt="" width={80} height={80} />
      <h1 className="about__name">Gitmun</h1>
      {version && <div className="about__version">Version {version}</div>}
      {commitHash && <div className="about__hash">{commitHash}</div>}
      {updaterSupported ? (
        <button
          className="about__attributions-btn"
          onClick={() => void handleCheckForUpdates()}
          disabled={checking}
        >
          {checking ? "Checking..." : "Check for updates"}
        </button>
      ) : updaterSupported === false ? (
        <div className="about__status">Updates are managed by this installation channel.</div>
      ) : null}
      <button
        className="about__attributions-btn"
        onClick={() => openAttributionsWindow().catch(() => {})}
      >
        View Attributions
      </button>
      {statusMessage && <div className="about__status">{statusMessage}</div>}
      <div className="about__links">
        <button
          className="about__link-btn"
          onClick={() => void open("https://github.com/cst8t/gitmun")}
          title="GitHub"
        >
          <GithubLogoIcon size={20} />
        </button>
        <button
          className="about__link-btn"
          disabled
          title="Not setup website yet"
        >
          <GlobeIcon size={20} />
        </button>
      </div>
    </div>
  );
}
