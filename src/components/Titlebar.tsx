import React, { useState, useEffect, useRef, RefObject } from "react";
import {
  GitIcon, BranchIcon, FetchIcon, PullIcon, PushIcon,
  StashIcon, SearchIcon, SettingsIcon, FolderIcon, CopyIcon, ChevDownIcon,
} from "./icons";
import type { PlatformType } from "../hooks/usePlatform";
import type { BranchInfo } from "../types";
import "./Titlebar.css";

type TitlebarProps = {
  platform: PlatformType;
  /** True when the OS provides native window decorations — hides drag region and window controls */
  native: boolean;
  repoPath: string | null;
  currentBranch: string | null;
  branches: BranchInfo[];
  identityInitials: string;
  identityAvatarUrl: string | null;
  recentRepos: string[];
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (query: string) => void;
  onSettingsClick: () => void;
  onIdentityClick: () => void;
  onCloneClick: () => void;
  onInitRepoClick: () => void;
  onOpenExistingClick: () => void;
  onRepoSelect: (path: string) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onStash: () => void;
  remoteOp?: "fetch" | "pull" | "push" | null;
  identityOpen: boolean;
};

function splitRepoPath(repoPath: string): { repoDir: string; repoName: string } {
  const normalized = repoPath.replace(/[\\/]+$/, "");
  const match = normalized.match(/^(.*[\\/])([^\\/]+)$/);

  if (!match) {
    return { repoDir: "", repoName: normalized };
  }

  const [, repoDir, repoName] = match;
  const shortenedRepoDir = repoDir.replace(/^\/home\/[^/\\]+/, "~");
  return { repoDir: shortenedRepoDir, repoName };
}

export function Titlebar({
  platform, native, repoPath, currentBranch, branches,
  identityInitials, identityAvatarUrl, recentRepos, searchQuery, searchInputRef,
  onSearchChange, onSettingsClick, onIdentityClick, onCloneClick, onInitRepoClick, onOpenExistingClick,
  onRepoSelect, onFetch, onPull, onPush, onStash,
  identityOpen, remoteOp,
}: TitlebarProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const currentBranchInfo = branches.find(b => b.isCurrent);
  const ahead = currentBranchInfo?.ahead ?? 0;
  const behind = currentBranchInfo?.behind ?? 0;

  const { repoDir, repoName } = repoPath
    ? splitRepoPath(repoPath)
    : { repoDir: "", repoName: "" };

  const dragRegionProps = native ? {} : { "data-tauri-drag-region": true };

  return (
    <div className={`titlebar titlebar--${platform}${native ? " titlebar--native" : ""}`}>
      {/* App branding — skip on Linux since the OS title bar already shows the app name */}
      {!native && (
        <>
          <div className="titlebar__brand" {...dragRegionProps}>
            <GitIcon /><span className="titlebar__name">Gitmun</span>
          </div>
          <div className="titlebar__sep" {...dragRegionProps} />
        </>
      )}

      {/* Repo + branch */}
      {repoPath ? (
        <>
          <div className="titlebar__repo" {...dragRegionProps}>
            <span className="titlebar__repo-dir">{repoDir}</span>
            <span className="titlebar__repo-name">{repoName}</span>
          </div>
          {currentBranch && (
            <div className="titlebar__branch-pill">
              <BranchIcon size={14} />
              <span className="titlebar__branch-name">{currentBranch}</span>
            </div>
          )}
        </>
      ) : (
        <span className="titlebar__no-repo" {...dragRegionProps}>No repository open</span>
      )}

      <div className="titlebar__spacer" {...dragRegionProps} />

      {/* Action buttons */}
      <div className="titlebar__actions">
        <ActionBtn icon={<FetchIcon />} label="Fetch" onClick={onFetch} disabled={!repoPath} loading={remoteOp === "fetch"} />
        <ActionBtn icon={<PullIcon />} label="Pull" badge={behind > 0 ? String(behind) : undefined} onClick={onPull} disabled={!repoPath} loading={remoteOp === "pull"} />
        <ActionBtn icon={<PushIcon />} label="Push" badge={ahead > 0 ? String(ahead) : undefined} onClick={onPush} disabled={!repoPath} loading={remoteOp === "push"} />
        <ActionBtn icon={<StashIcon />} label="Stash" onClick={onStash} disabled={!repoPath} />
      </div>
      <div className="titlebar__sep" />

      {/* New / clone / open repo */}
      <div className="titlebar__icon-btn titlebar__icon-btn--labeled" onClick={onInitRepoClick} title="Initialize a repository">
        <GitIcon /><span>New</span>
      </div>
      <div className="titlebar__icon-btn titlebar__icon-btn--labeled" onClick={onCloneClick} title="Clone a repository">
        <CopyIcon /><span>Clone</span>
      </div>
      <OpenDropdown
        repoPath={repoPath}
        recentRepos={recentRepos}
        onOpenExistingClick={onOpenExistingClick}
        onRepoSelect={onRepoSelect}
      />
      <div className="titlebar__sep" />

      {/* Search */}
      <div
        className={`titlebar__search${searchQuery || searchFocused ? " titlebar__search--active" : ""}`}
        onClick={() => searchInputRef.current?.focus()}
      >
        <SearchIcon />
        <input
          ref={searchInputRef}
          className="titlebar__search-input"
          placeholder="Search commits..."
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyDown={e => {
            if (e.key === "Escape") { onSearchChange(""); e.currentTarget.blur(); }
          }}
        />
        {!searchQuery && (
          <span className="titlebar__search-hint">
            {platform === "macos" ? "\u2318F" : "Ctrl+F"}
          </span>
        )}
      </div>

      {/* Settings */}
      <div className="titlebar__icon-btn" onClick={onSettingsClick}>
        <SettingsIcon />
      </div>

      {/* Identity avatar */}
      <div
        className={`titlebar__avatar ${identityOpen ? "titlebar__avatar--active" : ""}`}
        onClick={onIdentityClick}
      >
        {identityAvatarUrl
          ? <img className="titlebar__avatar-img" src={identityAvatarUrl} alt="" />
          : identityInitials}
      </div>

    </div>
  );
}

