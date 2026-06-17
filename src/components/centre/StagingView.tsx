import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileRow } from "./FileRow";
import { CommitBox } from "./CommitBox";
import type { CommitPrimaryAction, ConflictFileItem, FileStatusItem, RowStriping, SubmoduleStatus } from "../../types";
import { getNumstat } from "../../api/commands";
import { buildFileTree, descendantFilePaths, type FileTreeDirectoryNode, type FileTreeNode } from "../../utils/fileTree";
import { ChevDownIcon, ChevRightIcon, FolderIcon } from "../icons";

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
  selectedUnstaged: Record<string, boolean>;
  selectedStaged: Record<string, boolean>;
  onSelectedUnstagedChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onSelectedStagedChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
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
  rowStriping: RowStriping;
};

type CachedNumstat = {
  additions: number;
  deletions: number;
  updatedAt: number;
};

type TreeSection = "staged" | "unstaged";

type VisibleTreeRow =
  | { type: "directory"; node: FileTreeDirectoryNode; depth: number }
  | { type: "file"; node: Extract<FileTreeNode, { type: "file" }>; depth: number };

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

function folderStateKey(section: TreeSection, path: string): string {
  return `${section}:${path}`;
}

function visibleTreeRows(
  nodes: FileTreeNode[],
  section: TreeSection,
  expandedFolders: Record<string, boolean>,
  depth = 0,
): VisibleTreeRow[] {
  return nodes.flatMap((node): VisibleTreeRow[] => {
    if (node.type === "file") {
      return [{ type: "file", node, depth }];
    }

    const expanded = expandedFolders[folderStateKey(section, node.path)] ?? true;
    const children = expanded ? visibleTreeRows(node.children, section, expandedFolders, depth + 1) : [];
    return [{ type: "directory", node, depth }, ...children];
  });
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : "-";
}

