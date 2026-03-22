import React, { useEffect, useRef, useState } from "react";
import type { FileStatusItem } from "../../types";
import "./StashPushDialog.css";

type StashPushOptions = {
  message: string | null;
  includeUntracked: boolean;
  paths: string[] | null;
};

type Props = {
  stagedFiles: FileStatusItem[];
  unstagedFiles: FileStatusItem[];
  unversionedFiles: string[];
  onConfirm: (opts: StashPushOptions) => void;
  onCancel: () => void;
};

export function StashPushDialog({
  stagedFiles,
  unstagedFiles,
  unversionedFiles,
  onConfirm,
  onCancel,
}: Props) {
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(false);
  const [checkedPaths, setCheckedPaths] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    stagedFiles.forEach(f => initial.add(f.path));
    unstagedFiles.forEach(f => initial.add(f.path));
    return initial;
  });

  const messageRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messageRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  // When include-untracked is toggled on, check all untracked files by default.
  useEffect(() => {
    if (includeUntracked) {
      setCheckedPaths(prev => {
        const next = new Set(prev);
        unversionedFiles.forEach(p => next.add(p));
        return next;
      });
    } else {
      setCheckedPaths(prev => {
        const next = new Set(prev);
        unversionedFiles.forEach(p => next.delete(p));
        return next;
      });
    }
  }, [includeUntracked, unversionedFiles]);

  const togglePath = (path: string) => {
    setCheckedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allTrackedPaths = [
    ...stagedFiles.map(f => f.path),
    ...unstagedFiles.map(f => f.path),
  ];
  const allAvailablePaths = includeUntracked
    ? [...allTrackedPaths, ...unversionedFiles]
    : allTrackedPaths;

  const canSubmit = checkedPaths.size > 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    const uniqueAvailable = new Set(allAvailablePaths);
    const allSelected = uniqueAvailable.size === checkedPaths.size &&
      [...uniqueAvailable].every(p => checkedPaths.has(p));

    onConfirm({
      message: message.trim() || null,
      includeUntracked,
      paths: allSelected ? null : [...checkedPaths],
    });
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog stash-push-dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">Stash Changes</div>
        <form onSubmit={handleSubmit}>
          <div className="dialog__field">
            <label className="dialog__label">
              Message <span className="dialog__label-hint">(optional)</span>
            </label>
            <input
              ref={messageRef}
              type="text"
              className="dialog__input"
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder="WIP: "
            />
          </div>

          <label className="stash-push-dialog__checkbox-row">
            <input
              type="checkbox"
              checked={includeUntracked}
              onChange={e => setIncludeUntracked(e.target.checked)}
            />
            <span>Include untracked files</span>
          </label>

          <div className="stash-push-dialog__files">
            {stagedFiles.length > 0 && (
              <FileGroup
                label="Staged Changes"
                files={stagedFiles.map(f => ({ path: f.path, badge: f.status }))}
                checkedPaths={checkedPaths}
                onToggle={togglePath}
              />
            )}
            {unstagedFiles.length > 0 && (
              <FileGroup
                label="Unstaged Changes"
                files={unstagedFiles.map(f => ({ path: f.path, badge: f.status }))}
                checkedPaths={checkedPaths}
                onToggle={togglePath}
              />
            )}
            {includeUntracked && unversionedFiles.length > 0 && (
              <FileGroup
                label="Untracked Files"
                files={unversionedFiles.map(p => ({ path: p, badge: "?" }))}
                checkedPaths={checkedPaths}
                onToggle={togglePath}
              />
            )}
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
              Stash Changes
            </button>
          </div>
        </form>
      </div>
    </>
  );
}

type FileGroupProps = {
  label: string;
  files: { path: string; badge: string }[];
  checkedPaths: Set<string>;
  onToggle: (path: string) => void;
};

function FileGroup({ label, files, checkedPaths, onToggle }: FileGroupProps) {
  return (
    <div className="stash-push-dialog__group">
      <div className="stash-push-dialog__group-label">{label}</div>
      {files.map(({ path, badge }) => (
        <label key={path} className="stash-push-dialog__file-row">
          <input
            type="checkbox"
            checked={checkedPaths.has(path)}
            onChange={() => onToggle(path)}
          />
          <span className="stash-push-dialog__file-path">{path}</span>
          <span className="stash-push-dialog__file-badge">{badge.toUpperCase().slice(0, 1)}</span>
        </label>
      ))}
    </div>
  );
}
