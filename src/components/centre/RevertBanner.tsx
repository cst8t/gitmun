import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("centre");
  const hasConflicts = conflictedFiles.length > 0;
  const commitLabel = revertHead ? `'${revertHead}'` : t("banners.selectedCommit");

  return (
    <div className={`merge-banner${hasConflicts ? "" : " merge-banner--resolved"}`}>
      <div className="merge-banner__text">
        {hasConflicts ? (
          <>
            <span>{t("banners.revert.status", {commit: commitLabel})}</span>
            <span className="merge-banner__count">
              {t("banners.conflictsRemaining", {count: conflictedFiles.length})}
            </span>
          </>
        ) : (
          <span>{t("banners.revert.ready")}</span>
        )}
      </div>
      <div className="merge-banner__actions">
        <button
          className="merge-banner__btn merge-banner__btn--abort"
          onClick={onRevertAbort}
          disabled={isRunning}
        >
          {t("banners.revert.abort")}
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          onClick={onRevertContinue}
          disabled={hasConflicts || isRunning}
        >
          {isRunning ? t("actions.working", {ns: "common"}) : t("banners.revert.continue")}
        </button>
      </div>
    </div>
  );
}
