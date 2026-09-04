import React from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { BranchIcon } from "../icons";
import { StagingView } from "./StagingView";
import { LogView } from "./LogView";
import { MergeBanner } from "./MergeBanner";
import { RebaseBanner } from "./RebaseBanner";
import { CherryPickBanner } from "./CherryPickBanner";
import { RevertBanner } from "./RevertBanner";
import type {
  CommitHistoryItem,
  CommitLogScope,
  CommitMarkers,
  CommitPrimaryAction,
  ConflictFileItem,
  FileStatusItem,
  GitHookFailure,
  GitHookProgressState,
  LongRunningOperation,
  OperationFeedbackContent,
  RowStriping,
  StagingOperation,
  SubmoduleStatus,
  UnversionedItem,
} from "../../types";
import "./CentrePanel.css";

export type CentreTab = "changes" | "log";
const SHOW_COMMIT_GRAPH_KEY = "gitmun.showCommitGraph";
const INLINE_OPERATION_DELAY_MS = 500;
const POPUP_OPERATION_DELAY_MS = 2500;

function readShowCommitGraphPreference(): boolean {
  try {
    return localStorage.getItem(SHOW_COMMIT_GRAPH_KEY) === "true";
  } catch {
    return false;
  }
}

type CentrePanelProps = {
  repoPath: string | null;
  activeTab: CentreTab;
  currentBranch: string | null;
  stagedFiles: FileStatusItem[];
  unstagedFiles: FileStatusItem[];
  unversionedFiles: string[];
  unversionedItems?: UnversionedItem[];
  submodules: SubmoduleStatus[];
  conflictedFiles: ConflictFileItem[];
  mergeInProgress: boolean;
  mergeHeadBranch: string | null;
  mergeMessage: string | null;
  rebaseInProgress: boolean;
  rebaseOnto: string | null;
  cherryPickInProgress: boolean;
  cherryPickHead: string | null;
  revertInProgress: boolean;
  revertHead: string | null;
  commits: CommitHistoryItem[];
  loadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  pageSize: number;
  logLoading: boolean;
  logError: string | null;
  searching?: boolean;
  commitMarkers: CommitMarkers;
  logScope: CommitLogScope;
  rowStriping: RowStriping;
  showCommitGraphButton: boolean;
  onCommitGraphVisibilityChange?: (visible: boolean) => void;
  onLogScopeChange: (scope: CommitLogScope) => void;
  detachedHead: boolean;
  shallow: boolean;
  onTabChange: (tab: CentreTab) => void;
  selectedCommitHash: string | null;
  onSelectCommit: (commitHash: string) => void;
  onCreateTagAtCommit?: (commitHash: string) => void;
  onCherryPickAtCommit?: (commitHash: string) => void;
  onRevertAtCommit?: (commitHash: string) => void;
  onResetToCommit?: (commitHash: string, mode: "soft" | "mixed") => void;
  onExportCommitPatch?: (commitHashes: string[]) => void;
  selectedFile: string | null;
  selectedSubmodulePath: string | null;
  selectedStagedFiles: Record<string, boolean>;
  selectedUnstagedFiles: Record<string, boolean>;
  onSelectedStagedFilesChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onSelectedUnstagedFilesChange: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
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
  onCommit: (message: string, amend: boolean, action: CommitPrimaryAction) => boolean | Promise<boolean>;
  onMergeAbort: () => void;
  onRebaseContinue: () => void;
  onRebaseAbort: () => void;
  onCherryPickContinue: () => void;
  onCherryPickAbort: () => void;
  onRevertContinue: () => void;
  onRevertAbort: () => void;
  onConflictAcceptTheirs: (path: string) => void;
  onConflictAcceptOurs: (path: string) => void;
  onConflictResolveWithAi: (path: string) => void;
  getAiConflictEligibility?: (path: string) => Promise<{eligible: boolean; reason: string | null}>;
  onConflictResolveAllWithAi: (paths: string[]) => void;
  onCancelAiConflict: () => void;
  onOpenMergeTool: (path: string) => void;
  stagingOperation: StagingOperation | null;
  operationLock: LongRunningOperation | null;
  hookProgress?: GitHookProgressState | null;
  hookRejection?: (GitHookFailure & {operation: "commit" | "push"}) | null;
  onHookRejectionClose?: () => void;
  onHookRejectionBypass?: () => void;
  isCommitting: boolean;
  isRebaseActionRunning: boolean;
  isCherryPickActionRunning: boolean;
  isRevertActionRunning: boolean;
  lastCommitMessage: string;
  aiEnabled: boolean;
  aiConfigured: boolean;
  aiResolvingPath: string | null;
  aiConflictOperationId: string | null;
  aiConflictBatchProgress: {current: number; total: number; preparing: boolean} | null;
  aiConflictBatchFailure?: {filePath: string; message: string} | null;
  onSkipAiConflictBatchFailure?: () => void;
  onStopAiConflictBatchFailure?: () => void;
};

