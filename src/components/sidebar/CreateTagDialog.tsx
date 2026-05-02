import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./CreateTagDialog.css";
import { getTagNameError } from "../../utils/gitInputValidation";

type CreateTagDialogProps = {
  existingTagNames: string[];
  targetCommit?: string | null;
  onConfirm: (tagName: string, message: string | null) => void;
  onCancel: () => void;
};

export function CreateTagDialog({ existingTagNames, targetCommit, onConfirm, onCancel }: CreateTagDialogProps) {
  const { t } = useTranslation("sidebar");
  const [tagName, setTagName] = useState("");
  const [message, setMessage] = useState("");
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
    const trimmed = tagName.trim();
    if (!trimmed) {
      setNameError(null);
      return;
    }
    const validationError = getTagNameError(trimmed);
    if (validationError) {
      setNameError(validationError);
      return;
    }
    if (existingTagNames.includes(trimmed)) {
      setNameError("validation.tagExists");
      return;
    }
    setNameError(null);
  }, [tagName, existingTagNames]);

  const canSubmit = tagName.trim() && !nameError;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm(tagName.trim(), message.trim() || null);
  };

  const targetLabel = targetCommit ? targetCommit.slice(0, 8) : "HEAD";

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog create-tag-dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">{t("createTag.title")}</div>
        <form onSubmit={handleSubmit}>
          <div className="dialog__field">
            <label className="dialog__label">{t("createTag.tagName")}</label>
            <input
              ref={nameInputRef}
              type="text"
              className="dialog__input"
              value={tagName}
              onChange={e => setTagName(e.target.value)}
              placeholder={t("createTag.tagNamePlaceholder")}
            />
            {nameError && <div className="dialog__error">{t(nameError, {ns: "git", defaultValue: t(nameError) })}</div>}
          </div>
          <div className="dialog__field">
            <label className="dialog__label">
              {t("createTag.message")} <span className="dialog__label-hint">{t("createTag.messageHint")}</span>
            </label>
            <textarea
              className="dialog__textarea"
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={t("createTag.messagePlaceholder")}
              rows={3}
            />
          </div>
          <div className="create-tag-dialog__target">
            {t("createTag.tagging")} <span className="create-tag-dialog__target-hash">{targetLabel}</span>
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
              {t("createTag.title")}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
