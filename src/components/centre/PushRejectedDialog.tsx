import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { PushRejectionAnalysis } from "../../types";
import { WarningIcon } from "../icons";
import "./PushRejectedDialog.css";

type PushRejectedDialogProps = {
  analysis: PushRejectionAnalysis;
  onFetch: () => void;
  onIntegrate: () => void;
  onPublish: () => void;
  onRepairUpstream: () => void;
  onCancel: () => void;
};

export function PushRejectedDialog({
  analysis,
  onFetch,
  onIntegrate,
  onPublish,
  onRepairUpstream,
  onCancel,
}: PushRejectedDialogProps) {
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
      <div className="dialog push-rejected-dialog" role="dialog" aria-modal="true">
        <div className="dialog__title push-rejected-dialog__title">
          <WarningIcon size={18} className="push-rejected-dialog__icon" />
          <span>{t("pushRejected.title")}</span>
        </div>
        <div className="push-rejected-dialog__body">
          <p>{analysis.message}</p>
          <div className="push-rejected-dialog__meta">
            <span>{analysis.currentBranch ?? t("pushRejected.currentBranch")}</span>
            <span>{analysis.upstreamBranch ?? t("pushRejected.noUpstream")}</span>
          </div>
        </div>
        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            {t("pushRejected.cancel")}
          </button>
          {analysis.suggestedNextActions.includes("fetch") && (
            <button className="dialog__btn dialog__btn--cancel" onClick={onFetch}>
              {t("pushRejected.fetch")}
            </button>
          )}
          {analysis.suggestedNextActions.includes("integrate") && (
            <button className="dialog__btn dialog__btn--confirm" onClick={onIntegrate}>
              {t("pushRejected.integrate")}
            </button>
          )}
          {analysis.suggestedNextActions.includes("publish") && (
            <button className="dialog__btn dialog__btn--confirm" onClick={onPublish}>
              {t("pushRejected.publish")}
            </button>
          )}
          {analysis.suggestedNextActions.includes("repair-upstream") && (
            <button className="dialog__btn dialog__btn--confirm" onClick={onRepairUpstream}>
              {t("pushRejected.repairUpstream")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
