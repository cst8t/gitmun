import React from "react";
import type { UpdateDialogState } from "../../hooks/useUpdateFlow";
import "./UpdateDialog.css";

type Props = {
  dialog: UpdateDialogState;
  onClose: () => void;
  onRemindLater: () => void;
  onUpdateNow: () => void;
  onDontShowAgainChange: (value: boolean) => void;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = units[0];
  for (let index = 0; index < units.length - 1 && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index + 1];
  }
  return `${size >= 10 || unit === "B" ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

export function UpdateDialog({
  dialog,
  onClose,
  onRemindLater,
  onUpdateNow,
  onDontShowAgainChange,
}: Props) {
  const { open, update, phase, errorMessage, dontShowAgain, downloadedBytes, contentLength } = dialog;

  React.useEffect(() => {
    if (!open || phase === "downloading" || phase === "installing") {
      return;
    }

    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose, phase]);

  if (!open || !update) {
    return null;
  }

  const hasKnownLength = typeof contentLength === "number" && contentLength > 0;
  const percent = hasKnownLength
    ? Math.max(0, Math.min(100, Math.round((downloadedBytes / contentLength) * 100)))
    : null;
  const isBusy = phase === "downloading" || phase === "installing";
  const isSuccess = phase === "success";

  let title = `Update ${update.version} is available`;
  let body = "A newer Gitmun release is ready to download.";
  if (phase === "downloading") {
    title = `Downloading update ${update.version}`;
    body = hasKnownLength
      ? `${formatBytes(downloadedBytes)} of ${formatBytes(contentLength)} downloaded`
      : `${formatBytes(downloadedBytes)} downloaded`;
  } else if (phase === "installing") {
    title = `Installing update ${update.version}`;
    body = "Download complete. Gitmun is applying the update now.";
  } else if (isSuccess) {
    title = `Update ${update.version} installed`;
    body = "Restart Gitmun to finish applying the update.";
  }

  return (
    <>
      <div className="update-dialog__backdrop" onClick={isBusy ? undefined : onClose} />
      <div className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <div className="update-dialog__title" id="update-dialog-title">{title}</div>
        <div className="update-dialog__body">{body}</div>
        {(update.body || update.date) && phase === "prompt" && (
          <div className="update-dialog__meta">
            {update.date && <div className="update-dialog__date">Published {new Date(update.date * 1000).toLocaleString()}</div>}
            {update.body && <pre className="update-dialog__notes">{update.body}</pre>}
          </div>
        )}
        {errorMessage && (
          <div className="update-dialog__error">{errorMessage}</div>
        )}
        {(phase === "downloading" || phase === "installing") && (
          <div className="update-dialog__progress">
            <div className={`update-dialog__progress-track${hasKnownLength ? "" : " update-dialog__progress-track--indeterminate"}`}>
              <div
                className="update-dialog__progress-fill"
                style={percent == null ? undefined : {width: `${percent}%`}}
              />
            </div>
            <div className="update-dialog__progress-label">
              {phase === "installing" ? "Installing..." : percent == null ? "Downloading..." : `${percent}%`}
            </div>
          </div>
        )}
        {phase === "prompt" && (
          <label className="update-dialog__suppress">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={(event) => onDontShowAgainChange(event.target.checked)}
            />
            Don&apos;t show this update again
          </label>
        )}
        <div className="update-dialog__actions">
          {phase === "prompt" && (
            <>
              <button className="update-dialog__btn update-dialog__btn--secondary" onClick={onClose}>
                Close
              </button>
              <button className="update-dialog__btn update-dialog__btn--secondary" onClick={onRemindLater}>
                Remind me later
              </button>
              <button className="update-dialog__btn update-dialog__btn--primary" onClick={onUpdateNow}>
                Update now
              </button>
            </>
          )}
          {isSuccess && (
            <button className="update-dialog__btn update-dialog__btn--primary" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </>
  );
}
