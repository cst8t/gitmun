import React, { useRef, useState } from "react";
import {
  UserIcon, FolderIcon, GlobeIcon, SwapIcon, ShieldIcon,
  CloseIcon, EditIcon,
} from "../icons";
import type { GitIdentity } from "../../types";
import "./IdentityPanel.css";

type IdentityTab = "local" | "global" | "profiles";

const PROFILES_ENABLED = false;

type IdentityPanelProps = {
  open: boolean;
  onClose: () => void;
  localIdentity: GitIdentity | null;
  globalIdentity: GitIdentity | null;
  localIdentitySaving?: boolean;
  globalIdentitySaving?: boolean;
  onSaveLocalIdentity?: (payload: Partial<GitIdentity>) => Promise<void>;
  onSaveGlobalIdentity?: (payload: Partial<GitIdentity>) => Promise<void>;
  onScopeChange?: (scope: "local" | "global") => void;
};

export function IdentityPanel({
  open,
  onClose,
  localIdentity,
  globalIdentity,
  localIdentitySaving = false,
  globalIdentitySaving = false,
  onSaveLocalIdentity,
  onSaveGlobalIdentity,
  onScopeChange,
}: IdentityPanelProps) {
  const [tab, setTab] = useState<IdentityTab>("local");
  const [editMode, setEditMode] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<GitIdentity>>({});

  const didAutoSelectTabRef = useRef(false);
  const identity = tab === "local" ? localIdentity : globalIdentity;
  const scopeLabel = tab === "local" ? ".git/config" : "~/.gitconfig";
  const isSaving = tab === "local" ? localIdentitySaving : globalIdentitySaving;
  const displayIdentity: GitIdentity = identity ?? {
    name: null,
    email: null,
    signingKey: null,
    signingFormat: null,
    sshKeyPath: null,
  };

  React.useEffect(() => {
    if (!open) return;
    if (didAutoSelectTabRef.current) return;

    const localHasAny = !!(
      localIdentity?.name ||
      localIdentity?.email ||
      localIdentity?.signingKey ||
      localIdentity?.signingFormat ||
      localIdentity?.sshKeyPath
    );
    const globalHasAny = !!(
      globalIdentity?.name ||
      globalIdentity?.email ||
      globalIdentity?.signingKey ||
      globalIdentity?.signingFormat ||
      globalIdentity?.sshKeyPath
    );

    // Prefer repo-local when it's configured; otherwise default to global.
    if (!localHasAny && globalHasAny) {
      setTab("global");
    }

    didAutoSelectTabRef.current = true;
  }, [open, localIdentity, globalIdentity]);

  React.useEffect(() => {
    if (tab === "local" || tab === "global") {
      onScopeChange?.(tab);
    }
  }, [tab, onScopeChange]);

  React.useEffect(() => {
    if (!PROFILES_ENABLED && tab === "profiles") {
      setTab("local");
    }
  }, [tab]);

  // Initialize edit form when entering edit mode
  React.useEffect(() => {
    if (!open) return;
    if (editMode) {
      setEditFormData({
        name: displayIdentity.name ?? "",
        email: displayIdentity.email ?? "",
        signingKey: displayIdentity.signingKey ?? "",
        signingFormat: displayIdentity.signingFormat ?? "",
        sshKeyPath: displayIdentity.sshKeyPath ?? "",
      });
    }
  }, [open, editMode, displayIdentity.name, displayIdentity.email, displayIdentity.signingKey, displayIdentity.signingFormat, displayIdentity.sshKeyPath]);

  if (!open) return null;

  const handleSaveIdentity = async () => {
    const onSave = tab === "local" ? onSaveLocalIdentity : onSaveGlobalIdentity;
    if (!onSave) return;

    try {
      await onSave(editFormData);
      setEditMode(false);
    } catch (e) {
      // Error is handled by the hook
      console.error(e);
    }
  };

  return (
    <>
      <div className="identity-backdrop" onClick={onClose} />
      <div className="identity-panel">
        {/* Header */}
        <div className="identity-panel__header">
          <div className="identity-panel__title">
            <UserIcon /><span>Git Identity</span>
          </div>
          <div className="identity-panel__header-actions">
            <button
              className={`identity-panel__edit-btn ${editMode ? "identity-panel__edit-btn--active" : ""}`}
              onClick={() => setEditMode(!editMode)}
            >
              <EditIcon />{editMode ? "Editing" : "Edit"}
            </button>
            <button className="identity-panel__close-btn" onClick={onClose}><CloseIcon /></button>
          </div>
        </div>

        {/* Tabs */}
        <div className="identity-panel__tabs">
          {([
            { key: "local" as const, label: "Repository", icon: <FolderIcon /> },
            { key: "global" as const, label: "Global", icon: <GlobeIcon /> },
            ...(PROFILES_ENABLED
              ? ([{ key: "profiles" as const, label: "Profiles", icon: <SwapIcon /> }] as const)
              : ([] as const)),
          ]).map(t => (
            <button key={t.key}
              className={`identity-panel__tab ${tab === t.key ? "identity-panel__tab--active" : ""}`}
              onClick={() => setTab(t.key)}>
              {t.icon}{t.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="identity-panel__content">
          {(tab === "local" || tab === "global") && (
            <div className="identity-detail">
              <div className={`identity-detail__scope ${tab === "local" ? "identity-detail__scope--local" : "identity-detail__scope--global"}`}>
                {tab === "local" ? <FolderIcon /> : <GlobeIcon />}
                <span>{scopeLabel}</span>
                {tab === "local" && <span className="identity-detail__override-badge">override</span>}
              </div>

              {!identity && (
                <div className="identity-detail__hint">Loading identity...</div>
              )}

              {!editMode ? (
                <>
                  <div className="identity-detail__field">
                    <div className="identity-detail__label">user.name</div>
                    <div className="identity-detail__value">{displayIdentity.name ?? "Not set"}</div>
                  </div>

                  <div className="identity-detail__field">
                    <div className="identity-detail__label">user.email</div>
                    <div className="identity-detail__email">{displayIdentity.email ?? "Not set"}</div>
                  </div>

                  <div className="identity-detail__divider" />

                  <div className="identity-detail__signing">
                    <div className="identity-detail__signing-header">
                      <ShieldIcon />
                      <span className="identity-detail__signing-label">Commit Signing</span>
                      <span className={`identity-detail__signing-badge ${displayIdentity.signingKey ? "identity-detail__signing-badge--enabled" : ""}`}>
                        {displayIdentity.signingKey ? "enabled" : "disabled"}
                      </span>
                    </div>
                    {displayIdentity.signingKey && (
                      <div className="identity-detail__signing-info">
                        <div className="identity-detail__signing-row">
                          <span>Format</span>
                          <span className={`identity-detail__format-pill ${displayIdentity.signingFormat === "ssh" ? "identity-detail__format-pill--ssh" : ""}`}>
                            {displayIdentity.signingFormat === "ssh" ? "SSH" : "GPG"}
                          </span>
                        </div>
                        <div className="identity-detail__signing-row">
                          <span>{displayIdentity.signingFormat === "ssh" ? "Key" : "Key ID"}</span>
                          <span className="identity-detail__key-value">{displayIdentity.signingKey}</span>
                        </div>
                        {displayIdentity.sshKeyPath && (
                          <div className="identity-detail__signing-row">
                            <span>File</span>
                            <span className="identity-detail__key-value">{displayIdentity.sshKeyPath}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                </>
              ) : (
                <form className="identity-detail__edit-form">
                  <div className="identity-detail__field">
                    <label className="identity-detail__label">user.name</label>
                    <input
                      type="text"
                      className="identity-detail__input"
                      value={editFormData.name ?? ""}
                      onChange={(e) =>
                        setEditFormData({ ...editFormData, name: e.target.value })
                      }
                      disabled={isSaving}
                    />
                  </div>

                  <div className="identity-detail__field">
                    <label className="identity-detail__label">user.email</label>
                    <input
                      type="email"
                      className="identity-detail__input"
                      value={editFormData.email ?? ""}
                      onChange={(e) =>
                        setEditFormData({ ...editFormData, email: e.target.value })
                      }
                      disabled={isSaving}
                    />
                  </div>

                  <div className="identity-detail__divider" />

                  <div className="identity-detail__field">
                    <label className="identity-detail__label">Signing Configuration</label>
                    <div className="identity-detail__signing-form">
                      <div className="identity-detail__form-group">
                        <label className="identity-detail__form-label">user.signingkey</label>
                        <input
                          type="text"
                          className="identity-detail__input"
                          value={editFormData.signingKey ?? ""}
                          onChange={(e) =>
                            setEditFormData({ ...editFormData, signingKey: e.target.value })
                          }
                          disabled={isSaving}
                          placeholder="GPG key ID or SSH key"
                        />
                      </div>

                      <div className="identity-detail__form-group">
                        <label className="identity-detail__form-label">gpg.format</label>
                        <input
                          type="text"
                          className="identity-detail__input"
                          value={editFormData.signingFormat ?? ""}
                          onChange={(e) =>
                            setEditFormData({
                              ...editFormData,
                              signingFormat: e.target.value,
                            })
                          }
                          disabled={isSaving}
                          placeholder="gpg or ssh"
                        />
                      </div>

                      <div className="identity-detail__form-group">
                        <label className="identity-detail__form-label">gpg.ssh.allowedSignersFile</label>
                        <input
                          type="text"
                          className="identity-detail__input"
                          value={editFormData.sshKeyPath ?? ""}
                          onChange={(e) =>
                            setEditFormData({ ...editFormData, sshKeyPath: e.target.value })
                          }
                          disabled={isSaving}
                          placeholder="Path to allowed signers file"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="identity-detail__form-actions">
                    <button
                      type="button"
                      className="identity-detail__form-btn identity-detail__form-btn--cancel"
                      onClick={() => setEditMode(false)}
                      disabled={isSaving}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className={`identity-detail__form-btn identity-detail__form-btn--save ${isSaving ? "identity-detail__form-btn--loading" : ""}`}
                      onClick={handleSaveIdentity}
                      disabled={isSaving}
                    >
                      {isSaving ? "Saving..." : "Save"}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {PROFILES_ENABLED && tab === "profiles" && (
            <div className="identity-profiles">
              <div className="identity-profiles__desc">
                Switch between saved identity profiles for different contexts.
              </div>
              <div className="identity-profiles__placeholder">
                Identity profiles coming soon
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
