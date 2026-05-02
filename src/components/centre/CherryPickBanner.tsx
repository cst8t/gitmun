import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("centre");
  const hasConflicts = conflictedFiles.length > 0;
  const commitLabel = cherryPickHead ? `'${cherryPickHead}'` : t("banners.selectedCommit");
  const branchLabel = currentBranch ? `'${currentBranch}'` : t("banners.unknownBranch");

  return (
    <div className={`merge-banner${hasConflicts ? "" : " merge-banner--resolved"}`}>
      <div className="merge-banner__text">
        {hasConflicts ? (
          <>
            <span>{t("banners.cherryPick.status", {commit: commitLabel, branch: branchLabel})}</span>
            <span className="merge-banner__count">
              {t("banners.conflictsRemaining", {count: conflictedFiles.length})}
            </span>
          </>
        ) : (
          <span>{t("banners.cherryPick.ready")}</span>
        )}
      </div>
      <div className="merge-banner__actions">
        <button
          className="merge-banner__btn merge-banner__btn--abort"
          onClick={onCherryPickAbort}
          disabled={isRunning}
        >
          {t("banners.cherryPick.abort")}
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          onClick={onCherryPickContinue}
          disabled={hasConflicts || isRunning}
        >
          {isRunning ? t("actions.working", {ns: "common"}) : t("banners.cherryPick.continue")}
        </button>
      </div>
    </div>
  );
}
