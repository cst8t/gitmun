import {useEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import {CloseIcon} from "../../components/icons";
import type {AiConflictProposalResult} from "./types";
import "./ai.css";

type Props = {
    proposal: AiConflictProposalResult;
    applying: boolean;
    onApply: (regionIds: string[]) => Promise<void>;
    onRegenerate: (regionIds?: string[]) => Promise<void>;
    onUndo: () => Promise<void>;
    onClose: () => void;
};

export function AiConflictProposalDialog({proposal, applying, onApply, onRegenerate, onUndo, onClose}: Props) {
    const {t} = useTranslation("ai");
    const [selectedIds, setSelectedIds] = useState(() => proposal.regions.map(region => region.id));
    const [hasApplied, setHasApplied] = useState(false);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        closeButtonRef.current?.focus();
    }, []);

    useEffect(() => {
        setSelectedIds(proposal.regions.map(region => region.id));
        setHasApplied(false);
    }, [proposal]);

    const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
    const toggleRegion = (id: string) => {
        setSelectedIds(current => current.includes(id)
            ? current.filter(currentId => currentId !== id)
            : [...current, id]);
    };

    const apply = async () => {
        await onApply(selectedIds);
        setHasApplied(true);
    };

    return (
        <div className="ai-dialog-backdrop" role="presentation">
            <section className="ai-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-conflict-title">
                <header className="ai-dialog__header">
                    <div>
                        <h2 id="ai-conflict-title">{t("conflict.title")}</h2>
                        <p>{proposal.filePath}</p>
                    </div>
                    <button className="ai-dialog__close" ref={closeButtonRef} type="button" onClick={onClose} aria-label={t("actions.close")}>
                        <CloseIcon/>
                    </button>
                </header>

                <div className="ai-dialog__content">
                    {proposal.regions.map((region, index) => (
                        <article className="ai-conflict-region" key={region.id}>
                            <label className="ai-conflict-region__choice">
                                <input
                                    type="checkbox"
                                    checked={selected.has(region.id)}
                                    onChange={() => toggleRegion(region.id)}
                                    disabled={applying}
                                />
                                {t("conflict.region", {count: index + 1})}
                            </label>
                            <div className="ai-conflict-region__versions">
                                <ConflictVersion label={t("conflict.original")} value={region.original}/>
                                <ConflictVersion label={t("conflict.ours")} value={region.ours}/>
                                <ConflictVersion label={t("conflict.theirs")} value={region.theirs}/>
                                {region.ancestor !== null && (
                                    <ConflictVersion label={t("conflict.ancestor")} value={region.ancestor}/>
                                )}
                                <ConflictVersion label={t("conflict.proposed")} value={region.proposed}/>
                            </div>
                            {region.explanation && (
                                <details>
                                    <summary>{t("conflict.explanation")}</summary>
                                    <p>{region.explanation}</p>
                                </details>
                            )}
                            <button type="button" onClick={() => onRegenerate([region.id])} disabled={applying}>
                                {t("actions.regenerateRegion")}
                            </button>
                        </article>
                    ))}
                </div>

                <footer className="ai-dialog__actions" aria-live="polite">
                    <button type="button" onClick={onClose} disabled={applying}>{t("actions.discard")}</button>
                    <button type="button" onClick={() => onRegenerate()} disabled={applying}>{t("actions.regenerate")}</button>
                    {hasApplied && (
                        <button type="button" onClick={onUndo} disabled={applying}>{t("actions.undo")}</button>
                    )}
                    <button className="ai-dialog__button--primary" type="button" onClick={apply} disabled={applying || selectedIds.length === 0}>
                        {applying ? t("actions.applying") : t("actions.applySelected", {count: selectedIds.length})}
                    </button>
                </footer>
            </section>
        </div>
    );
}

function ConflictVersion({label, value}: {label: string; value: string}) {
    return (
        <section>
            <h3>{label}</h3>
            <pre>{value}</pre>
        </section>
    );
}
