import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileRow } from "./FileRow";
import { CommitBox } from "./CommitBox";
import type { CommitPrimaryAction, ConflictFileItem, FileStatusItem, SubmoduleStatus } from "../../types";
import { getNumstat } from "../../api/commands";

type StagingViewProps = {
  repoPath: string | null;
  stagedFiles: FileStatusItem[];
  unstagedFiles: FileStatusItem[];
  unversionedFiles: string[];
  submodules: SubmoduleStatus[];
  conflictedFiles: ConflictFileItem[];
  mergeInProgress: boolean;
  mergeMessage: string | null;
  rebaseInProgress: boolean;
  cherryPickInProgress: boolean;
  selectedFile: string | null;
  selectedSubmodulePath: string | null;
  onFileSelect: (path: string, staged: boolean) => void;
  onSubmoduleSelect: (path: string) => void;
  onSubmoduleInit: (path: string) => void;
  onSubmoduleUpdate: (path: string) => void;
  onSubmoduleSync: (path: string) => void;
  onSubmoduleFetch: (path: string) => void;
  onSubmodulePull: (path: string) => void;
  onSubmoduleOpen: (path: string) => void;
  onStageFile: (path: string) => void;
  onStageFiles: (paths: string[]) => void;
  onUnstageFile: (path: string) => void;
  onUnstageFiles: (paths: string[]) => void;
  onDiscardFile: (path: string) => void;
  onDiscardFiles: (paths: string[]) => void;
  onDiscardAll: (paths: string[]) => void;
  onExternalDiff: (path: string, staged: boolean) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  selectedCommitAction: CommitPrimaryAction;
  commitMessageRecommendedLength: number;
  allowCommitAndPush: boolean;
  onSelectCommitAction: (action: CommitPrimaryAction) => void;
  onCommit: (message: string, amend: boolean, action: CommitPrimaryAction) => void;
  onConflictAcceptTheirs: (path: string) => void;
  onConflictAcceptOurs: (path: string) => void;
  onOpenMergeTool: (path: string) => void;
  isCommitting: boolean;
  lastCommitMessage: string;
};

type CachedNumstat = {
  additions: number;
  deletions: number;
  updatedAt: number;
};

const NUMSTAT_REFRESH_MS = 7000;
const NUMSTAT_BATCH_SIZE = 6;

const SUBMODULE_STATE_LABELS: Record<SubmoduleStatus["state"], string> = {
  clean: "Clean",
  uninitialised: "Uninitialised",
  missing: "Missing",
  dirty: "Dirty",
  outOfSync: "Out of sync",
  conflict: "Conflict",
  syncRequired: "Sync required",
};

function cacheKey(path: string, staged: boolean): string {
  return `${staged ? "s" : "u"}:${path}`;
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : "-";
}

type SubmoduleRowProps = {
  submodule: SubmoduleStatus;
  selected: boolean;
  onSelect: () => void;
  onInit: () => void;
  onUpdate: () => void;
  onSync: () => void;
  onFetch: () => void;
  onPull: () => void;
  onOpen: () => void;
};

function SubmoduleRow({
  submodule,
  selected,
  onSelect,
  onInit,
  onUpdate,
  onSync,
  onFetch,
  onPull,
  onOpen,
}: SubmoduleRowProps) {
  const { t } = useTranslation("centre");
  const canInit = !submodule.initialised || submodule.state === "missing" || submodule.state === "uninitialised";
  const canUpdate = submodule.initialised && submodule.state !== "missing";
  const canSync = submodule.syncRequired;
  const canFetch = submodule.initialised;
  const canPull = submodule.initialised && !submodule.dirty && !!submodule.currentBranch;
  const canOpen = submodule.initialised;

  return (
    <div
      className={`submodule-row ${selected ? "submodule-row--selected" : ""}`}
      onClick={onSelect}
      onDoubleClick={canOpen ? onOpen : undefined}
    >
      <div className="submodule-row__main">
        <span className={`submodule-row__state submodule-row__state--${submodule.state}`}>
          {t(`submoduleState.${submodule.state}`, {ns: "git"})}
        </span>
        <span className="submodule-row__path">{submodule.path}</span>
        <span className="submodule-row__meta">
          {submodule.currentBranch ?? submodule.branch ?? t("staging.detachedOrUninitialised")}
        </span>
      </div>
      <div className="submodule-row__details">
        <span>{t("staging.expected", {hash: shortHash(submodule.expectedCommit)})}</span>
        <span>{t("staging.checkedOut", {hash: shortHash(submodule.checkedOutCommit)})}</span>
        {submodule.configuredUrl && <span title={submodule.configuredUrl}>{submodule.configuredUrl}</span>}
      </div>
      <div className="submodule-row__actions" onClick={e => e.stopPropagation()}>
        {canInit && <button onClick={onInit}>{t("actions.init", {ns: "common"})}</button>}
        {canUpdate && <button onClick={onUpdate}>{t("actions.update", {ns: "common"})}</button>}
        {canSync && <button onClick={onSync}>{t("staging.syncUrl")}</button>}
        {canFetch && <button onClick={onFetch}>{t("actions.fetch", {ns: "common"})}</button>}
        {canPull && <button onClick={onPull}>{t("actions.pull", {ns: "common"})}</button>}
        {canOpen && <button onClick={onOpen}>{t("actions.open", {ns: "common"})}</button>}
      </div>
    </div>
  );
}

