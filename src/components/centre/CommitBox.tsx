import React, { useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CommitPrimaryAction } from "../../types";
import { CheckIcon, ChevDownIcon } from "../icons";

type CommitBoxProps = {
  stagedCount: number;
  selectedAction: CommitPrimaryAction;
  commitMessageRecommendedLength: number;
  allowCommitAndPush: boolean;
  onSelectAction: (action: CommitPrimaryAction) => void;
  onCommit: (message: string, amend: boolean, action: CommitPrimaryAction) => void;
  isCommitting: boolean;
  lastCommitMessage: string;
  mergeMessage?: string | null;
  mergeInProgress?: boolean;
  rebaseInProgress?: boolean;
  cherryPickInProgress?: boolean;
};

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

export function CommitBox({
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
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const activeAction = allowCommitAndPush ? selectedAction : "commit";

  useEffect(() => {
    if (mergeInProgress && mergeMessage) {
      const cleaned = mergeMessage.split("\n").filter(l => !l.startsWith("#")).join("\n").trim();
      setMessage(cleaned);
    } else if (!mergeInProgress) {
      setMessage("");
    }
  // Only re-run when merge state transitions
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergeInProgress]);

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

  const subjectLine = message.split("\n")[0] ?? "";
  const subjectLength = subjectLine.length;
  const hasRecommendedLength = commitMessageRecommendedLength > 0;
  const subjectOverflow = hasRecommendedLength && subjectLength > commitMessageRecommendedLength;
  const actionDisabled =
    stagedCount === 0 || message.trim() === "" || isCommitting || rebaseInProgress || cherryPickInProgress;

  const handleAmendToggle = () => {
    const next = !amend;
    setAmend(next);
    if (next && lastCommitMessage) setMessage(lastCommitMessage);
  };

  const handleCommit = () => {
    if (actionDisabled) return;
    onCommit(message.trim(), amend, activeAction);
    setMessage("");
    setAmend(false);
    setMenuOpen(false);
  };

  return (
    <div className="commit-box">
      <div className="commit-box__amend" onClick={handleAmendToggle}>
        <div className={`commit-box__checkbox ${amend ? "commit-box__checkbox--active" : ""}`}>
          {amend && <CheckIcon size={10} />}
        </div>
        <span className={`commit-box__amend-label ${amend ? "commit-box__amend-label--active" : ""}`}>
          {t("commitBox.amend")}
        </span>
      </div>

      <textarea
        className={`commit-box__textarea ${message.trim() === "" && stagedCount > 0 ? "commit-box__textarea--warn" : ""}`}
        value={message}
        onChange={e => setMessage(e.target.value)}
        placeholder={amend ? t("commitBox.amendMessage") : t("commitBox.commitMessage")}
        rows={3}
      />

      <div className="commit-box__hints">
        <span className={`commit-box__hint ${subjectOverflow ? "commit-box__hint--error" : ""}`}>
          {subjectOverflow
            ? t("commitBox.subjectTooLong", {count: commitMessageRecommendedLength})
            : message.trim() === "" && stagedCount > 0
              ? t("commitBox.messageRequired")
              : ""}
        </span>
        {hasRecommendedLength && (
          <span className="commit-box__counter">{subjectLength}/{commitMessageRecommendedLength}</span>
        )}
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
