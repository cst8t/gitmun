import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { PullAnalysis, PullStrategy } from "../../types";
import "./DivergentPullDialog.css";

type DivergentPullDialogProps = {
  analysis: PullAnalysis;
  onConfirm: (strategy: PullStrategy) => void;
  onCancel: () => void;
};

export function DivergentPullDialog({ analysis, onConfirm, onCancel }: DivergentPullDialogProps) {
  const { t } = useTranslation("centre");

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog divergent-pull-dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">{t("divergentPull.title")}</div>
        <div className="divergent-pull-dialog__body">
          <p>{t("divergentPull.intro")}</p>
          <div className="divergent-pull-dialog__stats">
            <div>
              <span className="divergent-pull-dialog__label">{t("divergentPull.branch")}</span>
              <span>{analysis.currentBranch ?? t("divergentPull.currentBranch")}</span>
            </div>
            <div>
              <span className="divergent-pull-dialog__label">{t("divergentPull.upstream")}</span>
              <span>{analysis.upstreamBranch ?? t("divergentPull.noUpstream")}</span>
            </div>
            <div>
              <span className="divergent-pull-dialog__label">{t("divergentPull.ahead")}</span>
              <span>{analysis.ahead}</span>
            </div>
            <div>
              <span className="divergent-pull-dialog__label">{t("divergentPull.behind")}</span>
              <span>{analysis.behind}</span>
            </div>
          </div>
        </div>

        <div className="divergent-pull-dialog__options">
          <button className="divergent-pull-dialog__option" onClick={() => onConfirm("rebase")}>
            <span className="divergent-pull-dialog__option-title">{t("divergentPull.rebaseTitle")}</span>
            <span className="divergent-pull-dialog__option-copy">
              {t("divergentPull.rebaseBody")}
            </span>
          </button>
          <button className="divergent-pull-dialog__option" onClick={() => onConfirm("merge")}>
            <span className="divergent-pull-dialog__option-title">{t("divergentPull.mergeTitle")}</span>
            <span className="divergent-pull-dialog__option-copy">
              {t("divergentPull.mergeBody")}
            </span>
          </button>
        </div>

        <div className="divergent-pull-dialog__note">
          {t("divergentPull.note")}
        </div>

        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            {t("divergentPull.cancel")}
          </button>
        </div>
      </div>
    </>
  );
}
