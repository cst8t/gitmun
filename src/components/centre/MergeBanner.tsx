import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("centre");
  const resolved = conflictedFiles.length === 0;

  const branchLabel = mergeHeadBranch
    ? `'${mergeHeadBranch}'`
    : t("banners.unknownBranch");

  return (
    <div className={`merge-banner${resolved ? " merge-banner--resolved" : ""}`}>
      <div className="merge-banner__text">
        {resolved ? (
          <span>{t("banners.merge.ready")}</span>
        ) : (
          <>
            <span>{t("banners.merge.status", {source: branchLabel, target: currentBranch ?? t("banners.unknownBranch")})}</span>
            {conflictedFiles.length > 0 && (
              <span className="merge-banner__count">
                {t("banners.conflictsRemaining", {count: conflictedFiles.length})}
              </span>
            )}
          </>
        )}
      </div>
      <div className="merge-banner__actions">
        <button className="merge-banner__btn merge-banner__btn--abort" onClick={onMergeAbort}>
          {t("banners.merge.abort")}
        </button>
        <button
          className="merge-banner__btn merge-banner__btn--commit"
          disabled={!resolved || stagedCount === 0 || isCommitting}
          onClick={onCommitMerge}
        >
          {isCommitting ? t("commitBox.committing") : t("banners.merge.commit")}
        </button>
      </div>
    </div>
  );
}
