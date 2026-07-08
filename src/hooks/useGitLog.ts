import { useState, useEffect, useCallback, useRef } from "react";
import { getCommitHistory } from "../api/commands";
import type { CommitHistoryItem, CommitLogScope } from "../types";

const PAGE_SIZE = 100;

export function useGitLog(
  repoPath: string | null,
  scope: CommitLogScope = "currentCheckout",
  windowFocused = true,
  topoOrder = false,
) {
  const [commits, setCommits] = useState<CommitHistoryItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const commitsRef = useRef<CommitHistoryItem[]>([]);
  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;
  const currentScopeRef = useRef(scope);
  currentScopeRef.current = scope;
  const currentTopoOrderRef = useRef(topoOrder);
  currentTopoOrderRef.current = topoOrder;

  const refreshRequestId = useRef(0);
  const loadMoreRequestId = useRef(0);
  const pendingBlurredRefreshRef = useRef(false);
  // Cursor: hash of the last commit in the current list. The Rust side starts
  // the next walk from that commit's parents - O(PAGE_SIZE) per page.
  const cursorRef = useRef<string | undefined>(undefined);
  // Count of displayed commits, kept in a ref so loadMore doesn't go stale.
  const commitCountRef = useRef(0);

  useEffect(() => {
    setCommits([]);
    commitsRef.current = [];
    setHasMore(true);
    setError(null);
    setLoadMoreError(null);
    cursorRef.current = undefined;
    commitCountRef.current = 0;
  }, [repoPath, scope, topoOrder]);

  const refresh = useCallback(async (options?: { force?: boolean }) => {
    if (!windowFocused && options?.force !== true) {
      pendingBlurredRefreshRef.current = true;
      return;
    }
    if (!repoPath) {
      setCommits([]);
      commitsRef.current = [];
      setHasMore(true);
      setLoadMoreError(null);
      cursorRef.current = undefined;
      return;
    }
    const myId = ++refreshRequestId.current;
    const requestedLimit = Math.max(PAGE_SIZE, commitCountRef.current);
    setLoading(true);
    setError(null);
    setLoadMoreError(null);
    try {
      const page = await getCommitHistory(repoPath, requestedLimit, undefined, undefined, scope, topoOrder);
      if (
        currentRepoRef.current === repoPath
        && currentScopeRef.current === scope
        && currentTopoOrderRef.current === topoOrder
        && refreshRequestId.current === myId
        && commitCountRef.current <= requestedLimit
      ) {
        setCommits(page);
        commitsRef.current = page;
        setHasMore(page.length === requestedLimit);
        cursorRef.current = page[page.length - 1]?.hash;
        commitCountRef.current = page.length;
      }
    } catch (e) {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && currentTopoOrderRef.current === topoOrder && refreshRequestId.current === myId) {
        setError(String(e));
      }
    } finally {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && currentTopoOrderRef.current === topoOrder && refreshRequestId.current === myId) {
        setLoading(false);
      }
    }
  }, [repoPath, scope, topoOrder, windowFocused]);

  useEffect(() => { refresh(); }, [repoPath, scope, topoOrder]);

  useEffect(() => {
    if (!windowFocused || !pendingBlurredRefreshRef.current) return;
    pendingBlurredRefreshRef.current = false;
    refresh({ force: true });
  }, [refresh, windowFocused]);

  const loadMore = useCallback(async () => {
    if (!repoPath || loadingMore || !hasMore) return;
    const afterHash = cursorRef.current;
    if (!afterHash) return;
    const myId = ++loadMoreRequestId.current;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const offset = commitCountRef.current; // CLI fallback uses --skip
      const page = await getCommitHistory(repoPath, PAGE_SIZE, afterHash, offset, scope, topoOrder);
      if (
        currentRepoRef.current === repoPath
        && currentScopeRef.current === scope
        && currentTopoOrderRef.current === topoOrder
        && loadMoreRequestId.current === myId
        && cursorRef.current === afterHash
        && commitCountRef.current === offset
      ) {
        const existingHashes = new Set(commitsRef.current.map(commit => commit.hash));
        const nextPage = page.filter(commit => !existingHashes.has(commit.hash));
        const appendedCount = nextPage.length;
        if (appendedCount > 0) {
          const nextCommits = [...commitsRef.current, ...nextPage];
          commitsRef.current = nextCommits;
          setCommits(nextCommits);
        }
        setHasMore(page.length === PAGE_SIZE && appendedCount > 0);
        if (appendedCount > 0) {
          cursorRef.current = page[page.length - 1]?.hash;
          commitCountRef.current += appendedCount;
        }
      }
    } catch (e) {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && currentTopoOrderRef.current === topoOrder && loadMoreRequestId.current === myId) {
        setLoadMoreError(String(e));
      }
    } finally {
      if (currentRepoRef.current === repoPath && currentScopeRef.current === scope && currentTopoOrderRef.current === topoOrder && loadMoreRequestId.current === myId) {
        setLoadingMore(false);
      }
    }
  }, [repoPath, scope, topoOrder, loadingMore, hasMore]);

  return { commits, loading, loadingMore, loadMoreError, hasMore, error, pageSize: PAGE_SIZE, refresh, loadMore };
}
