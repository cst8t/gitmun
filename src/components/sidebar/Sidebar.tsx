import React, { useState } from "react";
import { BranchList } from "./BranchList";
import { RemoteSection } from "./RemoteSection";
import { ContextMenu } from "../shared/ContextMenu";
import type { BranchInfo, TagInfo, RemoteInfo, CreateBranchRequest, StashEntry } from "../../types";
import "./Sidebar.css";

type SidebarTab = "branches" | "tags" | "remotes" | "stashes";

type SidebarProps = {
  branches: BranchInfo[];
  tags: TagInfo[];
  remotes: RemoteInfo[];
  stashes: StashEntry[];
  repoPath: string | null;
  onSwitchBranch: (branchName: string) => void;
  onCreateBranch: (request: CreateBranchRequest) => void;
  onRenameBranch: (branchName: string) => void;
  onDeleteBranch: (branchName: string) => void;
  onForceDeleteBranch: (branchName: string) => void;
  onPublishBranch: () => void;
  onRepairUpstream: () => void;
  onChangeUpstream: () => void;
  onDeleteTag: (tagName: string) => void;
  onCreateTag: () => void;
  onPushTag: (tagName: string) => void;
  onDeleteRemoteTag: (tagName: string) => void;
  onCreateBranchFromTag: (tagName: string) => void;
  onMergeBranch: (branchName: string) => void;
  onRebaseBranch: (branchName: string) => void;
  onCheckoutRemoteBranch: (remoteBranchName: string) => void;
  onDeleteRemoteBranch: (remote: string, branch: string) => void;
  onAddRemote: () => void;
  onFetchRemote: (remoteName: string) => void;
  onPruneRemote: (remoteName: string) => void;
  onEditRemote: (remote: RemoteInfo) => void;
  onRemoveRemote: (remoteName: string) => void;
  onStashApply: (stashIndex: number) => void;
  onStashPop: (stashIndex: number) => void;
  onStashDrop: (stashIndex: number) => void;
  stashBusy?: boolean;
};

