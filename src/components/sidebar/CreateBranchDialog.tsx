import React from "react";
import "./CreateBranchDialog.css";
import type { BranchInfo, CreateBranchRequest, TagInfo } from "../../types";
import { getBranchNameError } from "../../utils/branchValidation";

type RevisionType = "local-branch" | "remote-branch" | "tag";

type CreateBranchDialogProps = {
  repoPath: string;
  branches: BranchInfo[];
  tags: TagInfo[];
  currentBranch?: BranchInfo;
  initialRevisionType?: RevisionType;
  initialRevision?: string;
  onConfirm: (request: CreateBranchRequest) => void;
  onCancel: () => void;
};

export function CreateBranchDialog({
  repoPath,
  branches,
  tags,
  currentBranch,
  initialRevisionType,
  initialRevision,
  onConfirm,
  onCancel
}: CreateBranchDialogProps) {
  const [branchName, setBranchName] = React.useState("");
  const [revisionType, setRevisionType] = React.useState<RevisionType>(initialRevisionType ?? "local-branch");
  const [selectedRevision, setSelectedRevision] = React.useState(initialRevision ?? currentBranch?.name ?? "");
  const [filter, setFilter] = React.useState("");
  const [checkoutAfterCreation, setCheckoutAfterCreation] = React.useState(true);
  const [trackRemote, setTrackRemote] = React.useState(false);
  const [matchTrackingBranch, setMatchTrackingBranch] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const prevRevisionTypeRef = React.useRef<RevisionType>(revisionType);

  // Close on Escape
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  // Focus the branch name input when dialog opens
  React.useEffect(() => {
    const input = document.querySelector('.create-branch-dialog__name-input') as HTMLInputElement;
    if (input) {
      input.focus();
    }
  }, []);

  // Reset selected revision when type changes
  React.useEffect(() => {
    const typeChanged = prevRevisionTypeRef.current !== revisionType;
    prevRevisionTypeRef.current = revisionType;

    // Only auto-select a default if no selection exists
    // This way, polling won't reset the user's selection
    if (revisionType === "local-branch") {
      if (!selectedRevision || branches.filter(b => !b.isRemote).every(b => b.name !== selectedRevision)) {
        setSelectedRevision(currentBranch?.name || "");
      }
      if (typeChanged) {
        setTrackRemote(false);
        setMatchTrackingBranch(false);
      }
    } else if (revisionType === "remote-branch") {
      const remoteBranches = branches.filter(b => b.isRemote);
      if (!selectedRevision || !remoteBranches.some(b => b.name === selectedRevision)) {
        setSelectedRevision(remoteBranches.length > 0 ? remoteBranches[0].name : "");
      }
      if (typeChanged) {
        setTrackRemote(true); // Default to tracking when switching to remote branch
      }
    } else if (revisionType === "tag") {
      if (!selectedRevision || !tags.some(t => t.name === selectedRevision)) {
        setSelectedRevision(tags.length > 0 ? tags[0].name : "");
      }
      if (typeChanged) {
        setTrackRemote(false);
        setMatchTrackingBranch(false);
      }
    }
  }, [revisionType, currentBranch, tags, branches, selectedRevision]);

  // When "Match tracking branch name" is active, auto-populate branch name from remote branch
  React.useEffect(() => {
    if (!matchTrackingBranch || revisionType !== "remote-branch" || !selectedRevision) return;
    // Strip the remote prefix (e.g. "origin/feature/foo" → "feature/foo")
    const slashIndex = selectedRevision.indexOf("/");
    const derivedName = slashIndex >= 0 ? selectedRevision.slice(slashIndex + 1) : selectedRevision;
    setBranchName(derivedName);
  }, [matchTrackingBranch, selectedRevision, revisionType]);

  // Validate branch name
  React.useEffect(() => {
    const trimmedName = branchName.trim();
    setError(null);

    if (!trimmedName) {
      return;
    }

    const branchNameError = getBranchNameError(trimmedName);
    if (branchNameError) {
      setError(branchNameError);
      return;
    }

    if (branches.some(b => b.name === trimmedName)) {
      setError("A branch with this name already exists");
      return;
    }
  }, [branchName, branches]);

  // Filter revisions based on type and filter text
  const getFilteredRevisions = () => {
    const filterLower = filter.toLowerCase();
    
    if (revisionType === "local-branch") {
      return branches
        .filter(b => !b.isRemote)
        .filter(b => b.name.toLowerCase().includes(filterLower))
        .sort((a, b) => {
          // Current branch first
          if (a.isCurrent) return -1;
          if (b.isCurrent) return 1;
          return a.name.localeCompare(b.name);
        });
    } else if (revisionType === "remote-branch") {
      return branches
        .filter(b => b.isRemote)
        .filter(b => b.name.toLowerCase().includes(filterLower))
        .sort((a, b) => a.name.localeCompare(b.name));
    } else if (revisionType === "tag") {
      // Use tags as they come from backend (already properly sorted by version)
      return tags
        .filter(t => t.name.toLowerCase().includes(filterLower));
    }
    
    return [];
  };

  const filteredRevisions = getFilteredRevisions();

  const canCreate = branchName.trim() && !error && selectedRevision;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!canCreate) return;

    onConfirm({
      repoPath,
      branchName: branchName.trim(),
      baseRef: selectedRevision || undefined,
      checkoutAfterCreation,
      trackRemote,
      matchTrackingBranch: revisionType === "remote-branch" ? matchTrackingBranch : false,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canCreate) {
      handleSubmit(e);
    }
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="create-branch-dialog" role="dialog" aria-modal="true">
        <div className="create-branch-dialog__title">Create New Branch</div>
        
        <form onSubmit={handleSubmit}>
          {/* Branch Name */}
          <div className="create-branch-dialog__field">
            <label className="create-branch-dialog__label">Branch name</label>
            <input
              type="text"
              className={`create-branch-dialog__name-input${matchTrackingBranch ? " create-branch-dialog__name-input--readonly" : ""}`}
              value={branchName}
              onChange={(e) => { if (!matchTrackingBranch) setBranchName(e.target.value); }}
              onKeyDown={handleKeyDown}
              placeholder="new-branch"
              readOnly={matchTrackingBranch}
            />
            {error && (
              <div className="create-branch-dialog__error">{error}</div>
            )}
          </div>

          {/* Starting Revision */}
          <div className="create-branch-dialog__revision-section">
            <label className="create-branch-dialog__label">Starting Revision</label>
            
            {/* Revision Type Tabs */}
            <div className="create-branch-dialog__revision-types">
              <button
                type="button"
                className={`create-branch-dialog__revision-type ${revisionType === "local-branch" ? "create-branch-dialog__revision-type--active" : ""}`}
                onClick={() => setRevisionType("local-branch")}
              >
                Local Branch
              </button>
              <button
                type="button"
                className={`create-branch-dialog__revision-type ${revisionType === "remote-branch" ? "create-branch-dialog__revision-type--active" : ""}`}
                onClick={() => setRevisionType("remote-branch")}
              >
                Remote Branch
              </button>
              <button
                type="button"
                className={`create-branch-dialog__revision-type ${revisionType === "tag" ? "create-branch-dialog__revision-type--active" : ""}`}
                onClick={() => setRevisionType("tag")}
              >
                Tag
              </button>
            </div>

            {/* Filter */}
            <div className="create-branch-dialog__filter-container">
              <input
                type="text"
                className="create-branch-dialog__filter"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Filter ${revisionType === "local-branch" ? "branches" : revisionType === "remote-branch" ? "remote branches" : "tags"}...`}
              />
            </div>

            {/* Revision List */}
            <div className="create-branch-dialog__revision-list">
              {filteredRevisions.length === 0 ? (
                <div className="create-branch-dialog__revision-item create-branch-dialog__revision-item--empty">
                  No {revisionType === "local-branch" ? "branches" : revisionType === "remote-branch" ? "remote branches" : "tags"} found
                </div>
              ) : (
                filteredRevisions.map((item) => {
                  const itemName = item.name;
                  const isCurrent = 'isCurrent' in item ? (item as BranchInfo).isCurrent : false;
                  const isSelected = selectedRevision === itemName;
                  
                  return (
                    <div
                      key={itemName}
                      className={`create-branch-dialog__revision-item ${isSelected ? "create-branch-dialog__revision-item--selected" : ""} ${isCurrent ? "create-branch-dialog__revision-item--current" : ""} ${revisionType === "tag" ? "create-branch-dialog__revision-item--tag" : ""}`}
                      onClick={() => setSelectedRevision(itemName)}
                    >
                      {itemName}
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Options */}
          <div className="create-branch-dialog__options">
            <label className="create-branch-dialog__checkbox">
              <input
                type="checkbox"
                checked={checkoutAfterCreation}
                onChange={(e) => setCheckoutAfterCreation(e.target.checked)}
              />
              Checkout new branch
            </label>
            
            {revisionType === "remote-branch" && (
              <label className="create-branch-dialog__checkbox">
                <input
                  type="checkbox"
                  checked={trackRemote}
                  onChange={(e) => { setTrackRemote(e.target.checked); if (!e.target.checked) setMatchTrackingBranch(false); }}
                />
                Set up tracking relationship
              </label>
            )}

            {revisionType === "remote-branch" && (
              <label className={`create-branch-dialog__checkbox${!trackRemote ? " create-branch-dialog__checkbox--disabled" : ""}`}>
                <input
                  type="checkbox"
                  checked={matchTrackingBranch}
                  disabled={!trackRemote}
                  onChange={(e) => setMatchTrackingBranch(e.target.checked)}
                />
                Match tracking branch name
              </label>
            )}
          </div>

          {/* Actions */}
          <div className="create-branch-dialog__actions">
            <button 
              type="button"
              className="create-branch-dialog__btn create-branch-dialog__btn--cancel" 
              onClick={onCancel}
            >
              Cancel
            </button>
            <button 
              type="submit"
              className={`create-branch-dialog__btn create-branch-dialog__btn--create ${!canCreate ? 'create-branch-dialog__btn--disabled' : ''}`}
              disabled={!canCreate}
            >
              Create Branch
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
