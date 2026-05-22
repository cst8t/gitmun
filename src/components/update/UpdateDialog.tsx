import React from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("update");
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
  const isMicrosoftStore = update.source === "microsoftStore";
  const isBusy = phase === "downloading" || phase === "installing" || phase === "storeOpening";
  const isSuccess = phase === "success";

  let title = isMicrosoftStore
    ? t("labels.storePromptTitle")
    : t("labels.promptTitle", { version: update.version });
  let body = isMicrosoftStore ? t("labels.storePromptBody") : t("labels.promptBody");
  if (phase === "storeOpening") {
    title = t("labels.storeOpeningTitle");
    body = t("labels.storeOpeningBody");
  } else if (phase === "storeDeferred") {
    title = t("labels.storeDeferredTitle");
    body = t("labels.storeDeferredBody");
  } else if (phase === "storeError") {
    title = t("labels.storeFailedTitle");
    body = t("labels.storeFailedBody", { message: errorMessage ?? t("labels.unknownError") });
  } else if (phase === "downloading") {
    title = isMicrosoftStore
      ? t("labels.storeDownloadingTitle")
      : t("labels.downloadingTitle", { version: update.version });
    body = isMicrosoftStore
      ? t("labels.storeDownloadingBody")
      : hasKnownLength
        ? t("labels.downloadedOf", { downloaded: formatBytes(downloadedBytes), total: formatBytes(contentLength) })
        : t("labels.downloaded", { bytes: formatBytes(downloadedBytes) });
  } else if (phase === "installing") {
    title = isMicrosoftStore
      ? t("labels.storeInstallingTitle")
      : t("labels.installingTitle", { version: update.version });
    body = isMicrosoftStore ? t("labels.storeInstallingBody") : t("labels.installingBody");
  } else if (isSuccess && !isMicrosoftStore) {
    title = t("labels.installedTitle", { version: update.version });
    body = t("labels.installedBody");
  }

  return (
    <>
      <div className="update-dialog__backdrop" onClick={isBusy ? undefined : onClose} />
      <div className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-dialog-title">
        <div className="update-dialog__title" id="update-dialog-title">{title}</div>
        <div className="update-dialog__body">{body}</div>
        {!isMicrosoftStore && (update.body || update.date) && phase === "prompt" && (
          <div className="update-dialog__meta">
            {update.date && (
              <div className="update-dialog__date">
                {t("labels.published", { date: new Date(update.date * 1000).toLocaleString() })}
              </div>
            )}
            {update.body && <pre className="update-dialog__notes">{update.body}</pre>}
          </div>
        )}
        {isMicrosoftStore && phase === "prompt" && update.mandatory && (
          <div className="update-dialog__meta">
            <div className="update-dialog__date">{t("labels.storeMandatory")}</div>
          </div>
        )}
        {errorMessage && !isMicrosoftStore && (
          <div className="update-dialog__error">{errorMessage}</div>
        )}
        {(phase === "downloading" || phase === "installing" || phase === "storeOpening") && (
          <div className="update-dialog__progress">
            <div className={`update-dialog__progress-track${hasKnownLength ? "" : " update-dialog__progress-track--indeterminate"}`}>
              <div
                className="update-dialog__progress-fill"
                style={percent == null ? undefined : {width: `${percent}%`}}
              />
            </div>
            <div className="update-dialog__progress-label">
              {phase === "storeOpening"
                ? t("labels.storeOpening")
                : phase === "installing"
                  ? t("labels.installing")
                  : percent == null ? t("labels.downloading") : `${percent}%`}
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
            {t("labels.dontShowAgain")}
          </label>
        )}
        <div className="update-dialog__actions">
          {phase === "prompt" && (
            <>
              <button className="update-dialog__btn update-dialog__btn--secondary" onClick={onClose}>
                {t("actions.close")}
              </button>
              <button className="update-dialog__btn update-dialog__btn--secondary" onClick={onRemindLater}>
                {t("actions.later")}
              </button>
              <button className="update-dialog__btn update-dialog__btn--primary" onClick={onUpdateNow}>
                {isMicrosoftStore ? t("actions.updateWithMicrosoftStore") : t("actions.updateNow")}
              </button>
            </>
          )}
          {(isSuccess || phase === "storeDeferred" || phase === "storeError") && (
            <button className="update-dialog__btn update-dialog__btn--primary" onClick={onClose}>
              {t("actions.close")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
