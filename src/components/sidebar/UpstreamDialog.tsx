import React, { useEffect, useMemo, useState } from "react";
import type { BranchInfo, RemoteInfo } from "../../types";
import { splitUpstreamRef } from "../../utils/remoteActionState";
import "./UpstreamDialog.css";

export type UpstreamDialogMode = "publish" | "repair" | "change";

type UpstreamDialogProps = {
  mode: UpstreamDialogMode;
  branchName: string;
  remotes: RemoteInfo[];
  remoteBranches: BranchInfo[];
  initialUpstream?: string | null;
  onConfirm: (selection: { remote: string; remoteBranch: string }) => void;
  onCancel: () => void;
};

const MODE_LABELS: Record<UpstreamDialogMode, string> = {
  publish: "Publish Branch",
  repair: "Repair Upstream",
  change: "Change Upstream",
};

export function UpstreamDialog({
  mode,
  branchName,
  remotes,
  remoteBranches,
  initialUpstream,
  onConfirm,
  onCancel,
}: UpstreamDialogProps) {
  const remoteInputId = React.useId();
  const remoteBranchInputId = React.useId();
  const initialSelection = splitUpstreamRef(initialUpstream);
  const [remote, setRemote] = useState(() => {
    if (initialSelection?.remote) {
      return initialSelection.remote;
    }
    return remotes.length === 1 ? remotes[0].name : "";
  });
  const [remoteBranch, setRemoteBranch] = useState(() => initialSelection?.branch ?? branchName);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  const knownRemoteBranches = useMemo(
    () => remoteBranches
      .filter(branch => branch.name.startsWith(`${remote}/`))
      .map(branch => branch.name.slice(remote.length + 1))
      .filter(branch => branch && branch !== "HEAD")
      .sort((a, b) => a.localeCompare(b)),
    [remote, remoteBranches],
  );

  const trimmedRemote = remote.trim();
  const trimmedRemoteBranch = remoteBranch.trim();
  const hasRemotes = remotes.length > 0;
  const hasKnownRemote = remotes.some(candidate => candidate.name === trimmedRemote);
  const canConfirm =
    hasRemotes &&
    hasKnownRemote &&
    Boolean(trimmedRemote) &&
    Boolean(trimmedRemoteBranch);

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!canConfirm) {
      return;
    }
    onConfirm({
      remote: trimmedRemote,
      remoteBranch: trimmedRemoteBranch,
    });
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog upstream-dialog" role="dialog" aria-modal="true">
        <div className="dialog__title">{MODE_LABELS[mode]}</div>
        <form onSubmit={handleSubmit}>
          <div className="upstream-dialog__summary">
            <div className="upstream-dialog__summary-row">
              <span>Local branch</span>
              <strong>{branchName}</strong>
            </div>
            <div className="upstream-dialog__summary-row">
              <span>Will track</span>
              <strong>{trimmedRemote && trimmedRemoteBranch ? `${trimmedRemote}/${trimmedRemoteBranch}` : "Choose a remote branch"}</strong>
            </div>
          </div>

          <div className="dialog__field">
            <label className="dialog__label" htmlFor={remoteInputId}>Remote</label>
            <select
              id={remoteInputId}
              className="dialog__input"
              value={remote}
              onChange={event => setRemote(event.target.value)}
              disabled={!hasRemotes}
            >
              <option value="">{hasRemotes ? "Choose a remote..." : "No remotes configured"}</option>
              {remotes.map(item => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </select>
          </div>

          <div className="dialog__field">
            <label className="dialog__label" htmlFor={remoteBranchInputId}>Remote branch</label>
            <input
              id={remoteBranchInputId}
              className="dialog__input"
              value={remoteBranch}
              onChange={event => setRemoteBranch(event.target.value)}
              placeholder={branchName}
            />
          </div>

          {knownRemoteBranches.length > 0 && (
            <div className="upstream-dialog__branches">
              <div className="dialog__label">Known branches on {remote}</div>
              <div className="upstream-dialog__branch-list">
                {knownRemoteBranches.map(branch => (
                  <button
                    key={branch}
                    type="button"
                    className={`upstream-dialog__branch-chip${branch === trimmedRemoteBranch ? " upstream-dialog__branch-chip--active" : ""}`}
                    onClick={() => setRemoteBranch(branch)}
                  >
                    {branch}
                  </button>
                ))}
              </div>
            </div>
          )}

          {!hasRemotes && (
            <div className="dialog__error">Add a remote before using this flow.</div>
          )}

          <div className="dialog__actions">
            <button type="button" className="dialog__btn dialog__btn--cancel" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className={`dialog__btn dialog__btn--confirm${canConfirm ? "" : " dialog__btn--disabled"}`}
              disabled={!canConfirm}
            >
              {MODE_LABELS[mode]}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
