import React, { useState, useEffect } from "react";
import { open } from "@tauri-apps/plugin-shell";
import { GithubLogoIcon, GlobeIcon } from "../icons";
import { getBuildVersion, getCommitHash, openAttributionsWindow } from "../../api/commands";
import "./AboutWindow.css";

export function AboutWindow() {
  const [version, setVersion] = useState<string | null>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([getBuildVersion(), getCommitHash()])
      .then(([v, h]) => { setVersion(v); setCommitHash(h); })
      .catch(() => {});
  }, []);

  return (
    <div className="about">
      <img className="about__icon" src="/icon.png" alt="" width={80} height={80} />
      <h1 className="about__name">Gitmun</h1>
      {version && <div className="about__version">Version {version}</div>}
      {commitHash && <div className="about__hash">{commitHash}</div>}
      <button
        className="about__attributions-btn"
        onClick={() => openAttributionsWindow().catch(() => {})}
      >
        View Attributions
      </button>
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
