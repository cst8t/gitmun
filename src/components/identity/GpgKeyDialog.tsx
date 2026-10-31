import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cancelGpgSigningKeys, listGpgSigningKeys } from "../../api/commands";
import type { GpgSigningKey } from "../../types";
import "./GpgKeyDialog.css";

type GpgKeyDialogProps = {
  repoPath: string;
  currentKey: string | null;
  returnFocus?: HTMLElement | null;
  onCancel: () => void;
  onUseKey: (fingerprint: string) => void;
};

export function GpgKeyDialog({repoPath, currentKey, returnFocus, onCancel, onUseKey}: GpgKeyDialogProps) {
  const { t, i18n } = useTranslation("identity");
  const [keys, setKeys] = useState<GpgSigningKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(currentKey?.replace(/\s/g, "").toUpperCase() ?? "");
  const [revision, setRevision] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const previousFocus = returnFocus ?? document.activeElement as HTMLElement | null;
    searchRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const requestId = crypto.randomUUID();
    let cancelled = false;
    setLoading(true);
    setError(null);
    setKeys([]);
    void listGpgSigningKeys(repoPath, requestId).then(result => {
      if (!cancelled) setKeys(result);
    }).catch(value => {
      if (cancelled) return;
      const code = String(value);
      setError(t(code.includes("GITMUN_ERROR_GPG_UNAVAILABLE") ? "keyChooser.unavailable"
        : code.includes("GITMUN_ERROR_GPG_LIST_TIMEOUT") ? "keyChooser.timeout" : "keyChooser.failed"));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      void cancelGpgSigningKeys(requestId).catch(() => {});
    };
  }, [repoPath, revision, t]);

  const search = query.trim().toLowerCase();
  const visibleKeys = keys.filter(key => key.userIds.some(identity => identity.toLowerCase().includes(search))
    || key.fingerprint.toLowerCase().includes(search.replace(/\s/g, "")));
  const chosenKey = visibleKeys.find(key => key.fingerprint === selected);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Tab") {
      const controls = event.currentTarget.querySelectorAll<HTMLElement>("input:not([disabled]), button:not([disabled])");
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <>
      <div className="dialog-backdrop" onClick={onCancel} />
      <div className="dialog gpg-key-dialog" role="dialog" aria-modal="true" aria-labelledby="gpg-key-dialog-title" onKeyDown={handleKeyDown}>
        <h2 className="dialog__title" id="gpg-key-dialog-title">{t("keyChooser.title")}</h2>
        <label className="dialog__field">
          <span className="dialog__label">{t("keyChooser.search")}</span>
          <input ref={searchRef} className="dialog__input" value={query} onChange={event => setQuery(event.target.value)} placeholder={t("keyChooser.searchPlaceholder")} />
        </label>
        <div className="gpg-key-dialog__keys" aria-busy={loading}>
          {loading ? <p role="status">{t("keyChooser.loading")}</p>
            : error ? <div role="alert" className="dialog__error">{error}</div>
            : !visibleKeys.length ? <p role="status">{t(keys.length ? "keyChooser.noMatches" : "keyChooser.empty")}</p>
            : visibleKeys.map(key => (
              <label key={key.fingerprint} className={`gpg-key-dialog__key ${selected === key.fingerprint ? "gpg-key-dialog__key--selected" : ""}`}>
                <input type="radio" name="gpg-signing-key" value={key.fingerprint} checked={selected === key.fingerprint} onChange={() => setSelected(key.fingerprint)} />
                <span className="gpg-key-dialog__details">
                  <span>{key.userIds[0] || t("keyChooser.unnamed")}</span>
                  <span className="gpg-key-dialog__fingerprint">{key.fingerprint}</span>
                  <span className="gpg-key-dialog__metadata">{t("keyChooser.expiry", {date: key.expiresAt
                    ? new Intl.DateTimeFormat(i18n.resolvedLanguage === "en" ? "en-GB" : i18n.resolvedLanguage, {dateStyle: "long"}).format(new Date(key.expiresAt * 1000)) : t("keyChooser.never")})}</span>
                  {key.hardwareBacked && <span className="gpg-key-dialog__metadata">{t("keyChooser.hardwareKey")}</span>}
                </span>
              </label>
            ))}
        </div>
        <div className="dialog__actions">
          {error && <button type="button" className="dialog__btn dialog__btn--cancel" onClick={() => setRevision(value => value + 1)}>{t("keyChooser.retry")}</button>}
          <button type="button" className="dialog__btn dialog__btn--cancel" onClick={onCancel}>{t("actions.cancel")}</button>
          <button type="button" className={`dialog__btn dialog__btn--confirm ${!chosenKey || loading ? "dialog__btn--disabled" : ""}`} disabled={!chosenKey || loading} onClick={() => chosenKey && onUseKey(chosenKey.fingerprint)}>{t("keyChooser.useKey")}</button>
        </div>
      </div>
    </>
  );
}
