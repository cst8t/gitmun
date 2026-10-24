import React from "react";
import { useTranslation } from "react-i18next";
import { Decoration, Diff, Hunk, type ChangeData, type DiffType, type HunkData, type ViewType } from "react-diff-view";
import type { FileDiff } from "../../types";
import "react-diff-view/style/index.css";
import "./DiffPanel.css";

const HUNK_HEADER_RE = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/;

function normalisedKind(kind: string): "add" | "remove" | "context" {
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

type FileDiffViewProps = {
  diff: FileDiff;
  viewType?: ViewType;
  wrapLines?: boolean;
  renderHunkAction?: (hunkIndex: number) => React.ReactNode;
};

export function FileDiffView({
  diff,
  viewType = "unified",
  wrapLines = false,
  renderHunkAction,
}: FileDiffViewProps) {
  const { t } = useTranslation("diffPanel");
  const renderedHunks = React.useMemo<HunkData[]>(() => {
    if (diff.isBinary) return [];

    return diff.hunks.map((hunk): HunkData => {
      const parsedHeader = parseHunkHeader(hunk.header);
      let oldCursor = parsedHeader?.oldStart ?? (hunk.lines.find((line) => line.oldLineNo != null)?.oldLineNo ?? 1);
      let newCursor = parsedHeader?.newStart ?? (hunk.lines.find((line) => line.newLineNo != null)?.newLineNo ?? 1);
      let oldLinesCount = 0;
      let newLinesCount = 0;

      const changes: ChangeData[] = hunk.lines.map((line) => {
        const kind = normalisedKind(line.kind);
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
        oldStart: parsedHeader?.oldStart ?? (hunk.lines.find((line) => line.oldLineNo != null)?.oldLineNo ?? 1),
        newStart: parsedHeader?.newStart ?? (hunk.lines.find((line) => line.newLineNo != null)?.newLineNo ?? 1),
        oldLines: parsedHeader?.oldLines ?? oldLinesCount,
        newLines: parsedHeader?.newLines ?? newLinesCount,
        changes,
      };
    });
  }, [diff]);

  const diffType = React.useMemo<DiffType>(() => {
    let hasAdds = false;
    let hasRemoves = false;
    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        const kind = normalisedKind(line.kind);
        if (kind === "add") hasAdds = true;
        if (kind === "remove") hasRemoves = true;
      }
    }
    if (hasAdds && !hasRemoves) return "add";
    if (!hasAdds && hasRemoves) return "delete";
    return "modify";
  }, [diff]);

  if (diff.isBinary) {
    return <div className="diff-panel__placeholder">{t("placeholders.binaryChanged")}</div>;
  }

  if (renderedHunks.length === 0) {
    return <div className="diff-panel__placeholder">{t("placeholders.emptyFile")}</div>;
  }

  return (
    <div className={`diff-panel__react-diff ${wrapLines ? "diff-panel__react-diff--wrap" : ""}`}>
      <Diff viewType={viewType} diffType={diffType} hunks={renderedHunks}>
        {(hunks) => hunks.flatMap((hunk, hunkIndex) => [
          <Decoration key={`hunk-header-${hunkIndex}`}>
            <div className="diff-panel__hunk-header">
              <span className="diff-panel__hunk-title">{hunk.content}</span>
              {renderHunkAction && <span className="diff-panel__hunk-action">{renderHunkAction(hunkIndex)}</span>}
            </div>
          </Decoration>,
          <Hunk key={`hunk-${hunkIndex}-${hunk.content}`} hunk={hunk} />,
        ])}
      </Diff>
    </div>
  );
}
