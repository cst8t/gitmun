import React, { useEffect, useRef, useState } from "react";
import "./CreateTagDialog.css";
import { getTagNameError } from "../../utils/gitInputValidation";

type CreateTagDialogProps = {
  existingTagNames: string[];
  targetCommit?: string | null;
  onConfirm: (tagName: string, message: string | null) => void;
  onCancel: () => void;
};

export function CreateTagDialog({ existingTagNames, targetCommit, onConfirm, onCancel }: CreateTagDialogProps) {
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
      setNameError("A tag with this name already exists");
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
        <div className="dialog__title">Create Tag</div>
        <form onSubmit={handleSubmit}>
          <div className="dialog__field">
            <label className="dialog__label">Tag name</label>
            <input
              ref={nameInputRef}
              type="text"
              className="dialog__input"
              value={tagName}
              onChange={e => setTagName(e.target.value)}
              placeholder="v1.0.0"
            />
            {nameError && <div className="dialog__error">{nameError}</div>}
          </div>
          <div className="dialog__field">
            <label className="dialog__label">
              Message <span className="dialog__label-hint">(optional - leave blank for lightweight tag)</span>
            </label>
            <textarea
              className="dialog__textarea"
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="Release v1.0.0"
              rows={3}
            />
          </div>
          <div className="create-tag-dialog__target">
            Tagging: <span className="create-tag-dialog__target-hash">{targetLabel}</span>
          </div>
          <div className="dialog__actions">
            <button type="button" className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className={`dialog__btn dialog__btn--confirm${!canSubmit ? " dialog__btn--disabled" : ""}`}
              disabled={!canSubmit}
            >
              Create Tag
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
