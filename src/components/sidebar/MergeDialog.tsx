import React, { useEffect, useState } from "react";
import "./MergeDialog.css";

export type MergeStrategy = "default" | "no-ff" | "ff-only";

type MergeDialogProps = {
  sourceBranch: string;
  targetBranch: string;
  onConfirm: (strategy: MergeStrategy) => void;
  onCancel: () => void;
};

const STRATEGIES: { value: MergeStrategy; label: string; description: string }[] = [
  {
    value: "default",
    label: "Default",
    description: "Fast-forward if possible, otherwise create a merge commit",
  },
  {
    value: "no-ff",
    label: "No Fast-Forward",
    description: "Always create a merge commit, even if fast-forward is possible",
  },
  {
    value: "ff-only",
    label: "Fast-Forward Only",
    description: "Refuse to merge if a fast-forward is not possible",
  },
];

export function MergeDialog({ sourceBranch, targetBranch, onConfirm, onCancel }: MergeDialogProps) {
  const [strategy, setStrategy] = useState<MergeStrategy>("default");

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm(strategy);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel, onConfirm, strategy]);

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog merge-dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">Merge Branch</div>
        <div className="merge-dialog__subtitle">
          Merge <span className="merge-dialog__branch">{sourceBranch}</span> into{" "}
          <span className="merge-dialog__branch">{targetBranch}</span>
        </div>

        <div className="merge-dialog__section-label">Strategy</div>
        <div className="merge-dialog__strategies">
          {STRATEGIES.map(s => (
            <label
              key={s.value}
              className={`merge-dialog__strategy ${strategy === s.value ? "merge-dialog__strategy--selected" : ""}`}
            >
              <input
                type="radio"
                name="merge-strategy"
                value={s.value}
                checked={strategy === s.value}
                onChange={() => setStrategy(s.value)}
              />
              <div className="merge-dialog__strategy-text">
                <span className="merge-dialog__strategy-label">{s.label}</span>
                <span className="merge-dialog__strategy-desc">{s.description}</span>
              </div>
            </label>
          ))}
        </div>

        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog__btn dialog__btn--confirm" onClick={() => onConfirm(strategy)}>
            Merge
          </button>
        </div>
      </div>
    </>
  );
}
