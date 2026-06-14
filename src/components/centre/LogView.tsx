import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { Virtuoso } from "react-virtuoso";
import type { ListItem, ListRange, VirtuosoHandle } from "react-virtuoso";
import type {
  CommitHistoryItem,
  CommitLogScope,
  CommitMarkers,
  CommitRefDecoration,
  CommitRefKind,
  RowStriping,
  Settings,
  SignatureStatus,
} from "../../types";
import { verifyCommits } from "../../api/commands";
import { buildCommitGraph, type CommitGraphRow } from "../../utils/commitGraph";
import { ContextMenu } from "../shared/ContextMenu";

function getInitials(name: string): string {
  return name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
}

function hashColour(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  const colours = ["#6ee7b7", "#93c5fd", "#fca5a5", "#c4b5fd", "#fcd34d", "#f0abfc"];
  return colours[Math.abs(h) % colours.length];
}

function graphLaneColour(lane: number): string {
  const colours = [
    "var(--accent)",
    "var(--green)",
    "var(--yellow)",
    "var(--red)",
    "#c4b5fd",
    "#6ee7b7",
    "#f0abfc",
    "#93c5fd",
  ];
  return colours[lane % colours.length];
}

function relativeTime(dateStr: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  try {
    const date = new Date(dateStr);
    const now = Date.now();
    const diff = Math.floor((now - date.getTime()) / 1000);
    if (diff < 60) return t("log.justNow");
    if (diff < 3600) return t("log.timeMinutesAgo", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("log.timeHoursAgo", { count: Math.floor(diff / 3600) });
    if (diff < 604800) return t("log.timeDaysAgo", { count: Math.floor(diff / 86400) });
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

function formatFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^[^:]+:/, "");
}

type SigPopoverData = {
  rect: DOMRect;
  status: SignatureStatus;
  signer: string | null;
  fingerprint: string | null;
  keyType: string | null;
  date: string;
};

function ShieldIcon({ status }: { status: SignatureStatus }) {
  return (
    <svg className="log-view__sig-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1L2 3.5v4C2 11 4.5 14 8 15c3.5-1 6-4 6-7.5v-4L8 1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" fill="none" />
      {status === "verified" && <path d="M5.5 8l2 2 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />}
      {status === "bad" && <path d="M6 6l4 4M10 6l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
    </svg>
  );
}

function SignaturePopover({ data, onClose }: { data: SigPopoverData; onClose: () => void }) {
  const { t } = useTranslation("centre");
  const ref = useRef<HTMLDivElement>(null);
  const { rect, status, signer, fingerprint, keyType, date } = data;

  // Position the popover above the badge, clamped to viewport
  const popoverWidth = 280;
  const gap = 6;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const elH = el.offsetHeight;
    let top = rect.top - elH - gap;
    if (top < 8) top = rect.bottom + gap;
    if (top + elH > innerHeight - 8) top = innerHeight - elH - 8;
    let left = rect.left + rect.width / 2 - popoverWidth / 2;
    if (left < 8) left = 8;
    if (left + popoverWidth > innerWidth - 8) left = innerWidth - popoverWidth - 8;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  });

  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) { if (e.key === "Escape") onClose(); return; }
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", handler);
    };
  }, [onClose]);

  const heading =
    status === "verified" ? t("log.signedVerified") :
    status === "bad"      ? t("log.signedBad") :
    status === "unknownKey" ? t("log.signedUnknownKey") :
                            t("log.signedUnverified");

  const mod = status === "verified" ? "verified" : status === "bad" ? "bad" : "unknown";

  return (
    <div ref={ref} className={`sig-popover sig-popover--${mod}`} role="dialog" aria-modal="false">
      <button className="sig-popover__close" onClick={onClose} aria-label={t("log.close")}>✕</button>
      <div className="sig-popover__header">
        <ShieldIcon status={status} />
        <span>{heading}</span>
      </div>
      {signer && (
        <div className="sig-popover__row">
          <span className="sig-popover__label">{t("log.signer")}</span>
          <span className="sig-popover__value">{signer}</span>
        </div>
      )}
      {keyType && (
        <div className="sig-popover__row">
          <span className="sig-popover__label">{t("log.keyType")}</span>
          <span className="sig-popover__value">{keyType.toUpperCase()}</span>
        </div>
      )}
      {fingerprint && (
        <div className="sig-popover__row">
          <span className="sig-popover__label">{t("log.fingerprint")}</span>
          <span className="sig-popover__value sig-popover__value--mono">{formatFingerprint(fingerprint)}</span>
        </div>
      )}
      <div className="sig-popover__row">
        <span className="sig-popover__label">{t("log.date")}</span>
        <span className="sig-popover__value">{new Date(date).toLocaleString()}</span>
      </div>
    </div>
  );
}

function SignatureBadge({ status, onOpen }: { status: SignatureStatus; onOpen: (rect: DOMRect) => void }) {
  const { t } = useTranslation("centre");
  if (status === "none") return null;
  const label = status === "verified" ? t("log.verified") : status === "bad" ? t("log.badSignature") : t("log.signed");
  const mod = status === "verified" ? "verified" : status === "bad" ? "bad" : "unknown";
  return (
    <button
      className={`log-view__sig-badge log-view__sig-badge--${mod}`}
      onClick={e => { e.stopPropagation(); onOpen((e.currentTarget as HTMLElement).getBoundingClientRect()); }}
    >
      <ShieldIcon status={status} />
      {label}
    </button>
  );
}

