import { useState, useEffect, useCallback, useRef } from "react";
import { stashList } from "../api/commands";
import type { StashEntry } from "../types";

export function useGitStashes(repoPath: string | null) {
  const [stashes, setStashes] = useState<StashEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  const fetchId = useRef(0);

  useEffect(() => {
    setStashes([]);
    setError(null);
  }, [repoPath]);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setStashes([]);
      return;
    }
    const myId = ++fetchId.current;
    setLoading(true);
    setError(null);
    try {
      const entries = await stashList(repoPath);
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setStashes(entries);
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

  return { stashes, loading, error, refresh };
}
