import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { ask, message } from "@tauri-apps/plugin-dialog";
import {
  UserIcon, FolderIcon, GlobeIcon, SwapIcon, ShieldIcon,
  CloseIcon, EditIcon,
} from "../icons";
import {
  addSshSigningKeyToAllowedSigners,
  getSshAllowedSignerStatus,
} from "../../api/commands";
import type { GitIdentity, SshAllowedSignerStatus } from "../../types";
import "./IdentityPanel.css";

type IdentityTab = "local" | "global" | "profiles";

const PROFILES_ENABLED = false;

const ALLOWED_SIGNERS_ERROR_CODES = [
  "GITMUN_ERROR_SSH_ALLOWED_SIGNERS_HOME_UNAVAILABLE",
  "GITMUN_ERROR_SSH_ALLOWED_SIGNERS_MISSING_EMAIL",
  "GITMUN_ERROR_SSH_ALLOWED_SIGNERS_NO_TARGET",
  "GITMUN_ERROR_SSH_ALLOWED_SIGNERS_SIGNING_KEY_MISSING",
  "GITMUN_ERROR_SSH_ALLOWED_SIGNERS_SIGNING_KEY_UNRESOLVED",
] as const;

type AllowedSignersErrorCode = typeof ALLOWED_SIGNERS_ERROR_CODES[number];

function extractAllowedSignersErrorCode(value: unknown): AllowedSignersErrorCode | null {
  const message = String(value);
  return ALLOWED_SIGNERS_ERROR_CODES.find(code => message.includes(code)) ?? null;
}

type IdentityPanelProps = {
  open: boolean;
  onClose: () => void;
  repoPath: string | null;
  localIdentity: GitIdentity | null;
  globalIdentity: GitIdentity | null;
  localIdentitySaving?: boolean;
  globalIdentitySaving?: boolean;
  onSaveLocalIdentity?: (payload: Partial<GitIdentity>) => Promise<void>;
  onSaveGlobalIdentity?: (payload: Partial<GitIdentity>) => Promise<void>;
  onRefreshLocalIdentity?: () => Promise<void>;
  onRefreshGlobalIdentity?: () => Promise<void>;
  onScopeChange?: (scope: "local" | "global") => void;
};

