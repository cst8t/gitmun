import React, { useEffect } from "react";
import type { PullAnalysis, PullStrategy } from "../../types";
import "./DivergentPullDialog.css";

type DivergentPullDialogProps = {
  analysis: PullAnalysis;
  onConfirm: (strategy: PullStrategy) => void;
  onCancel: () => void;
};

export function DivergentPullDialog({ analysis, onConfirm, onCancel }: DivergentPullDialogProps) {
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
        <div className="dialog__title">Choose Pull Strategy</div>
        <div className="divergent-pull-dialog__body">
          <p>
            This branch and its upstream both have commits the other side does not have.
            Git cannot choose between rebasing and merging automatically.
          </p>
          <div className="divergent-pull-dialog__stats">
            <div>
              <span className="divergent-pull-dialog__label">Branch</span>
              <span>{analysis.currentBranch ?? "Current branch"}</span>
            </div>
            <div>
              <span className="divergent-pull-dialog__label">Upstream</span>
              <span>{analysis.upstreamBranch ?? "No upstream"}</span>
            </div>
            <div>
              <span className="divergent-pull-dialog__label">Ahead</span>
              <span>{analysis.ahead}</span>
            </div>
            <div>
              <span className="divergent-pull-dialog__label">Behind</span>
              <span>{analysis.behind}</span>
            </div>
          </div>
        </div>

        <div className="divergent-pull-dialog__options">
          <button className="divergent-pull-dialog__option" onClick={() => onConfirm("rebase")}>
            <span className="divergent-pull-dialog__option-title">Rebase onto upstream</span>
            <span className="divergent-pull-dialog__option-copy">
              Keeps history linear but rewrites local commit IDs.
            </span>
          </button>
          <button className="divergent-pull-dialog__option" onClick={() => onConfirm("merge")}>
            <span className="divergent-pull-dialog__option-title">Merge upstream</span>
            <span className="divergent-pull-dialog__option-copy">
              Preserves local commit IDs but adds a merge commit.
            </span>
          </button>
        </div>

        <div className="divergent-pull-dialog__note">
          Fast-forward only is not possible when both sides have unique commits.
        </div>

        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
