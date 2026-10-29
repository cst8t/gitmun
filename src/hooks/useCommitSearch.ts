import { useCallback, useEffect, useRef, useState } from "react";
import { Channel } from "@tauri-apps/api/core";
import { cancelCommitSearch, continueCommitSearch, startCommitSearch } from "../api/commands";
import type { CommitHistoryItem, CommitLogScope, CommitSearchError, CommitSearchEvent, CommitSearchStatus } from "../types";

const EMPTY_COMMITS: CommitHistoryItem[] = [];

type SearchResults = {
  key: string;
  commits: CommitHistoryItem[];
  scannedCount: number;
  status: CommitSearchStatus;
  error: CommitSearchError | null;
};

type SearchSession = {
  id: string;
  key: string;
  status: CommitSearchStatus;
  refreshQueued: boolean;
};

function searchFailure(error: unknown): CommitSearchError {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return { code: error.code, details: "details" in error && typeof error.details === "string" ? error.details : undefined };
  }
  return { code: "search_failed", details: String(error) };
}

export function useCommitSearch(
  repoPath: string | null,
  input: string,
  scope: CommitLogScope,
  topoOrder: boolean,
  settingsKey: string,
) {
  const query = input.trim();
  const active = Boolean(repoPath && query);
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([repoPath, query, scope, topoOrder, settingsKey, revision]);
  const currentKey = useRef(key);
  currentKey.current = key;
  const sessionRef = useRef<SearchSession | null>(null);
  const [results, setResults] = useState<SearchResults>({
    key: "", commits: EMPTY_COMMITS, scannedCount: 0, status: "scanning", error: null,
  });

  useEffect(() => {
    if (!active || !repoPath) {
      setResults(previous => previous.key ? {
        key: "", commits: EMPTY_COMMITS, scannedCount: 0, status: "scanning", error: null,
      } : previous);
      return;
    }
    let disposed = false;
    let session: SearchSession | null = null;
    const timer = window.setTimeout(() => {
      if (disposed) return;
      session = { id: crypto.randomUUID(), key, status: "scanning", refreshQueued: false };
      sessionRef.current = session;
      const startedSession = session;
      setResults({ key, commits: [], scannedCount: 0, status: "scanning", error: null });
      const onEvent = new Channel<CommitSearchEvent>();
      onEvent.onmessage = event => {
        if (disposed || currentKey.current !== key || sessionRef.current !== startedSession || event.sessionId !== startedSession.id) return;
        startedSession.status = event.status;
        if (event.status !== "scanning" && startedSession.refreshQueued) {
          startedSession.refreshQueued = false;
          setRevision(previous => previous + 1);
          return;
        }
        setResults(previous => ({
          key,
          commits: previous.key !== key ? event.commits : event.commits.length > 0 ? [...previous.commits, ...event.commits] : previous.commits,
          scannedCount: event.scannedCount,
          status: event.status,
          error: event.error ?? null,
        }));
      };
      void startCommitSearch({ repoPath, query, scope, topoOrder, sessionId: startedSession.id }, onEvent)
        .then(() => {
          if (disposed) void cancelCommitSearch(startedSession.id).catch(() => {});
        })
        .catch(error => {
          if (disposed || currentKey.current !== key || sessionRef.current !== startedSession) return;
          startedSession.status = "error";
          if (startedSession.refreshQueued) {
            setRevision(previous => previous + 1);
          } else {
            setResults(previous => ({ ...previous, key, status: "error", error: searchFailure(error) }));
          }
        });
    }, 300);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      if (session) {
        if (sessionRef.current === session) sessionRef.current = null;
        void cancelCommitSearch(session.id).catch(() => {});
      }
    };
  }, [active, repoPath, query, scope, topoOrder, key]);

  const restart = useCallback(() => {
    setRevision(previous => previous + 1);
  }, []);

  const refresh = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.key !== currentKey.current) return;
    if (session.status === "scanning") {
      session.refreshQueued = true;
    } else {
      setRevision(previous => previous + 1);
    }
  }, []);

  const loadMore = useCallback(() => {
    const session = sessionRef.current;
    if (!session || session.key !== currentKey.current || session.status !== "paused") return;
    session.status = "scanning";
    setResults(previous => ({ ...previous, status: "scanning", error: null }));
    void continueCommitSearch(session.id).catch(error => {
      if (sessionRef.current !== session || currentKey.current !== session.key) return;
      session.status = "error";
      if (session.refreshQueued) {
        setRevision(previous => previous + 1);
      } else {
        setResults(previous => ({ ...previous, status: "error", error: searchFailure(error) }));
      }
    });
  }, []);

  const currentResults = results.key === key ? results : null;
  return {
    active,
    sessionKey: key,
    commits: active ? currentResults?.commits ?? EMPTY_COMMITS : EMPTY_COMMITS,
    scannedCount: active ? currentResults?.scannedCount ?? 0 : 0,
    status: currentResults?.status ?? "scanning",
    error: currentResults?.error ?? null,
    loadMore,
    restart,
    refresh,
    pageSize: 100,
  };
}
