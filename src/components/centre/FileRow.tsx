import React, { useState } from "react";
import { CheckIcon, FileIcon, StageArrowIcon, UnstageArrowIcon, DiscardIcon } from "../icons";
import type { FileStatusItem } from "../../types";

type FileRowProps = {
  file: FileStatusItem;
  isStaged: boolean;
  isSelected: boolean;
  checked?: boolean;
  onToggleChecked?: () => void;
  onSelect: () => void;
  onDoubleClick?: () => void;
  onStage?: () => void;
  onUnstage?: () => void;
  onDiscard?: () => void;
};

const STATUS_MAP: Record<string, { bg: string; text: string; label: string }> = {
  modified: { bg: "rgba(251,191,36,0.12)", text: "#fbbf24", label: "M" },
  new: { bg: "rgba(52,211,153,0.12)", text: "#34d399", label: "A" },
  added: { bg: "rgba(52,211,153,0.12)", text: "#34d399", label: "A" },
  deleted: { bg: "rgba(248,113,113,0.12)", text: "#f87171", label: "D" },
  renamed: { bg: "rgba(108,156,252,0.12)", text: "#6c9cfc", label: "R" },
};

export function FileRow({
  file,
  isStaged,
  isSelected,
  checked,
  onToggleChecked,
  onSelect,
  onDoubleClick,
  onStage,
  onUnstage,
  onDiscard,
}: FileRowProps) {
  const [hovered, setHovered] = useState(false);
  const statusKey = file.status.toLowerCase();
  const s = STATUS_MAP[statusKey] ?? STATUS_MAP.modified;

  return (
    <div
      className={`file-row ${isSelected ? "file-row--selected" : ""} ${hovered ? "file-row--hovered" : ""}`}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <input
        className="file-row__check"
        type="checkbox"
        checked={checked ?? false}
        onChange={(e) => {
          e.stopPropagation();
          onToggleChecked?.();
        }}
        onClick={e => e.stopPropagation()}
      />
      <span className="file-row__icon" style={{ color: isStaged ? "var(--green)" : "var(--text-muted)" }}>
        {isStaged ? <CheckIcon /> : <FileIcon />}
      </span>
      <span className="file-row__badge" style={{ background: s.bg, color: s.text }}>{s.label}</span>
      <span className="file-row__path">{file.path}</span>

      {hovered ? (
        <div className="file-row__actions" onClick={e => e.stopPropagation()}>
          {isStaged ? (
            <button className="file-row__action-btn file-row__action-btn--red" title="Unstage file" onClick={onUnstage}>
              <UnstageArrowIcon />
            </button>
          ) : (
            <>
              <button className="file-row__action-btn file-row__action-btn--accent" title="Stage file" onClick={onStage}>
                <StageArrowIcon />
              </button>
              <button className="file-row__action-btn file-row__action-btn--red" title="Revert changes" onClick={onDiscard}>
                <DiscardIcon />
              </button>
            </>
          )}
        </div>
      ) : (
        <span className="file-row__stats">
          {file.additions != null && file.additions > 0 && (
            <span className="file-row__stat-add">+{file.additions}</span>
          )}
          {file.deletions != null && file.deletions > 0 && (
            <span className="file-row__stat-del">-{file.deletions}</span>
          )}
        </span>
      )}
    </div>
  );
}
