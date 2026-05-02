import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("centre");
  const targetLabel = rebaseOnto ? `'${rebaseOnto}'` : t("banners.unknownBranch");
  const branchLabel = currentBranch ? `'${currentBranch}'` : t("banners.unknownBranch");
  const hasConflicts = conflictedFiles.length > 0;

  return (
    <div className={`merge-banner${hasConflicts ? "" : " merge-banner--resolved"}`}>
      <div className="merge-banner__text">
        {hasConflicts ? (
          <>
            <span>{t("banners.rebase.status", {branch: branchLabel, onto: targetLabel})}</span>
            <span className="merge-banner__count">
              {t("banners.conflictsRemaining", {count: conflictedFiles.length})}
            </span>
          </>
        ) : (
          <span>{t("banners.rebase.ready")}</span>
        )}
      </div>
      <div className="merge-banner__actions">
        <button
          className="merge-banner__btn merge-banner__btn--abort"
          onClick={onRebaseAbort}
          disabled={isRunning}
        >
          {t("banners.rebase.abort")}
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          onClick={onRebaseContinue}
          disabled={hasConflicts || isRunning}
        >
          {isRunning ? t("actions.working", {ns: "common"}) : t("banners.rebase.continue")}
        </button>
      </div>
    </div>
  );
}
