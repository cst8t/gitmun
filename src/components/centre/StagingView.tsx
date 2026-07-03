import React, { useEffect, useMemo, useState } from "react";
import { Virtuoso } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { FileRow } from "./FileRow";
import { CommitBox } from "./CommitBox";
import type {
  CommitPrimaryAction,
  ConflictFileItem,
  FileStatusItem,
  OperationFeedbackContent,
  RowStriping,
  StagingOperation,
  SubmoduleStatus,
  UnversionedItem,
} from "../../types";
import { getNumstat } from "../../api/commands";
import { buildFileTree, descendantFilePaths, type FileTreeDirectoryNode, type FileTreeNode } from "../../utils/fileTree";
import { ChevDownIcon, ChevRightIcon, FolderIcon } from "../icons";

type StagingViewProps = {
  repoPath: string | null;
  stagedFiles: FileStatusItem[];
  unstagedFiles: FileStatusItem[];
  unversionedFiles: string[];
  unversionedItems?: UnversionedItem[];
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
  stagingOperation: StagingOperation | null;
  inlineOperation: OperationFeedbackContent | null;
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
  | { type: "directory"; node: FileTreeDirectoryNode; depth: number; expanded: boolean }
  | { type: "file"; node: Extract<FileTreeNode, { type: "file" }>; depth: number; fileIndex: number };

type StagingListRow =
  | { type: "section"; key: string; section: "submodules" | "conflicts" | TreeSection }
  | { type: "submodule"; key: string; submodule: SubmoduleStatus; index: number }
  | { type: "conflict"; key: string; file: ConflictFileItem; index: number }
  | { type: "tree"; key: string; section: TreeSection; row: VisibleTreeRow }
  | { type: "empty"; key: string; section: TreeSection };

const NUMSTAT_REFRESH_MS = 7000;
const NUMSTAT_BATCH_SIZE = 6;
const AUTO_COLLAPSE_SECTION_THRESHOLD = 500;
const AUTO_COLLAPSE_DIRECTORY_THRESHOLD = 100;

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

function defaultDirectoryExpanded(node: FileTreeDirectoryNode, depth: number, totalFiles: number): boolean {
  if (totalFiles <= AUTO_COLLAPSE_SECTION_THRESHOLD) return true;
  return depth > 0 && node.fileCount < AUTO_COLLAPSE_DIRECTORY_THRESHOLD;
}

function isDirectoryExpanded(
  section: TreeSection,
  node: FileTreeDirectoryNode,
  depth: number,
  totalFiles: number,
  expandedFolders: Record<string, boolean>,
): boolean {
  const key = folderStateKey(section, node.path);
  return expandedFolders[key] ?? defaultDirectoryExpanded(node, depth, totalFiles);
}

function visibleTreeRows(
  nodes: FileTreeNode[],
  section: TreeSection,
  expandedFolders: Record<string, boolean>,
  totalFiles: number,
): VisibleTreeRow[] {
  let fileIndex = 0;

  const visit = (currentNodes: FileTreeNode[], depth: number): VisibleTreeRow[] =>
    currentNodes.flatMap((node): VisibleTreeRow[] => {
      if (node.type === "file") {
        const row = { type: "file" as const, node, depth, fileIndex };
        fileIndex += 1;
        return [row];
      }

      const expanded = node.children.length > 0 && isDirectoryExpanded(section, node, depth, totalFiles, expandedFolders);
      const children = expanded ? visit(node.children, depth + 1) : [];
      return [{ type: "directory", node, depth, expanded }, ...children];
    });

  return visit(nodes, 0);
}

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 8) : "-";
}

function OperationInlineFeedback({ operation }: { operation: OperationFeedbackContent }) {
  return (
    <div className="staging__operation-inline" aria-live="polite">
      <div className="staging__operation-spinner" aria-hidden="true" />
      <div className="staging__operation-copy">
        <div className="staging__operation-title">{operation.title}</div>
        <div className="staging__operation-message">{operation.message}</div>
      </div>
    </div>
  );
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
  disabled: boolean;
  onToggleExpanded: () => void;
  onToggleChecked: () => void;
};

