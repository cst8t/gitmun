import React from "react";
import type { ConflictFileItem } from "../../types";

type RevertBannerProps = {
  revertHead: string | null;
  conflictedFiles: ConflictFileItem[];
  onRevertContinue: () => void;
  onRevertAbort: () => void;
  isRunning: boolean;
};

export function RevertBanner({
  revertHead,
  conflictedFiles,
  onRevertContinue,
  onRevertAbort,
  isRunning,
}: RevertBannerProps) {
  const hasConflicts = conflictedFiles.length > 0;
  const commitLabel = revertHead ? `'${revertHead}'` : "selected commit";

  return (
    <div className={`merge-banner${hasConflicts ? "" : " merge-banner--resolved"}`}>
      <div className="merge-banner__text">
        {hasConflicts ? (
          <>
            <span>Reverting {commitLabel}</span>
            <span className="merge-banner__count">
              {" · "}{conflictedFiles.length} conflict{conflictedFiles.length !== 1 ? "s" : ""} remaining
            </span>
          </>
        ) : (
          <span>Revert in progress for {commitLabel} - continue when ready</span>
        )}
      </div>
      <div className="merge-banner__actions">
        <button
          className="merge-banner__btn merge-banner__btn--abort"
          onClick={onRevertAbort}
          disabled={isRunning}
        >
          Abort Revert
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          onClick={onRevertContinue}
          disabled={hasConflicts || isRunning}
        >
          {isRunning ? "Working..." : "Continue Revert"}
        </button>
      </div>
    </div>
  );
}
