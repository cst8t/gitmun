import React, { useEffect } from "react";
import type { PushRejectionAnalysis } from "../../types";
import "./PushRejectedDialog.css";

type PushRejectedDialogProps = {
  analysis: PushRejectionAnalysis;
  onFetch: () => void;
  onIntegrate: () => void;
  onCancel: () => void;
};

export function PushRejectedDialog({
  analysis,
  onFetch,
  onIntegrate,
  onCancel,
}: PushRejectedDialogProps) {
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
        <div className="dialog__title">Push Rejected</div>
        <div className="push-rejected-dialog__body">
          <p>{analysis.message}</p>
          <div className="push-rejected-dialog__meta">
            <span>{analysis.currentBranch ?? "Current branch"}</span>
            <span>{analysis.upstreamBranch ?? "No upstream"}</span>
          </div>
        </div>
        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog__btn dialog__btn--cancel" onClick={onFetch}>
            Fetch
          </button>
          <button className="dialog__btn dialog__btn--confirm" onClick={onIntegrate}>
            Integrate Changes
          </button>
        </div>
      </div>
    </>
  );
}
