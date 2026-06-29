import React, { useState, useEffect, useRef, RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  GitIcon, BranchIcon, FetchIcon, PullIcon, PushIcon,
  StashIcon, SearchIcon, SettingsIcon, FolderIcon, CopyIcon, ChevDownIcon, InfoIcon, TerminalIcon, OpenExternalIcon,
  MoreIcon,
} from "./icons";
import * as api from "../api/commands";
import type { ResetMode } from "../api/commands";
import type { PlatformType } from "../hooks/usePlatform";
import type { BranchInfo, RepoOpenLocation, RepoOpenLocationKind } from "../types";
import { displayNameForRepoPath } from "../utils/repoDisplayName";
import "./Titlebar.css";

type TitlebarProps = {
  platform: PlatformType;
  /** True when the OS provides native window decorations - hides drag region and window controls */
  native: boolean;
  repoPath: string | null;
  repoDisplayName: string | null;
  currentBranch: string | null;
  branches: BranchInfo[];
  identityInitials: string;
  identityAvatarUrl: string | null;
  recentRepos: string[];
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  onSearchChange: (query: string) => void;
  onAboutClick: () => void;
  onSettingsClick: () => void;
  onIdentityClick: () => void;
  onCloneClick: () => void;
  onInitRepoClick: () => void;
  onOpenExistingClick: () => void;
  onRepoSelect: (path: string) => void;
  onOpenRepoLocation: (kind: RepoOpenLocationKind) => void;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  pushLabel?: string;
  pushDisabled?: boolean;
  pushTitle?: string;
  onStash: () => void;
  onReset: (mode: Extract<ResetMode, "mixed" | "hard">) => void;
  onImportPatch: () => void;
  onExportPatch: (scope: "staged" | "unstaged" | "all" | "selected") => void;
  selectedPatchExportEnabled: boolean;
  remoteOp?: "fetch" | "pull" | "push" | null;
  identityOpen: boolean;
};

