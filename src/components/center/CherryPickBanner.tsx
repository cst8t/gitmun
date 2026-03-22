import React from "react";
import type { ConflictFileItem } from "../../types";

type CherryPickBannerProps = {
  currentBranch: string | null;
  cherryPickHead: string | null;
  conflictedFiles: ConflictFileItem[];
  onCherryPickContinue: () => void;
  onCherryPickAbort: () => void;
  isRunning: boolean;
};

export function CherryPickBanner({
  currentBranch,
  cherryPickHead,
  conflictedFiles,
  onCherryPickContinue,
  onCherryPickAbort,
  isRunning,
}: CherryPickBannerProps) {
  const hasConflicts = conflictedFiles.length > 0;
  const commitLabel = cherryPickHead ? `'${cherryPickHead}'` : "selected commit";
  const branchLabel = currentBranch ? `'${currentBranch}'` : "current branch";

  return (
    <div className={`merge-banner${hasConflicts ? "" : " merge-banner--resolved"}`}>
      <div className="merge-banner__text">
        {hasConflicts ? (
          <>
            <span>Cherry-picking {commitLabel} onto {branchLabel}</span>
            <span className="merge-banner__count">
              {" · "}{conflictedFiles.length} conflict{conflictedFiles.length !== 1 ? "s" : ""} remaining
            </span>
          </>
        ) : (
          <span>Cherry-pick in progress for {commitLabel} — continue when ready</span>
        )}
      </div>
      <div className="merge-banner__actions">
        <button
          className="merge-banner__btn merge-banner__btn--abort"
          onClick={onCherryPickAbort}
          disabled={isRunning}
        >
          Abort Cherry-pick
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          onClick={onCherryPickContinue}
          disabled={hasConflicts || isRunning}
        >
          {isRunning ? "Working..." : "Continue Cherry-pick"}
        </button>
      </div>
    </div>
  );
}
