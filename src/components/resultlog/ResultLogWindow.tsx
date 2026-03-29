import React, { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Settings, ThemeMode } from "../../types";
import { clearResultLog, getResultLogEntries, type ResultLogEntry } from "../../utils/resultLog";
import "./ResultLogWindow.css";

const THEME_MODE_KEY = "gitmun.themeMode";

async function resolveTheme(mode: ThemeMode): Promise<"light" | "dark"> {
  if (mode === "Light") return "light";
  if (mode === "Dark") return "dark";
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) return "dark";
  try {
    const hint = await invoke<string>("get_system_theme_hint");
    return hint === "dark" ? "dark" : "light";
  } catch {
    return "dark";
  }
}

export function ResultLogWindow() {
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
        document.documentElement.dataset.theme = await resolveTheme(settings.themeMode);
      } catch {
        document.documentElement.dataset.theme = "dark";
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
        <div className="result-log__title">Result Log</div>
        <div className="result-log__header-right">
          <label className="result-log__switch-row">
            <span className="result-log__switch-label">Console view</span>
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
              All
            </button>
            <button
              className={`result-log__filter ${filter === "success" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("success")}
            >
              Success
            </button>
            <button
              className={`result-log__filter ${filter === "error" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("error")}
            >
              Error
            </button>
            <button
              className={`result-log__filter ${filter === "info" ? "result-log__filter--active" : ""}`}
              onClick={() => setFilter("info")}
            >
              Info
            </button>
          </div>
          <button className="result-log__clear" onClick={handleClear} disabled={entries.length === 0}>Clear</button>
        </div>
      </div>
      <div className={`result-log__list ${consoleMode ? "result-log__list--console" : ""}`}>
        {empty ? (
          <div className="result-log__empty">No matching results.</div>
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
