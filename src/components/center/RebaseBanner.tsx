import React from "react";
import type { ConflictFileItem } from "../../types";

type RebaseBannerProps = {
  currentBranch: string | null;
  rebaseOnto: string | null;
  conflictedFiles: ConflictFileItem[];
  onRebaseContinue: () => void;
  onRebaseAbort: () => void;
  isRunning: boolean;
};

export function RebaseBanner({
  currentBranch,
  rebaseOnto,
  conflictedFiles,
  onRebaseContinue,
  onRebaseAbort,
  isRunning,
}: RebaseBannerProps) {
  const targetLabel = rebaseOnto ? `'${rebaseOnto}'` : "target";
  const branchLabel = currentBranch ? `'${currentBranch}'` : "current branch";
  const hasConflicts = conflictedFiles.length > 0;

  return (
    <div className={`merge-banner${hasConflicts ? "" : " merge-banner--resolved"}`}>
      <div className="merge-banner__text">
        {hasConflicts ? (
          <>
            <span>Rebasing {branchLabel} onto {targetLabel}</span>
            <span className="merge-banner__count">
              {" · "}{conflictedFiles.length} conflict{conflictedFiles.length !== 1 ? "s" : ""} remaining
            </span>
          </>
        ) : (
          <span>Rebase in progress onto {targetLabel} — continue when ready</span>
        )}
      </div>
      <div className="merge-banner__actions">
        <button
          className="merge-banner__btn merge-banner__btn--abort"
          onClick={onRebaseAbort}
          disabled={isRunning}
        >
          Abort Rebase
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          onClick={onRebaseContinue}
          disabled={hasConflicts || isRunning}
        >
          {isRunning ? "Working..." : "Continue Rebase"}
        </button>
      </div>
    </div>
  );
}
