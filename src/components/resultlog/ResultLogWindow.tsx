import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { Settings } from "../../types";
import { clearResultLog, getResultLogEntries, type ResultLogEntry } from "../../utils/resultLog";
import { applyThemeMode } from "../../utils/theme";
import { applyUiTextScale } from "../../utils/uiTextScale";
import "./ResultLogWindow.css";

const THEME_MODE_KEY = "gitmun.themeMode";

function repoLabel(repoPath?: string | null): string | null {
  if (!repoPath) return null;
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath;
}

export function ResultLogWindow() {
  const { t } = useTranslation("resultLog");
  const [entries, setEntries] = useState<ResultLogEntry[]>(() => getResultLogEntries());
  const [filter, setFilter] = useState<"all" | "success" | "error" | "info">("all");
  const [consoleMode, setConsoleMode] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const persistedTheme = localStorage.getItem(THEME_MODE_KEY);
        if (persistedTheme === "System" || persistedTheme === "Light" || persistedTheme === "Dark") {
          await invoke("set_theme_mode", { themeMode: persistedTheme });
        }
        const settings = await invoke<Settings>("get_settings");
        await applyThemeMode(settings.themeMode);
        applyUiTextScale(settings.uiTextScale);
      } catch {
        document.documentElement.dataset.theme = "dark";
        applyUiTextScale(1);
      }
    })();
  }, []);

  useEffect(() => {
    const sync = () => setEntries(getResultLogEntries());
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);

  const handleClear = useCallback(() => {
    clearResultLog();
    setEntries([]);
  }, []);

  const filteredEntries = useMemo(() => {
    if (filter === "all") return entries;
    return entries.filter(entry => entry.level === filter);
  }, [entries, filter]);

  const empty = useMemo(() => filteredEntries.length === 0, [filteredEntries]);

  return (
    <div className="result-log">
      <div className="result-log__header">
        <div className="result-log__title">{t("labels.title")}</div>
        <div className="result-log__header-right">
          <label className="result-log__switch-row">
            <span className="result-log__switch-label">{t("labels.consoleView")}</span>
            <span className="result-log__switch">
              <input
                type="checkbox"
                checked={consoleMode}
                onChange={e => setConsoleMode(e.target.checked)}
              />
              <span className="result-log__switch-track" />
            </span>
          </label>
          <div className="result-log__filters">
            <button
              className={`result-log__filter ${filter === "all" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("all")}
            >
              {t("filters.all")}
            </button>
            <button
              className={`result-log__filter ${filter === "success" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("success")}
            >
              {t("filters.success")}
            </button>
            <button
              className={`result-log__filter ${filter === "error" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("error")}
            >
              {t("filters.error")}
            </button>
            <button
              className={`result-log__filter ${filter === "info" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("info")}
            >
              {t("filters.info")}
            </button>
          </div>
          <button className="result-log__clear" onClick={handleClear} disabled={entries.length === 0}>{t("actions.clear")}</button>
        </div>
      </div>
      <div className={`result-log__list ${consoleMode ? "result-log__list--console" : ""}`}>
        {empty ? (
          <div className="result-log__empty">{t("labels.empty")}</div>
        ) : consoleMode ? (
          <div className="result-log__console">
            {filteredEntries.map(entry => (
              <div className="result-log__console-line" key={entry.id}>
                <span className="result-log__console-time">[{new Date(entry.ts).toLocaleTimeString()}]</span>
                <span className={`result-log__console-level result-log__console-level--${entry.level}`}>[{entry.level.toUpperCase()}]</span>
                <span
                  className={`result-log__console-backend result-log__console-backend--${
                    entry.backend === "gix+cli-fallback" ? "gix-cli-fallback" : entry.backend
                  }`}
                >
                  [{entry.backend}]
                </span>
                {entry.repoPath && <span className="result-log__console-repo">[{repoLabel(entry.repoPath)}]</span>}
                <span className="result-log__console-message"> {entry.message}</span>
              </div>
            ))}
          </div>
        ) : filteredEntries.map(entry => (
          <div className="result-log__item" key={entry.id}>
            <div className={`result-log__dot result-log__dot--${entry.level}`} />
            <div className="result-log__content">
              <div className="result-log__message">{entry.message}</div>
              <div className="result-log__meta">
                <span className="result-log__time">{new Date(entry.ts).toLocaleString()}</span>
                {entry.repoPath && <span className="result-log__repo" title={entry.repoPath}>{repoLabel(entry.repoPath)}</span>}
                <span
                  className={`result-log__backend result-log__backend--${
                    entry.backend === "gix+cli-fallback" ? "gix-cli-fallback" : entry.backend
                  }`}
                >
                  {entry.backend === "git-cli"
                    ? "git cli"
                    : entry.backend === "gix+cli-fallback"
                      ? "gix+cli-fallback"
                      : entry.backend === "gix"
                        ? "gix"
                        : "unknown"}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
