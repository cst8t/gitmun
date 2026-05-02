import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "./MergeDialog.css";

export type MergeStrategy = "default" | "no-ff" | "ff-only";

type MergeDialogProps = {
  sourceBranch: string;
  targetBranch: string;
  onConfirm: (strategy: MergeStrategy) => void;
  onCancel: () => void;
};

export function MergeDialog({ sourceBranch, targetBranch, onConfirm, onCancel }: MergeDialogProps) {
  const { t } = useTranslation("sidebar");
  const [strategy, setStrategy] = useState<MergeStrategy>("default");
  const strategies: { value: MergeStrategy; label: string; description: string }[] = [
    { value: "default", label: t("mergeDialog.default"), description: t("mergeDialog.defaultDescription") },
    { value: "no-ff", label: t("mergeDialog.noFastForward"), description: t("mergeDialog.noFastForwardDescription") },
    { value: "ff-only", label: t("mergeDialog.fastForwardOnly"), description: t("mergeDialog.fastForwardOnlyDescription") },
  ];

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
        <div className="dialog__title">{t("mergeDialog.title")}</div>
        <div className="merge-dialog__subtitle">
          {t("mergeDialog.merge")}{" "}
          <span className="merge-dialog__branch">{sourceBranch}</span>
          {" "}{t("mergeDialog.into")}{" "}
          <span className="merge-dialog__branch">{targetBranch}</span>
        </div>

        <div className="merge-dialog__section-label">{t("mergeDialog.strategy")}</div>
        <div className="merge-dialog__strategies">
          {strategies.map(s => (
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
            {t("actions.cancel", {ns: "common"})}
          </button>
          <button className="dialog__btn dialog__btn--confirm" onClick={() => onConfirm(strategy)}>
            {t("mergeDialog.merge")}
          </button>
        </div>
      </div>
    </>
  );
}
