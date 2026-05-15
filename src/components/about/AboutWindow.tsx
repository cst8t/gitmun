import React, { useState, useEffect } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-shell";
import { useTranslation } from "react-i18next";
import { GithubLogoIcon, GlobeIcon } from "../icons";
import {
  checkForAppUpdate,
  checkMicrosoftStoreUpdate,
  getAppUpdateChannel,
  getBuildVersion,
  getCommitHash,
  openAttributionsWindow,
} from "../../api/commands";
import type { AppUpdateChannel } from "../../types";
import "./AboutWindow.css";

export function AboutWindow() {
  const { t } = useTranslation("about");
  const [version, setVersion] = useState<string | null>(null);
  const [commitHash, setCommitHash] = useState<string | null>(null);
  const [updateChannel, setUpdateChannel] = useState<AppUpdateChannel | null>(null);
  const [checking, setChecking] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  useEffect(() => {
    Promise.all([getBuildVersion(), getCommitHash(), getAppUpdateChannel()])
      .then(([v, h, channel]) => {
        setVersion(v);
        setCommitHash(h);
        setUpdateChannel(channel);
      })
      .catch(() => {});
  }, []);

  async function handleCheckForUpdates() {
    setChecking(true);
    try {
      const channel = updateChannel ?? await getAppUpdateChannel();
      const update = channel === "MicrosoftStore"
        ? await checkMicrosoftStoreUpdate().then((storeUpdate) => storeUpdate ? {...storeUpdate, source: "microsoftStore" as const} : null)
        : await checkForAppUpdate().then((availableUpdate) => availableUpdate ? {...availableUpdate, source: "selfManaged" as const} : null);
      if (!update) {
        setStatusMessage(channel === "MicrosoftStore" ? t("status.latestMicrosoftStore") : t("status.latest"));
        return;
      }

      await emit("update-available", update);
      await getCurrentWindow().close();
    } catch (error) {
      setStatusMessage(t("status.checkFailed", { message: String(error) }));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="about">
      <img className="about__icon" src="/icon.svg" alt="" width={80} height={80} />
      <h1 className="about__name">Gitmun</h1>
      {version && <div className="about__version">{t("version", { version })}</div>}
      {commitHash && <div className="about__hash">{commitHash}</div>}
      {updateChannel === "SelfManaged" || updateChannel === "MicrosoftStore" ? (
        <button
          className="about__attributions-btn"
          onClick={() => void handleCheckForUpdates()}
          disabled={checking}
        >
          {checking ? t("actions.checking") : t("actions.checkForUpdates")}
        </button>
      ) : updateChannel === "SystemManaged" ? (
        <div className="about__status">{t("status.managed")}</div>
      ) : null}
      <button
        className="about__attributions-btn"
        onClick={() => openAttributionsWindow().catch(() => {})}
      >
        {t("actions.viewAttributions")}
      </button>
      {statusMessage && <div className="about__status">{statusMessage}</div>}
      <div className="about__links">
        <button
          className="about__link-btn"
          onClick={() => void open("https://github.com/cst8t/gitmun")}
          title={t("links.github")}
        >
          <GithubLogoIcon size={20} />
        </button>
        <button
          className="about__link-btn"
          disabled
          title={t("links.website")}
        >
          <GlobeIcon size={20} />
        </button>
      </div>
    </div>
  );
}
