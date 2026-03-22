import React from "react";
import type { ConflictFileItem } from "../../types";

type MergeBannerProps = {
  currentBranch: string | null;
  mergeHeadBranch: string | null;
  conflictedFiles: ConflictFileItem[];
  stagedCount: number;
  onMergeAbort: () => void;
  onCommitMerge: () => void;
  isCommitting: boolean;
};

export function MergeBanner({
  currentBranch,
  mergeHeadBranch,
  conflictedFiles,
  stagedCount,
  onMergeAbort,
  onCommitMerge,
  isCommitting,
}: MergeBannerProps) {
  const resolved = conflictedFiles.length === 0;

  const branchLabel = mergeHeadBranch
    ? `'${mergeHeadBranch}'`
    : "branch";
  const targetLabel = currentBranch ? ` into ${currentBranch}` : "";

  return (
    <div className={`merge-banner${resolved ? " merge-banner--resolved" : ""}`}>
      <div className="merge-banner__text">
        {resolved ? (
          <span>All conflicts resolved — ready to commit merge</span>
        ) : (
          <>
            <span>Merging {branchLabel}{targetLabel}</span>
            {conflictedFiles.length > 0 && (
              <span className="merge-banner__count">
                {" · "}{conflictedFiles.length} conflict{conflictedFiles.length !== 1 ? "s" : ""} remaining
              </span>
            )}
          </>
        )}
      </div>
      <div className="merge-banner__actions">
        <button className="merge-banner__btn merge-banner__btn--abort" onClick={onMergeAbort}>
          Abort Merge
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          disabled={!resolved || stagedCount === 0 || isCommitting}
          onClick={onCommitMerge}
        >
          {isCommitting ? "Committing..." : "Commit Merge"}
        </button>
      </div>
    </div>
  );
}
