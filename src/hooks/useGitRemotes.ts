import { useState, useEffect, useCallback, useRef } from "react";
import { getRemotes } from "../api/commands";
import type { RemoteInfo } from "../types";

export function useGitRemotes(repoPath: string | null) {
  const [remotes, setRemotes] = useState<RemoteInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Updated synchronously in the render body - always reflects the current
  // project even in the gap between a render and its effects.
  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  const fetchId = useRef(0);

  // Reset immediately when the repo changes so stale remotes never show.
  useEffect(() => {
    setRemotes([]);
    setError(null);
  }, [repoPath]);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setRemotes([]);
      return;
    }
    const myId = ++fetchId.current;
    setLoading(true);
    setError(null);
    try {
      const r = await getRemotes(repoPath);
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setRemotes(r);
      }
    } catch (e) {
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setError(String(e));
      }
    } finally {
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setLoading(false);
      }
    }
  }, [repoPath]);

  useEffect(() => { refresh(); }, [refresh]);

  return { remotes, loading, error, refresh };
}
