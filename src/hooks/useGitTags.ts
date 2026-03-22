import { useState, useEffect, useCallback, useRef } from "react";
import { getTags } from "../api/commands";
import type { TagInfo } from "../types";

export function useGitTags(repoPath: string | null) {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Updated synchronously in the render body — always reflects the current
  // project even in the gap between a render and its effects.
  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  const fetchId = useRef(0);

  // Reset immediately when the repo changes so stale tags never show.
  useEffect(() => {
    setTags([]);
    setError(null);
  }, [repoPath]);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setTags([]);
      return;
    }
    const myId = ++fetchId.current;
    setLoading(true);
    setError(null);
    try {
      const t = await getTags(repoPath);
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setTags(t);
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

  return { tags, loading, error, refresh };
}
