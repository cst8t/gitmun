import { useState, useEffect, useCallback, useRef } from "react";
import { getCommitHistory } from "../api/commands";
import type { CommitHistoryItem, CommitLogScope } from "../types";

const PAGE_SIZE = 100;

export function useGitLog(repoPath: string | null, scope: CommitLogScope = "currentCheckout") {
  const [commits, setCommits] = useState<CommitHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;

  const fetchId = useRef(0);
  // Cursor: hash of the last commit in the current list. The Rust side starts
  // the next walk from that commit's parents - O(PAGE_SIZE) per page.
  const cursorRef = useRef<string | undefined>(undefined);
  // Count of displayed commits, kept in a ref so loadMore doesn't go stale.
  const commitCountRef = useRef(0);

  useEffect(() => {
    setCommits([]);
    setHasMore(true);
    setError(null);
    cursorRef.current = undefined;
    commitCountRef.current = 0;
  }, [repoPath, scope]);

  const refresh = useCallback(async () => {
    if (!repoPath) {
      setCommits([]);
      setHasMore(true);
      cursorRef.current = undefined;
      return;
    }
    const myId = ++fetchId.current;
    setLoading(true);
    setError(null);
    cursorRef.current = undefined;
    commitCountRef.current = 0;
    try {
      const page = await getCommitHistory(repoPath, PAGE_SIZE, undefined, undefined, scope);
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && fetchId.current === myId) {
        setCommits(page);
        setHasMore(page.length === PAGE_SIZE);
        cursorRef.current = page[page.length - 1]?.hash;
        commitCountRef.current = page.length;
      }
    } catch (e) {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && fetchId.current === myId) {
        setError(String(e));
      }
    } finally {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && fetchId.current === myId) {
        setLoading(false);
      }
    }
  }, [repoPath, scope]);

  useEffect(() => { refresh(); }, [refresh]);

  const loadMore = useCallback(async () => {
    if (!repoPath || loadingMore || !hasMore) return;
    const afterHash = cursorRef.current;
    if (!afterHash) return;
    const myId = ++fetchId.current;
    setLoadingMore(true);
    try {
      const offset = commitCountRef.current; // CLI fallback uses --skip
      const page = await getCommitHistory(repoPath, PAGE_SIZE, afterHash, offset, scope);
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && fetchId.current === myId) {
        setCommits(prev => [...prev, ...page]);
        setHasMore(page.length === PAGE_SIZE);
        if (page.length > 0) {
          cursorRef.current = page[page.length - 1]?.hash;
          commitCountRef.current += page.length;
        }
      }
    } catch {
      // silently ignore - user can scroll up and back to retry
    } finally {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && fetchId.current === myId) {
        setLoadingMore(false);
      }
    }
  }, [repoPath, scope, loadingMore, hasMore]);

  return { commits, loading, loadingMore, hasMore, error, refresh, loadMore };
}