export function IdentityPanel({
  open,
  onClose,
  repoPath,
  localIdentity,
  globalIdentity,
  localIdentitySaving = false,
  globalIdentitySaving = false,
  onSaveLocalIdentity,
  onSaveGlobalIdentity,
  onRefreshLocalIdentity,
  onRefreshGlobalIdentity,
  onScopeChange,
}: IdentityPanelProps) {
  const { t } = useTranslation("identity");
  const [tab, setTab] = useState<IdentityTab>("local");
  const [editMode, setEditMode] = useState(false);
  const [editFormData, setEditFormData] = useState<Partial<GitIdentity>>({});
  const [allowedSignerStatus, setAllowedSignerStatus] = useState<SshAllowedSignerStatus | null>(null);
  const [allowedSignerLoading, setAllowedSignerLoading] = useState(false);

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
    commitSigningEnabled: false,
  };
  const activeScope = tab === "local" ? "Local" : tab === "global" ? "Global" : null;
  const allowedSignersErrorMessage = React.useCallback((value: unknown) => {
    const code = extractAllowedSignersErrorCode(value);
    return code ? t(`allowedSigners.errors.${code}`) : String(value);
  }, [t]);

  const refreshAllowedSignerStatus = React.useCallback(async () => {
    if (!open || !repoPath || !activeScope || displayIdentity.signingFormat !== "ssh") {
      setAllowedSignerStatus(null);
      return null;
    }

    setAllowedSignerLoading(true);
    try {
      const status = await getSshAllowedSignerStatus(repoPath, activeScope);
      setAllowedSignerStatus(status);
      return status;
    } finally {
      setAllowedSignerLoading(false);
    }
  }, [activeScope, displayIdentity.signingFormat, open, repoPath]);

  const addAllowedSigner = React.useCallback(async () => {
    if (!repoPath || !activeScope) return;
    await addSshSigningKeyToAllowedSigners(repoPath, activeScope);
    await (activeScope === "Local" ? onRefreshLocalIdentity?.() : onRefreshGlobalIdentity?.());
    await refreshAllowedSignerStatus();
    await emit("signature-settings-updated");
  }, [activeScope, onRefreshGlobalIdentity, onRefreshLocalIdentity, refreshAllowedSignerStatus, repoPath]);

  React.useEffect(() => {
    if (!open) return;
    if (didAutoSelectTabRef.current) return;

    const localHasAny = !!(
      localIdentity?.name ||
      localIdentity?.email ||
      localIdentity?.signingKey ||
      localIdentity?.signingFormat ||
      localIdentity?.sshKeyPath ||
      localIdentity?.commitSigningEnabled
    );
    const globalHasAny = !!(
      globalIdentity?.name ||
      globalIdentity?.email ||
      globalIdentity?.signingKey ||
      globalIdentity?.signingFormat ||
      globalIdentity?.sshKeyPath ||
      globalIdentity?.commitSigningEnabled
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

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!open || !repoPath || !activeScope || displayIdentity.signingFormat !== "ssh") {
        if (!cancelled) setAllowedSignerStatus(null);
        return;
      }

      setAllowedSignerLoading(true);
      try {
        const status = await getSshAllowedSignerStatus(repoPath, activeScope);
        if (!cancelled) setAllowedSignerStatus(status);
      } finally {
        if (!cancelled) setAllowedSignerLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activeScope, displayIdentity.signingFormat, displayIdentity.signingKey, displayIdentity.sshKeyPath, open, repoPath]);

  // Initialise edit form when entering edit mode
  React.useEffect(() => {
    if (!open) return;
    if (editMode) {
      setEditFormData({
        name: displayIdentity.name ?? "",
        email: displayIdentity.email ?? "",
        signingKey: displayIdentity.signingKey ?? "",
        signingFormat: displayIdentity.signingFormat ?? "",
        sshKeyPath: displayIdentity.sshKeyPath ?? "",
        commitSigningEnabled: displayIdentity.commitSigningEnabled ?? false,
      });
    }
  }, [open, editMode, displayIdentity.name, displayIdentity.email, displayIdentity.signingKey, displayIdentity.signingFormat, displayIdentity.sshKeyPath, displayIdentity.commitSigningEnabled]);

  if (!open) return null;

  const handleSaveIdentity = async () => {
    const onSave = tab === "local" ? onSaveLocalIdentity : onSaveGlobalIdentity;
    if (!onSave) return;

    try {
      await onSave(editFormData);
      setEditMode(false);
      if (!repoPath || !activeScope) return;

      const status = await getSshAllowedSignerStatus(repoPath, activeScope);
      setAllowedSignerStatus(status);
      if (status.blockingReason) {
        await message(allowedSignersErrorMessage(status.blockingReason), {
          title: t("allowedSigners.setupBlockedTitle"),
          kind: "error",
        });
        return;
      }
      if (!status.setupNeeded) return;

      const confirmed = await ask(
        t("allowedSigners.prompt", {path: status.targetPath}),
        {
          title: t("allowedSigners.promptTitle"),
          kind: "info",
          okLabel: t("allowedSigners.add"),
          cancelLabel: t("allowedSigners.notNow"),
        },
      );
      if (!confirmed) return;

      await addAllowedSigner();
    } catch (e) {
      await message(allowedSignersErrorMessage(e), {
        title: t("allowedSigners.setupFailedTitle"),
        kind: "error",
      });
    }
  };

  return (
    <>
      <div className="identity-backdrop" onClick={onClose} />
      <div className="identity-panel">
        {/* Header */}
        <div className="identity-panel__header">
          <div className="identity-panel__title">
            <UserIcon /><span>{t("labels.gitIdentity")}</span>
          </div>
          <div className="identity-panel__header-actions">
            <button
              className={`identity-panel__edit-btn ${editMode ? "identity-panel__edit-btn--active" : ""}`}
              onClick={() => setEditMode(!editMode)}
            >
              <EditIcon />{editMode ? t("labels.editing") : t("labels.edit")}
            </button>
            <button className="identity-panel__close-btn" onClick={onClose}><CloseIcon /></button>
          </div>
        </div>

        {/* Tabs */}
        <div className="identity-panel__tabs">
          {([
            { key: "local" as const, label: t("labels.repository"), icon: <FolderIcon /> },
            { key: "global" as const, label: t("labels.global"), icon: <GlobeIcon /> },
            ...(PROFILES_ENABLED
              ? ([{ key: "profiles" as const, label: t("labels.profiles"), icon: <SwapIcon /> }] as const)
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
                {tab === "local" && <span className="identity-detail__override-badge">{t("labels.override")}</span>}
              </div>

              {!identity && (
                <div className="identity-detail__hint">{t("labels.loading")}</div>
              )}

              {!editMode ? (
                <>
                  <div className="identity-detail__field">
                    <div className="identity-detail__label">{t("labels.userName")}</div>
                    <div className="identity-detail__value">{displayIdentity.name ?? t("common:generic.none")}</div>
                  </div>

                  <div className="identity-detail__field">
                    <div className="identity-detail__label">{t("labels.userEmail")}</div>
                    <div className="identity-detail__email">{displayIdentity.email ?? t("common:generic.none")}</div>
                  </div>

                  <div className="identity-detail__divider" />

                  <div className="identity-detail__signing">
                    <div className="identity-detail__signing-header">
                      <ShieldIcon />
                      <span className="identity-detail__signing-label">{t("labels.commitSigning")}</span>
                      <span className={`identity-detail__signing-badge ${displayIdentity.commitSigningEnabled ? "identity-detail__signing-badge--enabled" : ""}`}>
                        {displayIdentity.commitSigningEnabled ? t("labels.enabled") : t("labels.disabled")}
                      </span>
                    </div>
                    {(displayIdentity.signingKey || displayIdentity.signingFormat === "ssh") && (
                      <div className="identity-detail__signing-info">
                        <div className="identity-detail__signing-row">
                          <span>{t("labels.format")}</span>
                          <span className={`identity-detail__format-pill ${displayIdentity.signingFormat === "ssh" ? "identity-detail__format-pill--ssh" : ""}`}>
                            {displayIdentity.signingFormat === "ssh" ? "SSH" : "GPG"}
                          </span>
                        </div>
                        {displayIdentity.signingKey && (
                          <div className="identity-detail__signing-row">
                            <span>{displayIdentity.signingFormat === "ssh" ? t("labels.key") : t("labels.keyId")}</span>
                            <span className="identity-detail__key-value">{displayIdentity.signingKey}</span>
                          </div>
                        )}
                        {displayIdentity.sshKeyPath && (
                          <div className="identity-detail__signing-row">
                            <span>{t("labels.file")}</span>
                            <span className="identity-detail__key-value">{displayIdentity.sshKeyPath}</span>
                          </div>
                        )}
                        {displayIdentity.signingFormat === "ssh" && (
                          <div className="identity-detail__allowed-signers">
                            <div className="identity-detail__signing-row">
                              <span>{t("allowedSigners.configured")}</span>
                              <span>{allowedSignerStatus?.allowedSignersConfigured ? t("allowedSigners.yes") : t("allowedSigners.no")}</span>
                            </div>
                            <div className="identity-detail__signing-row">
                              <span>{t("allowedSigners.exists")}</span>
                              <span>{allowedSignerStatus?.allowedSignersExists ? t("allowedSigners.yes") : t("allowedSigners.no")}</span>
                            </div>
                            {allowedSignerStatus?.targetPath && (
                              <div className="identity-detail__signing-row">
                                <span>{t("allowedSigners.path")}</span>
                                <span className="identity-detail__key-value">{allowedSignerStatus.targetPath}</span>
                              </div>
                            )}
                            <div className="identity-detail__signing-row">
                              <span>{t("allowedSigners.keyTrusted")}</span>
                              <span>{allowedSignerStatus?.signingKeyTrusted ? t("allowedSigners.yes") : t("allowedSigners.no")}</span>
                            </div>
                            {allowedSignerStatus?.setupNeeded && (
                              <button
                                type="button"
                                className="identity-detail__allowed-signers-btn"
                                onClick={addAllowedSigner}
                                disabled={allowedSignerLoading}
                              >
                                {allowedSignerLoading ? t("allowedSigners.adding") : t("allowedSigners.add")}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                </>
              ) : (
                <form className="identity-detail__edit-form">
                  <div className="identity-detail__field">
                    <label className="identity-detail__label">{t("labels.userName")}</label>
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
                    <label className="identity-detail__label">{t("labels.userEmail")}</label>
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
                    <label className="identity-detail__label">{t("labels.signingConfiguration")}</label>
                    <div className="identity-detail__signing-form">
                      <label className="identity-detail__toggle-row">
                        <span className="identity-detail__form-label">commit.gpgsign</span>
                        <input
                          type="checkbox"
                          className="identity-detail__toggle-input"
                          checked={!!editFormData.commitSigningEnabled}
                          onChange={(e) =>
                            setEditFormData({ ...editFormData, commitSigningEnabled: e.target.checked })
                          }
                          disabled={isSaving}
                        />
                      </label>

                      <div className="identity-detail__form-group">
                        <label className="identity-detail__form-label">{t("labels.signingKey")}</label>
                        <input
                          type="text"
                          className="identity-detail__input"
                          value={editFormData.signingKey ?? ""}
                          onChange={(e) =>
                            setEditFormData({
                              ...editFormData,
                              signingKey: e.target.value,
                              commitSigningEnabled: e.target.value.trim()
                                ? true
                                : editFormData.commitSigningEnabled,
                            })
                          }
                          disabled={isSaving}
                          placeholder={t("placeholders.signingKey")}
                        />
                      </div>

                      <div className="identity-detail__form-group">
                        <label className="identity-detail__form-label">{t("labels.format")}</label>
                        <input
                          type="text"
                          className="identity-detail__input"
                          value={editFormData.signingFormat ?? ""}
                          onChange={(e) =>
                            setEditFormData({
                              ...editFormData,
                              signingFormat: e.target.value,
                              commitSigningEnabled: e.target.value.trim()
                                ? true
                                : editFormData.commitSigningEnabled,
                            })
                          }
                          disabled={isSaving}
                          placeholder={t("placeholders.format")}
                        />
                      </div>

                      <div className="identity-detail__form-group">
                        <label className="identity-detail__form-label">{t("labels.allowedSignersFile")}</label>
                        <input
                          type="text"
                          className="identity-detail__input"
                          value={editFormData.sshKeyPath ?? ""}
                          onChange={(e) =>
                            setEditFormData({
                              ...editFormData,
                              sshKeyPath: e.target.value,
                              commitSigningEnabled: e.target.value.trim()
                                ? true
                                : editFormData.commitSigningEnabled,
                            })
                          }
                          disabled={isSaving}
                          placeholder={t("placeholders.allowedSignersFile")}
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
                      {t("actions.cancel")}
                    </button>
                    <button
                      type="button"
                      className={`identity-detail__form-btn identity-detail__form-btn--save ${isSaving ? "identity-detail__form-btn--loading" : ""}`}
                      onClick={handleSaveIdentity}
                      disabled={isSaving}
                    >
                      {isSaving ? t("actions.saving") : t("actions.save")}
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}

          {PROFILES_ENABLED && tab === "profiles" && (
            <div className="identity-profiles">
              <div className="identity-profiles__desc">
                {t("profiles.description")}
              </div>
              <div className="identity-profiles__placeholder">
                {t("profiles.comingSoon")}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
