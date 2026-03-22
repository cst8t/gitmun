import React from "react";
import { StageHunkIcon } from "../icons";
import type { DiffHunk, DiffLine } from "../../types";

type DiffHunkViewProps = {
  hunk: DiffHunk;
  hunkIndex: number;
  showStageButton: boolean;
  isStaged: boolean;
  onStageHunk: () => void;
};

export function DiffHunkView({ hunk, hunkIndex, showStageButton, isStaged, onStageHunk }: DiffHunkViewProps) {
  return (
    <div className="diff-hunk">
      <div className="diff-hunk__header">
        <span>{hunk.header}</span>
        {showStageButton && (
          <button
            className={`diff-hunk__stage-btn ${isStaged ? "diff-hunk__stage-btn--staged" : ""}`}
            onClick={onStageHunk}
          >
            <StageHunkIcon />
            {isStaged ? "Staged" : "Stage hunk"}
          </button>
        )}
      </div>
      {hunk.lines.map((line, li) => (
        <DiffLineView key={li} line={line} />
      ))}
    </div>
  );
}

function DiffLineView({ line }: { line: DiffLine }) {
  const kind = line.kind.toLowerCase();
  const isAdd = kind === "add";
  const isDel = kind === "remove";
  const prefix = isAdd ? "+" : isDel ? "\u2212" : " ";

  return (
    <div className={`diff-line ${isAdd ? "diff-line--add" : isDel ? "diff-line--del" : ""}`}>
      <span className="diff-line__num">{line.oldLineNo ?? ""}</span>
      <span className="diff-line__num">{line.newLineNo ?? ""}</span>
      <span className="diff-line__sign">{prefix}</span>
      <span className="diff-line__content">{line.content}</span>
    </div>
  );
}