function HookProgressBanner({progress, onDismiss}: {progress: GitHookProgressState; onDismiss: () => void}) {
  const {t} = useTranslation("centre");
  const [expanded, setExpanded] = React.useState(progress.expanded);
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  React.useEffect(() => setExpanded(progress.expanded), [progress.expanded]);
  React.useEffect(() => {
    const update = () => setElapsedSeconds(Math.floor((Date.now() - progress.startedAt) / 1000));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [progress.startedAt]);
  const title = progress.phase === "warning"
    ? t("gitHooks.checkoutWarningTitle")
    : progress.phase === "awaitingDecision"
      ? t("gitHooks.failedTitle", {operation: t(`gitHooks.operations.${progress.operation}`)})
      : progress.hookName
        ? t("gitHooks.runningHook", {hook: progress.hookName})
        : t("gitHooks.runningOperation", {operation: t(`gitHooks.operations.${progress.operation}`)});
  return <div className="staging__commit-progress" role="status" aria-live="polite">
    <div className="staging__operation-inline">
      {progress.phase === "running" ? <div className="staging__operation-spinner" aria-hidden="true" /> : <div className="staging__operation-failed" aria-hidden="true">!</div>}
      <div className="staging__operation-copy">
        <div className="staging__operation-title">{title}</div>
        <div className="staging__operation-message">{progress.phase === "running" ? t("gitHooks.elapsed", {seconds: elapsedSeconds}) : t(progress.phase === "warning" ? "gitHooks.checkoutWarningMessage" : "gitHooks.reviewFailure")}</div>
      </div>
      {progress.output && <button type="button" className="staging__operation-cancel" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t(expanded ? "gitHooks.hideOutput" : "gitHooks.viewOutput")}</button>}
      {progress.phase === "warning" && <button type="button" className="staging__operation-cancel" onClick={onDismiss}>{t("gitHooks.dismiss")}</button>}
    </div>
    {expanded && progress.output && <pre className="staging__commit-output">{progress.output}{progress.outputTruncated ? `\n${t("gitHooks.outputTruncated")}` : ""}</pre>}
  </div>;
}

function HookFailureDialog({failure, onClose, onBypass}: {failure: GitHookFailure & {operation: "commit" | "push"}; onClose: () => void; onBypass: () => void}) {
  const {t} = useTranslation("centre");
  const closeButtonRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => { closeButtonRef.current?.focus(); }, []);
  return <><div className="dialog-backdrop" /><div className="dialog commit-hook-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-hook-dialog-title">
    <div id="git-hook-dialog-title" className="dialog__title">{t("gitHooks.failedTitle", {operation: t(`gitHooks.operations.${failure.operation}`)})}</div>
    <div className="commit-hook-dialog__summary">{t("gitHooks.failedDescription", {hook: failure.hookName, exitStatus: failure.exitStatus ?? t("gitHooks.unknownExitStatus")})}</div>
    {failure.bypassSupported && <div className="commit-hook-dialog__warning">{t(`gitHooks.bypassWarning.${failure.operation}`)}</div>}
    {failure.output && <pre className="commit-hook-dialog__output">{failure.output}{failure.outputTruncated ? `\n${t("gitHooks.outputTruncated")}` : ""}</pre>}
    <div className="dialog__actions"><button ref={closeButtonRef} type="button" className="dialog__btn dialog__btn--cancel" onClick={onClose}>{t("gitHooks.close")}</button>{failure.bypassSupported && <button type="button" className="dialog__btn dialog__btn--confirm" onClick={onBypass}>{t(`gitHooks.bypassAction.${failure.operation}`)}</button>}</div>
  </div></>;
}