export function Titlebar({
  platform, native, repoPath, currentBranch, branches,
  repoDisplayName,
  identityInitials, identityAvatarUrl, recentRepos, searchQuery, searchInputRef,
  onSearchChange, onAboutClick, onSettingsClick, onIdentityClick, onCloneClick, onInitRepoClick, onOpenExistingClick,
  onRepoSelect, onOpenRepoLocation, onFetch, onPull, onPush, pushLabel, pushDisabled = false, pushTitle, onStash,
  onReset, onImportPatch, onExportPatch, selectedPatchExportEnabled,
  identityOpen, remoteOp,
}: TitlebarProps) {
  const { t } = useTranslation("titlebar");
  const [searchFocused, setSearchFocused] = useState(false);
  const [repoPathCopied, setRepoPathCopied] = useState(false);
  const repoPathCopiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pushActionLabel = pushLabel ?? t("actions.push");
  const currentBranchInfo = branches.find(b => b.isCurrent);
  const ahead = currentBranchInfo?.ahead ?? 0;
  const behind = currentBranchInfo?.behind ?? 0;
  const searchDisabled = !repoPath;
  const searchShortcutLabel = platform === "macos" ? "\u2318F" : "Ctrl+F";

  const repoName = repoPath ? displayNameForRepoPath(repoPath, repoDisplayName) : "";

  const copyRepoPath = () => {
    if (!repoPath) return;
    setRepoPathCopied(true);
    if (repoPathCopiedTimerRef.current) clearTimeout(repoPathCopiedTimerRef.current);
    repoPathCopiedTimerRef.current = setTimeout(() => {
      setRepoPathCopied(false);
      repoPathCopiedTimerRef.current = null;
    }, 1200);
    navigator.clipboard?.writeText(repoPath).catch(() => {});
  };

  useEffect(() => {
    return () => {
      if (repoPathCopiedTimerRef.current) clearTimeout(repoPathCopiedTimerRef.current);
    };
  }, []);

  const dragRegionProps = native ? {} : { "data-tauri-drag-region": true };

  return (
    <div className={`titlebar titlebar--${platform}${native ? " titlebar--native" : ""}`}>
      {/* App branding - skip on Linux since the OS title bar already shows the app name */}
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
        <div className="titlebar__repo-area">
          <div className="titlebar__repo-wrap">
            <button
              type="button"
              className="titlebar__repo"
              onClick={copyRepoPath}
              title={t("actions.copyRepositoryPath")}
              aria-label={t("actions.copyRepositoryPath")}
            >
              <span className="titlebar__repo-name">{repoName}</span>
            </button>
            <span className={`titlebar__repo-copied${repoPathCopied ? " titlebar__repo-copied--visible" : ""}`}>
              {t("labels.copied")}
            </span>
          </div>
          {currentBranch && (
            <div className="titlebar__branch-pill" title={currentBranch}>
              <BranchIcon size={16} className="titlebar__branch-icon" />
              <span className="titlebar__branch-name">{currentBranch}</span>
            </div>
          )}
        </div>
      ) : (
        <span className="titlebar__no-repo" {...dragRegionProps}>{t("labels.noRepositoryOpen")}</span>
      )}

      <div className="titlebar__spacer" {...dragRegionProps} />

      {/* Action buttons */}
      <div className="titlebar__actions">
        <ActionBtn icon={<FetchIcon size={18} className="titlebar__toolbar-icon" />} label={t("actions.fetch")} onClick={onFetch} disabled={!repoPath} loading={remoteOp === "fetch"} />
        <ActionBtn icon={<PullIcon size={18} className="titlebar__toolbar-icon" />} label={t("actions.pull")} badge={behind > 0 ? String(behind) : undefined} onClick={onPull} disabled={!repoPath} loading={remoteOp === "pull"} />
        <ActionBtn
          icon={<PushIcon size={18} className="titlebar__toolbar-icon" />}
          label={pushActionLabel}
          badge={pushActionLabel === t("actions.push") && ahead > 0 ? String(ahead) : undefined}
          onClick={onPush}
          disabled={!repoPath || pushDisabled}
          loading={remoteOp === "push"}
          title={pushTitle}
        />
        <ActionBtn icon={<StashIcon size={18} className="titlebar__toolbar-icon" />} label={t("actions.stash")} onClick={onStash} disabled={!repoPath} />
        <MoreDropdown
          repoPath={repoPath}
          onReset={onReset}
          onImportPatch={onImportPatch}
          onExportPatch={onExportPatch}
          selectedPatchExportEnabled={selectedPatchExportEnabled}
        />
      </div>
      <div className="titlebar__sep" />

      <div className="titlebar__repo-actions">
        <div className="titlebar__icon-btn titlebar__icon-btn--labeled" onClick={onInitRepoClick} title={t("actions.initialiseRepository")}>
          <GitIcon size={18} className="titlebar__toolbar-icon" /><span className="titlebar__btn-label">{t("actions.new")}</span>
        </div>
        <div className="titlebar__icon-btn titlebar__icon-btn--labeled" onClick={onCloneClick} title={t("actions.cloneRepository")}>
          <CopyIcon size={18} className="titlebar__toolbar-icon" /><span className="titlebar__btn-label">{t("actions.clone")}</span>
        </div>
        <OpenDropdown
          repoPath={repoPath}
          recentRepos={recentRepos}
          onOpenExistingClick={onOpenExistingClick}
          onRepoSelect={onRepoSelect}
        />
        <OpenInDropdown
          repoPath={repoPath}
          onOpenRepoLocation={onOpenRepoLocation}
        />
      </div>
      <div className="titlebar__sep" />

      {/* Search */}
      <div
        className={`titlebar__search${!searchDisabled && (searchQuery || searchFocused) ? " titlebar__search--active" : ""}${searchDisabled ? " titlebar__search--disabled" : ""}`}
        onClick={searchDisabled ? undefined : () => searchInputRef.current?.focus()}
        aria-disabled={searchDisabled}
        title={searchDisabled ? undefined : t("labels.searchCommitsShortcut", { shortcut: searchShortcutLabel })}
      >
        <SearchIcon size={18} className="titlebar__toolbar-icon" />
        <input
          ref={searchInputRef}
          className="titlebar__search-input"
          placeholder={t("labels.searchCommits")}
          value={searchQuery}
          disabled={searchDisabled}
          aria-label={t("labels.searchCommitsShortcut", { shortcut: searchShortcutLabel })}
          onChange={e => onSearchChange(e.target.value)}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onKeyDown={e => {
            if (e.key === "Escape") { onSearchChange(""); e.currentTarget.blur(); }
          }}
        />
      </div>

      <div className="titlebar__icon-btn" onClick={onAboutClick} title={t("actions.about")}>
        <InfoIcon size={18} className="titlebar__toolbar-icon" />
      </div>
      <div className="titlebar__icon-btn" onClick={onSettingsClick}>
        <SettingsIcon size={18} className="titlebar__toolbar-icon" />
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