type CommitRowProps = {
  commit: CommitHistoryItem;
  index: number;
  graphRow: CommitGraphRow | undefined;
  graphLaneCount: number;
  effectiveSigStatus: SignatureStatus;
  signer: string | null | undefined;
  fingerprint: string | null | undefined;
  isSelected: boolean;
  isHead: boolean;
  isUpstream: boolean;
  upstreamRef: string | null | undefined;
  avatarUrl: string | null | undefined;
  striped?: "Subtle" | "Strong";
  showCommitGraph: boolean;
  highlightedGraphHashes: Set<string> | null;
  onSelectCommit: (hash: string, index: number, event: React.MouseEvent) => void;
  onHoverCommit: (hash: string | null) => void;
  onVisibleSignedCommit: (index: number) => void;
  onContextMenu: (hash: string, index: number, x: number, y: number) => void;
  onBadgeClick: (rect: DOMRect, status: SignatureStatus, signer: string | null, fingerprint: string | null, keyType: string | null, date: string) => void;
};

const GRAPH_LANE_WIDTH = 12;
const GRAPH_NODE_RADIUS = 4;
const MAX_VISIBLE_REF_CHIPS = 2;
const MAX_REF_LABEL_LENGTH = 8;
const MAX_VERIFICATION_BATCH_SIZE = 20;
const BACKGROUND_VERIFICATION_PUMP_DELAY_MS = 25;

function graphWidth(laneCount: number): number {
  return Math.max(14, laneCount * GRAPH_LANE_WIDTH);
}

function graphX(lane: number, laneCount: number): number {
  return 5 + Math.min(lane, laneCount - 1) * GRAPH_LANE_WIDTH;
}

function graphPieceClass(baseClass: string, active: boolean | null): string {
  if (active === null) return baseClass;
  return `${baseClass} ${active ? "log-view__graph-piece--active" : "log-view__graph-piece--dimmed"}`;
}

function graphTitle(
  commit: CommitHistoryItem,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const lines = [
    t("log.graphCommit", { hash: commit.shortHash }),
    t("log.graphLaneHint"),
  ];
  const firstParent = commit.parentHashes[0];
  const mergedParents = commit.parentHashes.slice(1);
  if (firstParent) {
    lines.push(t("log.graphFirstParent", { hash: firstParent.slice(0, 7) }));
  }
  if (mergedParents.length > 0) {
    lines.push(t("log.graphMergedParents", { hashes: mergedParents.map(hash => hash.slice(0, 7)).join(", ") }));
  }
  if (commit.refDecorations.length > 0) {
    lines.push(t("log.graphRefs", { refs: commit.refDecorations.map(ref => ref.name).join(", ") }));
  }
  return lines.join("\n");
}