export function Sidebar({
  branches,
  tags,
  remotes,
  stashes,
  repoPath,
  onSwitchBranch,
  onCreateBranch,
  onRenameBranch,
  onDeleteBranch,
  onForceDeleteBranch,
  onPublishBranch,
  onRepairUpstream,
  onChangeUpstream,
  onDeleteTag,
  onCreateTag,
  onPushTag,
  onDeleteRemoteTag,
  onCreateBranchFromTag,
  onMergeBranch,
  onRebaseBranch,
  onCheckoutRemoteBranch,
  onDeleteRemoteBranch,
  onAddRemote,
  onFetchRemote,
  onPruneRemote,
  onEditRemote,
  onRemoveRemote,
  onStashApply,
  onStashPop,
  onStashDrop,
  stashBusy,
}: SidebarProps) {
  const [tab, setTab] = useState<SidebarTab>("branches");
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; name: string } | null>(null);

  return (
    <div className="sidebar">
      <div className="sidebar__tabs">
        {(["branches", "tags", "remotes", "stashes"] as const).map(t => (
          <button key={t}
            className={`sidebar__tab ${tab === t ? "sidebar__tab--active" : ""}`}
            onClick={() => setTab(t)}
            title={t.charAt(0).toUpperCase() + t.slice(1)}>
            {t}
          </button>
        ))}
      </div>

      <div className="sidebar__content">
        {tab === "branches" && (
          <BranchList
            branches={branches}
            tags={tags}
            repoPath={repoPath}
            onSwitchBranch={onSwitchBranch}
            onCreateBranch={onCreateBranch}
            onRenameBranch={onRenameBranch}
            onDeleteBranch={onDeleteBranch}
            onForceDeleteBranch={onForceDeleteBranch}
            onMergeBranch={onMergeBranch}
            onRebaseBranch={onRebaseBranch}
            onPublishBranch={onPublishBranch}
            onRepairUpstream={onRepairUpstream}
            onChangeUpstream={onChangeUpstream}
          />
        )}
        {tab === "tags" && (
          <div className="sidebar__list">
            <button className="sidebar__create-tag-btn" onClick={onCreateTag}>
              + Create Tag
            </button>
            {tags.length > 0
              ? tags.map(t => (
                  <div
                    key={t.name}
                    className="sidebar__item"
                    onContextMenu={(e) => { e.preventDefault(); setTagMenu({ x: e.clientX, y: e.clientY, name: t.name }); }}
                  >
                    <span className="sidebar__item-name">{t.name}</span>
                    <span className="sidebar__item-hash">{t.hash}</span>
                  </div>
                ))
              : <div className="sidebar__empty">No tags</div>
            }
          </div>
        )}
        {tab === "remotes" && (
          <div className="sidebar__list">
            <button className="sidebar__add-remote-btn" onClick={onAddRemote}>
              + Add Remote
            </button>
            {remotes.length > 0
              ? remotes.map(r => {
                  const remoteBranches = branches.filter(b => b.isRemote && b.name.startsWith(`${r.name}/`));
                  const currentBranch = branches.find(b => b.isCurrent && !b.isRemote);
                  const currentUpstream = currentBranch?.upstream ?? undefined;
                  return (
                    <RemoteSection
                      key={r.name}
                      remote={r}
                      branches={remoteBranches}
                      currentUpstream={currentUpstream}
                      onCheckoutRemoteBranch={onCheckoutRemoteBranch}
                      onMergeRemoteBranch={onMergeBranch}
                      onDeleteRemoteBranch={onDeleteRemoteBranch}
                      onFetchRemote={onFetchRemote}
                      onPruneRemote={onPruneRemote}
                      onEditRemote={onEditRemote}
                      onRemoveRemote={onRemoveRemote}
                    />
                  );
                })
              : <div className="sidebar__empty">No remotes configured</div>
            }
          </div>
        )}
        {tab === "stashes" && (
          <div className="sidebar__list">
            {stashes.length > 0
              ? stashes.map(s => (
                  <div key={s.index} className="sidebar__stash-item">
                    <div className="sidebar__stash-info">
                      <span className="sidebar__stash-message">{s.message}</span>
                      <span className="sidebar__stash-hash">{s.shortHash}</span>
                    </div>
                    <div className="sidebar__stash-actions">
                      <button
                        className="sidebar__stash-btn"
                        title="Apply (keep stash)"
                        disabled={stashBusy}
                        onClick={() => onStashApply(s.index)}
                      >
                        Apply
                      </button>
                      <button
                        className="sidebar__stash-btn"
                        title="Pop (apply and remove)"
                        disabled={stashBusy}
                        onClick={() => onStashPop(s.index)}
                      >
                        Pop
                      </button>
                      <button
                        className="sidebar__stash-btn sidebar__stash-btn--danger"
                        title="Drop (delete without applying)"
                        disabled={stashBusy}
                        onClick={() => onStashDrop(s.index)}
                      >
                        Drop
                      </button>
                    </div>
                  </div>
                ))
              : <div className="sidebar__empty">No stashes</div>
            }
          </div>
        )}
      </div>

      {tagMenu && (
        <ContextMenu
          x={tagMenu.x}
          y={tagMenu.y}
          onClose={() => setTagMenu(null)}
          items={[
            {
              label: "Push Tag",
              onClick: () => onPushTag(tagMenu.name),
            },
            {
              label: "Delete from Remote",
              onClick: () => onDeleteRemoteTag(tagMenu.name),
            },
            {
              label: "Create Branch from Tag…",
              onClick: () => onCreateBranchFromTag(tagMenu.name),
            },
            {
              label: `Delete "${tagMenu.name}"`,
              danger: true,
              onClick: () => onDeleteTag(tagMenu.name),
            },
          ]}
        />
      )}
    </div>
  );
}
