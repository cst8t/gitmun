import React, { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Virtuoso } from "react-virtuoso";
import { useTranslation } from "react-i18next";
import { FileRow } from "./FileRow";
import { CommitBox } from "./CommitBox";
import type {
  CommitHookRejection,
  CommitPrimaryAction,
  CommitProgressState,
  ConflictFileItem,
  FileStatusItem,
  OperationFeedbackContent,
  RowStriping,
  StagingOperation,
  SubmoduleOperationState,
  SubmoduleRemotePreview,
  SubmoduleStatus,
  UnversionedItem,
} from "../../types";
import { getNumstat, openSettingsWindow } from "../../api/commands";
import { buildFileTree, descendantFilePaths, type FileTreeDirectoryNode, type VisibleFileTreeRow, visibleFileTreeRows } from "../../utils/fileTree";
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
  revertInProgress: boolean;
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
  submoduleOperations?: Record<string, SubmoduleOperationState>;
  submoduleBusy?: boolean;
  recursiveSubmodules?: boolean;
  onRecursiveSubmodulesChange?: (recursive: boolean) => void;
  onSubmodulePrepareRemote?: (path: string) => void;
  onSubmoduleApplyRemote?: (path: string, recursive: boolean) => void;
  remoteUpdatePreview?: SubmoduleRemotePreview | null;
  onRemoteUpdatePreviewClose?: () => void;
  onDismissSubmoduleFeedback?: (path: string) => void;
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
  onCommit: (message: string, amend: boolean, action: CommitPrimaryAction) => boolean | Promise<boolean>;
  onConflictAcceptTheirs: (path: string) => void;
  onConflictAcceptOurs: (path: string) => void;
  onConflictResolveWithAi: (path: string) => void;
  getAiConflictEligibility?: (path: string) => Promise<{eligible: boolean; reason: string | null}>;
  onConflictResolveAllWithAi: (paths: string[]) => void;
  onCancelAiConflict: () => void;
  onOpenMergeTool: (path: string) => void;
  stagingOperation: StagingOperation | null;
  inlineOperation: OperationFeedbackContent | null;
  commitProgress?: CommitProgressState | null;
  hookRejection?: CommitHookRejection | null;
  onHookRejectionClose?: () => void;
  onHookRejectionBypass?: () => void;
  isCommitting: boolean;
  lastCommitMessage: string;
  rowStriping: RowStriping;
  aiEnabled: boolean;
  aiConfigured: boolean;
  aiResolvingPath: string | null;
  aiConflictOperationId: string | null;
  aiConflictBatchProgress: {current: number; total: number; preparing: boolean} | null;
  aiConflictBatchFailure: {filePath: string; message: string} | null;
  onSkipAiConflictBatchFailure: () => void;
  onStopAiConflictBatchFailure: () => void;
};

type CachedNumstat = {
  additions: number;
  deletions: number;
  updatedAt: number;
  failed?: boolean;
};

type TreeSection = "staged" | "unstaged";

type StagingListRow =
  | { type: "section"; key: string; section: "submodules" | "conflicts" | TreeSection }
  | { type: "submodule"; key: string; submodule: SubmoduleStatus; index: number }
  | { type: "conflict"; key: string; file: ConflictFileItem; index: number }
  | { type: "tree"; key: string; section: TreeSection; row: VisibleFileTreeRow }
  | { type: "empty"; key: string; section: TreeSection };

const NUMSTAT_REFRESH_MS = 7000;
const NUMSTAT_BATCH_SIZE = 6;
const NUMSTAT_FAILURE_BACKOFF_MS = 3000;

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

function shortHash(hash: string | null): string {
  return hash ? hash.slice(0, 7) : "-";
}

function OperationInlineFeedback({
  title,
  message,
  action,
}: Pick<OperationFeedbackContent, "title" | "message"> & {action?: React.ReactNode}) {
  return (
    <div className="staging__operation-inline" role="status" aria-live="polite">
      <div className="staging__operation-spinner" aria-hidden="true" />
      <div className="staging__operation-copy">
        <div className="staging__operation-title">{title}</div>
        <div className="staging__operation-message">{message}</div>
      </div>
      {action}
    </div>
  );
}

