import React, { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { ask, message, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  UserIcon, FolderIcon, GlobeIcon, SwapIcon, ShieldIcon,
  CloseIcon, EditIcon,
} from "../icons";
import {
  addSshSigningKeyToAllowedSigners,
  getSshAllowedSignerStatus,
  getIdentitySigningContext,
  importSshPublicKey,
} from "../../api/commands";
import type { GitIdentity, IdentityChanges, IdentityField, SshAllowedSignerStatus } from "../../types";
import { GpgKeyDialog } from "./GpgKeyDialog";
import "./IdentityPanel.css";

type IdentityTab = "local" | "global" | "profiles";

const PROFILES_ENABLED = false;
const SIGNING_FORMATS = ["openpgp", "ssh", "x509"];

const TEXT_FIELDS = [
  { field: "name", label: "userName", type: "text" },
  { field: "email", label: "userEmail", type: "email" },
  { field: "signingFormat", label: "format", type: "text" },
  { field: "signingKey", label: "signingKey", type: "text" },
  { field: "sshKeyPath", label: "allowedSignersFile", type: "text" },
] as const;

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
  onSaveLocalIdentity?: (payload: IdentityChanges) => Promise<void>;
  onSaveGlobalIdentity?: (payload: IdentityChanges) => Promise<void>;
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
  const [savePending, setSavePending] = useState(false);
  const [filePickerPending, setFilePickerPending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [keyChooserOpen, setKeyChooserOpen] = useState(false);
  const [signingFormat, setSigningFormat] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState(false);
  const keyActionGeneration = useRef(0);
  const keyHelperRef = useRef<HTMLButtonElement>(null);
  const [allowedSignerStatus, setAllowedSignerStatus] = useState<SshAllowedSignerStatus | null>(null);
  const [allowedSignerLoading, setAllowedSignerLoading] = useState(false);

  const didAutoSelectTabRef = useRef(false);
  const identity = tab === "local" ? localIdentity : globalIdentity;
  const scopeLabel = tab === "local" ? ".git/config" : "~/.gitconfig";
  const isSaving = savePending || localIdentitySaving || globalIdentitySaving;
  const isBusy = isSaving || filePickerPending || keyChooserOpen;
  const displayIdentity: GitIdentity = identity ?? {
    name: null,
    email: null,
    signingKey: null,
    signingFormat: null,
    sshKeyPath: null,
    commitSigningEnabled: null,
  };
  const formIdentity = { ...displayIdentity, ...editFormData };
  const hasOverrides = Object.values(displayIdentity).some(value => value !== null);
  const absentLabel = tab === "local" ? t("labels.noRepositoryOverride") : t("labels.notConfigured");
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

    if (!localIdentity || !globalIdentity) return;
    const localHasAny = Object.values(localIdentity).some(value => value !== null);
    const globalHasAny = Object.values(globalIdentity).some(value => value !== null);

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

  React.useEffect(() => {
    setEditMode(false);
    setEditFormData({});
    setSaveError(null);
  }, [open, repoPath, tab]);

  React.useEffect(() => {
    keyActionGeneration.current += 1;
    setKeyChooserOpen(false);
    setSigningFormat(null);
    setContextError(false);
    if (!open || !editMode || !repoPath || !activeScope) {
      setContextLoading(false);
      return;
    }
    let cancelled = false;
    const draft = editFormData.signingFormat;
    setContextLoading(true);
    void getIdentitySigningContext({
      repoPath,
      scope: activeScope,
      signingFormat: draft,
      clearSigningFormat: draft === null || (draft !== undefined && !draft.trim()),
    }).then(context => {
      if (!cancelled) setSigningFormat(context.format.trim().toLowerCase());
    }).catch(() => {
      if (!cancelled) setContextError(true);
    }).finally(() => {
      if (!cancelled) setContextLoading(false);
    });
    return () => { cancelled = true; };
  }, [open, editMode, repoPath, activeScope, displayIdentity.signingFormat, editFormData.signingFormat]);

  const closePanel = () => {
    if (isBusy) return;
    setEditMode(false);
    setEditFormData({});
    setSaveError(null);
    onClose();
  };

  if (!open) return null;

  const handleBrowseAllowedSigners = async () => {
    setFilePickerPending(true);
    setSaveError(null);
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: t("picker.allowedSignersFile"),
        defaultPath: formIdentity.sshKeyPath || undefined,
      });
      if (typeof selected === "string") {
        setEditFormData(current => ({...current, sshKeyPath: selected}));
      }
    } catch {
      setSaveError(t("errors.filePickerFailed"));
    } finally {
      setFilePickerPending(false);
    }
  };

  const handleImportSshKey = async () => {
    const generation = keyActionGeneration.current;
    setFilePickerPending(true);
    setSaveError(null);
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: t("picker.sshPublicKey"),
        filters: [
          {name: t("picker.publicKeyFiles"), extensions: ["pub"]},
          {name: t("picker.allFiles"), extensions: ["*"]},
        ],
      });
      if (typeof selected !== "string" || generation !== keyActionGeneration.current) return;
      const key = await importSshPublicKey(selected);
      if (generation === keyActionGeneration.current) {
        setEditFormData(current => ({...current, signingKey: key}));
      }
    } catch (error) {
      if (generation !== keyActionGeneration.current) return;
      const code = String(error);
      const known = ["PRIVATE", "INVALID", "MULTIPLE", "TOO_LARGE", "READ_FAILED"]
        .find(reason => code.includes(`GITMUN_ERROR_SSH_KEY_${reason}`));
      setSaveError(t(known ? `keyImport.errors.${known}` : "keyImport.failed"));
    } finally {
      setFilePickerPending(false);
    }
  };

  const handleSaveIdentity = async () => {
    const onSave = tab === "local" ? onSaveLocalIdentity : onSaveGlobalIdentity;
    if (!onSave) return;

    const payload: IdentityChanges = {};
    const clearFields: IdentityField[] = [];
    for (const {field} of TEXT_FIELDS) {
      const value = editFormData[field];
      if (value === undefined) continue;
      if (value === null || !value.trim()) {
        clearFields.push(field);
      } else if (value !== displayIdentity[field]) {
        payload[field] = value;
      }
    }
    if (editFormData.commitSigningEnabled === null) {
      clearFields.push("commitSigningEnabled");
    } else if (editFormData.commitSigningEnabled !== undefined
      && editFormData.commitSigningEnabled !== displayIdentity.commitSigningEnabled) {
      payload.commitSigningEnabled = editFormData.commitSigningEnabled;
    }
    if (clearFields.length) payload.clearFields = clearFields;

    setSavePending(true);
    setSaveError(null);
    try {
      if (Object.keys(payload).length) await onSave(payload);
    } catch {
      setSaveError(t("errors.saveFailed"));
      setSavePending(false);
      return;
    }

    setEditMode(false);
    setEditFormData({});
    try {
      const configuredSigning = payload.commitSigningEnabled === true
        || !!(payload.signingKey || payload.signingFormat || payload.sshKeyPath);
      if (!configuredSigning || !repoPath || !activeScope || (signingFormat ?? formIdentity.signingFormat) !== "ssh") return;

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
    } finally {
      setSavePending(false);
    }
  };

  return (
    <>
      <div className="identity-backdrop" onClick={closePanel} />
      <div className="identity-panel">
        {/* Header */}
        <div className="identity-panel__header">
          <div className="identity-panel__title">
            <UserIcon /><span>{t("labels.gitIdentity")}</span>
          </div>
          <div className="identity-panel__header-actions">
            <button
              className={`identity-panel__edit-btn ${editMode ? "identity-panel__edit-btn--active" : ""}`}
              onClick={() => {
                setEditFormData({});
                setSaveError(null);
                setEditMode(!editMode);
              }}
              disabled={isBusy || !identity}
            >
              <EditIcon />{editMode ? t("labels.editing") : t("labels.edit")}
            </button>
            <button className="identity-panel__close-btn" onClick={closePanel} disabled={isBusy} aria-label={t("common:actions.close")}><CloseIcon /></button>
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
              disabled={isBusy}
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
                {tab === "local" && hasOverrides && <span className="identity-detail__override-badge">{t("labels.override")}</span>}
              </div>

              {!identity && (
                <div className="identity-detail__hint">{t("labels.loading")}</div>
              )}

              {!editMode ? (
                <>
                  <div className="identity-detail__field">
                    <div className="identity-detail__label">{t("labels.userName")}</div>
                    <div className="identity-detail__value">{displayIdentity.name ?? absentLabel}</div>
                  </div>

                  <div className="identity-detail__field">
                    <div className="identity-detail__label">{t("labels.userEmail")}</div>
                    <div className="identity-detail__email">{displayIdentity.email ?? absentLabel}</div>
                  </div>

                  <div className="identity-detail__divider" />

                  <div className="identity-detail__signing">
                    <div className="identity-detail__signing-header">
                      <ShieldIcon />
                      <span className="identity-detail__signing-label">{t("labels.commitSigning")}</span>
                      <span className={`identity-detail__signing-badge ${displayIdentity.commitSigningEnabled === null ? "identity-detail__signing-badge--inherited" : displayIdentity.commitSigningEnabled ? "identity-detail__signing-badge--enabled" : ""}`}>
                        {displayIdentity.commitSigningEnabled === null ? absentLabel : displayIdentity.commitSigningEnabled ? t("labels.enabled") : t("labels.disabled")}
                      </span>
                    </div>
                    <div className="identity-detail__signing-info">
                      <div className="identity-detail__signing-row">
                        <span>{t("labels.format")}</span>
                        <span className={displayIdentity.signingFormat === null ? "identity-detail__key-value" : `identity-detail__format-pill ${displayIdentity.signingFormat === "ssh" ? "identity-detail__format-pill--ssh" : ""}`}>
                          {displayIdentity.signingFormat ?? absentLabel}
                        </span>
                      </div>
                      <div className="identity-detail__signing-row">
                        <span>{displayIdentity.signingFormat === "ssh" ? t("labels.key") : t("labels.keyId")}</span>
                        <span className="identity-detail__key-value">{displayIdentity.signingKey ?? absentLabel}</span>
                      </div>
                      <div className="identity-detail__signing-row">
                        <span>{t("labels.file")}</span>
                        <span className="identity-detail__key-value">{displayIdentity.sshKeyPath ?? absentLabel}</span>
                      </div>
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
                              disabled={allowedSignerLoading || isBusy}
                            >
                              {allowedSignerLoading ? t("allowedSigners.adding") : t("allowedSigners.add")}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                </>
              ) : (
                <form className="identity-detail__edit-form">
                  {tab === "local" && (
                    <>
                      <p className="identity-detail__reset-note">{t("notes.repositoryReset")}</p>
                      <button
                        type="button"
                        className="identity-detail__form-btn"
                        disabled={isBusy}
                        onClick={() => setEditFormData({
                          name: null, email: null, signingKey: null,
                          signingFormat: null, sshKeyPath: null, commitSigningEnabled: null,
                        })}
                      >
                        {t("actions.clearRepositoryOverrides")}
                      </button>
                    </>
                  )}
                  {TEXT_FIELDS.map(({field, label, type}) => (
                    <React.Fragment key={field}>
                      {field === "signingFormat" && (
                        <>
                          <div className="identity-detail__divider" />
                          <label className="identity-detail__form-group">
                            <span className="identity-detail__label">{t("labels.commitSigning")}</span>
                            <select
                              className="identity-detail__input"
                              value={formIdentity.commitSigningEnabled === null ? "inherit" : String(formIdentity.commitSigningEnabled)}
                              onChange={event => setEditFormData({
                                ...editFormData,
                                commitSigningEnabled: event.target.value === "inherit" ? null : event.target.value === "true",
                              })}
                              disabled={isBusy}
                            >
                              <option value="inherit">{tab === "local" ? t("actions.useInheritedSetting") : t("labels.notConfigured")}</option>
                              <option value="true">{t("labels.enabled")}</option>
                              <option value="false">{t("labels.disabled")}</option>
                            </select>
                          </label>
                        </>
                      )}
                      <div className="identity-detail__form-group">
                        <div className="identity-detail__field-heading">
                          <label className="identity-detail__label" htmlFor={`identity-${field}`}>{t(`labels.${label}`)}</label>
                          {tab === "local" && (
                            <button
                              type="button"
                              className="identity-detail__inherit-btn"
                              aria-label={t("actions.inheritField", {field: t(`labels.${label}`)})}
                              disabled={isBusy || formIdentity[field] === null}
                              onClick={() => setEditFormData({...editFormData, [field]: null})}
                            >
                              {t("actions.useInheritedSetting")}
                            </button>
                          )}
                        </div>
                        <div className="identity-detail__input-row">
                          {field === "signingFormat" ? (
                            <select
                              id={`identity-${field}`}
                              className="identity-detail__input"
                              value={formIdentity.signingFormat ?? ""}
                              onChange={event => setEditFormData({...editFormData, signingFormat: event.target.value || null})}
                              disabled={isBusy}
                            >
                              <option value="">{tab === "local" ? t("actions.useInheritedSetting") : t("labels.notConfigured")}</option>
                              {SIGNING_FORMATS.map(format => <option key={format} value={format}>{t(`formats.${format}`)}</option>)}
                              {formIdentity.signingFormat && !SIGNING_FORMATS.includes(formIdentity.signingFormat) && (
                                <option value={formIdentity.signingFormat}>{t("formats.current", {format: formIdentity.signingFormat})}</option>
                              )}
                            </select>
                          ) : (
                            <input
                              id={`identity-${field}`}
                              type={type}
                              className="identity-detail__input"
                              value={formIdentity[field] ?? ""}
                              placeholder={absentLabel}
                              onChange={event => setEditFormData({...editFormData, [field]: event.target.value})}
                              disabled={isBusy}
                            />
                          )}
                          {field === "signingKey" && (signingFormat === "ssh" || signingFormat === "openpgp") && (
                            <button
                              type="button"
                              className="identity-detail__browse-btn"
                              ref={keyHelperRef}
                              disabled={isBusy || contextLoading}
                              onClick={signingFormat === "ssh" ? handleImportSshKey : () => setKeyChooserOpen(true)}
                            >
                              {t(signingFormat === "ssh" ? "actions.importPublicKey" : "actions.chooseKey")}
                            </button>
                          )}
                          {field === "sshKeyPath" && (
                            <button
                              type="button"
                              className="identity-detail__browse-btn"
                              title={t("actions.browseAllowedSigners")}
                              aria-label={t("actions.browseAllowedSigners")}
                              disabled={isBusy}
                              onClick={handleBrowseAllowedSigners}
                            >
                              <FolderIcon />
                            </button>
                          )}
                        </div>
                        {field === "signingFormat" && contextLoading && <p className="identity-detail__reset-note" role="status">{t("notes.detectingFormat")}</p>}
                        {field === "signingFormat" && contextError && <p className="identity-detail__save-error" role="alert">{t("notes.formatUnavailable")}</p>}
                        {field === "signingFormat" && formIdentity.signingFormat === null && signingFormat && <p className="identity-detail__reset-note">{t("notes.inheritedFormat", {format: signingFormat})}</p>}
                        {field === "signingKey" && signingFormat === "ssh" && formIdentity.signingKey?.startsWith("key::") && <p className="identity-detail__reset-note">{t("notes.sshAgent")}</p>}
                      </div>
                    </React.Fragment>
                  ))}
                  {saveError && <div className="identity-detail__save-error" role="alert">{saveError}</div>}

                  <div className="identity-detail__form-actions">
                    <button
                      type="button"
                      className="identity-detail__form-btn identity-detail__form-btn--cancel"
                      onClick={() => setEditMode(false)}
                      disabled={isBusy}
                    >
                      {t("actions.cancel")}
                    </button>
                    <button
                      type="button"
                      className={`identity-detail__form-btn identity-detail__form-btn--save ${isSaving ? "identity-detail__form-btn--loading" : ""}`}
                      onClick={handleSaveIdentity}
                      disabled={isBusy}
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
      {keyChooserOpen && editMode && repoPath && signingFormat === "openpgp" && (
        <GpgKeyDialog
          repoPath={repoPath}
          currentKey={formIdentity.signingKey ?? null}
          returnFocus={keyHelperRef.current}
          onCancel={() => setKeyChooserOpen(false)}
          onUseKey={fingerprint => {
            setEditFormData(current => ({...current, signingKey: fingerprint}));
            setKeyChooserOpen(false);
          }}
        />
      )}
    </>
  );
}
