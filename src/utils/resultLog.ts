export type ResultLogLevel = "info" | "success" | "error";

export type ResultLogEntry = {
  id: string;
  ts: string;
  level: ResultLogLevel;
  message: string;
  backend: "gix" | "git-cli" | "gix+cli-fallback" | "unknown";
};

export const RESULT_LOG_STORAGE_KEY = "gitmun.resultLogEntries";
const RESULT_LOG_LIMIT = 500;

export function getResultLogEntries(): ResultLogEntry[] {
  try {
    const raw = localStorage.getItem(RESULT_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Partial<ResultLogEntry>>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => typeof entry?.message === "string")
      .map((entry) => ({
        id: entry.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ts: entry.ts ?? new Date().toISOString(),
        level: entry.level === "success" || entry.level === "error" ? entry.level : "info",
        message: entry.message as string,
        backend: entry.backend === "gix" || entry.backend === "git-cli" || entry.backend === "gix+cli-fallback"
          ? entry.backend
          : "unknown",
      }));
  } catch {
    return [];
  }
}

export function appendResultLog(
  level: ResultLogLevel,
  message: string,
  backend: ResultLogEntry["backend"] = "unknown",
) {
  const entry: ResultLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    level,
    message,
    backend,
  };

  const next = [entry, ...getResultLogEntries()].slice(0, RESULT_LOG_LIMIT);
  localStorage.setItem(RESULT_LOG_STORAGE_KEY, JSON.stringify(next));
}

export function clearResultLog() {
  localStorage.setItem(RESULT_LOG_STORAGE_KEY, JSON.stringify([]));
}