function CommitGraphGutter({
  row,
  laneCount,
  commit,
  highlightedHashes,
}: {
  row: CommitGraphRow | undefined;
  laneCount: number;
  commit: CommitHistoryItem;
  highlightedHashes: Set<string> | null;
}) {
  const { t } = useTranslation("centre");
  const width = graphWidth(laneCount);
  if (!row) {
    return <div className="log-view__graph" style={{ width }} aria-hidden="true" />;
  }

  const commitX = graphX(row.commitLane, laneCount);
  const nodeSize = GRAPH_NODE_RADIUS * 2;
  const hasHighlight = highlightedHashes !== null;
  const graphTitleText = graphTitle(commit, t);
  const isActiveHash = (hash: string): boolean | null => {
    if (!highlightedHashes) return null;
    return highlightedHashes.has(hash);
  };

  return (
    <div className="log-view__graph" style={{ width }} title={graphTitleText} aria-label={graphTitleText}>
      {row.topLanes.map(lane => {
        const x = graphX(lane.lane, laneCount);
        return (
          <span
            key={`top-${lane.lane}-${lane.hash}`}
            className={graphPieceClass(
              "log-view__graph-vertical log-view__graph-vertical--top",
              isActiveHash(lane.hash),
            )}
            style={{ left: x, background: graphLaneColour(lane.lane) }}
          />
        );
      })}
      <svg className="log-view__graph-connectors" width={width} height="100%" viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
        {row.parentLanes.map(parent => {
          const x = graphX(parent.lane, laneCount);
          if (x === commitX) return null;
          return (
            <line
              key={`parent-${parent.lane}-${parent.hash}`}
              x1={commitX}
              y1="50"
              x2={x}
              y2="100"
              stroke={graphLaneColour(parent.lane)}
              className={graphPieceClass("log-view__graph-connector", isActiveHash(parent.hash))}
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>
      {row.bottomLanes.map(lane => {
        const x = graphX(lane.lane, laneCount);
        return (
          <span
            key={`bottom-${lane.lane}-${lane.hash}`}
            className={graphPieceClass(
              "log-view__graph-vertical log-view__graph-vertical--bottom",
              isActiveHash(lane.hash),
            )}
            style={{ left: x, background: graphLaneColour(lane.lane) }}
          />
        );
      })}
      <span
        className={graphPieceClass("log-view__graph-node", hasHighlight ? highlightedHashes.has(row.hash) : null)}
        style={{
          left: commitX - GRAPH_NODE_RADIUS,
          top: `calc(50% - ${GRAPH_NODE_RADIUS}px)`,
          width: nodeSize,
          height: nodeSize,
          background: graphLaneColour(row.commitLane),
        }}
      />
    </div>
  );
}

function refTitle(
  decoration: CommitRefDecoration,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (decoration.kind === "localBranch") return t("log.localBranchRef", { name: decoration.name });
  if (decoration.kind === "remoteBranch") return t("log.remoteBranchRef", { name: decoration.name });
  return t("log.tagRef", { name: decoration.name });
}

function refClass(kind: CommitRefKind): string {
  return `log-view__ref log-view__ref--${kind}`;
}

function compactRefName(name: string): string {
  if (name.length <= MAX_REF_LABEL_LENGTH) return name;
  return `${name.slice(0, MAX_REF_LABEL_LENGTH - 3)}...`;
}

function refPriority(kind: CommitRefKind): number {
  if (kind === "localBranch") return 0;
  if (kind === "tag") return 1;
  return 2;
}

function compactRefDecorations(decorations: CommitRefDecoration[]): CommitRefDecoration[] {
  return [...decorations].sort((a, b) => (
    refPriority(a.kind) - refPriority(b.kind) || a.name.localeCompare(b.name)
  ));
}

function CommitRefChips({ decorations }: { decorations: CommitRefDecoration[] }) {
  const { t } = useTranslation("centre");
  if (decorations.length === 0) return null;
  const sorted = compactRefDecorations(decorations);
  const visible = sorted.slice(0, MAX_VISIBLE_REF_CHIPS);
  const hidden = sorted.slice(MAX_VISIBLE_REF_CHIPS);

  return (
    <div className="log-view__refs" aria-label={t("log.commitRefs")}>
      {visible.map(decoration => (
        <span
          key={`${decoration.kind}-${decoration.name}`}
          className={refClass(decoration.kind)}
          title={refTitle(decoration, t)}
        >
          {compactRefName(decoration.name)}
        </span>
      ))}
      {hidden.length > 0 && (
        <span
          className="log-view__ref log-view__ref--more"
          title={t("log.moreRefs", { count: hidden.length, refs: hidden.map(ref => ref.name).join(", ") })}
        >
          {t("log.moreRefsLabel", { count: hidden.length })}
        </span>
      )}
    </div>
  );
}

const CommitRow = React.memo(function CommitRow({
  commit: c,
  index,
  graphRow,
  graphLaneCount,
  effectiveSigStatus,
  signer,
  fingerprint,
  isSelected,
  isHead,
  isUpstream,
  upstreamRef,
  avatarUrl,
  striped,
  showCommitGraph,
  highlightedGraphHashes,
  onSelectCommit,
  onHoverCommit,
  onVisibleSignedCommit,
  onContextMenu,
  onBadgeClick,
}: CommitRowProps) {
  const { t } = useTranslation("centre");
  const colour = hashColour(c.author);
  const initials = getInitials(c.author);
  const handleClick = useCallback((e: React.MouseEvent) => onSelectCommit(c.hash, index, e), [onSelectCommit, c.hash, index]);
  const stripingClass = striped ? ` log-view__row--striped-${striped.toLowerCase()}` : "";
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    onContextMenu(c.hash, index, e.clientX, e.clientY);
  }, [onContextMenu, c.hash, index]);
  useEffect(() => {
    if (c.signatureStatus === "signed") onVisibleSignedCommit(index);
  }, [c.hash, c.signatureStatus, index, onVisibleSignedCommit]);

  return (
    <div
      className={`log-view__row${stripingClass} ${isSelected ? "log-view__row--selected" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => { if (showCommitGraph) onHoverCommit(c.hash); }}
      onMouseLeave={() => { if (showCommitGraph) onHoverCommit(null); }}
      aria-selected={isSelected}
    >
      {showCommitGraph && (
        <CommitGraphGutter
          row={graphRow}
          laneCount={graphLaneCount}
          commit={c}
          highlightedHashes={highlightedGraphHashes}
        />
      )}
      {/* Initials are the base layer; the image fades in on top - no layout shift. */}
      <div className="log-view__avatar" style={{ background: `${colour}18`, color: colour }}>
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
        <div className="log-view__subject-row">
          <div className="log-view__message">{c.message}</div>
        </div>
        <div className="log-view__meta">
          <span className="log-view__hash">{c.shortHash}</span>
          {isHead && <span className="log-view__marker log-view__marker--head">HEAD</span>}
          {isUpstream && (
            <span className="log-view__marker log-view__marker--upstream">
              {upstreamRef ?? "UPSTREAM"}
            </span>
          )}
          <CommitRefChips decorations={c.refDecorations} />
          <SignatureBadge
            status={effectiveSigStatus}
            onOpen={rect => onBadgeClick(rect, effectiveSigStatus, signer ?? null, fingerprint ?? null, c.keyType, c.date)}
          />
          <span className="log-view__author">{c.author}</span>
          <span className="log-view__time">{relativeTime(c.date, t)}</span>
        </div>
      </div>
    </div>
  );
});

type LogViewProps = {
  active: boolean;
  repoPath: string | null;
  commits: CommitHistoryItem[];
  loadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  pageSize: number;
  logLoading: boolean;
  logError: string | null;
  commitMarkers: CommitMarkers;
  logScope: CommitLogScope;
  rowStriping: RowStriping;
  showCommitGraph: boolean;
  detachedHead: boolean;
  shallow: boolean;
  selectedCommitHash: string | null;
  onSelectCommit: (commitHash: string) => void;
  onCreateTagAtCommit?: (commitHash: string) => void;
  onCherryPickAtCommit?: (commitHash: string) => void;
  onRevertAtCommit?: (commitHash: string) => void;
  onResetToCommit?: (commitHash: string, mode: "soft" | "mixed") => void;
};

// Caps the burst of IPC calls on mount to avoid saturating the Tauri channel.
const MAX_CONCURRENT_FETCHES = 3;

function getCommitRangeHashes(commits: CommitHistoryItem[], fromHash: string, toIndex: number): string[] {
  const fromIndex = commits.findIndex(c => c.hash === fromHash);
  if (fromIndex === -1) {
    const hash = commits[toIndex]?.hash;
    return hash ? [hash] : [];
  }
  const start = Math.min(fromIndex, toIndex);
  const end = Math.max(fromIndex, toIndex);
  return commits.slice(start, end + 1).map(c => c.hash);
}

function getLoadedAncestorHashes(commits: CommitHistoryItem[], hash: string | null): Set<string> | null {
  if (!hash) return null;
  const byHash = new Map(commits.map(commit => [commit.hash, commit]));
  const highlighted = new Set<string>();
  const pending = [hash];

  while (pending.length > 0) {
    const currentHash = pending.pop()!;
    if (highlighted.has(currentHash)) continue;
    const commit = byHash.get(currentHash);
    if (!commit) continue;
    highlighted.add(currentHash);
    pending.push(...commit.parentHashes);
  }

  return highlighted.size > 0 ? highlighted : null;
}

function formatCommitDetails(commits: CommitHistoryItem[]): string {
  return commits.map(c => [
    `commit ${c.hash}`,
    `Author: ${c.author} <${c.authorEmail}>`,
    `Date: ${c.date}`,
    "",
    c.message,
  ].join("\n")).join("\n\n");
}

type VerificationStage = "idle" | "queued" | "verifying" | "verified" | "bad" | "unknownKey" | "failed";

type VerificationEntry = {
  stage: VerificationStage;
  visibleStatus?: Exclude<SignatureStatus, "none" | "signed">;
  signer: string | null;
  fingerprint: string | null;
  requestId: number;
  concreteRequestId: number;
  attempted: boolean;
  retryCount: number;
};

function verificationKey(repoPath: string, hash: string): string {
  return `${repoPath}\u0000${hash}`;
}

function concreteSignatureStatus(status: SignatureStatus): Exclude<SignatureStatus, "none" | "signed"> | null {
  if (status === "verified" || status === "bad" || status === "unknownKey") return status;
  return null;
}

function signatureSettingsChanged(previous: Settings | null, next: Settings | null): boolean {
  if (!previous || !next) return false;
  return previous.gpgKeyserverVerificationEnabled !== next.gpgKeyserverVerificationEnabled
    || previous.gitExecutablePath !== next.gitExecutablePath;
}

function signatureVerificationPriority(commit: CommitHistoryItem | undefined): number {
  if (commit?.keyType === "ssh") return 0;
  if (commit?.keyType === "gpg") return 2;
  return 1;
}

export function LogView({
  active,
  repoPath,
  commits,
  loadMore,
  hasMore,
  loadingMore,
  loadMoreError,
  pageSize,
  logLoading,
  logError,
  commitMarkers,
  logScope,
  rowStriping,
  showCommitGraph,
  detachedHead,
  shallow,
  selectedCommitHash,
  onSelectCommit,
  onCreateTagAtCommit,
  onCherryPickAtCommit,
  onRevertAtCommit,
  onResetToCommit,
}: LogViewProps) {
  const { t } = useTranslation("centre");
  const [avatars, setAvatars] = useState<Record<string, string | null>>({});
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number; hash: string } | null>(null);
  const [selectedCommitHashes, setSelectedCommitHashes] = useState<Set<string>>(() => {
    const initialHash = selectedCommitHash ?? commits[0]?.hash;
    return initialHash ? new Set([initialHash]) : new Set();
  });
  const [selectionAnchorHash, setSelectionAnchorHash] = useState<string | null>(selectedCommitHash ?? commits[0]?.hash ?? null);
  const [hoveredCommitHash, setHoveredCommitHash] = useState<string | null>(null);
  const [verificationEntries, setVerificationEntries] = useState<Record<string, VerificationEntry>>({});
  const [sigPopover, setSigPopover] = useState<SigPopoverData | null>(null);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevRepoRef = useRef<string | null>(repoPath);
  const prevLogScopeRef = useRef<CommitLogScope>(logScope);
  const currentRepoRef = useRef(repoPath);
  currentRepoRef.current = repoPath;
  const verifyGenerationRef = useRef(0);
  const verificationEntriesRef = useRef<Record<string, VerificationEntry>>({});
  const verificationQueueRef = useRef<string[]>([]);
  const queuedVerificationKeysRef = useRef<Set<string>>(new Set());
  const inFlightVerificationKeysRef = useRef<Set<string>>(new Set());
  const activeVerificationBatchRef = useRef(false);
  const verificationPumpQueuedRef = useRef(false);
  const verificationRequestIdRef = useRef(0);
  const lastSettingsRef = useRef<Settings | null>(null);
  const visibleRangeRef = useRef<ListRange>({ startIndex: 0, endIndex: 19 });
  const pendingRevealIndexRef = useRef<number | null>(null);
  const commitHashes = useMemo(() => new Set(commits.map(c => c.hash)), [commits]);
  const commitByHash = useMemo(() => new Map(commits.map(commit => [commit.hash, commit])), [commits]);
  const commitGraph = useMemo(() => showCommitGraph ? buildCommitGraph(commits) : null, [showCommitGraph, commits]);
  const graphFocusHash = showCommitGraph
    ? hoveredCommitHash ?? (selectedCommitHashes.size === 1 ? Array.from(selectedCommitHashes)[0] : null)
    : null;
  const highlightedGraphHashes = useMemo(
    () => showCommitGraph ? getLoadedAncestorHashes(commits, graphFocusHash) : null,
    [commits, graphFocusHash, showCommitGraph],
  );
  const selectedCommits = useMemo(
    () => commits.filter(c => selectedCommitHashes.has(c.hash)),
    [commits, selectedCommitHashes],
  );
  const commitMenuCommits = useMemo(() => {
    if (!commitMenu) return [];
    if (selectedCommits.some(c => c.hash === commitMenu.hash)) return selectedCommits;
    const target = commits.find(c => c.hash === commitMenu.hash);
    return target ? [target] : [];
  }, [commitMenu, selectedCommits, commits]);

  // A generation counter lets us abandon in-flight fetches on repo change
  // without needing to cancel the underlying Promises.
  const generationRef = useRef(0);
  const fetchingRef = useRef<Set<string>>(new Set());
  const fetchedRef = useRef<Set<string>>(new Set());
  const queueRef = useRef<string[]>([]);
  const queuedEmailsRef = useRef<Set<string>>(new Set());
  const activeRef = useRef(0);

  const replaceVerificationEntries = useCallback((updater: (prev: Record<string, VerificationEntry>) => Record<string, VerificationEntry>) => {
    const next = updater(verificationEntriesRef.current);
    verificationEntriesRef.current = next;
    setVerificationEntries(next);
  }, []);

  const pumpVerificationRef = useRef<() => void>(() => {});
  pumpVerificationRef.current = () => {
    if (activeVerificationBatchRef.current || !currentRepoRef.current) return;
    const repo = currentRepoRef.current;
    const batchKeys: string[] = [];
    const remainingKeys: string[] = [];
    let batchPriority: number | null = null;
    verificationQueueRef.current.sort((a, b) => {
      const aHash = a.slice(a.indexOf("\u0000") + 1);
      const bHash = b.slice(b.indexOf("\u0000") + 1);
      return signatureVerificationPriority(commitByHash.get(aHash)) - signatureVerificationPriority(commitByHash.get(bHash));
    });
    for (const key of verificationQueueRef.current) {
      const hash = key.slice(key.indexOf("\u0000") + 1);
      const commit = commitByHash.get(hash);
      if (!commit) {
        queuedVerificationKeysRef.current.delete(key);
        continue;
      }
      const priority = signatureVerificationPriority(commit);
      if (batchPriority === null) batchPriority = priority;
      if (priority === batchPriority && batchKeys.length < MAX_VERIFICATION_BATCH_SIZE) {
        batchKeys.push(key);
        queuedVerificationKeysRef.current.delete(key);
      } else {
        remainingKeys.push(key);
      }
    }
    verificationQueueRef.current = remainingKeys;
    if (batchKeys.length === 0) return;

    const hashes = batchKeys
      .map(key => key.slice(key.indexOf("\u0000") + 1))
      .filter(hash => commitHashes.has(hash));
    if (hashes.length === 0) {
      pumpVerificationRef.current();
      return;
    }

    const requestId = ++verificationRequestIdRef.current;
    const generation = verifyGenerationRef.current;
    activeVerificationBatchRef.current = true;
    for (const hash of hashes) {
      inFlightVerificationKeysRef.current.add(verificationKey(repo, hash));
    }
    replaceVerificationEntries(prev => {
      const next = { ...prev };
      for (const hash of hashes) {
        const key = verificationKey(repo, hash);
        const existing = next[key];
        next[key] = {
          stage: "verifying",
          visibleStatus: existing?.visibleStatus,
          signer: existing?.signer ?? null,
          fingerprint: existing?.fingerprint ?? null,
          requestId,
          concreteRequestId: existing?.concreteRequestId ?? 0,
          attempted: true,
          retryCount: existing?.retryCount ?? 0,
        };
      }
      return next;
    });

    verifyCommits(repo, hashes).then(results => {
      if (verifyGenerationRef.current !== generation || currentRepoRef.current !== repo) return;
      const byHash = new Map(results.map(result => [result.hash, result]));
      replaceVerificationEntries(prev => {
        const next = { ...prev };
        for (const hash of hashes) {
          const key = verificationKey(repo, hash);
          const existing = next[key];
          if (!existing) continue;
          const result = byHash.get(hash);
          if (!result) {
            next[key] = {
              ...existing,
              stage: existing.visibleStatus ?? "idle",
              requestId: Math.max(existing.requestId, requestId),
              attempted: true,
            };
            continue;
          }
          const concreteStatus = concreteSignatureStatus(result.status);
          if (concreteStatus) {
            if (existing.concreteRequestId > requestId) continue;
            next[key] = {
              ...existing,
              stage: concreteStatus,
              visibleStatus: concreteStatus,
              signer: result.signer,
              fingerprint: result.fingerprint,
              requestId: Math.max(existing.requestId, requestId),
              concreteRequestId: requestId,
              attempted: true,
            };
          } else {
            next[key] = {
              ...existing,
              stage: existing.visibleStatus ?? "idle",
              requestId: Math.max(existing.requestId, requestId),
              attempted: true,
            };
          }
        }
        return next;
      });
    }).catch(() => {
      if (verifyGenerationRef.current !== generation || currentRepoRef.current !== repo) return;
      replaceVerificationEntries(prev => {
        const next = { ...prev };
        for (const hash of hashes) {
          const key = verificationKey(repo, hash);
          const existing = next[key];
          if (!existing) continue;
          next[key] = {
            ...existing,
            stage: "failed",
            requestId: Math.max(existing.requestId, requestId),
            attempted: true,
          };
        }
        return next;
      });
    }).finally(() => {
      if (verifyGenerationRef.current === generation && currentRepoRef.current === repo) {
        for (const hash of hashes) {
          inFlightVerificationKeysRef.current.delete(verificationKey(repo, hash));
        }
        activeVerificationBatchRef.current = false;
        pumpVerificationRef.current();
      }
    });
  };

  const requestVerificationPump = useCallback(() => {
    if (verificationPumpQueuedRef.current) return;
    verificationPumpQueuedRef.current = true;
    Promise.resolve().then(() => {
      verificationPumpQueuedRef.current = false;
      pumpVerificationRef.current();
    });
  }, []);

  const requestDelayedVerificationPump = useCallback(() => {
    if (verificationPumpQueuedRef.current) return;
    verificationPumpQueuedRef.current = true;
    window.setTimeout(() => {
      verificationPumpQueuedRef.current = false;
      pumpVerificationRef.current();
    }, BACKGROUND_VERIFICATION_PUMP_DELAY_MS);
  }, []);

  const scheduleVerificationKey = useCallback((repo: string, hash: string, forceRevalidate: boolean, pumpNow = true) => {
    const key = verificationKey(repo, hash);
    const existing = verificationEntriesRef.current[key];
    const canRetryFailure = existing?.stage === "failed" && existing.retryCount < 1;
    const shouldSchedule = forceRevalidate
      || !existing
      || (existing.stage === "idle" && !existing.attempted)
      || canRetryFailure;
    if (
      !shouldSchedule
      || queuedVerificationKeysRef.current.has(key)
      || (!forceRevalidate && inFlightVerificationKeysRef.current.has(key))
    ) return;

    queuedVerificationKeysRef.current.add(key);
    verificationQueueRef.current.push(key);
    replaceVerificationEntries(prev => {
      const current = prev[key];
      return {
        ...prev,
        [key]: {
          stage: "queued",
          visibleStatus: current?.visibleStatus,
          signer: current?.signer ?? null,
          fingerprint: current?.fingerprint ?? null,
          requestId: current?.requestId ?? 0,
          concreteRequestId: current?.concreteRequestId ?? 0,
          attempted: current?.attempted ?? false,
          retryCount: canRetryFailure ? (current?.retryCount ?? 0) + 1 : (current?.retryCount ?? 0),
        },
      };
    });
    if (pumpNow) pumpVerificationRef.current();
  }, [replaceVerificationEntries]);

  const handleVisibleSignedCommit = useCallback((index: number) => {
    if (!active || !repoPath) return;
    const commit = commits[index];
    if (!commit || commit.signatureStatus !== "signed") return;
    scheduleVerificationKey(repoPath, commit.hash, false, false);
    requestVerificationPump();
  }, [active, commits, repoPath, requestVerificationPump, scheduleVerificationKey]);

  const verifyVisibleSignedCommits = useCallback((startIndex: number, endIndex: number, forceRevalidate = false) => {
    if (!active || !repoPath || commits.length === 0) return;
    const verifyStart = Math.min(startIndex, commits.length - 1);
    const verifyEnd = Math.min(endIndex, commits.length - 1);
    const visibleSignedCommits = commits
      .slice(verifyStart, verifyEnd + 1)
      .filter(commit => commit.signatureStatus === "signed")
      .sort((a, b) => signatureVerificationPriority(a) - signatureVerificationPriority(b));
    let lastPriority: number | null = null;
    for (const commit of visibleSignedCommits) {
      if (commit.signatureStatus !== "signed") continue;
      const priority = signatureVerificationPriority(commit);
      if (lastPriority !== null && priority !== lastPriority) {
        pumpVerificationRef.current();
      }
      scheduleVerificationKey(repoPath, commit.hash, forceRevalidate, false);
      lastPriority = priority;
    }
    pumpVerificationRef.current();
  }, [active, repoPath, commits, scheduleVerificationKey]);

  const verifyLoadedSignedCommits = useCallback(() => {
    if (!active || !repoPath || commits.length === 0) return;
    let scheduled = false;
    for (const commit of commits) {
      if (commit.signatureStatus !== "signed") continue;
      const beforeLength = verificationQueueRef.current.length;
      scheduleVerificationKey(repoPath, commit.hash, false, false);
      if (verificationQueueRef.current.length !== beforeLength) scheduled = true;
    }
    if (scheduled) requestDelayedVerificationPump();
  }, [active, commits, repoPath, requestDelayedVerificationPump, scheduleVerificationKey]);

  const handleVisibleRange = useCallback((range: ListRange) => {
    if (!active) return;
    visibleRangeRef.current = range;
    verifyVisibleSignedCommits(range.startIndex, range.endIndex);
    for (let i = range.startIndex; i <= Math.min(range.endIndex + 5, commits.length - 1); i++) {
      const email = commits[i]?.authorEmail;
      if (email) scheduleRef.current(email);
    }
  }, [active, commits, verifyVisibleSignedCommits]);

  const handleItemsRendered = useCallback((items: ListItem<CommitHistoryItem>[]) => {
    if (items.length === 0) return;
    const indexes = items.map(item => item.index);
    handleVisibleRange({
      startIndex: Math.min(...indexes),
      endIndex: Math.max(...indexes),
    });
  }, [handleVisibleRange]);

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
    if (repoPath !== prevRepoRef.current || logScope !== prevLogScopeRef.current) {
      prevRepoRef.current = repoPath;
      prevLogScopeRef.current = logScope;
      generationRef.current++;
      queueRef.current = [];
      queuedEmailsRef.current.clear();
      activeRef.current = 0;
      fetchingRef.current.clear();
      fetchedRef.current.clear();
      setAvatars({});
      verificationEntriesRef.current = {};
      verificationQueueRef.current = [];
      queuedVerificationKeysRef.current.clear();
      inFlightVerificationKeysRef.current.clear();
      activeVerificationBatchRef.current = false;
      verificationPumpQueuedRef.current = false;
      setVerificationEntries({});
      setHoveredCommitHash(null);
      setSelectedCommitHashes(() => {
        const nextHash = selectedCommitHash && commits.some(c => c.hash === selectedCommitHash)
          ? selectedCommitHash
          : commits[0]?.hash;
        return nextHash ? new Set([nextHash]) : new Set();
      });
      setSelectionAnchorHash(selectedCommitHash ?? commits[0]?.hash ?? null);
      verifyGenerationRef.current++;
    }
  }, [repoPath, logScope]);

  useEffect(() => {
    setSelectedCommitHashes(prev => {
      const next = new Set(Array.from(prev).filter(hash => commitHashes.has(hash)));
      if (next.size > 0 && (!selectedCommitHash || next.has(selectedCommitHash))) return next;
      if (selectedCommitHash && commitHashes.has(selectedCommitHash)) return new Set([selectedCommitHash]);
      if (next.size > 0) return next;
      const firstHash = commits[0]?.hash;
      return firstHash ? new Set([firstHash]) : new Set();
    });
    setSelectionAnchorHash(prev => {
      if (prev && commitHashes.has(prev)) return prev;
      if (selectedCommitHash && commitHashes.has(selectedCommitHash)) return selectedCommitHash;
      return commits[0]?.hash ?? null;
    });
    replaceVerificationEntries(prev => {
      const next: Record<string, VerificationEntry> = {};
      for (const [key, value] of Object.entries(prev)) {
        const hash = key.slice(key.indexOf("\u0000") + 1);
        if (commitHashes.has(hash)) next[key] = value;
      }
      return next;
    });
  }, [commits, commitHashes, selectedCommitHash]);

  // Virtuoso's rangeChanged only fires when the container has dimensions. If the
  // Log tab is hidden on load it never fires, so the first visible page is eager.
  useEffect(() => {
    verifyVisibleSignedCommits(visibleRangeRef.current.startIndex, visibleRangeRef.current.endIndex);
  }, [verifyVisibleSignedCommits]);

  useEffect(() => {
    verifyLoadedSignedCommits();
  }, [verifyLoadedSignedCommits]);

  useEffect(() => {
    if (!active) return;
    const eager = Math.min(commits.length, 20);
    for (let i = 0; i < eager; i++) {
      const email = commits[i]?.authorEmail;
      if (email) scheduleRef.current(email);
    }
  }, [active, commits]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen<Settings>("settings-updated", (event) => {
        if (signatureSettingsChanged(lastSettingsRef.current, event.payload)) {
          verifyVisibleSignedCommits(visibleRangeRef.current.startIndex, visibleRangeRef.current.endIndex, true);
        }
        lastSettingsRef.current = event.payload;
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
  }, [verifyVisibleSignedCommits]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      const fn = await listen("signature-settings-updated", () => {
        verifyVisibleSignedCommits(visibleRangeRef.current.startIndex, visibleRangeRef.current.endIndex, true);
      });
      if (cancelled) fn(); else unlisten = fn;
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [verifyVisibleSignedCommits]);

  const handleSelectCommit = useCallback((hash: string, index: number, event: React.MouseEvent) => {
    if (event.shiftKey && selectionAnchorHash) {
      setSelectedCommitHashes(new Set(getCommitRangeHashes(commits, selectionAnchorHash, index)));
    } else if (event.ctrlKey || event.metaKey) {
      setSelectedCommitHashes(prev => {
        const next = new Set(prev);
        if (next.has(hash) && next.size > 1) {
          next.delete(hash);
        } else {
          next.add(hash);
        }
        return next;
      });
      setSelectionAnchorHash(hash);
    } else {
      setSelectedCommitHashes(new Set([hash]));
      setSelectionAnchorHash(hash);
    }
    onSelectCommit(hash);
  }, [commits, selectionAnchorHash, onSelectCommit]);

  const handleCommitContextMenu = useCallback((hash: string, index: number, x: number, y: number) => {
    if (!selectedCommitHashes.has(hash)) {
      setSelectedCommitHashes(new Set([hash]));
      setSelectionAnchorHash(hash);
      onSelectCommit(hash);
    }
    setCommitMenu({ hash, x, y });
  }, [selectedCommitHashes, onSelectCommit]);

  const copyText = useCallback((text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  const upstreamInList = commitMarkers.upstreamHead
    ? commits.some(c => c.hash === commitMarkers.upstreamHead)
    : true;
  const showUpstreamNotice = Boolean(
    commitMarkers.upstreamRef && commitMarkers.upstreamHead && !upstreamInList,
  );
  const historyNotice = logScope === "allRefs"
    ? t("log.historyAllRefs")
    : detachedHead && shallow
      ? t("log.historyDetachedShallow")
      : detachedHead
        ? t("log.historyDetached")
        : shallow
          ? t("log.historyShallow")
          : null;

  const handleCloseSigPopover = useCallback(() => setSigPopover(null), []);
  const handleHoverCommit = useCallback((hash: string | null) => setHoveredCommitHash(hash), []);
  const handleLoadMore = useCallback(() => {
    if (loadingMore) return;
    pendingRevealIndexRef.current = commits.length;
    loadMore();
  }, [commits.length, loadMore, loadingMore]);
  useEffect(() => {
    const revealIndex = pendingRevealIndexRef.current;
    if (revealIndex === null) return;
    if (commits.length > revealIndex) {
      pendingRevealIndexRef.current = null;
      virtuosoRef.current?.scrollToIndex({ index: revealIndex, align: "start" });
      return;
    }
    if (!loadingMore && (loadMoreError || !hasMore)) {
      pendingRevealIndexRef.current = null;
    }
  }, [commits.length, hasMore, loadingMore, loadMoreError]);
  const Footer = useCallback(() => {
    if (!hasMore || logLoading || commits.length === 0) return null;
    return (
      <div className="log-view__load-more">
        {loadMoreError && (
          <div className="log-view__load-more-error">
            {t("log.loadMoreFailed", { message: loadMoreError })}
          </div>
        )}
        <button
          type="button"
          className="log-view__load-more-btn"
          onClick={handleLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? t("log.loadingMore") : t("log.viewNextCommits", { count: pageSize })}
        </button>
      </div>
    );
  }, [commits.length, handleLoadMore, hasMore, loadMoreError, loadingMore, logLoading, pageSize, t]);
  const striped = (index: number): "Subtle" | "Strong" | undefined => {
    if (rowStriping === "Off" || index % 2 === 0) return undefined;
    return rowStriping;
  };

  return (
    <div className="log-view">
      {historyNotice && <div className="log-view__notice">{historyNotice}</div>}
      {showUpstreamNotice && (
        <div className="log-view__notice">
          {t("log.upstreamOutside", { ref: commitMarkers.upstreamRef })}
        </div>
      )}
      <Virtuoso
        ref={virtuosoRef}
        style={{ flex: 1 }}
        data={commits}
        itemContent={(index, c) => {
          const resolved = repoPath ? verificationEntries[verificationKey(repoPath, c.hash)] : undefined;
          const stageStatus = resolved ? concreteSignatureStatus(resolved.stage as SignatureStatus) : null;
          const effectiveSigStatus = resolved?.visibleStatus ?? stageStatus ?? c.signatureStatus;
          return (
            <CommitRow
              commit={c}
              index={index}
              graphRow={commitGraph?.rows[c.hash]}
              graphLaneCount={commitGraph?.visibleLaneCount ?? 0}
              effectiveSigStatus={effectiveSigStatus}
              signer={resolved?.signer}
              fingerprint={resolved?.fingerprint}
              isSelected={selectedCommitHashes.has(c.hash)}
              isHead={commitMarkers.localHead === c.hash}
              isUpstream={commitMarkers.upstreamHead === c.hash}
              upstreamRef={commitMarkers.upstreamRef}
              avatarUrl={c.authorEmail ? avatars[c.authorEmail] : undefined}
              striped={striped(index)}
              showCommitGraph={showCommitGraph}
              highlightedGraphHashes={highlightedGraphHashes}
              onSelectCommit={handleSelectCommit}
              onHoverCommit={handleHoverCommit}
              onVisibleSignedCommit={handleVisibleSignedCommit}
              onContextMenu={handleCommitContextMenu}
              onBadgeClick={(rect, status, signer, fp, keyType, date) =>
                setSigPopover({ rect, status, signer, fingerprint: fp, keyType, date })
              }
            />
          );
        }}
        rangeChanged={handleVisibleRange}
        itemsRendered={handleItemsRendered}
        components={{
          EmptyPlaceholder: () => {
            if (logError) {
              return <div className="log-view__empty">{t("log.loadFailed", { message: logError })}</div>;
            }
            if (logLoading) {
              return <div className="log-view__empty">{t("log.loading")}</div>;
            }
            return (
              <div className="log-view__empty">
                {logScope === "allRefs" ? t("log.noCommitsAllRefs") : t("log.noCommits")}
              </div>
            );
          },
          Footer,
        }}
      />
      {sigPopover && <SignaturePopover data={sigPopover} onClose={handleCloseSigPopover} />}
      {commitMenu && commitMenuCommits.length > 0 && (
        <ContextMenu
          x={commitMenu.x}
          y={commitMenu.y}
          onClose={() => setCommitMenu(null)}
          items={[
            {
              label: t("log.copyCommitHash"),
              onClick: () => copyText(commitMenuCommits.map(c => c.hash).join("\n")),
            },
            {
              label: t("log.copyShortHash"),
              onClick: () => copyText(commitMenuCommits.map(c => c.shortHash).join("\n")),
            },
            {
              label: t("log.copySubject"),
              onClick: () => copyText(commitMenuCommits.map(c => c.message).join("\n")),
            },
            {
              label: t("log.copyDetails"),
              onClick: () => copyText(formatCommitDetails(commitMenuCommits)),
            },
            ...(commitMenuCommits.length === 1 && (onCherryPickAtCommit || onRevertAtCommit || onResetToCommit || onCreateTagAtCommit) ? [
              { type: "separator" as const },
            ] : []),
            ...(commitMenuCommits.length === 1 && onCherryPickAtCommit ? [{
              label: t("log.cherryPickCommit"),
              onClick: () => onCherryPickAtCommit(commitMenuCommits[0].hash),
            }] : []),
            ...(commitMenuCommits.length === 1 && onRevertAtCommit ? [{
              label: t("log.revertCommit"),
              onClick: () => onRevertAtCommit(commitMenuCommits[0].hash),
            }] : []),
            ...(commitMenuCommits.length === 1 && onResetToCommit ? [
              { label: t("log.softReset"), onClick: () => onResetToCommit(commitMenuCommits[0].hash, "soft") },
              { label: t("log.mixedReset"), onClick: () => onResetToCommit(commitMenuCommits[0].hash, "mixed") },
            ] : []),
            ...(commitMenuCommits.length === 1 && onCreateTagAtCommit && (onCherryPickAtCommit || onRevertAtCommit || onResetToCommit) ? [
              { type: "separator" as const },
            ] : []),
            ...(commitMenuCommits.length === 1 && onCreateTagAtCommit ? [{
              label: t("log.createTagHere"),
              onClick: () => onCreateTagAtCommit(commitMenuCommits[0].hash),
            }] : []),
          ]}
        />
      )}
    </div>
  );
}
