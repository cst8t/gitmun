import React, { useState } from "react";
import { BranchIcon } from "../icons";
import { CreateBranchDialog } from "./CreateBranchDialog";
import { ContextMenu } from "../shared/ContextMenu";
import type { BranchInfo, CreateBranchRequest, TagInfo } from "../../types";

type BranchListProps = {
  branches: BranchInfo[];
  tags: TagInfo[];
  repoPath: string | null;
  onSwitchBranch: (branchName: string) => void;
  onCreateBranch: (request: CreateBranchRequest) => void;
  onRenameBranch: (branchName: string) => void;
  onDeleteBranch: (branchName: string) => void;
  onForceDeleteBranch: (branchName: string) => void;
  onMergeBranch: (branchName: string) => void;
  onRebaseBranch: (branchName: string) => void;
};

export function BranchList({
  branches,
  tags,
  repoPath,
  onSwitchBranch,
  onCreateBranch,
  onRenameBranch,
  onDeleteBranch,
  onForceDeleteBranch,
  onMergeBranch,
  onRebaseBranch,
}: BranchListProps) {
  const [hoveredBranch, setHoveredBranch] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; branch: string } | null>(null);

  const currentBranch = branches.find(b => b.isCurrent && !b.isRemote);

  const handleCreateBranch = (request: CreateBranchRequest) => {
    onCreateBranch(request);
    setShowCreateDialog(false);
  };

  const handleContextMenu = (e: React.MouseEvent, branchName: string) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, branch: branchName });
  };

  return (
    <>
      <div className="sidebar__list">
        <button
          className="sidebar__create-branch-btn"
          onClick={() => setShowCreateDialog(true)}
          title="Create new branch"
        >
          <BranchIcon size={14} />
          Create Branch
        </button>

        {branches.filter(b => !b.isRemote).map(b => (
          <div
            key={b.name}
            className={`sidebar__branch ${b.isCurrent ? "sidebar__branch--current" : ""}`}
            onMouseEnter={() => setHoveredBranch(b.name)}
            onMouseLeave={() => setHoveredBranch(null)}
            onContextMenu={(e) => handleContextMenu(e, b.name)}
          >
            <BranchIcon size={14} />
            <span className="sidebar__branch-name">{b.name}</span>
            {(b.behind > 0 || b.ahead > 0) && (
              <div className="sidebar__branch-counts">
                {b.behind > 0 && <span className="sidebar__branch-behind">{"\u2193"}{b.behind}</span>}
                {b.ahead > 0 && <span className="sidebar__branch-ahead">{"\u2191"}{b.ahead}</span>}
              </div>
            )}
            {!b.isCurrent && hoveredBranch === b.name && (
              <button
                className="sidebar__branch-checkout"
                title={`Switch to ${b.name}`}
                onClick={e => { e.stopPropagation(); onSwitchBranch(b.name); }}
              >
                Switch
              </button>
            )}
          </div>
        ))}
      </div>

      {contextMenu && (() => {
        const isCurrentBranch = branches.find(b => b.name === contextMenu.branch && !b.isRemote)?.isCurrent;
        return (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            items={[
              {
                label: `Rename "${contextMenu.branch}"`,
                onClick: () => onRenameBranch(contextMenu.branch),
              },
              ...(!isCurrentBranch ? [{
                label: `Merge "${contextMenu.branch}" into ${currentBranch?.name ?? "current"}`,
                onClick: () => onMergeBranch(contextMenu.branch),
              }] : []),
              ...(!isCurrentBranch ? [{
                label: `Rebase ${currentBranch?.name ?? "current"} onto "${contextMenu.branch}"`,
                onClick: () => onRebaseBranch(contextMenu.branch),
              }] : []),
              ...(!isCurrentBranch ? [{
                label: `Delete "${contextMenu.branch}"`,
                danger: true,
                onClick: () => onDeleteBranch(contextMenu.branch),
              }] : []),
              ...(!isCurrentBranch ? [{
                label: `Force Delete "${contextMenu.branch}"`,
                danger: true,
                onClick: () => onForceDeleteBranch(contextMenu.branch),
              }] : []),
            ]}
          />
        );
      })()}

      {showCreateDialog && repoPath && (
        <CreateBranchDialog
          repoPath={repoPath}
          branches={branches}
          tags={tags}
          currentBranch={currentBranch}
          onConfirm={handleCreateBranch}
          onCancel={() => setShowCreateDialog(false)}
        />
      )}
    </>
  );
}
