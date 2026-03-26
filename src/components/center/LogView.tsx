import React, { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Virtuoso } from "react-virtuoso";
import type { CommitHistoryItem, CommitMarkers } from "../../types";
import { ContextMenu } from "../shared/ContextMenu";

function getInitials(name: string): string {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function hashColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const colors = ["#6ee7b7", "#93c5fd", "#fca5a5", "#c4b5fd", "#fcd34d", "#f0abfc"];
  return colors[Math.abs(h) % colors.length];
}

function relativeTime(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = Date.now();
    const diff = Math.floor((now - date.getTime()) / 1000);
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)} day${Math.floor(diff / 86400) > 1 ? "s" : ""} ago`;
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

type CommitRowProps = {
  commit: CommitHistoryItem;
  isSelected: boolean;
  isHead: boolean;
  isUpstream: boolean;
  upstreamRef: string | null | undefined;
  avatarUrl: string | null | undefined;
  onSelectCommit: (hash: string) => void;
  onContextMenu: (hash: string, x: number, y: number) => void;
};

const CommitRow = React.memo(function CommitRow({
  commit: c,
  isSelected,
  isHead,
  isUpstream,
  upstreamRef,
  avatarUrl,
  onSelectCommit,
  onContextMenu,
}: CommitRowProps) {
  const color = hashColor(c.author);
  const initials = getInitials(c.author);
  const handleClick = useCallback(() => onSelectCommit(c.hash), [onSelectCommit, c.hash]);
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(c.hash, e.clientX, e.clientY);
  }, [onContextMenu, c.hash]);

  return (
    <div
      className={`log-view__row ${isSelected ? "log-view__row--selected" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      {/* Initials are the base layer; the image fades in on top — no layout shift. */}
      <div className="log-view__avatar" style={{ background: `${color}18`, color }}>
        {initials}
        {avatarUrl && (
          <img
            src={avatarUrl}
            alt=""
            className="log-view__avatar-img"
            onLoad={e => e.currentTarget.classList.add("log-view__avatar-img--loaded")}
          />
        )}
      </div>
      <div className="log-view__content">
        <div className="log-view__message">{c.message}</div>
        <div className="log-view__meta">
          <span className="log-view__hash">{c.shortHash}</span>
          {isHead && <span className="log-view__marker log-view__marker--head">HEAD</span>}
          {isUpstream && (
            <span className="log-view__marker log-view__marker--upstream">
              {upstreamRef ?? "UPSTREAM"}
            </span>
          )}
          <span className="log-view__author">{c.author}</span>
          <span className="log-view__time">{relativeTime(c.date)}</span>
        </div>
      </div>
    </div>
  );
});

type LogViewProps = {
  repoPath: string | null;
  commits: CommitHistoryItem[];
  loadMore: () => void;
  hasMore: boolean;
  commitMarkers: CommitMarkers;
  selectedCommitHash: string | null;
  onSelectCommit: (commitHash: string) => void;
  onCreateTagAtCommit?: (commitHash: string) => void;
  onCherryPickAtCommit?: (commitHash: string) => void;
  onRevertAtCommit?: (commitHash: string) => void;
  onResetToCommit?: (commitHash: string, mode: "soft" | "mixed") => void;
};

// Caps the burst of IPC calls on mount to avoid saturating the Tauri channel.
const MAX_CONCURRENT_FETCHES = 3;

