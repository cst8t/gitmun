import React from "react";
import { Decoration, Diff, Hunk, type ChangeData, type DiffType, type HunkData, type ViewType } from "react-diff-view";
import { FileIcon } from "../icons";
import { StageHunkIcon } from "../icons";
import type { CommitDetails, CommitFileItem, FileDiff } from "../../types";
import { getCommitDetails } from "../../api/commands";
import type { CenterTab } from "../center/CenterPanel";
import "react-diff-view/style/index.css";
import "./DiffPanel.css";

const HUNK_HEADER_RE = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/;

function normalizedKind(kind: string): "add" | "remove" | "context" {
  const lower = kind.toLowerCase();
  if (lower === "add") return "add";
  if (lower === "remove") return "remove";
  return "context";
}

function parseHunkHeader(header: string): { oldStart: number; oldLines: number; newStart: number; newLines: number } | null {
  const match = HUNK_HEADER_RE.exec(header);
  if (!match) return null;

  const oldStart = Number.parseInt(match[1], 10);
  const oldLines = match[2] ? Number.parseInt(match[2], 10) : 1;
  const newStart = Number.parseInt(match[3], 10);
  const newLines = match[4] ? Number.parseInt(match[4], 10) : 1;

  return { oldStart, oldLines, newStart, newLines };
}

function toInsertChange(content: string, lineNumber: number): ChangeData {
  return { type: "insert", content, lineNumber, isInsert: true } as ChangeData;
}

function toDeleteChange(content: string, lineNumber: number): ChangeData {
  return { type: "delete", content, lineNumber, isDelete: true } as ChangeData;
}

function toNormalChange(content: string, oldLineNumber: number, newLineNumber: number): ChangeData {
  return { type: "normal", content, oldLineNumber, newLineNumber, isNormal: true } as ChangeData;
}

type CommitDetailsPopoverProps = {
  rect: DOMRect;
  data: CommitDetails;
  onClose: () => void;
  onSelectCommit?: (hash: string) => void;
};

function CommitDetailsPopover({ rect, data, onClose, onSelectCommit }: CommitDetailsPopoverProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const popoverWidth = 360;
  const gap = 6;

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { innerWidth, innerHeight } = window;
    const elH = el.offsetHeight;
    // Drop down from the button, right-aligned to it
    let top = rect.bottom + gap;
    if (top + elH > innerHeight - 8) top = rect.top - elH - gap;
    let left = rect.right - popoverWidth;
    if (left < 8) left = 8;
    if (left + popoverWidth > innerWidth - 8) left = innerWidth - popoverWidth - 8;
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  });

  React.useEffect(() => {
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

  const sameCommitter =
    data.committer === data.author &&
    data.committerEmail === data.authorEmail &&
    data.committerDate === data.authorDate;

  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleString(); } catch { return iso; }
  };

  const copyHash = () => { navigator.clipboard.writeText(data.hash).catch(() => {}); };

  return (
    <div ref={ref} className="commit-details-popover" role="dialog" aria-modal="false">
      <button className="commit-details-popover__close" onClick={onClose} aria-label="Close">✕</button>

      <div className="commit-details-popover__section">
        <span className="commit-details-popover__label">Hash</span>
        <div className="commit-details-popover__hash-row">
          <span className="commit-details-popover__value commit-details-popover__value--mono">{data.hash}</span>
          <button className="commit-details-popover__copy-btn" onClick={copyHash} title="Copy full hash">⎘</button>
        </div>
      </div>

      <div className="commit-details-popover__section">
        <span className="commit-details-popover__label">Author</span>
        <span className="commit-details-popover__value">{data.author} &lt;{data.authorEmail}&gt;</span>
        <span className="commit-details-popover__value commit-details-popover__value--muted">{formatDate(data.authorDate)}</span>
      </div>

      {!sameCommitter && (
        <div className="commit-details-popover__section">
          <span className="commit-details-popover__label">Committer</span>
          <span className="commit-details-popover__value">{data.committer} &lt;{data.committerEmail}&gt;</span>
          <span className="commit-details-popover__value commit-details-popover__value--muted">{formatDate(data.committerDate)}</span>
        </div>
      )}

      {data.parentHashes.length > 0 && (
        <div className="commit-details-popover__section">
          <span className="commit-details-popover__label">Parents</span>
          <div className="commit-details-popover__chips">
            {data.parentHashes.map(h => (
              <button
                key={h}
                className="commit-details-popover__chip"
                onClick={() => { onSelectCommit?.(h); onClose(); }}
                title={h}
              >
                {h.slice(0, 7)}
              </button>
            ))}
          </div>
        </div>
      )}

      {data.tags.length > 0 && (
        <div className="commit-details-popover__section">
          <span className="commit-details-popover__label">Tags</span>
          <div className="commit-details-popover__chips">
            {data.tags.map(tag => (
              <span key={tag} className="commit-details-popover__chip commit-details-popover__chip--tag">{tag}</span>
            ))}
          </div>
        </div>
      )}

      {data.trailers.map(t => (
        <div key={`${t.key}:${t.value}`} className="commit-details-popover__section">
          <span className="commit-details-popover__label">{t.key}</span>
          <span className="commit-details-popover__value">{t.value}</span>
        </div>
      ))}
    </div>
  );
}