function useDelayedOperationFeedback(operation: LongRunningOperation | null) {
  const [now, setNow] = React.useState(() => Date.now());

  React.useEffect(() => {
    if (!operation) {
      return;
    }

    const update = () => setNow(Date.now());
    update();

    const elapsed = Date.now() - operation.startedAt;
    const inlineTimer = window.setTimeout(update, Math.max(0, INLINE_OPERATION_DELAY_MS - elapsed));
    const popupTimer = window.setTimeout(update, Math.max(0, POPUP_OPERATION_DELAY_MS - elapsed));

    return () => {
      window.clearTimeout(inlineTimer);
      window.clearTimeout(popupTimer);
    };
  }, [operation?.id, operation?.startedAt]);

  if (!operation) {
    return { showInline: false, showPopup: false };
  }

  const elapsed = now - operation.startedAt;
  return {
    showInline: elapsed >= INLINE_OPERATION_DELAY_MS,
    showPopup: elapsed >= POPUP_OPERATION_DELAY_MS,
  };
}

function getOperationContent(
  operation: LongRunningOperation | null,
  t: TFunction<"centre">,
): OperationFeedbackContent | null {
  if (!operation) return null;

  switch (operation.kind) {
    case "stage":
      return {
        kind: operation.kind,
        title: t("operation.stageTitle"),
        message: t("operation.stageMessage", { count: operation.count ?? 0 }),
      };
    case "stageAll":
      return {
        kind: operation.kind,
        title: t("operation.stageAllTitle"),
        message: t("operation.stageAllMessage"),
      };
    case "unstage":
      return {
        kind: operation.kind,
        title: t("operation.unstageTitle"),
        message: t("operation.unstageMessage", { count: operation.count ?? 0 }),
      };
    case "unstageAll":
      return {
        kind: operation.kind,
        title: t("operation.unstageAllTitle"),
        message: t("operation.unstageAllMessage"),
      };
    case "commitAndPush":
      return {
        kind: operation.kind,
        title: t("operation.commitAndPushTitle"),
        message: t("operation.commitAndPushMessage"),
      };
    case "commit":
      return {
        kind: operation.kind,
        title: t("operation.commitTitle"),
        message: t("operation.commitMessage"),
      };
  }
}

