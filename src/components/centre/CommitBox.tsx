import React, { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CommitPrimaryAction } from "../../types";
import { getCommitMessageRecovery } from "../../api/commands";
import {
  clearCommitMessageDraft,
  loadCommitMessageDraft,
  saveCommitMessageDraft,
} from "../../utils/commitMessageDraft";
import { CheckIcon, ChevDownIcon } from "../icons";

type CommitBoxProps = {
  repoPath: string | null;
  stagedCount: number;
  selectedAction: CommitPrimaryAction;
  commitMessageRecommendedLength: number;
  allowCommitAndPush: boolean;
  onSelectAction: (action: CommitPrimaryAction) => void;
  onCommit: (message: string, amend: boolean, action: CommitPrimaryAction) => boolean | Promise<boolean>;
  isCommitting: boolean;
  lastCommitMessage: string;
  mergeMessage?: string | null;
  mergeInProgress?: boolean;
  rebaseInProgress?: boolean;
  cherryPickInProgress?: boolean;
};

type CommitBoxDragState = {
  startY: number;
  startHeight: number;
  totalHeight: number;
};

const MIN_COMMIT_BOX_HEIGHT = 214;
const MIN_STAGING_FILES_HEIGHT = 120;
const COMMIT_BOX_RATIO_KEY = "gitmun.commitBoxRatio";

function getCommitButtonLabel(
  action: CommitPrimaryAction,
  stagedCount: number,
  amend: boolean,
  mergeInProgress?: boolean,
  t?: TFunction<"centre">,
) {
  const translate = t ?? ((key: string, options?: Record<string, unknown>) => {
    if (key === "commitBox.amendAndPush") return `Amend and Push (${options?.count})`;
    if (key === "commitBox.amendCommit") return `Amend (${options?.count})`;
    if (key === "commitBox.commitMergeAndPush") return `Commit Merge and Push (${options?.count})`;
    if (key === "commitBox.commitMerge") return `Commit Merge (${options?.count})`;
    if (key === "commitBox.commitAndPushButton") return `Commit and Push (${options?.count})`;
    return `Commit (${options?.count})`;
  });
  if (amend) {
    return action === "commitAndPush" ? translate("commitBox.amendAndPush", {count: stagedCount}) : translate("commitBox.amendCommit", {count: stagedCount});
  }
  if (mergeInProgress) {
    return action === "commitAndPush"
      ? translate("commitBox.commitMergeAndPush", {count: stagedCount})
      : translate("commitBox.commitMerge", {count: stagedCount});
  }
  return action === "commitAndPush"
    ? translate("commitBox.commitAndPushButton", {count: stagedCount})
    : translate("commitBox.commitButton", {count: stagedCount});
}

function splitCommitMessage(message: string) {
  const newlineIndex = message.indexOf("\n");
  if (newlineIndex === -1) return { subject: message, body: "" };

  const subject = message.slice(0, newlineIndex);
  const rest = message.slice(newlineIndex + 1);
  const body = rest.startsWith("\n") ? rest.slice(1) : rest;
  return { subject, body };
}

function parseCommitBoxRatio(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return null;
  if (parsed <= 0 || parsed >= 1) return null;
  return parsed;
}

function clampCommitBoxHeight(totalHeight: number, desiredHeight: number): number {
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) return MIN_COMMIT_BOX_HEIGHT;

  const maxHeight = Math.max(MIN_COMMIT_BOX_HEIGHT, totalHeight - MIN_STAGING_FILES_HEIGHT);
  return Math.round(Math.min(Math.max(desiredHeight, MIN_COMMIT_BOX_HEIGHT), maxHeight));
}

function commitBoxRatioFromHeight(totalHeight: number, height: number): number | null {
  if (!Number.isFinite(totalHeight) || totalHeight <= 0) return null;
  const ratio = height / totalHeight;
  return ratio > 0 && ratio < 1 ? ratio : null;
}

function getCommitBoxStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function CommitBox({
  repoPath,
  stagedCount,
  selectedAction,
  commitMessageRecommendedLength,
  allowCommitAndPush,
  onSelectAction,
  onCommit,
  isCommitting,
  lastCommitMessage,
  mergeMessage,
  mergeInProgress,
  rebaseInProgress,
  cherryPickInProgress,
}: CommitBoxProps) {
  const { t } = useTranslation("centre");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [amend, setAmend] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [commitBoxHeight, setCommitBoxHeight] = useState<number | null>(null);
  const [dragState, setDragState] = useState<CommitBoxDragState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const commitBoxRef = useRef<HTMLDivElement>(null);
  const commitBoxHeightRef = useRef<number>(MIN_COMMIT_BOX_HEIGHT);
  const commitBoxRatioRef = useRef<number | null>(parseCommitBoxRatio(getCommitBoxStorage()?.getItem(COMMIT_BOX_RATIO_KEY) ?? null));
  const activeAction = allowCommitAndPush ? selectedAction : "commit";

  useEffect(() => {
    setDraftReady(false);
    setRecoveryMessage(null);

    if (mergeInProgress && mergeMessage) {
      const cleaned = mergeMessage.split("\n").filter(l => !l.startsWith("#")).join("\n").trim();
      const nextMessage = splitCommitMessage(cleaned);
      setSubject(nextMessage.subject);
      setBody(nextMessage.body);
      setDraftReady(true);
      return;
    }

    if (mergeInProgress) {
      setDraftReady(true);
      return;
    }

    if (!repoPath) {
      setSubject("");
      setBody("");
      setDraftReady(true);
      return;
    }

    const draft = loadCommitMessageDraft(repoPath);
    if (draft) {
      setSubject(draft.subject);
      setBody(draft.body);
      setDraftReady(true);
      return;
    }

    setSubject("");
    setBody("");
    setDraftReady(true);

    let cancelled = false;
    getCommitMessageRecovery(repoPath)
      .then(recovery => {
        if (!cancelled) {
          setRecoveryMessage(recovery && recovery.message !== lastCommitMessage ? recovery.message : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecoveryMessage(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, mergeInProgress, mergeMessage, lastCommitMessage]);

  useEffect(() => {
    if (!repoPath || !draftReady || mergeInProgress || amend) return;
    saveCommitMessageDraft(repoPath, subject, body);
  }, [repoPath, subject, body, draftReady, mergeInProgress, amend]);

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [menuOpen]);

  useEffect(() => {
    if (!allowCommitAndPush) {
      setMenuOpen(false);
    }
  }, [allowCommitAndPush]);

  useEffect(() => {
    const root = commitBoxRef.current?.parentElement;
    if (!root) return;

    const applyLayout = () => {
      const ratio = commitBoxRatioRef.current;
      if (ratio == null) return;

      const totalHeight = root.getBoundingClientRect().height;
      if (totalHeight <= 0) return;
      const nextHeight = clampCommitBoxHeight(totalHeight, totalHeight * ratio);
      commitBoxHeightRef.current = nextHeight;
      setCommitBoxHeight(nextHeight);
    };

    applyLayout();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(applyLayout);
    observer?.observe(root);
    window.addEventListener("resize", applyLayout);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", applyLayout);
    };
  }, []);

  useEffect(() => {
    if (!dragState) return;

    const handleMouseMove = (event: MouseEvent) => {
      const nextHeight = dragState.startHeight + dragState.startY - event.clientY;
      const clampedHeight = clampCommitBoxHeight(dragState.totalHeight, nextHeight);
      commitBoxHeightRef.current = clampedHeight;
      setCommitBoxHeight(clampedHeight);
    };
    const handleMouseUp = () => {
      setDragState(null);
      const totalHeight = commitBoxRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
      const ratio = commitBoxRatioFromHeight(totalHeight, commitBoxHeightRef.current);
      const storage = getCommitBoxStorage();
      commitBoxRatioRef.current = ratio;
      if (ratio == null) {
        storage?.removeItem(COMMIT_BOX_RATIO_KEY);
      } else {
        storage?.setItem(COMMIT_BOX_RATIO_KEY, ratio.toFixed(6));
      }
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragState]);

  const trimmedSubject = subject.trim();
  const trimmedBody = body.trim();
  const subjectLength = subject.length;
  const hasRecommendedLength = commitMessageRecommendedLength > 0;
  const subjectOverflow = hasRecommendedLength && subjectLength > commitMessageRecommendedLength;
  const actionDisabled =
    stagedCount === 0 || trimmedSubject === "" || isCommitting || rebaseInProgress || cherryPickInProgress;

  const handleAmendToggle = () => {
    const next = !amend;
    setAmend(next);
    if (next && lastCommitMessage) {
      const nextMessage = splitCommitMessage(lastCommitMessage);
      setSubject(nextMessage.subject);
      setBody(nextMessage.body);
    }
  };

  const canRestoreRecovery = recoveryMessage != null && subject === "" && body === "" && !mergeInProgress && !amend;

  const handleRestoreRecovery = () => {
    if (!recoveryMessage) return;
    const nextMessage = splitCommitMessage(recoveryMessage);
    setSubject(nextMessage.subject);
    setBody(nextMessage.body);
    setRecoveryMessage(null);
  };

  const handleCommit = async () => {
    if (actionDisabled) return;
    const message = trimmedBody === "" ? trimmedSubject : `${trimmedSubject}\n\n${trimmedBody}`;
    const committed = await onCommit(message, amend, activeAction);
    if (committed !== false) {
      setSubject("");
      setBody("");
      setAmend(false);
      setMenuOpen(false);
      if (repoPath) {
        clearCommitMessageDraft(repoPath);
      }
    }
  };

  const handleCommitKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      handleCommit();
    }
  };

  const handleResizeMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const commitBoxRect = commitBoxRef.current?.getBoundingClientRect();
    const stagingRect = commitBoxRef.current?.parentElement?.getBoundingClientRect();
    if (!commitBoxRect || !stagingRect) return;

    setCommitBoxHeight(commitBoxRect.height);
    commitBoxHeightRef.current = commitBoxRect.height;
    setDragState({
      startY: event.clientY,
      startHeight: commitBoxRect.height,
      totalHeight: stagingRect.height,
    });
  };

  return (
    <div
      className={`commit-box ${dragState ? "commit-box--resizing" : ""}`}
      ref={commitBoxRef}
      style={commitBoxHeight ? {"--commit-box-height": `${commitBoxHeight}px`} as React.CSSProperties : undefined}
    >
      <div
        className="commit-box__resize-handle"
        onMouseDown={handleResizeMouseDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("commitBox.resizeEditor")}
      />

      <input
        className={`commit-box__subject ${trimmedSubject === "" && stagedCount > 0 ? "commit-box__subject--warn" : ""}`}
        value={subject}
        onChange={e => setSubject(e.target.value)}
        onKeyDown={handleCommitKeyDown}
        placeholder={amend ? t("commitBox.amendSubject") : t("commitBox.commitSubject")}
        spellCheck="true"
        data-allow-native-context-menu="true"
      />

      <textarea
        className="commit-box__textarea"
        value={body}
        onChange={e => setBody(e.target.value)}
        onKeyDown={handleCommitKeyDown}
        placeholder={amend ? t("commitBox.amendBody") : t("commitBox.commitBody")}
        rows={2}
        spellCheck="true"
        data-allow-native-context-menu="true"
      />

      <div className="commit-box__meta">
        <div className="commit-box__amend" onClick={handleAmendToggle}>
          <div className={`commit-box__checkbox ${amend ? "commit-box__checkbox--active" : ""}`}>
            {amend && <CheckIcon size={10} />}
          </div>
          <span className={`commit-box__amend-label ${amend ? "commit-box__amend-label--active" : ""}`}>
            {t("commitBox.amend")}
          </span>
        </div>

        <div className="commit-box__hints">
          {canRestoreRecovery && (
            <button
              type="button"
              className="commit-box__restore"
              onClick={handleRestoreRecovery}
            >
              {t("commitBox.restorePreviousMessage")}
            </button>
          )}
          <span className={`commit-box__hint ${subjectOverflow ? "commit-box__hint--error" : ""}`}>
            {subjectOverflow
              ? t("commitBox.subjectTooLong", {count: commitMessageRecommendedLength})
              : trimmedSubject === "" && stagedCount > 0
                ? t("commitBox.messageRequired")
                : ""}
          </span>
          {hasRecommendedLength && (
            <span className="commit-box__counter">{subjectLength}/{commitMessageRecommendedLength}</span>
          )}
        </div>
      </div>

      <div className="commit-box__actions" ref={menuRef}>
        <button
          className={`commit-box__btn commit-box__btn--primary ${allowCommitAndPush ? "" : "commit-box__btn--solo"} ${actionDisabled ? "commit-box__btn--disabled" : ""} ${isCommitting ? "commit-box__btn--pulse" : ""}`}
          disabled={actionDisabled}
          onClick={handleCommit}
        >
          {isCommitting
            ? activeAction === "commitAndPush"
              ? t("commitBox.committingAndPushing")
              : t("commitBox.committing")
            : rebaseInProgress
              ? t("commitBox.rebaseInProgress")
              : cherryPickInProgress
                ? t("commitBox.cherryPickInProgress")
                : getCommitButtonLabel(activeAction, stagedCount, amend, mergeInProgress, t)}
        </button>
        {allowCommitAndPush && (
          <button
            type="button"
            className={`commit-box__btn commit-box__btn--toggle ${isCommitting ? "commit-box__btn--disabled" : ""}`}
            disabled={isCommitting}
            onClick={() => setMenuOpen(open => !open)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("commitBox.chooseAction")}
          >
            <ChevDownIcon size={14} />
          </button>
        )}
        {allowCommitAndPush && menuOpen && (
          <div className="commit-box__menu" role="menu">
            {([
              { action: "commit" as const, label: t("commitBox.commit") },
              { action: "commitAndPush" as const, label: t("commitBox.commitAndPush") },
            ]).map(item => (
              <button
                key={item.action}
                type="button"
                className="commit-box__menu-item"
                role="menuitemradio"
                aria-checked={selectedAction === item.action}
                onClick={() => {
                  onSelectAction(item.action);
                  setMenuOpen(false);
                }}
              >
                <span>{item.label}</span>
                {selectedAction === item.action && <CheckIcon size={12} />}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
