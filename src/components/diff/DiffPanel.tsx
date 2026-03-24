import React from "react";
import { Decoration, Diff, Hunk, type ChangeData, type DiffType, type HunkData, type ViewType } from "react-diff-view";
import { FileIcon } from "../icons";
import { StageHunkIcon } from "../icons";
import type { CommitFileItem, FileDiff } from "../../types";
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

type DiffPanelProps = {
  mode: CenterTab;
  diff: FileDiff | null;
  loading: boolean;
  selectedFile: string | null;
  selectedCommitHash: string | null;
  commitFiles: CommitFileItem[];
  commitFilesLoading: boolean;
  compareCurrentFileLabel: string;
  onCompareCurrentFile: () => void;
  onOpenCommitFileDiff: (filePath: string) => void;
  isUnstaged: boolean;
  stagedHunks: Record<string, boolean>;
  onStageHunk: (hunkIndex: number) => void;
};

export function DiffPanel({
  mode,
  diff,
  loading,
  selectedFile,
  selectedCommitHash,
  commitFiles,
  commitFilesLoading,
  compareCurrentFileLabel,
  onCompareCurrentFile,
  onOpenCommitFileDiff,
  isUnstaged,
  stagedHunks,
  onStageHunk,
}: DiffPanelProps) {
  const [viewType, setViewType] = React.useState<ViewType>("unified");
  const [selectedCommitFile, setSelectedCommitFile] = React.useState<string | null>(null);

  React.useEffect(() => {
    setViewType("unified");
  }, [selectedFile, mode]);

  React.useEffect(() => {
    setSelectedCommitFile(null);
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
              <div className="diff-panel__react-diff">
                <Diff
                  viewType={viewType}
                  diffType={diffType}
                  hunks={renderedHunks}
                >
                  {(hunks) => hunks.flatMap((hunk, hi) => [
                    <Decoration key={`hunk-header-${hi}`}>
                      <div className="diff-panel__hunk-header">
                        <span>{hunk.content}</span>
                        {isUnstaged && (
                          <button
                            className={`diff-hunk__stage-btn ${stagedHunks[`${selectedFile}:${hi}`] ? "diff-hunk__stage-btn--staged" : ""}`}
                            onClick={() => onStageHunk(hi)}
                          >
                            <StageHunkIcon />
                            {stagedHunks[`${selectedFile}:${hi}`] ? "Staged" : "Stage hunk"}
                          </button>
                        )}
                      </div>
                    </Decoration>,
                    <Hunk key={`hunk-${hi}-${hunk.content}`} hunk={hunk} />,
                  ])}
                </Diff>
              </div>
            ) : (
              <div className="diff-panel__placeholder">Empty file — no changes to display</div>
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
    </div>
  );
}