function DirectoryRow({
  directory,
  depth,
  expanded,
  checked,
  indeterminate,
  disabled,
  onToggleExpanded,
  onToggleChecked,
}: DirectoryRowProps) {
  const { t } = useTranslation("centre");
  const checkRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (checkRef.current) {
      checkRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);

  return (
    <div
      className="staging__folder-row"
      style={depth > 0 ? { paddingLeft: 8 + depth * 18 } : undefined}
      title={directory.path}
    >
      <input
        ref={checkRef}
        className="file-row__check"
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={t(checked ? "staging.deselectFolderFiles" : "staging.selectFolderFiles", {
          path: directory.path,
        })}
        onChange={(e) => {
          e.stopPropagation();
          if (disabled) return;
          onToggleChecked();
        }}
        onClick={e => e.stopPropagation()}
      />
      {directory.children.length > 0 && (
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
      )}
      <span className="staging__folder-icon">
        <FolderIcon size={15} />
      </span>
      {directory.status === "new" && <span className="file-row__badge file-row__badge--new">A</span>}
      <span className="staging__folder-name">{directory.name}</span>
      <span className="staging__folder-count">
        {directory.selectablePath && directory.children.length === 0
          ? t("staging.untrackedDirectory")
          : t("fileCount", { ns: "common", count: directory.fileCount })}
      </span>
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
  stagedFiles, unstagedFiles, unversionedFiles, unversionedItems, submodules, conflictedFiles, mergeInProgress, mergeMessage, rebaseInProgress, cherryPickInProgress,
  selectedFile, selectedSubmodulePath, selectedUnstaged, selectedStaged, onSelectedUnstagedChange, onSelectedStagedChange,
  onFileSelect, onSubmoduleSelect, onSubmoduleInit, onSubmoduleUpdate, onSubmoduleSync,
  onSubmoduleFetch, onSubmodulePull, onSubmoduleOpen, onStageFile, onStageFiles, onUnstageFile, onUnstageFiles,
  onDiscardFile, onDiscardFiles, onDiscardAll, onExternalDiff, onStageAll, onUnstageAll,
  selectedCommitAction, commitMessageRecommendedLength, allowCommitAndPush, onSelectCommitAction, onCommit,
  onConflictAcceptTheirs, onConflictAcceptOurs, onOpenMergeTool,
  stagingOperation, inlineOperation, isCommitting, lastCommitMessage, rowStriping,
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
      ...(unversionedItems ?? unversionedFiles.map(path => ({ path, kind: "file" as const })))
        .map(item => ({ path: item.path, kind: item.kind, status: "new", additions: null, deletions: null })),
    ],
    [mergedUnstaged, unversionedFiles, unversionedItems],
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
    () => visibleTreeRows(stagedTree, "staged", expandedFolders, mergedStaged.length),
    [stagedTree, expandedFolders, mergedStaged.length],
  );
  const unstagedTreeRows = useMemo(
    () => visibleTreeRows(unstagedTree, "unstaged", expandedFolders, allUnstaged.length),
    [unstagedTree, expandedFolders, allUnstaged.length],
  );
  const stagingBusy = stagingOperation != null;
  const inlineOperationIsCommit = inlineOperation?.kind === "commit" || inlineOperation?.kind === "commitAndPush";

  const toggleUnstaged = (path: string) => {
    if (stagingBusy) return;
    onSelectedUnstagedChange(prev => ({ ...prev, [path]: !prev[path] }));
  };

  const toggleStaged = (path: string) => {
    if (stagingBusy) return;
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
    setExpandedFolders(prev => {
      const treeRows = section === "staged" ? stagedTreeRows : unstagedTreeRows;
      const currentRow = treeRows.find(row => row.type === "directory" && row.node.path === path);
      const currentExpanded = currentRow?.type === "directory"
        ? currentRow.expanded
        : prev[key] ?? true;
      return { ...prev, [key]: !currentExpanded };
    });
  };
  const striped = (index: number): "Subtle" | "Strong" | undefined => {
    if (rowStriping === "Off" || index % 2 === 0) return undefined;
    return rowStriping;
  };
  const renderTreeRow = (row: VisibleTreeRow, section: TreeSection) => {
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
            expanded={row.expanded}
            checked={checked}
            indeterminate={!checked && someChecked}
            disabled={stagingBusy}
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
          striped={striped(row.fileIndex)}
          checked={selectedMap[f.path] ?? false}
          selectionDisabled={stagingBusy}
          displayPath={row.depth > 0 ? row.node.name : undefined}
          titlePath={row.depth > 0 ? f.path : undefined}
          depth={row.depth}
          onToggleChecked={() => isStaged ? toggleStaged(f.path) : toggleUnstaged(f.path)}
          onSelect={() => onFileSelect(f.path, isStaged)}
          onDoubleClick={() => onExternalDiff(f.path, isStaged)}
          onStage={isStaged ? undefined : () => onStageFile(f.path)}
          onUnstage={isStaged ? () => onUnstageFile(f.path) : undefined}
          onDiscard={isStaged ? undefined : () => onDiscardFile(f.path)}
          actionDisabled={stagingBusy}
        />
      </div>
    );
  };

  const stagingRows = useMemo<StagingListRow[]>(() => {
    const rows: StagingListRow[] = [];

    if (submodules.length > 0) {
      rows.push({ type: "section", key: "section:submodules", section: "submodules" });
      rows.push(...submodules.map((submodule, index) => ({
        type: "submodule" as const,
        key: `submodule:${submodule.path}`,
        submodule,
        index,
      })));
    }

    if ((mergeInProgress || rebaseInProgress || cherryPickInProgress) && conflictedFiles.length > 0) {
      rows.push({ type: "section", key: "section:conflicts", section: "conflicts" });
      rows.push(...conflictedFiles.map((file, index) => ({
        type: "conflict" as const,
        key: `conflict:${file.path}`,
        file,
        index,
      })));
    }

    rows.push({ type: "section", key: "section:staged", section: "staged" });
    if (mergedStaged.length === 0) {
      rows.push({ type: "empty", key: "empty:staged", section: "staged" });
    } else {
      rows.push(...stagedTreeRows.map(row => ({
        type: "tree" as const,
        key: row.type === "directory" ? `staged:directory:${row.node.path}` : `staged:file:${row.node.path}`,
        section: "staged" as const,
        row,
      })));
    }

    rows.push({ type: "section", key: "section:unstaged", section: "unstaged" });
    if (allUnstaged.length === 0) {
      rows.push({ type: "empty", key: "empty:unstaged", section: "unstaged" });
    } else {
      rows.push(...unstagedTreeRows.map(row => ({
        type: "tree" as const,
        key: row.type === "directory" ? `unstaged:directory:${row.node.path}` : `unstaged:file:${row.node.path}`,
        section: "unstaged" as const,
        row,
      })));
    }

    return rows;
  }, [
    allUnstaged.length,
    cherryPickInProgress,
    conflictedFiles,
    mergeInProgress,
    mergedStaged.length,
    rebaseInProgress,
    stagedTreeRows,
    submodules,
    unstagedTreeRows,
  ]);

  const renderSectionHeader = (section: StagingListRow & { type: "section" }) => {
    if (section.section === "submodules") {
      return (
        <div className="staging__section staging__section--virtual">
          <div className="staging__section-header">
            <span className="staging__section-label">
              {t("staging.submodules")} {"\u00B7"} {submodules.length}
            </span>
          </div>
        </div>
      );
    }

    if (section.section === "conflicts") {
      return (
        <div className="staging__section staging__section--virtual">
          <div className="staging__section-header">
            <span className="staging__section-label staging__section-label--conflict">
              {t("staging.conflicts")} {"\u00B7"} {t("fileCount", {ns: "common", count: conflictedFiles.length})}
            </span>
          </div>
        </div>
      );
    }

    const isStaged = section.section === "staged";
    const count = isStaged ? stagedFiles.length : allUnstaged.length;
    const selectedPaths = isStaged ? selectedStagedPaths : selectedUnstagedPaths;

    return (
      <div className="staging__section staging__section--virtual">
        <div className="staging__section-header">
          <span className="staging__section-label">
            {t(isStaged ? "staging.staged" : "staging.unstaged")} {"\u00B7"} {t("fileCount", {ns: "common", count})}
          </span>
          {count > 0 && (
            <div className="staging__section-actions">
              {isStaged ? (
                <>
                  <button
                    className="staging__section-action staging__section-action--muted"
                    onClick={handleUnstageSelected}
                    disabled={selectedPaths.length === 0 || stagingBusy}
                  >
                    {t("staging.unstageSelected")}
                  </button>
                  <button className="staging__section-action staging__section-action--muted" onClick={onUnstageAll} disabled={stagingBusy}>
                    {t("staging.unstageAll")}
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="staging__section-action staging__section-action--danger"
                    onClick={() => onDiscardFiles(selectedUnstagedPaths)}
                    disabled={selectedUnstagedPaths.length === 0 || stagingBusy}
                  >
                    {t("staging.revertSelected")}
                  </button>
                  <button
                    className="staging__section-action staging__section-action--danger"
                    onClick={() => onDiscardAll(allUnstaged.map(f => f.path))}
                    disabled={stagingBusy}
                  >
                    {t("staging.revertAll")}
                  </button>
                  <button
                    className="staging__section-action staging__section-action--accent"
                    onClick={handleStageSelected}
                    disabled={selectedUnstagedPaths.length === 0 || stagingBusy}
                  >
                    {t("staging.stageSelected")}
                  </button>
                  <button className="staging__section-action staging__section-action--accent" onClick={onStageAll} disabled={stagingBusy}>
                    {t("staging.stageAll")}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderConflictRow = (file: ConflictFileItem, index: number) => {
    const rowStripe = striped(index);
    return (
      <div className="staging__list-row">
        <div className="staging__row-anim">
          <div
            className={`staging__conflict-row${rowStripe ? ` staging__conflict-row--striped-${rowStripe.toLowerCase()}` : ""} ${selectedFile === file.path ? "staging__conflict-row--selected" : ""}`}
            onClick={() => onFileSelect(file.path, false)}
            onDoubleClick={() => onOpenMergeTool(file.path)}
          >
            <span className="staging__conflict-badge">C</span>
            <span className="staging__conflict-path">{file.path}</span>
            <span className="staging__conflict-type">{file.conflictType.replace(/_/g, " ")}</span>
            <div className="staging__conflict-actions" onClick={e => e.stopPropagation()}>
              <button
                className="staging__conflict-btn staging__conflict-btn--open"
                title={t("staging.openInMergeTool")}
                onClick={() => onOpenMergeTool(file.path)}
              >
                {t("actions.open", {ns: "common"})}
              </button>
              <button
                className="staging__conflict-btn staging__conflict-btn--ours"
                title={t("staging.acceptOurs")}
                onClick={() => onConflictAcceptOurs(file.path)}
              >
                {t("staging.ours")}
              </button>
              <button
                className="staging__conflict-btn staging__conflict-btn--theirs"
                title={t("staging.acceptTheirs")}
                onClick={() => onConflictAcceptTheirs(file.path)}
              >
                {t("staging.theirs")}
              </button>
              <button
                className="staging__conflict-btn staging__conflict-btn--resolve"
                title={t("staging.markResolved")}
                onClick={() => onStageFile(file.path)}
              >
                {t("staging.resolve")}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderStagingRow = (_index: number, row: StagingListRow) => {
    switch (row.type) {
      case "section":
        return renderSectionHeader(row);
      case "submodule":
        return (
          <div className="staging__list-row">
            <div className="staging__row-anim">
              <SubmoduleRow
                submodule={row.submodule}
                selected={selectedSubmodulePath === row.submodule.path}
                striped={striped(row.index)}
                onSelect={() => onSubmoduleSelect(row.submodule.path)}
                onInit={() => onSubmoduleInit(row.submodule.path)}
                onUpdate={() => onSubmoduleUpdate(row.submodule.path)}
                onSync={() => onSubmoduleSync(row.submodule.path)}
                onFetch={() => onSubmoduleFetch(row.submodule.path)}
                onPull={() => onSubmodulePull(row.submodule.path)}
                onOpen={() => onSubmoduleOpen(row.submodule.path)}
              />
            </div>
          </div>
        );
      case "conflict":
        return renderConflictRow(row.file, row.index);
      case "tree":
        return <div className="staging__list-row">{renderTreeRow(row.row, row.section)}</div>;
      case "empty":
        return (
          <div className="staging__list-row">
            <div className="staging__empty">
              {t(row.section === "staged" ? "staging.noStagedChanges" : "staging.workingTreeClean")}
            </div>
          </div>
        );
    }
  };

  return (
    <div className="staging">
      {inlineOperation && !inlineOperationIsCommit && <OperationInlineFeedback operation={inlineOperation} />}
      <div className="staging__files">
        <Virtuoso
          className="staging__virtual-list"
          style={{ height: "100%" }}
          data={stagingRows}
          computeItemKey={(_index, row) => row.key}
          itemContent={renderStagingRow}
        />
      </div>

      {inlineOperation && inlineOperationIsCommit && <OperationInlineFeedback operation={inlineOperation} />}
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