type DiffPanelProps = {
  mode: CenterTab;
  diff: FileDiff | null;
  loading: boolean;
  selectedFile: string | null;
  selectedCommitHash: string | null;
  repoPath: string | null;
  commitFiles: CommitFileItem[];
  commitFilesLoading: boolean;
  compareCurrentFileLabel: string;
  onCompareCurrentFile: () => void;
  onOpenCommitFileDiff: (filePath: string) => void;
  onSelectCommit?: (hash: string) => void;
  hunkAction: "stage" | "unstage" | null;
  hunkActionBusy: boolean;
  wrapLines: boolean;
  onHunkAction: (hunkIndex: number) => void;
};

export function DiffPanel({
  mode,
  diff,
  loading,
  selectedFile,
  selectedCommitHash,
  repoPath,
  commitFiles,
  commitFilesLoading,
  compareCurrentFileLabel,
  onCompareCurrentFile,
  onOpenCommitFileDiff,
  onSelectCommit,
  hunkAction,
  hunkActionBusy,
  wrapLines,
  onHunkAction,
}: DiffPanelProps) {
  const [viewType, setViewType] = React.useState<ViewType>("unified");
  const [selectedCommitFile, setSelectedCommitFile] = React.useState<string | null>(null);
  const [detailsPopover, setDetailsPopover] = React.useState<{ rect: DOMRect; data: CommitDetails } | null>(null);
  const [detailsLoading, setDetailsLoading] = React.useState(false);

  React.useEffect(() => {
    setViewType("unified");
  }, [selectedFile, mode]);

  React.useEffect(() => {
    setSelectedCommitFile(null);
    setDetailsPopover(null);
  }, [selectedCommitHash]);

  const hasSelectedFile = mode === "changes" && !!selectedFile;
  const currentDiff =
    mode === "changes" && selectedFile && diff?.filePath === selectedFile
      ? diff
      : null;
  const totalAdds = currentDiff?.hunks.reduce((a, h) => a + h.lines.filter(l => normalizedKind(l.kind) === "add").length, 0) ?? 0;
  const totalDels = currentDiff?.hunks.reduce((a, h) => a + h.lines.filter(l => normalizedKind(l.kind) === "remove").length, 0) ?? 0;
  const fileName = selectedFile ? selectedFile.split("/").pop() ?? selectedFile : null;
  const language = currentDiff?.detectedFileType ?? "Text";
  const lineEndingLabel = currentDiff ? (() => {
    switch (currentDiff.lineEnding) {
      case "lf": return "LF";
      case "crlf": return "CRLF";
      case "mixed": return "Mixed EOL";
      default: return "Unknown EOL";
    }
  })() : null;
  const statusFileName = fileName ?? selectedFile ?? "File";
  const showLoadedMetadata = !loading && !!currentDiff;
  const statusBarMeta = showLoadedMetadata
    ? `${language} · ${statusFileName} · ${lineEndingLabel}`
    : statusFileName;
  const statusLetter = (status: string) => {
    const s = status.toLowerCase();
    if (s.startsWith("add")) return "A";
    if (s.startsWith("del")) return "D";
    if (s.startsWith("ren")) return "R";
    if (s.startsWith("cop")) return "C";
    return "M";
  };

  const renderedHunks = React.useMemo<HunkData[]>(() => {
    if (mode !== "changes" || !currentDiff || currentDiff.isBinary) return [];

    return currentDiff.hunks.map((hunk): HunkData => {
      const parsedHeader = parseHunkHeader(hunk.header);
      let oldCursor = parsedHeader?.oldStart ?? (hunk.lines.find(line => line.oldLineNo != null)?.oldLineNo ?? 1);
      let newCursor = parsedHeader?.newStart ?? (hunk.lines.find(line => line.newLineNo != null)?.newLineNo ?? 1);
      let oldLinesCount = 0;
      let newLinesCount = 0;

      const changes: ChangeData[] = hunk.lines.map((line) => {
        const kind = normalizedKind(line.kind);
        if (kind === "add") {
          const lineNumber = line.newLineNo ?? newCursor;
          newCursor = lineNumber + 1;
          newLinesCount += 1;
          return toInsertChange(line.content, lineNumber);
        }

        if (kind === "remove") {
          const lineNumber = line.oldLineNo ?? oldCursor;
          oldCursor = lineNumber + 1;
          oldLinesCount += 1;
          return toDeleteChange(line.content, lineNumber);
        }

        const oldLineNumber = line.oldLineNo ?? oldCursor;
        const newLineNumber = line.newLineNo ?? newCursor;
        oldCursor = oldLineNumber + 1;
        newCursor = newLineNumber + 1;
        oldLinesCount += 1;
        newLinesCount += 1;
        return toNormalChange(line.content, oldLineNumber, newLineNumber);
      });

      return {
        content: hunk.header,
        oldStart: parsedHeader?.oldStart ?? (hunk.lines.find(line => line.oldLineNo != null)?.oldLineNo ?? 1),
        newStart: parsedHeader?.newStart ?? (hunk.lines.find(line => line.newLineNo != null)?.newLineNo ?? 1),
        oldLines: parsedHeader?.oldLines ?? oldLinesCount,
        newLines: parsedHeader?.newLines ?? newLinesCount,
        changes,
      };
    });
  }, [mode, currentDiff]);

  const diffType = React.useMemo<DiffType>(() => {
    if (!currentDiff) return "modify";
    let hasAdds = false;
    let hasRemoves = false;
    for (const hunk of currentDiff.hunks) {
      for (const line of hunk.lines) {
        const kind = normalizedKind(line.kind);
        if (kind === "add") hasAdds = true;
        if (kind === "remove") hasRemoves = true;
      }
    }
    if (hasAdds && !hasRemoves) return "add";
    if (!hasAdds && hasRemoves) return "delete";
    return "modify";
  }, [currentDiff]);

  return (
    <div className="diff-panel">
      {/* Header */}
      <div className="diff-panel__header">
        <FileIcon />
        <span className="diff-panel__filename">
          {mode === "log"
            ? (selectedCommitHash ? `Commit ${selectedCommitHash.slice(0, 8)}` : "Commit files")
            : (selectedFile ?? "Click a file to show changes")}
        </span>
        {mode === "changes" && hasSelectedFile && currentDiff && (
          <span className="diff-panel__stats">
            <span className="diff-panel__stat-add">+{totalAdds}</span>
            <span className="diff-panel__stat-sep">/</span>
            <span className="diff-panel__stat-del">-{totalDels}</span>
          </span>
        )}
        {mode === "log" && selectedCommitHash && repoPath && (
          <button
            className="diff-panel__details-btn"
            title="Commit details"
            disabled={detailsLoading}
            onClick={async (e) => {
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDetailsLoading(true);
              try {
                const data = await getCommitDetails(repoPath, selectedCommitHash);
                setDetailsPopover({ rect, data });
              } catch {
                // silently ignore - IPC errors surfaced elsewhere
              } finally {
                setDetailsLoading(false);
              }
            }}
          >
            {detailsLoading ? "…" : "···"}
          </button>
        )}
        {mode === "changes" && hasSelectedFile && (
          <div className="diff-panel__view-toggle">
            <button
              className="diff-panel__view-btn"
              onClick={onCompareCurrentFile}
              disabled={!selectedFile}
              title={selectedFile ? compareCurrentFileLabel : "Select a file first"}
            >
              {compareCurrentFileLabel}
            </button>
            <button
              className={`diff-panel__view-btn ${viewType === "unified" ? "diff-panel__view-btn--active" : ""}`}
              onClick={() => setViewType("unified")}
            >
              Inline
            </button>
            <button
              className={`diff-panel__view-btn ${viewType === "split" ? "diff-panel__view-btn--active" : ""}`}
              onClick={() => setViewType("split")}
            >
              Split
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="diff-panel__body">
        {mode === "log" ? (
          commitFilesLoading ? (
            <div className="diff-panel__placeholder">Loading commit files...</div>
          ) : commitFiles.length > 0 ? (
            <div className="diff-panel__commit-files">
              {commitFiles.map((file) => (
                <button
                  key={`${file.status}:${file.path}`}
                  className={`diff-panel__commit-file-row ${selectedCommitFile === file.path ? "diff-panel__commit-file-row--selected" : ""}`}
                  onClick={() => setSelectedCommitFile(file.path)}
                  onDoubleClick={() => onOpenCommitFileDiff(file.path)}
                  title="Double-click to open diff"
                >
                  <span className={`diff-panel__commit-file-status diff-panel__commit-file-status--${file.status.toLowerCase()}`}>
                    {statusLetter(file.status)}
                  </span>
                  <span className="diff-panel__commit-file-path">{file.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="diff-panel__placeholder">Select a commit to view changed files</div>
          )
        ) : (
          loading ? (
            <div className="diff-panel__placeholder">Loading diff...</div>
          ) : currentDiff ? (
            currentDiff.isBinary ? (
              <div className="diff-panel__placeholder">Binary file changed</div>
            ) : renderedHunks.length > 0 ? (
              <div className={`diff-panel__react-diff ${wrapLines ? "diff-panel__react-diff--wrap" : ""}`}>
                <Diff
                  viewType={viewType}
                  diffType={diffType}
                  hunks={renderedHunks}
                >
                  {(hunks) => hunks.flatMap((hunk, hi) => [
                    <Decoration key={`hunk-header-${hi}`}>
                      <div className="diff-panel__hunk-header">
                        <span className="diff-panel__hunk-title">{hunk.content}</span>
                        {hunkAction && (
                          <span className="diff-panel__hunk-action">
                            <button
                              className={`diff-hunk__stage-btn ${hunkAction === "unstage" ? "diff-hunk__stage-btn--unstage" : ""}`}
                              onClick={() => onHunkAction(hi)}
                              disabled={hunkActionBusy}
                            >
                              <StageHunkIcon />
                              {hunkAction === "unstage" ? "Unstage hunk" : "Stage hunk"}
                            </button>
                          </span>
                        )}
                      </div>
                    </Decoration>,
                    <Hunk key={`hunk-${hi}-${hunk.content}`} hunk={hunk} />,
                  ])}
                </Diff>
              </div>
            ) : (
              <div className="diff-panel__placeholder">Empty file - no changes to display</div>
            )
          ) : (
            <div className="diff-panel__placeholder">Click a file to show changes</div>
          )
        )}
      </div>

      {/* Status bar (only when an actual file is selected in Changes view) */}
      {mode === "changes" && selectedFile && (
        <div className="diff-panel__statusbar">
          <span className="diff-panel__meta">{statusBarMeta}</span>
        </div>
      )}

      {detailsPopover && (
        <CommitDetailsPopover
          rect={detailsPopover.rect}
          data={detailsPopover.data}
          onClose={() => setDetailsPopover(null)}
          onSelectCommit={onSelectCommit}
        />
      )}
    </div>
  );
}
