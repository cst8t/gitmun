import React, { useEffect, useRef, useState } from "react";
import type { CommitPrimaryAction } from "../../types";
import { CheckIcon, ChevDownIcon } from "../icons";

type CommitBoxProps = {
  stagedCount: number;
  selectedAction: CommitPrimaryAction;
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
) {
  if (amend) {
    return action === "commitAndPush" ? `Amend and Push (${stagedCount})` : `Amend (${stagedCount})`;
  }
  if (mergeInProgress) {
    return action === "commitAndPush"
      ? `Commit Merge and Push (${stagedCount})`
      : `Commit Merge (${stagedCount})`;
  }
  return action === "commitAndPush"
    ? `Commit and Push (${stagedCount})`
    : `Commit (${stagedCount})`;
}

export function CommitBox({
  stagedCount,
  selectedAction,
  onSelectAction,
  onCommit,
  isCommitting,
  lastCommitMessage,
  mergeMessage,
  mergeInProgress,
  rebaseInProgress,
  cherryPickInProgress,
}: CommitBoxProps) {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  const subjectLine = message.split("\n")[0] ?? "";
  const subjectLength = subjectLine.length;
  const subjectOverflow = subjectLength > 72;
  const actionDisabled =
    stagedCount === 0 || message.trim() === "" || isCommitting || rebaseInProgress || cherryPickInProgress;

  const handleAmendToggle = () => {
    const next = !amend;
    setAmend(next);
    if (next && lastCommitMessage) setMessage(lastCommitMessage);
  };

  const handleCommit = () => {
    if (actionDisabled) return;
    onCommit(message.trim(), amend, selectedAction);
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
          Amend last commit
        </span>
      </div>

      <textarea
        className={`commit-box__textarea ${message.trim() === "" && stagedCount > 0 ? "commit-box__textarea--warn" : ""}`}
        value={message}
        onChange={e => setMessage(e.target.value)}
        placeholder={amend ? "Amend commit message..." : "Commit message..."}
        rows={3}
      />

      <div className="commit-box__hints">
        <span className={`commit-box__hint ${subjectOverflow ? "commit-box__hint--error" : ""}`}>
          {subjectOverflow
            ? "Subject line exceeds 72 chars"
            : message.trim() === "" && stagedCount > 0
              ? "Message required to commit"
              : ""}
        </span>
        <span className="commit-box__counter">{subjectLength}/72</span>
      </div>

      <div className="commit-box__actions" ref={menuRef}>
        <button
          className={`commit-box__btn commit-box__btn--primary ${actionDisabled ? "commit-box__btn--disabled" : ""} ${isCommitting ? "commit-box__btn--pulse" : ""}`}
          disabled={actionDisabled}
          onClick={handleCommit}
        >
          {isCommitting
            ? selectedAction === "commitAndPush"
              ? "Committing and Pushing..."
              : "Committing..."
            : rebaseInProgress
              ? "Rebase in progress"
              : cherryPickInProgress
                ? "Cherry-pick in progress"
                : getCommitButtonLabel(selectedAction, stagedCount, amend, mergeInProgress)}
        </button>
        <button
          type="button"
          className={`commit-box__btn commit-box__btn--toggle ${isCommitting ? "commit-box__btn--disabled" : ""}`}
          disabled={isCommitting}
          onClick={() => setMenuOpen(open => !open)}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Choose commit action"
        >
          <ChevDownIcon size={14} />
        </button>
        {menuOpen && (
          <div className="commit-box__menu" role="menu">
            {([
              { action: "commit" as const, label: "Commit" },
              { action: "commitAndPush" as const, label: "Commit and Push" },
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
