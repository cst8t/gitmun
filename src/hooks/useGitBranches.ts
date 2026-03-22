import { useState, useEffect, useCallback, useRef } from "react";
import { getBranches } from "../api/commands";
import type { BranchInfo } from "../types";

export function useGitBranches(repoPath: string | null) {
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Updated synchronously in the render body so it is always current even in
  // the gap between a render and its effects. Stale callbacks (e.g. old timer
  // ticks that fire before effect cleanup) compare their closed-over repoPath
  // against this ref; a mismatch means they are from a previous project and
  // must discard their result without touching any state.
  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  // Guards against same-repo concurrent calls: only the most recently started
  // fetch is allowed to write state.
  const fetchId = useRef(0);

  // Reset immediately when the repo changes so stale branches never show.
  useEffect(() => {
    setBranches([]);
    setError(null);
  }, [repoPath]);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setBranches([]);
      return;
    }
    const myId = ++fetchId.current;
    setLoading(true);
    setError(null);
    try {
      const b = await getBranches(repoPath);
      // Discard if the hook has moved to a different repo OR a newer fetch has
      // already started for the same repo.
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setBranches(b);
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

  return { branches, loading, error, refresh };
}