export function StagingView({
  repoPath,
  stagedFiles, unstagedFiles, unversionedFiles, submodules, conflictedFiles, mergeInProgress, mergeMessage, rebaseInProgress, cherryPickInProgress,
  selectedFile, selectedSubmodulePath, onFileSelect, onSubmoduleSelect, onSubmoduleInit, onSubmoduleUpdate, onSubmoduleSync,
  onSubmoduleFetch, onSubmodulePull, onSubmoduleOpen, onStageFile, onStageFiles, onUnstageFile, onUnstageFiles,
  onDiscardFile, onDiscardFiles, onDiscardAll, onExternalDiff, onStageAll, onUnstageAll,
  selectedCommitAction, commitMessageRecommendedLength, allowCommitAndPush, onSelectCommitAction, onCommit,
  onConflictAcceptTheirs, onConflictAcceptOurs, onOpenMergeTool,
  isCommitting, lastCommitMessage,
}: StagingViewProps) {
  const { t } = useTranslation("centre");
  const [selectedUnstaged, setSelectedUnstaged] = useState<Record<string, boolean>>({});
  const [selectedStaged, setSelectedStaged] = useState<Record<string, boolean>>({});
  const [numstatCache, setNumstatCache] = useState<Record<string, CachedNumstat>>({});
  const [numstatLoading, setNumstatLoading] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setNumstatCache({});
    setNumstatLoading({});
  }, [repoPath]);

  const mergedStaged = useMemo(
    () => stagedFiles.map((file) => {
      if (file.additions != null || file.deletions != null) return file;
      const cached = numstatCache[cacheKey(file.path, true)];
      if (!cached) return file;
      return { ...file, additions: cached.additions, deletions: cached.deletions };
    }),
    [stagedFiles, numstatCache],
  );

  const mergedUnstaged = useMemo(
    () => unstagedFiles.map((file) => {
      if (file.additions != null || file.deletions != null) return file;
      const cached = numstatCache[cacheKey(file.path, false)];
      if (!cached) return file;
      return { ...file, additions: cached.additions, deletions: cached.deletions };
    }),
    [unstagedFiles, numstatCache],
  );

  const allUnstaged: FileStatusItem[] = [
    ...mergedUnstaged,
    ...unversionedFiles.map(path => ({ path, status: "new", additions: null, deletions: null })),
  ];

  useEffect(() => {
    if (!repoPath) return;

    const now = Date.now();
    const targets = [
      ...stagedFiles.map(file => ({ file, staged: true })),
      ...unstagedFiles.map(file => ({ file, staged: false })),
    ]
      .filter(({ file, staged }) => {
        if (file.additions != null || file.deletions != null) return false;
        const key = cacheKey(file.path, staged);
        if (numstatLoading[key]) return false;
        const cached = numstatCache[key];
        if (!cached) return true;
        return now - cached.updatedAt > NUMSTAT_REFRESH_MS;
      })
      .slice(0, NUMSTAT_BATCH_SIZE);

    if (targets.length === 0) return;

    let cancelled = false;
    setNumstatLoading((prev) => {
      const next = { ...prev };
      for (const { file, staged } of targets) {
        next[cacheKey(file.path, staged)] = true;
      }
      return next;
    });

    Promise.all(
      targets.map(async ({ file, staged }) => {
        const key = cacheKey(file.path, staged);
        try {
          const result = await getNumstat(repoPath, file.path, staged);
          return { key, additions: result.additions, deletions: result.deletions };
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (cancelled) {
        setNumstatLoading((prev) => {
          const next = { ...prev };
          for (const { file, staged } of targets) {
            delete next[cacheKey(file.path, staged)];
          }
          return next;
        });
        return;
      }
      const updatedAt = Date.now();

      setNumstatCache((prev) => {
        const next = { ...prev };
        for (const result of results) {
          if (!result) continue;
          next[result.key] = {
            additions: result.additions,
            deletions: result.deletions,
            updatedAt,
          };
        }
        return next;
      });

      setNumstatLoading((prev) => {
        const next = { ...prev };
        for (const { file, staged } of targets) {
          delete next[cacheKey(file.path, staged)];
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [repoPath, stagedFiles, unstagedFiles, numstatCache, numstatLoading]);

  const selectedUnstagedPaths = useMemo(
    () => allUnstaged.filter(f => selectedUnstaged[f.path]).map(f => f.path),
    [allUnstaged, selectedUnstaged],
  );
  const selectedStagedPaths = useMemo(
    () => mergedStaged.filter(f => selectedStaged[f.path]).map(f => f.path),
    [mergedStaged, selectedStaged],
  );

  const toggleUnstaged = (path: string) => {
    setSelectedUnstaged(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleStaged = (path: string) => {
    setSelectedStaged(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const handleStageSelected = () => {
    if (selectedUnstagedPaths.length === 0) return;
    onStageFiles(selectedUnstagedPaths);
    setSelectedUnstaged({});
  };

  const handleUnstageSelected = () => {
    if (selectedStagedPaths.length === 0) return;
    onUnstageFiles(selectedStagedPaths);
    setSelectedStaged({});
  };

  return (
    <div className="staging">
      <div className="staging__files">
        {submodules.length > 0 && (
          <div className="staging__section">
            <div className="staging__section-header">
              <span className="staging__section-label">
                {t("staging.submodules")} {"\u00B7"} {submodules.length}
              </span>
            </div>
            {submodules.map(submodule => (
              <div key={submodule.path} className="staging__row-anim">
                <SubmoduleRow
                  submodule={submodule}
                  selected={selectedSubmodulePath === submodule.path}
                  onSelect={() => onSubmoduleSelect(submodule.path)}
                  onInit={() => onSubmoduleInit(submodule.path)}
                  onUpdate={() => onSubmoduleUpdate(submodule.path)}
                  onSync={() => onSubmoduleSync(submodule.path)}
                  onFetch={() => onSubmoduleFetch(submodule.path)}
                  onPull={() => onSubmodulePull(submodule.path)}
                  onOpen={() => onSubmoduleOpen(submodule.path)}
                />
              </div>
            ))}
          </div>
        )}

        {/* Conflicts section - shown during merge/rebase */}
        {(mergeInProgress || rebaseInProgress || cherryPickInProgress) && conflictedFiles.length > 0 && (
          <div className="staging__section">
            <div className="staging__section-header">
              <span className="staging__section-label staging__section-label--conflict">
                {t("staging.conflicts")} {"\u00B7"} {t("fileCount", {ns: "common", count: conflictedFiles.length})}
              </span>
            </div>
            {conflictedFiles.map(f => (
              <div key={f.path} className="staging__row-anim">
                <div
                  className={`staging__conflict-row ${selectedFile === f.path ? "staging__conflict-row--selected" : ""}`}
                  onClick={() => onFileSelect(f.path, false)}
                  onDoubleClick={() => onOpenMergeTool(f.path)}
                >
                  <span className="staging__conflict-badge">C</span>
                  <span className="staging__conflict-path">{f.path}</span>
                  <span className="staging__conflict-type">{f.conflictType.replace(/_/g, " ")}</span>
                  <div className="staging__conflict-actions" onClick={e => e.stopPropagation()}>
                    <button
                      className="staging__conflict-btn staging__conflict-btn--open"
                      title={t("staging.openInMergeTool")}
                      onClick={() => onOpenMergeTool(f.path)}
                    >
                      {t("actions.open", {ns: "common"})}
                    </button>
                    <button
                      className="staging__conflict-btn staging__conflict-btn--ours"
                      title={t("staging.acceptOurs")}
                      onClick={() => onConflictAcceptOurs(f.path)}
                    >
                      {t("staging.ours")}
                    </button>
                    <button
                      className="staging__conflict-btn staging__conflict-btn--theirs"
                      title={t("staging.acceptTheirs")}
                      onClick={() => onConflictAcceptTheirs(f.path)}
                    >
                      {t("staging.theirs")}
                    </button>
                    <button
                      className="staging__conflict-btn staging__conflict-btn--resolve"
                      title={t("staging.markResolved")}
                      onClick={() => onStageFile(f.path)}
                    >
                      {t("staging.resolve")}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Staged section */}
        <div className="staging__section">
          <div className="staging__section-header">
            <span className="staging__section-label">
              {t("staging.staged")} {"\u00B7"} {t("fileCount", {ns: "common", count: stagedFiles.length})}
            </span>
            {stagedFiles.length > 0 && (
              <div className="staging__section-actions">
                <button
                  className="staging__section-action staging__section-action--muted"
                  onClick={handleUnstageSelected}
                  disabled={selectedStagedPaths.length === 0}
                >
                  {t("staging.unstageSelected")}
                </button>
                <button className="staging__section-action staging__section-action--muted" onClick={onUnstageAll}>
                  {t("staging.unstageAll")}
                </button>
              </div>
            )}
          </div>
          {mergedStaged.length === 0 ? (
            <div className="staging__empty">{t("staging.noStagedChanges")}</div>
          ) : (
            mergedStaged.map(f => (
              <div key={f.path} className="staging__row-anim">
                <FileRow
                  file={f}
                  isStaged
                  isSelected={selectedFile === f.path}
                  checked={selectedStaged[f.path] ?? false}
                  onToggleChecked={() => toggleStaged(f.path)}
                  onSelect={() => onFileSelect(f.path, true)}
                  onDoubleClick={() => onExternalDiff(f.path, true)}
                  onUnstage={() => onUnstageFile(f.path)}
                />
              </div>
            ))
          )}
        </div>

        {/* Unstaged section */}
        <div className="staging__section">
          <div className="staging__section-header">
            <span className="staging__section-label">
              {t("staging.unstaged")} {"\u00B7"} {t("fileCount", {ns: "common", count: allUnstaged.length})}
            </span>
            {allUnstaged.length > 0 && (
              <div className="staging__section-actions">
                <button
                  className="staging__section-action staging__section-action--danger"
                  onClick={() => onDiscardFiles(selectedUnstagedPaths)}
                  disabled={selectedUnstagedPaths.length === 0}
                >
                  {t("staging.revertSelected")}
                </button>
                <button
                  className="staging__section-action staging__section-action--danger"
                  onClick={() => onDiscardAll(allUnstaged.map(f => f.path))}
                >
                  {t("staging.revertAll")}
                </button>
                <button
                  className="staging__section-action staging__section-action--accent"
                  onClick={handleStageSelected}
                  disabled={selectedUnstagedPaths.length === 0}
                >
                  {t("staging.stageSelected")}
                </button>
                <button className="staging__section-action staging__section-action--accent" onClick={onStageAll}>
                  {t("staging.stageAll")}
                </button>
              </div>
            )}
          </div>
          {allUnstaged.length === 0 ? (
            <div className="staging__empty">{t("staging.workingTreeClean")}</div>
          ) : (
            allUnstaged.map(f => (
              <div key={f.path} className="staging__row-anim">
                <FileRow
                  file={f}
                  isStaged={false}
                  isSelected={selectedFile === f.path}
                  checked={selectedUnstaged[f.path] ?? false}
                  onToggleChecked={() => toggleUnstaged(f.path)}
                  onSelect={() => onFileSelect(f.path, false)}
                  onDoubleClick={() => onExternalDiff(f.path, false)}
                  onStage={() => onStageFile(f.path)}
                  onDiscard={() => onDiscardFile(f.path)}
                />
              </div>
            ))
          )}
        </div>
      </div>

      <CommitBox
        stagedCount={stagedFiles.length}
        selectedAction={selectedCommitAction}
        commitMessageRecommendedLength={commitMessageRecommendedLength}
        allowCommitAndPush={allowCommitAndPush}
        onSelectAction={onSelectCommitAction}
        onCommit={onCommit}
        isCommitting={isCommitting}
        lastCommitMessage={lastCommitMessage}
        mergeMessage={mergeMessage}
        mergeInProgress={mergeInProgress}
        rebaseInProgress={rebaseInProgress}
        cherryPickInProgress={cherryPickInProgress}
      />
    </div>
  );
}
