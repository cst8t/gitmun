import React from "react";
import { StagingView } from "./StagingView";
import { LogView } from "./LogView";
import { MergeBanner } from "./MergeBanner";
import { RebaseBanner } from "./RebaseBanner";
import { CherryPickBanner } from "./CherryPickBanner";
import { RevertBanner } from "./RevertBanner";
import type { CommitHistoryItem, CommitMarkers, ConflictFileItem, FileStatusItem, SubmoduleStatus } from "../../types";
import "./CentrePanel.css";

export type CentreTab = "changes" | "log";

type CentrePanelProps = {
  repoPath: string | null;
  activeTab: CentreTab;
  currentBranch: string | null;
  stagedFiles: FileStatusItem[];
  unstagedFiles: FileStatusItem[];
  unversionedFiles: string[];
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
  commitMarkers: CommitMarkers;
  onTabChange: (tab: CentreTab) => void;
  selectedCommitHash: string | null;
  onSelectCommit: (commitHash: string) => void;
  onCreateTagAtCommit?: (commitHash: string) => void;
  onCherryPickAtCommit?: (commitHash: string) => void;
  onRevertAtCommit?: (commitHash: string) => void;
  onResetToCommit?: (commitHash: string, mode: "soft" | "mixed") => void;
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
  onCommit: (message: string, amend: boolean) => void;
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
  isCommitting: boolean;
  isRebaseActionRunning: boolean;
  isCherryPickActionRunning: boolean;
  isRevertActionRunning: boolean;
  lastCommitMessage: string;
};

export function CentrePanel(props: CentrePanelProps) {
  const tab = props.activeTab;
  const submoduleChanges = props.submodules.filter(submodule => submodule.state !== "clean").length;
  const totalChanges = props.stagedFiles.length + props.unstagedFiles.length + props.unversionedFiles.length + submoduleChanges;

  const handleCommitMerge = () => {
    const message = props.mergeMessage?.split("\n").find(l => !l.startsWith("#"))?.trim()
      || props.mergeMessage?.trim()
      || "";
    props.onCommit(message, false);
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
          Changes
          {totalChanges > 0 && <span className="centre__tab-badge">{totalChanges}</span>}
        </button>
        <button
          className={`centre__tab ${tab === "log" ? "centre__tab--active" : ""}`}
          onClick={() => props.onTabChange("log")}>
          Log
        </button>
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
          submodules={props.submodules}
          conflictedFiles={props.conflictedFiles}
          mergeInProgress={props.mergeInProgress}
          mergeMessage={props.mergeMessage}
          rebaseInProgress={props.rebaseInProgress}
          cherryPickInProgress={props.cherryPickInProgress}
          selectedFile={props.selectedFile}
          selectedSubmodulePath={props.selectedSubmodulePath}
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
          onCommit={props.onCommit}
          onConflictAcceptTheirs={props.onConflictAcceptTheirs}
          onConflictAcceptOurs={props.onConflictAcceptOurs}
          onOpenMergeTool={props.onOpenMergeTool}
          isCommitting={props.isCommitting}
          lastCommitMessage={props.lastCommitMessage}
        />
      </div>
      <div style={{ display: tab === "log" ? "contents" : "none" }}>
        <LogView
          active={tab === "log"}
          repoPath={props.repoPath}
          commits={props.commits}
          loadMore={props.loadMore}
          hasMore={props.hasMore}
          commitMarkers={props.commitMarkers}
          selectedCommitHash={props.selectedCommitHash}
          onSelectCommit={props.onSelectCommit}
          onCreateTagAtCommit={props.onCreateTagAtCommit}
          onCherryPickAtCommit={props.onCherryPickAtCommit}
          onRevertAtCommit={props.onRevertAtCommit}
          onResetToCommit={props.onResetToCommit}
        />
      </div>
    </div>
  );
}