export function CentrePanel(props: CentrePanelProps) {
  const { t } = useTranslation("centre");
  const [showCommitGraph, setShowCommitGraph] = React.useState(readShowCommitGraphPreference);
  const preferredShowCommitGraph = props.showCommitGraphButton && showCommitGraph;
  const effectiveShowCommitGraph = preferredShowCommitGraph && !props.searching;
  const tab = props.activeTab;
  const operationContent = getOperationContent(props.operationLock, t);
  const operationFeedback = useDelayedOperationFeedback(props.operationLock);
  const inlineOperationContent = operationFeedback.showInline ? operationContent : null;
  const popupOperationContent = operationFeedback.showPopup && operationContent && !props.hookProgress
    ? { ...operationContent, message: t("operation.stillRunningMessage") }
    : null;
  const submoduleChanges = props.submodules.filter(submodule => submodule.state !== "clean").length;
  const totalChanges = props.stagedFiles.length + props.unstagedFiles.length + props.unversionedFiles.length + submoduleChanges;

  React.useEffect(() => {
    props.onCommitGraphVisibilityChange?.(preferredShowCommitGraph);
  }, [preferredShowCommitGraph, props.onCommitGraphVisibilityChange]);

  const handleToggleCommitGraph = () => {
    setShowCommitGraph(previous => {
      const next = !previous;
      try {
        localStorage.setItem(SHOW_COMMIT_GRAPH_KEY, String(next));
      } catch {
        // Keep the in-memory preference when storage is unavailable.
      }
      return next;
    });
  };

  const handleCommitMerge = () => {
    const message = props.mergeMessage?.split("\n").find(l => !l.startsWith("#"))?.trim()
      || props.mergeMessage?.trim()
      || "";
    void props.onCommit(message, false, props.selectedCommitAction);
  };

  return (
    <div className="centre">
      {props.mergeInProgress && (
        <MergeBanner
          currentBranch={props.currentBranch}
          mergeHeadBranch={props.mergeHeadBranch}
          conflictedFiles={props.conflictedFiles}
          stagedCount={props.stagedFiles.length}
          onMergeAbort={props.onMergeAbort}
          onCommitMerge={handleCommitMerge}
          isCommitting={props.isCommitting}
          interactionLocked={props.aiResolvingPath !== null}
        />
      )}
      {!props.mergeInProgress && props.rebaseInProgress && (
        <RebaseBanner
          currentBranch={props.currentBranch}
          rebaseOnto={props.rebaseOnto}
          conflictedFiles={props.conflictedFiles}
          onRebaseContinue={props.onRebaseContinue}
          onRebaseAbort={props.onRebaseAbort}
          isRunning={props.isRebaseActionRunning}
          interactionLocked={props.aiResolvingPath !== null}
        />
      )}
      {!props.mergeInProgress && !props.rebaseInProgress && props.cherryPickInProgress && (
        <CherryPickBanner
          currentBranch={props.currentBranch}
          cherryPickHead={props.cherryPickHead}
          conflictedFiles={props.conflictedFiles}
          onCherryPickContinue={props.onCherryPickContinue}
          onCherryPickAbort={props.onCherryPickAbort}
          isRunning={props.isCherryPickActionRunning}
          interactionLocked={props.aiResolvingPath !== null}
        />
      )}
      {!props.mergeInProgress && !props.rebaseInProgress && !props.cherryPickInProgress && props.revertInProgress && (
        <RevertBanner
          revertHead={props.revertHead}
          conflictedFiles={props.conflictedFiles}
          onRevertContinue={props.onRevertContinue}
          onRevertAbort={props.onRevertAbort}
          isRunning={props.isRevertActionRunning}
          interactionLocked={props.aiResolvingPath !== null}
        />
      )}
      {props.hookProgress && <HookProgressBanner progress={props.hookProgress} onDismiss={props.onHookRejectionClose ?? (() => {})} />}
      <div className="centre__tabs">
        <button
          className={`centre__tab ${tab === "changes" ? "centre__tab--active" : ""}`}
          onClick={() => props.onTabChange("changes")}>
          {t("tabs.changes")}
          {totalChanges > 0 && <span className="centre__tab-badge">{totalChanges}</span>}
        </button>
        <button
          className={`centre__tab ${tab === "log" ? "centre__tab--active" : ""}`}
          onClick={() => props.onTabChange("log")}>
          {t("tabs.log")}
        </button>
        <div className="centre__tabs-spacer" />
        {tab === "log" && (
          <div className="centre__tabs-actions">
            {props.showCommitGraphButton && (
              <button
                type="button"
                className={`log-view__toolbar-toggle ${showCommitGraph ? "log-view__toolbar-toggle--active" : ""}`}
                title={showCommitGraph ? t("log.hideCommitGraph") : t("log.showCommitGraph")}
                aria-label={showCommitGraph ? t("log.hideCommitGraph") : t("log.showCommitGraph")}
                aria-pressed={showCommitGraph}
                disabled={props.searching}
                onClick={handleToggleCommitGraph}
              >
                <BranchIcon size={15} />
              </button>
            )}
            <div className="log-view__scope-actions" role="group" aria-label={t("log.commitLogScope")}>
              <button
                type="button"
                className={`log-view__scope-btn ${props.logScope === "currentCheckout" ? "log-view__scope-btn--active" : ""}`}
                onClick={() => props.onLogScopeChange("currentCheckout")}
              >
                {t("log.currentCheckout")}
              </button>
              <button
                type="button"
                className={`log-view__scope-btn ${props.logScope === "allRefs" ? "log-view__scope-btn--active" : ""}`}
                onClick={() => props.onLogScopeChange("allRefs")}
              >
                {t("log.allRefs")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/*
        Both panels stay mounted so tab switches keep Log scroll, selection,
        and graph state. Changes stays CSS-hidden so CommitBox drafts and
        in-progress AI conflict UI keep their Effects. Log uses Activity so
        its Effects pause while hidden, without dropping DOM or React state.
      */}
      <div style={{ display: tab === "changes" ? "contents" : "none" }}>
        <StagingView
          repoPath={props.repoPath}
          stagedFiles={props.stagedFiles}
          unstagedFiles={props.unstagedFiles}
          unversionedFiles={props.unversionedFiles}
          unversionedItems={props.unversionedItems}
          submodules={props.submodules}
          conflictedFiles={props.conflictedFiles}
          mergeInProgress={props.mergeInProgress}
          mergeMessage={props.mergeMessage}
          rebaseInProgress={props.rebaseInProgress}
          cherryPickInProgress={props.cherryPickInProgress}
          revertInProgress={props.revertInProgress}
          selectedFile={props.selectedFile}
          selectedSubmodulePath={props.selectedSubmodulePath}
          selectedStaged={props.selectedStagedFiles}
          selectedUnstaged={props.selectedUnstagedFiles}
          onSelectedStagedChange={props.onSelectedStagedFilesChange}
          onSelectedUnstagedChange={props.onSelectedUnstagedFilesChange}
          onFileSelect={props.onFileSelect}
          onSubmoduleSelect={props.onSubmoduleSelect}
          onSubmoduleInit={props.onSubmoduleInit}
          onSubmoduleUpdate={props.onSubmoduleUpdate}
          onSubmoduleSync={props.onSubmoduleSync}
          onSubmoduleFetch={props.onSubmoduleFetch}
          onSubmodulePull={props.onSubmodulePull}
          onSubmoduleOpen={props.onSubmoduleOpen}
          onStageFile={props.onStageFile}
          onStageFiles={props.onStageFiles}
          onUnstageFile={props.onUnstageFile}
          onUnstageFiles={props.onUnstageFiles}
          onDiscardFile={props.onDiscardFile}
          onDiscardFiles={props.onDiscardFiles}
          onDiscardAll={props.onDiscardAll}
          onExternalDiff={props.onExternalDiff}
          onStageAll={props.onStageAll}
          onUnstageAll={props.onUnstageAll}
          selectedCommitAction={props.selectedCommitAction}
          commitMessageRecommendedLength={props.commitMessageRecommendedLength}
          allowCommitAndPush={props.allowCommitAndPush}
          onSelectCommitAction={props.onSelectCommitAction}
          onCommit={props.onCommit}
          onConflictAcceptTheirs={props.onConflictAcceptTheirs}
          onConflictAcceptOurs={props.onConflictAcceptOurs}
          onConflictResolveWithAi={props.onConflictResolveWithAi}
          getAiConflictEligibility={props.getAiConflictEligibility}
          onConflictResolveAllWithAi={props.onConflictResolveAllWithAi}
          onCancelAiConflict={props.onCancelAiConflict}
          onOpenMergeTool={props.onOpenMergeTool}
          stagingOperation={props.stagingOperation}
          inlineOperation={inlineOperationContent}
          commitProgress={null}
          hookRejection={null}
          isCommitting={props.isCommitting}
          lastCommitMessage={props.lastCommitMessage}
          rowStriping={props.rowStriping}
          aiEnabled={props.aiEnabled}
          aiConfigured={props.aiConfigured}
          aiResolvingPath={props.aiResolvingPath}
           aiConflictOperationId={props.aiConflictOperationId}
           aiConflictBatchProgress={props.aiConflictBatchProgress}
           aiConflictBatchFailure={props.aiConflictBatchFailure ?? null}
           onSkipAiConflictBatchFailure={props.onSkipAiConflictBatchFailure ?? (() => {})}
           onStopAiConflictBatchFailure={props.onStopAiConflictBatchFailure ?? (() => {})}
         />
      </div>
      <React.Activity mode={tab === "log" ? "visible" : "hidden"} name="log">
        <LogView
          active={tab === "log"}
          repoPath={props.repoPath}
          commits={props.commits}
          loadMore={props.loadMore}
          hasMore={props.hasMore}
          loadingMore={props.loadingMore}
          loadMoreError={props.loadMoreError}
          pageSize={props.pageSize}
          logLoading={props.logLoading}
          logError={props.logError}
          searching={props.searching}
          commitMarkers={props.commitMarkers}
          logScope={props.logScope}
          rowStriping={props.rowStriping}
          showCommitGraph={effectiveShowCommitGraph}
          detachedHead={props.detachedHead}
          shallow={props.shallow}
          selectedCommitHash={props.selectedCommitHash}
          onSelectCommit={props.onSelectCommit}
          onCreateTagAtCommit={props.onCreateTagAtCommit}
          onCherryPickAtCommit={props.onCherryPickAtCommit}
          onRevertAtCommit={props.onRevertAtCommit}
          onResetToCommit={props.onResetToCommit}
          onExportCommitPatch={props.onExportCommitPatch}
        />
      </React.Activity>
      {props.hookRejection && <HookFailureDialog failure={props.hookRejection} onClose={props.onHookRejectionClose ?? (() => {})} onBypass={props.onHookRejectionBypass ?? (() => {})} />}
      {popupOperationContent && (
        <>
          <div className="centre__operation-backdrop" />
          <div className="centre__operation-popup" role="status" aria-live="polite">
            <div className="centre__operation-spinner" aria-hidden="true" />
            <div className="centre__operation-copy">
              <div className="centre__operation-title">{popupOperationContent.title}</div>
              <div className="centre__operation-message">{popupOperationContent.message}</div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
