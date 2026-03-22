import React, { useEffect, useRef, useState } from "react";
import { getRemoteNameError } from "../../utils/gitInputValidation";

type EditRemoteDialogProps = {
  currentName: string;
  currentUrl: string;
  existingRemoteNames: string[];
  onConfirm: (newName: string, newUrl: string) => void;
  onCancel: () => void;
};

export function EditRemoteDialog({
  currentName,
  currentUrl,
  existingRemoteNames,
  onConfirm,
  onCancel,
}: EditRemoteDialogProps) {
  const [name, setName] = useState(currentName);
  const [url, setUrl] = useState(currentUrl);
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
    if (trimmed !== currentName && existingRemoteNames.includes(trimmed)) {
      setNameError("A remote with this name already exists");
      return;
    }
    setNameError(null);
  }, [name, currentName, existingRemoteNames]);

  const unchanged = name.trim() === currentName && url.trim() === currentUrl;
  const canSubmit = name.trim() && url.trim() && !nameError && !unchanged;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onConfirm(name.trim(), url.trim());
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">Edit Remote</div>
        <form onSubmit={handleSubmit}>
          <div className="dialog__field">
            <label className="dialog__label">Name</label>
            <input
              ref={nameInputRef}
              type="text"
              className="dialog__input"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            {nameError && <div className="dialog__error">{nameError}</div>}
          </div>
          <div className="dialog__field">
            <label className="dialog__label">URL</label>
            <input
              type="text"
              className="dialog__input"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
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
              Save
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