function CommitHookProgress({progress}: {progress: NonNullable<StagingViewProps["commitProgress"]>}) {
  const { t } = useTranslation("centre");
  const [expanded, setExpanded] = useState(progress.expanded);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    setExpanded(progress.expanded);
  }, [progress.expanded]);

  useEffect(() => {
    const update = () => setElapsedSeconds(Math.floor((Date.now() - progress.startedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [progress.startedAt]);

  const title = progress.phase === "awaitingDecision"
    ? t("commitHooks.awaitingDecision")
    : progress.hookName
      ? t("commitHooks.runningHook", {hook: progress.hookName})
      : t("commitHooks.committing");

  return (
    <div className="staging__commit-progress" role="status" aria-live="polite">
      <div className="staging__operation-inline">
        {progress.phase === "running" ? <div className="staging__operation-spinner" aria-hidden="true" /> : <div className="staging__operation-failed" aria-hidden="true">!</div>}
        <div className="staging__operation-copy">
          <div className="staging__operation-title">{title}</div>
          <div className="staging__operation-message">{progress.phase === "running" ? t("commitHooks.elapsed", {seconds: elapsedSeconds}) : t("commitHooks.reviewFailure")}</div>
        </div>
        {progress.output && (
          <button
            type="button"
            className="staging__operation-cancel"
            aria-expanded={expanded}
            onClick={() => setExpanded(current => !current)}>
            {expanded ? t("commitHooks.hideOutput") : t("commitHooks.viewOutput")}
          </button>
        )}
      </div>
      {expanded && progress.output && (
        <pre className="staging__commit-output">{progress.output}{progress.outputTruncated ? `\n${t("commitHooks.outputTruncated")}` : ""}</pre>
      )}
    </div>
  );
}

function HookFailureDialog({
  rejection,
  onClose,
  onBypass,
}: {
  rejection: NonNullable<StagingViewProps["hookRejection"]>;
  onClose: () => void;
  onBypass: () => void;
}) {
  const { t } = useTranslation("centre");
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  return (
    <>
      <div className="dialog-backdrop" />
      <div className="dialog commit-hook-dialog" role="alertdialog" aria-modal="true" aria-labelledby="commit-hook-dialog-title">
        <div id="commit-hook-dialog-title" className="dialog__title">{t("commitHooks.failedTitle")}</div>
        <div className="commit-hook-dialog__summary">
          {t("commitHooks.failedDescription", {hook: rejection.hookName, exitStatus: rejection.exitStatus ?? t("commitHooks.unknownExitStatus")})}
        </div>
        {rejection.bypassSupported && <div className="commit-hook-dialog__warning">{t("commitHooks.bypassWarning")}</div>}
        {rejection.output && (
          <pre className="commit-hook-dialog__output">{rejection.output}{rejection.outputTruncated ? `\n${t("commitHooks.outputTruncated")}` : ""}</pre>
        )}
        <div className="dialog__actions">
          <button ref={closeButtonRef} type="button" className="dialog__btn dialog__btn--cancel" onClick={onClose}>
            {t("commitHooks.close")}
          </button>
          {rejection.bypassSupported && (
            <button type="button" className="dialog__btn dialog__btn--confirm" onClick={onBypass}>
              {t("commitHooks.commitWithoutHooks")}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

function AiConflictOperationFeedback({
  operationId,
  batchProgress,
  batchFailure,
  onCancel,
  onSkipFailure,
  onStopFailure,
}: {
  operationId: string;
  batchProgress: {current: number; total: number; preparing: boolean} | null;
  batchFailure: {filePath: string; message: string} | null;
  onCancel: () => void;
  onSkipFailure: () => void;
  onStopFailure: () => void;
}) {
  const { t: tAi } = useTranslation("ai");
  const [stage, setStage] = useState("collectingContext");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  useEffect(() => {
    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [operationId]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void listen<{operationId: string; stage: string}>("ai-operation-progress", event => {
      if (event.payload.operationId === operationId) setStage(event.payload.stage);
    }).then(remove => {
      if (cancelled) remove(); else unlisten = remove;
    }).catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [operationId]);

  return (
    <OperationInlineFeedback
      title={batchFailure
        ? tAi("conflict.batchFailureTitle")
        : batchProgress
        ? tAi(batchProgress.preparing ? "conflict.preparingBatch" : "conflict.generatingBatch", batchProgress)
        : tAi("conflict.generatingProposal")}
      message={batchFailure
        ? tAi("conflict.batchFailureMessage", {
          file: batchFailure.filePath,
          message: batchFailure.message,
        })
        : tAi("conflict.generationProgress", {
          stage: tAi(`progress.${stage}`),
          count: elapsedSeconds,
        })}
      action={batchFailure ? (
        <>
          <button className="staging__operation-cancel" type="button" onClick={onSkipFailure}>
            {tAi("actions.skipFailedAndContinue")}
          </button>
          <button className="staging__operation-cancel" type="button" onClick={onStopFailure}>
            {tAi("actions.stopBatch")}
          </button>
        </>
      ) : (
        <button
          className="staging__operation-cancel"
          type="button"
          title={tAi("conflict.cancelTitle")}
          onClick={onCancel}
        >
          {tAi(batchProgress ? "actions.cancelResolveAll" : "actions.cancelResolve")}
        </button>
      )}
    />
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
  onPrepareRemote?: () => void;
  operation?: SubmoduleOperationState;
  busy: boolean;
  onDismissFeedback?: () => void;
};

function SubmoduleOperationFeedback({
  operation,
  fallback,
  onDismiss,
}: {
  operation: SubmoduleOperationState;
  fallback: string | null;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation("centre");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const running = operation.phase === "running" || operation.phase === "refreshing";

  useEffect(() => {
    if (!running) return;
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - operation.startedAt) / 1000)));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [operation.startedAt, running]);

  return (
    <div
      className={`submodule-row__feedback submodule-row__feedback--${operation.phase}`}
      role="status"
      aria-live="polite"
      onClick={event => event.stopPropagation()}
    >
      {running && <span className="staging__operation-spinner" aria-hidden="true" />}
      <span>{operation.message ?? fallback}</span>
      {running && <span>{t("staging.submoduleElapsed", {seconds: elapsedSeconds})}</span>}
      {operation.phase === "error" && operation.error && (
        <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
          {t(expanded ? "staging.hideDiagnostic" : "staging.showDiagnostic")}
        </button>
      )}
      {operation.phase === "error" && onDismiss && (
        <button type="button" onClick={onDismiss}>{t("actions.dismiss", {ns: "common"})}</button>
      )}
      {expanded && operation.error && <pre className="submodule-row__diagnostic">{operation.error}</pre>}
    </div>
  );
}

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
  onPrepareRemote,
  operation,
  busy,
  onDismissFeedback,
}: SubmoduleRowProps) {
  const { t } = useTranslation("centre");
  const configured = Boolean(submodule.configuredUrl);
  const conflicted = submodule.state === "conflict";
  const canInit = configured && (!submodule.initialised || submodule.state === "missing" || submodule.state === "uninitialised");
  const canUpdate = configured && submodule.initialised && submodule.state !== "missing" && !submodule.dirty && !conflicted;
  const canSync = configured && submodule.syncRequired;
  const canFetch = configured && submodule.initialised;
  const canPull = configured && submodule.initialised && !submodule.dirty && !conflicted && !!submodule.currentBranch && !!submodule.upstreamBranch;
  const canOpen = submodule.initialised;
  const unavailable = (key: string) => t(`staging.submoduleUnavailable.${key}`);
  const pullReason = !configured
    ? unavailable("unconfigured")
    : submodule.dirty
      ? unavailable("dirty")
      : conflicted
        ? unavailable("conflict")
        : !submodule.currentBranch
          ? unavailable("detached")
          : !submodule.upstreamBranch
            ? unavailable("noUpstream")
            : unavailable("pull");
  const actionLabel = operation?.phase === "running" || operation?.phase === "refreshing"
    ? t(`staging.submoduleAction.${operation.action}`)
    : null;
  const disabledReason = (available: boolean, reason: string) => available ? undefined : reason;
  const buttonLabel = (action: SubmoduleOperationState["action"], fallback: string) => operation?.action === action && actionLabel
    ? <><span className="submodule-row__button-spinner staging__operation-spinner" aria-hidden="true" />{actionLabel}</>
    : fallback;
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
        <button type="button" disabled={busy || !canInit} title={disabledReason(canInit, configured ? unavailable("initialise") : unavailable("unconfigured"))} onClick={onInit}>{buttonLabel("initialise", t("actions.initialise", {ns: "common"}))}</button>
        <button type="button" disabled={busy || !canUpdate} title={canUpdate ? t("staging.checkoutRecordedHint") : disabledReason(false, submodule.dirty ? unavailable("dirty") : conflicted ? unavailable("conflict") : unavailable("checkout"))} onClick={onUpdate}>{buttonLabel("checkout", t("staging.checkoutRecorded"))}</button>
        <button type="button" disabled={busy || !canUpdate || !onPrepareRemote} title={canUpdate && onPrepareRemote ? t("staging.updateFromRemoteHint") : disabledReason(false, submodule.dirty ? unavailable("dirty") : unavailable("remote"))} onClick={onPrepareRemote}>{buttonLabel("prepareRemote", t("staging.updateFromRemote"))}</button>
        <button type="button" disabled={busy || !canSync} title={disabledReason(canSync, configured ? unavailable("sync") : unavailable("unconfigured"))} onClick={onSync}>{buttonLabel("sync", t("staging.syncUrl"))}</button>
        <button type="button" disabled={busy || !canFetch} title={disabledReason(canFetch, configured ? unavailable("fetch") : unavailable("unconfigured"))} onClick={onFetch}>{buttonLabel("fetch", t("actions.fetch", {ns: "common"}))}</button>
        <button type="button" disabled={busy || !canPull} title={canPull ? t("staging.pullHint") : pullReason} onClick={onPull}>{buttonLabel("pull", t("actions.pull", {ns: "common"}))}</button>
        <button type="button" disabled={busy || !canOpen} title={disabledReason(canOpen, unavailable("open"))} onClick={onOpen}>{buttonLabel("open", t("actions.open", {ns: "common"}))}</button>
      </div>
      {operation && <SubmoduleOperationFeedback operation={operation} fallback={actionLabel} onDismiss={onDismissFeedback} />}
    </div>
  );
}

function RemoteUpdatePreviewDialog({
  preview,
  busy,
  recursive,
  onRecursiveChange,
  operation,
  onApply,
  onClose,
}: {
  preview: NonNullable<StagingViewProps["remoteUpdatePreview"]>;
  busy: boolean;
  recursive: boolean;
  onRecursiveChange: (recursive: boolean) => void;
  operation?: SubmoduleOperationState;
  onApply: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("centre");
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);
  return <>
    <div className="dialog-backdrop" />
    <div ref={dialogRef} className="dialog submodule-update-dialog" role="dialog" aria-modal="true" aria-labelledby="submodule-update-dialog-title" tabIndex={-1} onKeyDown={event => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (!busy) onClose();
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
        event.preventDefault(); first.focus();
      }
    }}>
      <div id="submodule-update-dialog-title" className="dialog__title">{t("staging.remotePreviewTitle")}</div>
      <p className="submodule-update-dialog__description">{t("staging.remotePreviewDescription", {path: preview.path})}</p>
      <dl className="submodule-update-dialog__details">
        <div><dt>{t("staging.remote")}</dt><dd>{preview.remote}</dd></div>
        <div><dt>{t("staging.branch")}</dt><dd>{preview.branch}</dd></div>
        <div><dt>{t("staging.currentCommit")}</dt><dd>{shortHash(preview.currentCommit)}</dd></div>
        <div><dt>{t("staging.targetCommit")}</dt><dd>{shortHash(preview.targetCommit)}</dd></div>
      </dl>
      {preview.alreadyCheckedOut && <p className="submodule-update-dialog__notice">{t("staging.alreadyAtRemoteCommit")}</p>}
      {preview.willDetachHead && !preview.alreadyCheckedOut && <p className="submodule-update-dialog__notice">{t("staging.remoteUpdateDetaches")}</p>}
      <label className="staging__submodule-recursive submodule-update-dialog__nested">
        <input
          type="checkbox"
          checked={recursive}
          disabled={busy}
          onChange={event => onRecursiveChange(event.target.checked)}
        />
        {t("staging.includeNested")}
      </label>
      <p className="submodule-update-dialog__description">{t("staging.remoteNestedFollowsRecorded")}</p>
      {operation && <SubmoduleOperationFeedback operation={operation} fallback={null} />}
      <div className="dialog__actions">
        <button type="button" className="dialog__btn dialog__btn--cancel" disabled={busy} onClick={onClose}>{t("actions.cancel", {ns: "common"})}</button>
        <button type="button" className="dialog__btn dialog__btn--confirm" disabled={busy} onClick={onApply}>{busy ? <><span className="staging__operation-spinner" aria-hidden="true" />{t("staging.submoduleAction.applyRemote")}</> : t("staging.applyRemoteUpdate")}</button>
      </div>
    </div>
  </>;
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
  stagedFiles, unstagedFiles, unversionedFiles, unversionedItems, submodules, conflictedFiles, mergeInProgress, mergeMessage, rebaseInProgress, cherryPickInProgress, revertInProgress,
  selectedFile, selectedSubmodulePath, selectedUnstaged, selectedStaged, onSelectedUnstagedChange, onSelectedStagedChange,
  onFileSelect, onSubmoduleSelect, onSubmoduleInit, onSubmoduleUpdate, onSubmoduleSync,
  onSubmoduleFetch, onSubmodulePull, onSubmoduleOpen, onStageFile, onStageFiles, onUnstageFile, onUnstageFiles,
  onDiscardFile, onDiscardFiles, onDiscardAll, onExternalDiff, onStageAll, onUnstageAll,
  selectedCommitAction, commitMessageRecommendedLength, allowCommitAndPush, onSelectCommitAction, onCommit,
  onConflictAcceptTheirs, onConflictAcceptOurs, onConflictResolveWithAi, getAiConflictEligibility,
  onConflictResolveAllWithAi, onCancelAiConflict, onOpenMergeTool,
  stagingOperation, inlineOperation, commitProgress, hookRejection, onHookRejectionClose, onHookRejectionBypass, isCommitting, lastCommitMessage, rowStriping, aiEnabled, aiConfigured, aiResolvingPath,
  aiConflictOperationId, aiConflictBatchProgress, aiConflictBatchFailure,
  onSkipAiConflictBatchFailure, onStopAiConflictBatchFailure,
  submoduleOperations = {}, submoduleBusy = false, recursiveSubmodules = true, onRecursiveSubmodulesChange,
  onSubmodulePrepareRemote, onSubmoduleApplyRemote, remoteUpdatePreview, onRemoteUpdatePreviewClose,
  onDismissSubmoduleFeedback,
}: StagingViewProps) {
  const { t } = useTranslation("centre");
  const [numstatCache, setNumstatCache] = useState<Record<string, CachedNumstat>>({});
  const [numstatLoading, setNumstatLoading] = useState<Record<string, boolean>>({});
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({});
  const [aiEligibility, setAiEligibility] = useState<Record<string, {eligible: boolean; reason: string | null}>>({});

  const numstatCacheRef = useRef(numstatCache);
  numstatCacheRef.current = numstatCache;
  const numstatLoadingRef = useRef(numstatLoading);
  numstatLoadingRef.current = numstatLoading;
  const numstatGenerationRef = useRef(0);

  useEffect(() => {
    if (!repoPath || !aiConfigured || !getAiConflictEligibility || conflictedFiles.length === 0) {
      setAiEligibility({});
      return;
    }
    let cancelled = false;
    Promise.all(conflictedFiles.map(async file => {
      try {
        return [file.path, await getAiConflictEligibility(file.path)] as const;
      } catch {
        return [file.path, {eligible: false, reason: "unknown"}] as const;
      }
    })).then(entries => {
      if (!cancelled) setAiEligibility(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [aiConfigured, conflictedFiles, getAiConflictEligibility, repoPath]);

  const eligibleConflictPaths = useMemo(
    () => conflictedFiles
      .filter(file => aiEligibility[file.path]?.eligible === true)
      .map(file => file.path),
    [aiEligibility, conflictedFiles],
  );
  const aiEligibilityPending = aiConfigured
    && conflictedFiles.some(file => aiEligibility[file.path] === undefined);

  useEffect(() => {
    numstatGenerationRef.current += 1;
    numstatCacheRef.current = {};
    numstatLoadingRef.current = {};
    setNumstatCache({});
    setNumstatLoading({});
    setExpandedFolders({});
  }, [repoPath]);

  const mergedStaged = useMemo(
    () => stagedFiles.map((file) => {
      if (file.additions != null || file.deletions != null) return file;
      const cached = numstatCache[cacheKey(file.path, true)];
      if (!cached || cached.failed) return file;
      return { ...file, additions: cached.additions, deletions: cached.deletions };
    }),
    [stagedFiles, numstatCache],
  );

  const mergedUnstaged = useMemo(
    () => unstagedFiles.map((file) => {
      if (file.additions != null || file.deletions != null) return file;
      const cached = numstatCache[cacheKey(file.path, false)];
      if (!cached || cached.failed) return file;
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

    const generation = numstatGenerationRef.current;
    const now = Date.now();
    const cache = numstatCacheRef.current;
    const loading = numstatLoadingRef.current;
    const targets = [
      ...stagedFiles.map(file => ({ file, staged: true })),
      ...unstagedFiles.map(file => ({ file, staged: false })),
    ]
      .filter(({ file, staged }) => {
        if (file.kind === "submodule" || file.additions != null || file.deletions != null) return false;
        const key = cacheKey(file.path, staged);
        if (loading[key]) return false;
        const cached = cache[key];
        if (!cached) return true;
        if (cached.failed) return now - cached.updatedAt > NUMSTAT_FAILURE_BACKOFF_MS;
        return now - cached.updatedAt > NUMSTAT_REFRESH_MS;
      })
      .slice(0, NUMSTAT_BATCH_SIZE);

    if (targets.length === 0) return;

    numstatLoadingRef.current = {
      ...loading,
      ...Object.fromEntries(targets.map(({ file, staged }) => [cacheKey(file.path, staged), true])),
    };
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
          return { key, additions: result.additions, deletions: result.deletions, failed: false };
        } catch {
          return { key, additions: 0, deletions: 0, failed: true };
        }
      }),
    ).then((results) => {
      if (generation !== numstatGenerationRef.current) {
        return;
      }
      const updatedAt = Date.now();

      setNumstatCache((prev) => {
        const next = { ...prev };
        for (const result of results) {
          next[result.key] = {
            additions: result.additions,
            deletions: result.deletions,
            updatedAt,
            failed: result.failed || undefined,
          };
        }
        return next;
      });

      for (const { file, staged } of targets) {
        delete numstatLoadingRef.current[cacheKey(file.path, staged)];
      }
      setNumstatLoading((prev) => {
        const next = { ...prev };
        for (const { file, staged } of targets) {
          delete next[cacheKey(file.path, staged)];
        }
        return next;
      });
    });

  }, [repoPath, stagedFiles, unstagedFiles, numstatCache]);

  const selectedUnstagedPaths = useMemo(
    () => allUnstaged.filter(f => selectedUnstaged[f.path]).map(f => f.path),
    [allUnstaged, selectedUnstaged],
  );
  const selectedStagedPaths = useMemo(
    () => mergedStaged.filter(f => selectedStaged[f.path]).map(f => f.path),
    [mergedStaged, selectedStaged],
  );
  const discardablePaths = allUnstaged.filter(file => file.kind !== "submodule").map(file => file.path);
  const selectedDiscardablePaths = discardablePaths.filter(path => selectedUnstaged[path]);
  const stagedTree = useMemo(() => buildFileTree(mergedStaged), [mergedStaged]);
  const unstagedTree = useMemo(() => buildFileTree(allUnstaged), [allUnstaged]);
  const stagedTreeRows = useMemo(
    () => visibleFileTreeRows(stagedTree, expandedFolders, mergedStaged.length, (path) => folderStateKey("staged", path)),
    [stagedTree, expandedFolders, mergedStaged.length],
  );
  const unstagedTreeRows = useMemo(
    () => visibleFileTreeRows(unstagedTree, expandedFolders, allUnstaged.length, (path) => folderStateKey("unstaged", path)),
    [unstagedTree, expandedFolders, allUnstaged.length],
  );
  const stagingBusy = stagingOperation != null || submoduleBusy || aiResolvingPath !== null;
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
  const renderTreeRow = (row: VisibleFileTreeRow, section: TreeSection) => {
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
    const isSubmoduleGitlink = f.kind === "submodule";
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
          onDoubleClick={isSubmoduleGitlink ? undefined : () => {
            if (!aiResolvingPath) onExternalDiff(f.path, isStaged);
          }}
          onStage={isStaged ? undefined : () => onStageFile(f.path)}
          onUnstage={isStaged ? () => onUnstageFile(f.path) : undefined}
          onDiscard={isStaged || isSubmoduleGitlink ? undefined : () => onDiscardFile(f.path)}
          actionDisabled={stagingBusy}
          submoduleOperation={isSubmoduleGitlink ? submoduleOperations[f.path] : undefined}
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

    if ((mergeInProgress || rebaseInProgress || cherryPickInProgress || revertInProgress) && conflictedFiles.length > 0) {
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
    revertInProgress,
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
            <label className="staging__submodule-recursive">
              <input
                type="checkbox"
                checked={recursiveSubmodules}
                disabled={submoduleBusy}
                onChange={event => onRecursiveSubmodulesChange?.(event.target.checked)}
              />
              {t("staging.includeNested")}
            </label>
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
            {aiEnabled && aiConfigured && conflictedFiles.length > 1 && (
              <div className="staging__section-actions">
                <button
                  className="staging__section-action staging__section-action--accent"
                  type="button"
                  title={t("staging.generateAllAiTitle")}
                  onClick={() => onConflictResolveAllWithAi(conflictedFiles.map(file => file.path))}
                  disabled={aiEligibilityPending || eligibleConflictPaths.length === 0 || aiResolvingPath !== null}
                >
                  {t("staging.generateAllAi")}
                </button>
              </div>
            )}
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
                    onClick={() => onDiscardFiles(selectedDiscardablePaths)}
                    disabled={selectedDiscardablePaths.length === 0 || stagingBusy}
                  >
                    {t("staging.revertSelected")}
                  </button>
                  <button
                    className="staging__section-action staging__section-action--danger"
                    onClick={() => onDiscardAll(discardablePaths)}
                    disabled={discardablePaths.length === 0 || stagingBusy}
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
    const resolvingWithAi = aiResolvingPath === file.path;
    return (
      <div className="staging__list-row">
        <div className="staging__row-anim">
          <div
            className={`staging__conflict-row${rowStripe ? ` staging__conflict-row--striped-${rowStripe.toLowerCase()}` : ""} ${selectedFile === file.path ? "staging__conflict-row--selected" : ""}${resolvingWithAi ? " staging__conflict-row--ai-resolving" : ""}`}
            aria-busy={resolvingWithAi || undefined}
            onClick={() => onFileSelect(file.path, false)}
            onDoubleClick={() => {
              if (!aiResolvingPath) onOpenMergeTool(file.path);
            }}
          >
            <span className="staging__conflict-badge">C</span>
            <span className="staging__conflict-path">{file.path}</span>
            <span className="staging__conflict-type">{file.conflictType.replace(/_/g, " ")}</span>
            <div className="staging__conflict-actions" onClick={e => e.stopPropagation()}>
              <button
                className="staging__conflict-btn staging__conflict-btn--open"
                title={t("staging.openInMergeTool")}
                onClick={() => onOpenMergeTool(file.path)}
                disabled={aiResolvingPath !== null}
              >
                {t("actions.open", {ns: "common"})}
              </button>
              <button
                className="staging__conflict-btn staging__conflict-btn--ours"
                title={t("staging.acceptOurs")}
                onClick={() => onConflictAcceptOurs(file.path)}
                disabled={aiResolvingPath !== null}
              >
                {t("staging.ours")}
              </button>
              <button
                className="staging__conflict-btn staging__conflict-btn--theirs"
                title={t("staging.acceptTheirs")}
                onClick={() => onConflictAcceptTheirs(file.path)}
                disabled={aiResolvingPath !== null}
              >
                {t("staging.theirs")}
              </button>
              {aiEnabled && (
                aiConfigured ? (
                  <button
                    className="staging__conflict-btn staging__conflict-btn--ai"
                    title={resolvingWithAi
                      ? t("staging.aiResolving")
                      : aiEligibility[file.path]?.reason
                        ? t(`aiErrors.${aiEligibility[file.path].reason}`)
                        : t("staging.resolveWithAiTitle")}
                    onClick={() => onConflictResolveWithAi(file.path)}
                    disabled={aiResolvingPath !== null || aiEligibility[file.path]?.eligible !== true}
                  >
                    {resolvingWithAi
                      ? t("staging.aiResolving")
                      : t("staging.aiResolve")}
                  </button>
                ) : (
                  <button
                    className="staging__conflict-btn staging__conflict-btn--ai"
                    title={t("staging.configureAiTitle")}
                    onClick={() => void openSettingsWindow()}
                  >
                    {t("staging.configureAi")}
                  </button>
                )
              )}
              <button
                className="staging__conflict-btn staging__conflict-btn--resolve"
                title={t("staging.markResolved")}
                onClick={() => onStageFile(file.path)}
                disabled={aiResolvingPath !== null}
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
                onPrepareRemote={onSubmodulePrepareRemote ? () => onSubmodulePrepareRemote(row.submodule.path) : undefined}
                operation={submoduleOperations[row.submodule.path]}
                busy={submoduleBusy}
                onDismissFeedback={onDismissSubmoduleFeedback ? () => onDismissSubmoduleFeedback(row.submodule.path) : undefined}
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
      {inlineOperation && !inlineOperationIsCommit && <OperationInlineFeedback {...inlineOperation} />}
      {aiResolvingPath && aiConflictOperationId && (
        <AiConflictOperationFeedback
          key={aiConflictOperationId}
           operationId={aiConflictOperationId}
           batchProgress={aiConflictBatchProgress}
           batchFailure={aiConflictBatchFailure}
           onCancel={onCancelAiConflict}
           onSkipFailure={onSkipAiConflictBatchFailure}
           onStopFailure={onStopAiConflictBatchFailure}
         />
      )}
      <div className="staging__files">
        <Virtuoso
          className="staging__virtual-list"
          style={{ height: "100%" }}
          data={stagingRows}
          computeItemKey={(_index, row) => row.key}
          itemContent={renderStagingRow}
        />
      </div>

      {commitProgress
        ? <CommitHookProgress progress={commitProgress} />
        : inlineOperation && inlineOperationIsCommit && <OperationInlineFeedback {...inlineOperation} />}
      <CommitBox
        repoPath={repoPath}
        stagedCount={stagedFiles.length}
        selectedAction={selectedCommitAction}
        commitMessageRecommendedLength={commitMessageRecommendedLength}
        allowCommitAndPush={allowCommitAndPush}
        onSelectAction={onSelectCommitAction}
        onCommit={onCommit}
        isCommitting={isCommitting}
        operationBusy={submoduleBusy}
        lastCommitMessage={lastCommitMessage}
        mergeMessage={mergeMessage}
        mergeInProgress={mergeInProgress}
        rebaseInProgress={rebaseInProgress}
        cherryPickInProgress={cherryPickInProgress}
        revertInProgress={revertInProgress}
        aiEnabled={aiEnabled}
        aiConfigured={aiConfigured}
      />
      {hookRejection && (
        <HookFailureDialog
          rejection={hookRejection}
          onClose={onHookRejectionClose ?? (() => {})}
          onBypass={onHookRejectionBypass ?? (() => {})}
        />
      )}
      {remoteUpdatePreview && onSubmoduleApplyRemote && (
        <RemoteUpdatePreviewDialog
          preview={remoteUpdatePreview}
          busy={submoduleBusy}
          recursive={recursiveSubmodules}
          operation={submoduleOperations[remoteUpdatePreview.path]}
          onRecursiveChange={onRecursiveSubmodulesChange ?? (() => {})}
          onApply={() => onSubmoduleApplyRemote(remoteUpdatePreview.path, recursiveSubmodules)}
          onClose={onRemoteUpdatePreviewClose ?? (() => {})}
        />
      )}
    </div>
  );
}