function OpenDropdown({ repoPath, recentRepos, onOpenExistingClick, onRepoSelect }: {
  repoPath: string | null;
  recentRepos: string[];
  onOpenExistingClick: () => void;
  onRepoSelect: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const recent = recentRepos.filter(r => r !== repoPath).slice(0, 5);

  return (
    <div className="titlebar__open-dropdown" ref={ref}>
      <div
        className="titlebar__icon-btn titlebar__icon-btn--labeled"
        onClick={() => setOpen(v => !v)}
        title="Open a repository"
      >
        <FolderIcon />
        <span>Open</span>
        <ChevDownIcon />
      </div>
      {open && (
        <div className="titlebar__open-menu">
          <div
            className="titlebar__open-menu-item"
            onClick={() => { setOpen(false); onOpenExistingClick(); }}
          >
            <FolderIcon size={14} />
            <span>Open repository…</span>
          </div>
          {recent.length > 0 && (
            <>
              <div className="titlebar__open-menu-sep" />
              {recent.map(r => (
                <div
                  key={r}
                  className="titlebar__open-menu-item titlebar__open-menu-item--recent"
                  onClick={() => { setOpen(false); onRepoSelect(r); }}
                  title={r}
                >
                  {r.split("/").pop()}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ActionBtn({ icon, label, badge, onClick, disabled, loading, title }: {
  icon: React.ReactNode; label: string; badge?: string; onClick: () => void; disabled?: boolean; loading?: boolean; title?: string;
}) {
  const inactive = disabled || loading;
  return (
    <div
      className={`titlebar__action-btn${disabled ? " titlebar__action-btn--disabled" : ""}${loading ? " titlebar__action-btn--loading" : ""}`}
      onClick={inactive ? undefined : onClick}
      title={title}
    >
      {loading ? <span className="titlebar__btn-spinner" /> : icon}
      <span>{label}</span>
      {!loading && badge && <span className="titlebar__badge">{badge}</span>}
    </div>
  );
}
