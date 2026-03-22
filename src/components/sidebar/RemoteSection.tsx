import React, { useState } from "react";
import { ContextMenu } from "../shared/ContextMenu";
import type { BranchInfo, RemoteInfo } from "../../types";
import "./RemoteSection.css";

type RemoteSectionProps = {
  remote: RemoteInfo;
  branches: BranchInfo[];
  currentUpstream: string | undefined;
  onCheckoutRemoteBranch: (remoteBranchName: string) => void;
  onMergeRemoteBranch: (remoteBranchName: string) => void;
  onDeleteRemoteBranch: (remote: string, branch: string) => void;
  onFetchRemote: (remoteName: string) => void;
  onPruneRemote: (remoteName: string) => void;
  onEditRemote: (remote: RemoteInfo) => void;
  onRemoveRemote: (remoteName: string) => void;
};

export function RemoteSection({
  remote,
  branches,
  currentUpstream,
  onCheckoutRemoteBranch,
  onMergeRemoteBranch,
  onDeleteRemoteBranch,
  onFetchRemote,
  onPruneRemote,
  onEditRemote,
  onRemoveRemote,
}: RemoteSectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; branch: string } | null>(null);
  const [remoteMenu, setRemoteMenu] = useState<{ x: number; y: number } | null>(null);

  // Strip "remote/" prefix from full ref names like "origin/main" → "main"
  const stripRemotePrefix = (name: string) => {
    const prefix = `${remote.name}/`;
    return name.startsWith(prefix) ? name.slice(prefix.length) : name;
  };

  const getFullRemoteBranchName = (branchName: string) => `${remote.name}/${branchName}`;

  const handleBranchContextMenu = (e: React.MouseEvent, branchName: string) => {
    e.preventDefault();
    setBranchMenu({ x: e.screenX, y: e.screenY, branch: branchName });
  };

  const handleRemoteContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRemoteMenu({ x: e.screenX, y: e.screenY });
  };

  return (
    <div className="remote-section">
      <button
        className="remote-section__header"
        onClick={() => setCollapsed(c => !c)}
        onContextMenu={handleRemoteContextMenu}
      >
        <span className={`remote-section__chevron ${collapsed ? "remote-section__chevron--collapsed" : ""}`}>
          ▾
        </span>
        <span className="remote-section__name">{remote.name}</span>
        <span className="remote-section__url">{remote.url}</span>
      </button>

      {!collapsed && (
        <div className="remote-section__branches">
          {branches.length === 0 ? (
            <div className="remote-section__empty">No branches fetched</div>
          ) : (
            branches.map(b => {
              const shortName = stripRemotePrefix(b.name);
              const isUpstream = currentUpstream === b.name;
              return (
                <div
                  key={b.name}
                  className={`remote-section__branch ${isUpstream ? "remote-section__branch--upstream" : ""}`}
                  onContextMenu={e => handleBranchContextMenu(e, shortName)}
                >
                  <span className="remote-section__branch-name">{shortName}</span>
                  {isUpstream && <span className="remote-section__upstream-badge">upstream</span>}
                </div>
              );
            })
          )}
        </div>
      )}

      {branchMenu && (
        <ContextMenu
          x={branchMenu.x}
          y={branchMenu.y}
          onClose={() => setBranchMenu(null)}
          items={[
            {
              label: `Checkout "${getFullRemoteBranchName(branchMenu.branch)}"`,
              onClick: () => onCheckoutRemoteBranch(getFullRemoteBranchName(branchMenu.branch)),
            },
            {
              label: `Merge "${getFullRemoteBranchName(branchMenu.branch)}" into current`,
              onClick: () => onMergeRemoteBranch(getFullRemoteBranchName(branchMenu.branch)),
            },
            {
              label: `Delete "${remote.name}/${branchMenu.branch}"`,
              danger: true,
              onClick: () => onDeleteRemoteBranch(remote.name, branchMenu.branch),
            },
          ]}
        />
      )}

      {remoteMenu && (
        <ContextMenu
          x={remoteMenu.x}
          y={remoteMenu.y}
          onClose={() => setRemoteMenu(null)}
          items={[
            {
              label: `Fetch "${remote.name}"`,
              onClick: () => onFetchRemote(remote.name),
            },
            {
              label: `Prune "${remote.name}"`,
              onClick: () => onPruneRemote(remote.name),
            },
            {
              label: "Edit Remote…",
              onClick: () => onEditRemote(remote),
            },
            {
              label: `Remove "${remote.name}"`,
              danger: true,
              onClick: () => onRemoveRemote(remote.name),
            },
          ]}
        />
      )}
    </div>
  );
}
