import React, { useEffect, useState } from "react";
import { CheckIcon } from "../icons";

type CommitBoxProps = {
  stagedCount: number;
  onCommit: (message: string, amend: boolean) => void;
  isCommitting: boolean;
  lastCommitMessage: string;
  mergeMessage?: string | null;
  mergeInProgress?: boolean;
  rebaseInProgress?: boolean;
  cherryPickInProgress?: boolean;
};

export function CommitBox({
  stagedCount,
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

  const subjectLine = message.split("\n")[0] ?? "";
  const subjectLength = subjectLine.length;
  const subjectOverflow = subjectLength > 72;
  const disabled = stagedCount === 0 || message.trim() === "" || isCommitting || rebaseInProgress || cherryPickInProgress;

  const handleAmendToggle = () => {
    const next = !amend;
    setAmend(next);
    if (next && lastCommitMessage) setMessage(lastCommitMessage);
  };

  const handleCommit = () => {
    if (disabled) return;
    onCommit(message.trim(), amend);
    setMessage("");
    setAmend(false);
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

      <button
        className={`commit-box__btn ${disabled ? "commit-box__btn--disabled" : ""} ${isCommitting ? "commit-box__btn--pulse" : ""}`}
        disabled={disabled}
        onClick={handleCommit}
      >
        {isCommitting
          ? "Committing..."
          : rebaseInProgress
            ? "Rebase in progress"
            : cherryPickInProgress
              ? "Cherry-pick in progress"
            : amend
              ? `Amend (${stagedCount})`
              : mergeInProgress
                ? `Commit Merge (${stagedCount})`
                : `Commit (${stagedCount})`}
      </button>
    </div>
  );
}
