import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getRemoteNameError } from "../../utils/gitInputValidation";

type AddRemoteDialogProps = {
  existingRemoteNames: string[];
  onConfirm: (name: string, url: string) => void;
  onCancel: () => void;
};

export function AddRemoteDialog({ existingRemoteNames, onConfirm, onCancel }: AddRemoteDialogProps) {
  const { t } = useTranslation("sidebar");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  useEffect(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(null);
      return;
    }
    const validationError = getRemoteNameError(trimmed);
    if (validationError) {
      setNameError(validationError);
      return;
    }
    if (existingRemoteNames.includes(trimmed)) {
      setNameError("validation.remoteExists");
      return;
    }
    setNameError(null);
  }, [name, existingRemoteNames]);

  const canSubmit = name.trim() && url.trim() && !nameError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm(name.trim(), url.trim());
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">{t("addRemote.title")}</div>
        <form onSubmit={handleSubmit}>
          <div className="dialog__field">
            <label className="dialog__label">{t("addRemote.name")}</label>
            <input
              ref={nameInputRef}
              type="text"
              className="dialog__input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder={t("addRemote.namePlaceholder")}
            />
            {nameError && <div className="dialog__error">{t(nameError, {ns: "git", defaultValue: t(nameError) })}</div>}
          </div>
          <div className="dialog__field">
            <label className="dialog__label">{t("addRemote.url")}</label>
            <input
              type="text"
              className="dialog__input"
              value={url}
              onChange={e => setUrl(e.target.value)}
              placeholder={t("addRemote.urlPlaceholder")}
            />
          </div>
          <div className="dialog__actions">
            <button type="button" className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
              {t("actions.cancel", {ns: "common"})}
            </button>
            <button
              type="submit"
              className={`dialog__btn dialog__btn--confirm${!canSubmit ? " dialog__btn--disabled" : ""}`}
              disabled={!canSubmit}
            >
              {t("addRemote.title")}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
