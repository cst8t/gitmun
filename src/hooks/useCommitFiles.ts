import { useState, useEffect, useCallback, useRef } from "react";
import { getCommitFiles } from "../api/commands";
import type { CommitFileItem } from "../types";

export function useCommitFiles(repoPath: string | null, commitHash: string | null) {
  const [files, setFiles] = useState<CommitFileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  const fetchId = useRef(0);

  const refresh = useCallback(async () => {
    if (!repoPath || !commitHash) {
      setFiles([]);
      return;
    }
    const myId = ++fetchId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await getCommitFiles(repoPath, commitHash);
      if (currentRepoRef.current === repoPath && fetchId.current === myId) {
        setFiles(result);
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
  }, [repoPath, commitHash]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { files, loading, error, refresh };
}
