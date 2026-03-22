import React from "react";
import "./ConfirmRevertDialog.css";

type ConfirmRevertDialogProps = {
  filePath: string;
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
};

export function ConfirmRevertDialog({ filePath, onConfirm, onCancel }: ConfirmRevertDialogProps) {
  const [dontShowAgain, setDontShowAgain] = React.useState(false);
  const fileName = filePath.split("/").pop() ?? filePath;

  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog confirm-revert-dialog" role="dialog" aria-modal="true">
        <div className="confirm-revert-dialog__title">Revert changes?</div>
        <div className="confirm-revert-dialog__body">
          All uncommitted changes to <span className="confirm-revert-dialog__filename">{fileName}</span> will be permanently lost.
        </div>
        <label className="confirm-revert-dialog__suppress">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={e => setDontShowAgain(e.target.checked)}
          />
          Don't show this again
        </label>
        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="dialog__btn dialog__btn--confirm" onClick={() => onConfirm(dontShowAgain)}>
            Revert
          </button>
        </div>
      </div>
    </>
  );
}
