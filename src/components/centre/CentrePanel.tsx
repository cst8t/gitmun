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
  commitMarkers: CommitMarkers;
  logScope: CommitLogScope;
  rowStriping: RowStriping;
  showCommitGraphButton: boolean;
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
  onOpenMergeTool: (path: string) => void;
  stagingOperation: StagingOperation | null;
  operationLock: LongRunningOperation | null;
  isCommitting: boolean;
  isRebaseActionRunning: boolean;
  isCherryPickActionRunning: boolean;
  isRevertActionRunning: boolean;
  lastCommitMessage: string;
};

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
  const effectiveShowCommitGraph = props.showCommitGraphButton && showCommitGraph;
  const tab = props.activeTab;
  const operationContent = getOperationContent(props.operationLock, t);
  const operationFeedback = useDelayedOperationFeedback(props.operationLock);
  const inlineOperationContent = operationFeedback.showInline ? operationContent : null;
  const popupOperationContent = operationFeedback.showPopup && operationContent
    ? { ...operationContent, message: t("operation.stillRunningMessage") }
    : null;
  const submoduleChanges = props.submodules.filter(submodule => submodule.state !== "clean").length;
  const totalChanges = props.stagedFiles.length + props.unstagedFiles.length + props.unversionedFiles.length + submoduleChanges;

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
        />
      )}
      {!props.mergeInProgress && !props.rebaseInProgress && !props.cherryPickInProgress && props.revertInProgress && (
        <RevertBanner
          revertHead={props.revertHead}
          conflictedFiles={props.conflictedFiles}
          onRevertContinue={props.onRevertContinue}
          onRevertAbort={props.onRevertAbort}
          isRunning={props.isRevertActionRunning}
        />
      )}
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
        Both panels are always in the DOM. Mounting LogView on first click is
        expensive (DOM creation + IntersectionObserver + avatar fetches). By
        keeping both rendered and toggling CSS display, switching tabs is a
        zero-cost CSS property change instead of a full React mount.
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
          onOpenMergeTool={props.onOpenMergeTool}
          stagingOperation={props.stagingOperation}
          inlineOperation={inlineOperationContent}
          isCommitting={props.isCommitting}
          lastCommitMessage={props.lastCommitMessage}
          rowStriping={props.rowStriping}
        />
      </div>
      <div style={{ display: tab === "log" ? "contents" : "none" }}>
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
      </div>
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
