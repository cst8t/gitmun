import { useState, useEffect } from "react";
import { getDiff } from "../api/commands";
import type { FileDiff } from "../types";

export function useGitDiff(repoPath: string | null, filePath: string | null, staged: boolean) {
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repoPath || !filePath) {
      setDiff(null);
      return;
    }

    let cancelled = false;
    setDiff(null);
    setLoading(true);
    setError(null);

    getDiff(repoPath, filePath, staged)
      .then(d => { if (!cancelled) setDiff(d); })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [repoPath, filePath, staged]);

  return { diff, loading, error };
}
