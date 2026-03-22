import { useState, useEffect, useCallback, useRef } from "react";
import { getRepoStatus } from "../api/commands";
import type { RepoStatus } from "../types";

export function useGitStatus(repoPath: string | null) {
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  const fetchId = useRef(0);
  const isRunningRef = useRef(false);

  useEffect(() => {
    setStatus(null);
    setError(null);
  }, [repoPath]);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    const silent = options?.silent === true;
    if (!repoPath) {
      setStatus(null);
      return;
    }
    if (silent && isRunningRef.current) return;
    const myId = ++fetchId.current;
    if (!silent) setLoading(true);
    setError(null);
    isRunningRef.current = true;
    try {
      const s = await getRepoStatus(repoPath);
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setStatus(s);
      }
    } catch (e) {
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setError(String(e));
      }
    } finally {
      isRunningRef.current = false;
      if (currentRepoRef.current === repoPath && fetchId.current === myId && !silent) {
        setLoading(false);
      }
    }
  }, [repoPath]);

  // Initial fetch. On focus, do one silent refresh to pick up external edits
  // made while the window was away. The .git FS watcher (in ProjectView) handles
  // instant updates for all in-app git operations — no timer needed.
  useEffect(() => {
    refresh();
    const handleFocus = () => refresh({ silent: true });
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refresh]);

  return { status, loading, error, refresh };
}