function MoreDropdown({ repoPath, onReset, onImportPatch, onExportPatch, selectedPatchExportEnabled }: {
  repoPath: string | null;
  onReset: (mode: Extract<ResetMode, "mixed" | "hard">) => void;
  onImportPatch: () => void;
  onExportPatch: (scope: "staged" | "unstaged" | "all" | "selected") => void;
  selectedPatchExportEnabled: boolean;
}) {
  const { t } = useTranslation("titlebar");
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const disabled = !repoPath;

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

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

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div className="titlebar__open-dropdown" ref={ref}>
      <div
        className={`titlebar__icon-btn titlebar__icon-btn--labeled${disabled ? " titlebar__icon-btn--disabled" : ""}`}
        onClick={disabled ? undefined : () => setOpen(v => !v)}
        title={t("actions.more")}
        aria-disabled={disabled}
      >
        <MoreIcon size={18} className="titlebar__toolbar-icon" />
        <span className="titlebar__btn-label">{t("actions.more")}</span>
        <ChevDownIcon />
      </div>
      {open && !disabled && (
        <div className="titlebar__open-menu">
          <div className="titlebar__open-menu-heading">{t("patchFiles.heading")}</div>
          <div className="titlebar__open-menu-item" onClick={() => run(onImportPatch)}>
            <span>{t("patchFiles.import")}</span>
          </div>
          <div className="titlebar__open-menu-item titlebar__open-menu-item--submenu">
            <span>{t("patchFiles.export")}</span>
            <ChevDownIcon size={13} className="titlebar__submenu-chevron" />
            <div className="titlebar__open-submenu">
              <div className="titlebar__open-menu-item" onClick={() => run(() => onExportPatch("staged"))}>
                <span>{t("patchFiles.exportStaged")}</span>
              </div>
              <div className="titlebar__open-menu-item" onClick={() => run(() => onExportPatch("unstaged"))}>
                <span>{t("patchFiles.exportUnstaged")}</span>
              </div>
              <div className="titlebar__open-menu-item" onClick={() => run(() => onExportPatch("all"))}>
                <span>{t("patchFiles.exportAll")}</span>
              </div>
              <div
                className={`titlebar__open-menu-item${selectedPatchExportEnabled ? "" : " titlebar__open-menu-item--disabled"}`}
                aria-disabled={!selectedPatchExportEnabled}
                onClick={selectedPatchExportEnabled ? () => run(() => onExportPatch("selected")) : undefined}
              >
                <span>{t("patchFiles.exportSelected")}</span>
              </div>
            </div>
          </div>
          <div className="titlebar__open-menu-heading">{t("reset.heading")}</div>
          <div className="titlebar__open-menu-item" onClick={() => run(() => onReset("mixed"))}>
            <span>{t("reset.mixed")}</span>
          </div>
          <div className="titlebar__open-menu-item" onClick={() => run(() => onReset("hard"))}>
            <span>{t("reset.hard")}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function fallbackOpenLocations(t: ReturnType<typeof useTranslation<"titlebar">>["t"]): RepoOpenLocation[] {
  return [
    {
      kind: "fileExplorer",
      label: t("actions.fileManager"),
      fallbackLabel: t("actions.fileManager"),
      iconDataUrl: null,
    },
    {
      kind: "terminal",
      label: t("actions.terminal"),
      fallbackLabel: t("actions.terminal"),
      iconDataUrl: null,
    },
  ];
}

function OpenInDropdown({ repoPath, onOpenRepoLocation }: {
  repoPath: string | null;
  onOpenRepoLocation: (kind: RepoOpenLocationKind) => void;
}) {
  const { t } = useTranslation("titlebar");
  const [open, setOpen] = useState(false);
  const [locations, setLocations] = useState<RepoOpenLocation[]>(() => fallbackOpenLocations(t));
  const ref = useRef<HTMLDivElement>(null);
  const disabled = !repoPath;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getRepoOpenLocations()
      .then(result => {
        if (!cancelled && result.length > 0) {
          setLocations(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocations(fallbackOpenLocations(t));
        }
      });
    return () => { cancelled = true; };
  }, [open, t]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

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

  return (
    <div className="titlebar__open-dropdown" ref={ref}>
      <div
        className={`titlebar__icon-btn titlebar__icon-btn--labeled${disabled ? " titlebar__icon-btn--disabled" : ""}`}
        onClick={disabled ? undefined : () => setOpen(v => !v)}
        title={t("actions.openIn")}
        aria-disabled={disabled}
      >
        <OpenExternalIcon size={18} className="titlebar__toolbar-icon" />
        <span className="titlebar__btn-label">{t("actions.openIn")}</span>
        <ChevDownIcon />
      </div>
      {open && !disabled && (
        <div className="titlebar__open-menu">
          {locations.map(location => (
            <div
              key={location.kind}
              className="titlebar__open-menu-item"
              onClick={() => { setOpen(false); onOpenRepoLocation(location.kind); }}
            >
              {location.iconDataUrl ? (
                <img className="titlebar__open-menu-icon" src={location.iconDataUrl} alt="" />
              ) : location.kind === "terminal" || location.kind === "gitBash" ? (
                <TerminalIcon size={14} />
              ) : (
                <FolderIcon size={14} />
              )}
              <span>{location.label || location.fallbackLabel}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function OpenDropdown({ repoPath, recentRepos, onOpenExistingClick, onRepoSelect }: {
  repoPath: string | null;
  recentRepos: string[];
  onOpenExistingClick: () => void;
  onRepoSelect: (path: string) => void;
}) {
  const { t } = useTranslation("titlebar");
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
        title={t("actions.openRepository")}
      >
        <FolderIcon size={18} className="titlebar__toolbar-icon" />
        <span className="titlebar__btn-label">{t("actions.open")}</span>
        <ChevDownIcon />
      </div>
      {open && (
        <div className="titlebar__open-menu">
          <div
            className="titlebar__open-menu-item"
            onClick={() => { setOpen(false); onOpenExistingClick(); }}
          >
            <FolderIcon size={14} />
            <span>{t("actions.openRepositoryMenu")}</span>
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
      title={title ?? label}
    >
      {loading ? <span className="titlebar__btn-spinner" /> : icon}
      <span className="titlebar__btn-label">{label}</span>
      {!loading && badge && <span className="titlebar__badge">{badge}</span>}
    </div>
  );
}
