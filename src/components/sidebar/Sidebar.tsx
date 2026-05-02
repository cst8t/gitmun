import React, { useState } from "react";
import { useTranslation } from "react-i18next";
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
  onStashDrop: (stash: StashEntry) => void;
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
  const { t } = useTranslation("sidebar");
  const [tab, setTab] = useState<SidebarTab>("branches");
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number; name: string } | null>(null);

  return (
    <div className="sidebar">
      <div className="sidebar__tabs">
        {(["branches", "tags", "remotes", "stashes"] as const).map(tabName => (
          <button key={tabName}
            className={`sidebar__tab ${tab === tabName ? "sidebar__tab--active" : ""}`}
            onClick={() => setTab(tabName)}
            title={t(`sections.${tabName}`)}>
            {t(`sections.${tabName}`)}
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
              + {t("createTag.title")}
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
              : <div className="sidebar__empty">{t("sidebar.noTags")}</div>
            }
          </div>
        )}
        {tab === "remotes" && (
          <div className="sidebar__list">
            <button className="sidebar__add-remote-btn" onClick={onAddRemote}>
              + {t("addRemote.title")}
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
              : <div className="sidebar__empty">{t("sidebar.noRemotes")}</div>
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
                        title={t("sidebar.applyKeep")}
                        disabled={stashBusy}
                        onClick={() => onStashApply(s.index)}
                      >
                        {t("actions.apply", {ns: "common"})}
                      </button>
                      <button
                        className="sidebar__stash-btn"
                        title={t("sidebar.popRemove")}
                        disabled={stashBusy}
                        onClick={() => onStashPop(s.index)}
                      >
                        Pop
                      </button>
                      <button
                        className="sidebar__stash-btn sidebar__stash-btn--danger"
                        title={t("sidebar.dropDelete")}
                        disabled={stashBusy}
                        onClick={() => onStashDrop(s)}
                      >
                        {t("actions.drop", {ns: "common"})}
                      </button>
                    </div>
                  </div>
                ))
              : <div className="sidebar__empty">{t("sidebar.noStashes")}</div>
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
              label: t("sidebar.pushTag"),
              onClick: () => onPushTag(tagMenu.name),
            },
            {
              label: t("sidebar.deleteTagRemote"),
              onClick: () => onDeleteRemoteTag(tagMenu.name),
            },
            {
              label: t("sidebar.tagCreateBranch"),
              onClick: () => onCreateBranchFromTag(tagMenu.name),
            },
            {
              label: t("sidebar.deleteTag", {tag: tagMenu.name}),
              danger: true,
              onClick: () => onDeleteTag(tagMenu.name),
            },
          ]}
        />
      )}
    </div>
  );
}