type SubmoduleRowProps = {
  submodule: SubmoduleStatus;
  selected: boolean;
  striped?: "Subtle" | "Strong";
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
  striped,
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
  const stripingClass = striped ? ` submodule-row--striped-${striped.toLowerCase()}` : "";

  return (
    <div
      className={`submodule-row${stripingClass} ${selected ? "submodule-row--selected" : ""}`}
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

type DirectoryRowProps = {
  directory: FileTreeDirectoryNode;
  depth: number;
  expanded: boolean;
  checked: boolean;
  indeterminate: boolean;
  striped?: "Subtle" | "Strong";
  onToggleExpanded: () => void;
  onToggleChecked: () => void;
};

function DirectoryRow({
  directory,
  depth,
  expanded,
  checked,
  indeterminate,
  striped,
  onToggleExpanded,
  onToggleChecked,
}: DirectoryRowProps) {
  const { t } = useTranslation("centre");
  const checkRef = React.useRef<HTMLInputElement>(null);
  const stripingClass = striped ? ` staging__folder-row--striped-${striped.toLowerCase()}` : "";

  useEffect(() => {
    if (checkRef.current) {
      checkRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <div
      className={`staging__folder-row${stripingClass}`}
      style={depth > 0 ? { paddingLeft: 8 + depth * 18 } : undefined}
      title={directory.path}
    >
      <input
        ref={checkRef}
        className="file-row__check"
        type="checkbox"
        checked={checked}
        aria-label={t(checked ? "staging.deselectFolderFiles" : "staging.selectFolderFiles", {
          path: directory.path,
        })}
        onChange={(e) => {
          e.stopPropagation();
          onToggleChecked();
        }}
        onClick={e => e.stopPropagation()}
      />
      <button
        className="staging__folder-toggle"
        type="button"
        aria-label={t(expanded ? "staging.collapseFolder" : "staging.expandFolder", {
          path: directory.path,
        })}
        onClick={onToggleExpanded}
      >
        {expanded ? <ChevDownIcon size={13} /> : <ChevRightIcon size={13} />}
      </button>
      <span className="staging__folder-icon">
        <FolderIcon size={15} />
      </span>
      <span className="staging__folder-name">{directory.name}</span>
      <span className="staging__folder-count">{t("fileCount", { ns: "common", count: directory.fileCount })}</span>
      <span className="file-row__stats">
        {directory.additions > 0 && (
          <span className="file-row__stat-add">+{directory.additions}</span>
        )}
        {directory.deletions > 0 && (
          <span className="file-row__stat-del">-{directory.deletions}</span>
        )}
      </span>
    </div>
  );
}

export function StagingView({
  repoPath,
  stagedFiles, unstagedFiles, unversionedFiles, submodules, conflictedFiles, mergeInProgress, mergeMessage, rebaseInProgress, cherryPickInProgress,
  selectedFile, selectedSubmodulePath, selectedUnstaged, selectedStaged, onSelectedUnstagedChange, onSelectedStagedChange,
  onFileSelect, onSubmoduleSelect, onSubmoduleInit, onSubmoduleUpdate, onSubmoduleSync,
  onSubmoduleFetch, onSubmodulePull, onSubmoduleOpen, onStageFile, onStageFiles, onUnstageFile, onUnstageFiles,
  onDiscardFile, onDiscardFiles, onDiscardAll, onExternalDiff, onStageAll, onUnstageAll,
  selectedCommitAction, commitMessageRecommendedLength, allowCommitAndPush, onSelectCommitAction, onCommit,
  onConflictAcceptTheirs, onConflictAcceptOurs, onOpenMergeTool,
  isCommitting, lastCommitMessage, rowStriping,
}: StagingViewProps) {
  const { t } = useTranslation("centre");
  const [numstatCache, setNumstatCache] = useState<Record<string, CachedNumstat>>({});
  const [numstatLoading, setNumstatLoading] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setNumstatCache({});
    setNumstatLoading({});
    setExpandedFolders({});
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

  const allUnstaged: FileStatusItem[] = useMemo(
    () => [
      ...mergedUnstaged,
      ...unversionedFiles.map(path => ({ path, status: "new", additions: null, deletions: null })),
    ],
    [mergedUnstaged, unversionedFiles],
  );

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
  const stagedTree = useMemo(() => buildFileTree(mergedStaged), [mergedStaged]);
  const unstagedTree = useMemo(() => buildFileTree(allUnstaged), [allUnstaged]);
  const stagedTreeRows = useMemo(
    () => visibleTreeRows(stagedTree, "staged", expandedFolders),
    [stagedTree, expandedFolders],
  );
  const unstagedTreeRows = useMemo(
    () => visibleTreeRows(unstagedTree, "unstaged", expandedFolders),
    [unstagedTree, expandedFolders],
  );

  const toggleUnstaged = (path: string) => {
    onSelectedUnstagedChange(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleStaged = (path: string) => {
    onSelectedStagedChange(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const handleStageSelected = () => {
    if (selectedUnstagedPaths.length === 0) return;
    onStageFiles(selectedUnstagedPaths);
    onSelectedUnstagedChange({});
  };

  const handleUnstageSelected = () => {
    if (selectedStagedPaths.length === 0) return;
    onUnstageFiles(selectedStagedPaths);
    onSelectedStagedChange({});
  };
  const toggleFolderExpanded = (section: TreeSection, path: string) => {
    const key = folderStateKey(section, path);
    setExpandedFolders(prev => ({ ...prev, [key]: !(prev[key] ?? true) }));
  };
  const striped = (index: number): "Subtle" | "Strong" | undefined => {
    if (rowStriping === "Off" || index % 2 === 0) return undefined;
    return rowStriping;
  };
  const renderTreeRow = (row: VisibleTreeRow, index: number, section: TreeSection) => {
    const isStaged = section === "staged";
    const selectedMap = isStaged ? selectedStaged : selectedUnstaged;
    const onSelectedChange = isStaged ? onSelectedStagedChange : onSelectedUnstagedChange;

    if (row.type === "directory") {
      const paths = descendantFilePaths(row.node);
      const checked = paths.length > 0 && paths.every(path => selectedMap[path]);
      const someChecked = paths.some(path => selectedMap[path]);
      return (
        <div key={`${section}:${row.node.path}`} className="staging__row-anim">
          <DirectoryRow
            directory={row.node}
            depth={row.depth}
            expanded={expandedFolders[folderStateKey(section, row.node.path)] ?? true}
            checked={checked}
            indeterminate={!checked && someChecked}
            striped={striped(index)}
            onToggleExpanded={() => toggleFolderExpanded(section, row.node.path)}
            onToggleChecked={() => {
              onSelectedChange(prev => {
                const next = { ...prev };
                for (const path of paths) {
                  if (checked) {
                    delete next[path];
                  } else {
                    next[path] = true;
                  }
                }
                return next;
              });
            }}
          />
        </div>
      );
    }

    const f = row.node.file;
    return (
      <div key={`${section}:${f.path}`} className="staging__row-anim">
        <FileRow
          file={f}
          isStaged={isStaged}
          isSelected={selectedFile === f.path}
          striped={striped(index)}
          checked={selectedMap[f.path] ?? false}
          displayPath={row.depth > 0 ? row.node.name : undefined}
          titlePath={row.depth > 0 ? f.path : undefined}
          depth={row.depth}
          onToggleChecked={() => isStaged ? toggleStaged(f.path) : toggleUnstaged(f.path)}
          onSelect={() => onFileSelect(f.path, isStaged)}
          onDoubleClick={() => onExternalDiff(f.path, isStaged)}
          onStage={isStaged ? undefined : () => onStageFile(f.path)}
          onUnstage={isStaged ? () => onUnstageFile(f.path) : undefined}
          onDiscard={isStaged ? undefined : () => onDiscardFile(f.path)}
        />
      </div>
    );
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
            {submodules.map((submodule, index) => (
              <div key={submodule.path} className="staging__row-anim">
                <SubmoduleRow
                  submodule={submodule}
                  selected={selectedSubmodulePath === submodule.path}
                  striped={striped(index)}
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
            {conflictedFiles.map((f, index) => {
              const rowStripe = striped(index);
              return (
              <div key={f.path} className="staging__row-anim">
                <div
                  className={`staging__conflict-row${rowStripe ? ` staging__conflict-row--striped-${rowStripe.toLowerCase()}` : ""} ${selectedFile === f.path ? "staging__conflict-row--selected" : ""}`}
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
              );
            })}
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
            stagedTreeRows.map((row, index) => renderTreeRow(row, index, "staged"))
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
            unstagedTreeRows.map((row, index) => renderTreeRow(row, index, "unstaged"))
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
