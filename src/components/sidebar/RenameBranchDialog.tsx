import React, { useEffect, useRef, useState } from "react";
import "./RenameBranchDialog.css";
import { getBranchNameError } from "../../utils/branchValidation";

type RenameBranchDialogProps = {
  currentName: string;
  existingBranchNames: string[];
  onConfirm: (newName: string) => void;
  onCancel: () => void;
};

export function RenameBranchDialog({
  currentName,
  existingBranchNames,
  onConfirm,
  onCancel,
}: RenameBranchDialogProps) {
  const [name, setName] = useState(currentName);
  const [nameError, setNameError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
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

    const branchNameError = getBranchNameError(trimmed);
    if (branchNameError) {
      setNameError(branchNameError);
      return;
    }

    if (trimmed !== currentName && existingBranchNames.includes(trimmed)) {
      setNameError("A branch with this name already exists");
      return;
    }

    setNameError(null);
  }, [name, currentName, existingBranchNames]);

  const unchanged = name.trim() === currentName;
  const canSubmit = name.trim() && !nameError && !unchanged;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) {
      return;
    }
    onConfirm(name.trim());
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">Rename Branch</div>
        <form onSubmit={handleSubmit}>
          <div className="dialog__field">
            <label className="dialog__label">Branch name</label>
            <input
              ref={inputRef}
              type="text"
              className="dialog__input"
              value={name}
              onChange={e => setName(e.target.value)}
            />
            {nameError && <div className="dialog__error">{nameError}</div>}
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
              Rename
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
