import React from "react";
import { useTranslation } from "react-i18next";
import "./ConfirmRevertDialog.css";

type ConfirmRevertDialogProps = {
  filePaths: string[];
  onConfirm: (dontShowAgain: boolean) => void;
  onCancel: () => void;
};

export function ConfirmRevertDialog({ filePaths, onConfirm, onCancel }: ConfirmRevertDialogProps) {
  const { t } = useTranslation("centre");
  const [dontShowAgain, setDontShowAgain] = React.useState(false);
  const single = filePaths.length === 1;
  const fileName = single ? (filePaths[0].split("/").pop() ?? filePaths[0]) : null;

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
        <div className="confirm-revert-dialog__title">{t("confirmRevert.title")}</div>
        <div className="confirm-revert-dialog__body">
          {single
            ? t("confirmRevert.message", {count: 1, file: fileName})
            : t("confirmRevert.message", {count: filePaths.length})
          }
        </div>
        {single && (
          <label className="confirm-revert-dialog__suppress">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={e => setDontShowAgain(e.target.checked)}
            />
            {t("confirmRevert.dontAsk")}
          </label>
        )}
        <div className="dialog__actions">
          <button className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
            {t("actions.cancel", {ns: "common"})}
          </button>
          <button className="dialog__btn dialog__btn--confirm" onClick={() => onConfirm(dontShowAgain)}>
            {t("confirmRevert.revert")}
          </button>
        </div>
      </div>
    </>
  );
}