export function LogView({
  repoPath,
  commits,
  loadMore,
  hasMore,
  commitMarkers,
  selectedCommitHash,
  onSelectCommit,
  onCreateTagAtCommit,
  onCherryPickAtCommit,
  onRevertAtCommit,
  onResetToCommit,
}: LogViewProps) {
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; hash: string } | null>(null);

  const prevRepoRef = useRef<string | null>(null);
  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;

  // A generation counter lets us abandon in-flight fetches on repo change
  // without needing to cancel the underlying Promises.
  const generationRef = useRef(0);
  const fetchingRef = useRef<Set<string>>(new Set());
  const fetchedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<string[]>([]);
  const queuedEmailsRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(0);

  // Stored in a ref so .finally() callbacks always see the current version.
  const pumpRef = useRef<() => void>(() => {});
  pumpRef.current = () => {
    const gen = generationRef.current;
    const repo = currentRepoRef.current;
    while (activeRef.current < MAX_CONCURRENT_FETCHES && queueRef.current.length > 0) {
      const email = queueRef.current.shift()!;
      queuedEmailsRef.current.delete(email);
      if (!repo || fetchingRef.current.has(email)) continue;
      activeRef.current++;
      fetchingRef.current.add(email);
      invoke<string | null>("fetch_avatar", { email, repoPath: repo })
        .then(dataUrl => {
          if (generationRef.current === gen) {
            fetchedRef.current.add(email);
            startTransition(() => {
              setAvatars(prev => ({ ...prev, [email]: dataUrl }));
            });
          }
        })
        .catch(() => {
          if (generationRef.current === gen) {
            fetchedRef.current.add(email);
            startTransition(() => {
              setAvatars(prev => ({ ...prev, [email]: null }));
            });
          }
        })
        .finally(() => {
          fetchingRef.current.delete(email);
          if (generationRef.current === gen) {
            activeRef.current--;
            pumpRef.current();
          }
        });
    }
  };

  // Checks fetchedRef rather than avatars state so it's safe to call immediately after reset.
  const scheduleRef = useRef<(email: string) => void>(() => {});
  scheduleRef.current = (email: string) => {
    if (!currentRepoRef.current) return;
    if (fetchedRef.current.has(email) || fetchingRef.current.has(email)) return;
    if (queuedEmailsRef.current.has(email)) return;
    queuedEmailsRef.current.add(email);
    queueRef.current.push(email);
    pumpRef.current();
  };

  useEffect(() => {
    if (repoPath !== prevRepoRef.current) {
      prevRepoRef.current = repoPath;
      generationRef.current++;
      queueRef.current = [];
      queuedEmailsRef.current.clear();
      activeRef.current = 0;
      fetchingRef.current.clear();
      fetchedRef.current.clear();
      setAvatars({});
    }
  }, [repoPath]);

  // Virtuoso's rangeChanged only fires when the container has dimensions. If the
  // Log tab is hidden (display:none) on load it never fires, so we eagerly
  // schedule the first page here. scheduleRef deduplicates if it fires later too.
  useEffect(() => {
    const eager = Math.min(commits.length, 20);
    for (let i = 0; i < eager; i++) {
      const email = commits[i]?.authorEmail;
      if (email) scheduleRef.current(email);
    }
  }, [commits]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen("settings-updated", () => {
        generationRef.current++;
        queueRef.current = [];
        queuedEmailsRef.current.clear();
        activeRef.current = 0;
        fetchingRef.current.clear();
        fetchedRef.current.clear();
        setAvatars({});
      });
      if (cancelled) fn(); else unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const handleCommitContextMenu = useCallback((hash: string, x: number, y: number) => {
    setCommitMenu({ hash, x, y });
  }, []);

  const upstreamInList = commitMarkers.upstreamHead
    ? commits.some(c => c.hash === commitMarkers.upstreamHead)
    : true;
  const showUpstreamNotice = Boolean(
    commitMarkers.upstreamRef && commitMarkers.upstreamHead && !upstreamInList,
  );

  return (
    <div className="log-view">
      {showUpstreamNotice && (
        <div className="log-view__notice">
          Upstream tip {commitMarkers.upstreamRef} is outside this local history view.
        </div>
      )}
      <Virtuoso
        style={{ flex: 1 }}
        data={commits}
        itemContent={(index, c) => (
          <CommitRow
            commit={c}
            isSelected={selectedCommitHash ? selectedCommitHash === c.hash : index === 0}
            isHead={commitMarkers.localHead === c.hash}
            isUpstream={commitMarkers.upstreamHead === c.hash}
            upstreamRef={commitMarkers.upstreamRef}
            avatarUrl={c.authorEmail ? avatars[c.authorEmail] : undefined}
            onSelectCommit={onSelectCommit}
            onContextMenu={handleCommitContextMenu}
          />
        )}
        rangeChanged={({ startIndex, endIndex }) => {
          for (let i = startIndex; i <= Math.min(endIndex + 5, commits.length - 1); i++) {
            const email = commits[i]?.authorEmail;
            if (email) scheduleRef.current(email);
          }
        }}
        endReached={() => { if (hasMore) loadMore(); }}
        components={{
          EmptyPlaceholder: () => <div className="log-view__empty">No commits yet</div>,
        }}
      />
      {commitMenu && (onCreateTagAtCommit || onCherryPickAtCommit || onRevertAtCommit || onResetToCommit) && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          onClose={() => setCommitMenu(null)}
          items={[
            ...(onCherryPickAtCommit ? [{
              label: "Cherry-pick Commit",
              onClick: () => onCherryPickAtCommit(commitMenu.hash),
            }] : []),
            ...(onRevertAtCommit ? [{
              label: "Revert Commit…",
              onClick: () => onRevertAtCommit(commitMenu.hash),
            }] : []),
            ...(onResetToCommit ? [
              { label: "Soft Reset to Here", onClick: () => onResetToCommit(commitMenu.hash, "soft") },
              { label: "Mixed Reset to Here", onClick: () => onResetToCommit(commitMenu.hash, "mixed") },
            ] : []),
            ...(onCreateTagAtCommit ? [{
              label: "Create Tag Here…",
              onClick: () => onCreateTagAtCommit(commitMenu.hash),
            }] : []),
          ]}
        />
      )}
    </div>
  );
}
