import {type KeyboardEvent, useEffect, useMemo, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import {CheckIcon} from "../../components/icons";
import type {AiConflictOperation, AiConflictResolutionResult, AiConflictReviewItem} from "./types";
import "./ai.css";

type Props = {
    items: AiConflictReviewItem[];
    operation: AiConflictOperation;
    onApply: (proposalId: string, regionIds: string[]) => Promise<AiConflictResolutionResult>;
    onRegenerate: (proposalId: string, regionIds?: string[]) => Promise<void>;
    onRetry: (filePath: string) => Promise<void>;
    onUndo: (proposalId: string) => Promise<void>;
    onClose: () => void;
};

type ConflictVersionKind = "original" | "ours" | "theirs" | "ancestor" | "proposed";

function initialRegionSelections(items: AiConflictReviewItem[]): Record<string, string[]> {
    return Object.fromEntries(items.flatMap(item => item.status === "ready" ? [[
        item.proposal.proposalId,
        item.proposal.regions.map(region => region.id),
    ]] : []));
}

export function AiConflictProposalDialog({items, operation, onApply, onRegenerate, onRetry, onUndo, onClose}: Props) {
    const {t} = useTranslation("ai");
    const [selectedIdsByProposal, setSelectedIdsByProposal] = useState(() => initialRegionSelections(items));
    const [appliedIdsByProposal, setAppliedIdsByProposal] = useState<Record<string, string[]>>({});
    const [resolvedByProposal, setResolvedByProposal] = useState<Record<string, boolean>>({});
    const [activeFilePath, setActiveFilePath] = useState(() => items[0]?.filePath ?? "");
    const firstProposal = items.find(item => item.status === "ready")?.proposal;
    const [activeRegionId, setActiveRegionId] = useState(() => firstProposal?.regions[0]?.id ?? "");
    const dialogRef = useRef<HTMLElement>(null);
    const previousFocusRef = useRef<HTMLElement | null>(null);
    const regionTabRefs = useRef<Array<HTMLButtonElement | null>>([]);

    useEffect(() => {
        previousFocusRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        dialogRef.current?.focus();
        return () => {
            if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
        };
    }, []);

    useEffect(() => {
        const readyProposals = items.flatMap(item => item.status === "ready" ? [item.proposal] : []);
        setSelectedIdsByProposal(current => Object.fromEntries(readyProposals.map(proposal => [
            proposal.proposalId,
            current[proposal.proposalId] ?? proposal.regions.map(region => region.id),
        ])));
        setAppliedIdsByProposal(current => Object.fromEntries(readyProposals.map(proposal => [
            proposal.proposalId,
            current[proposal.proposalId] ?? [],
        ])));
        setActiveFilePath(current => items.some(item => item.filePath === current)
            ? current
            : items[0]?.filePath ?? "");
    }, [items]);

    const proposals = items.flatMap(item => item.status === "ready" ? [item.proposal] : []);
    const activeItemIndex = Math.max(0, items.findIndex(item => item.filePath === activeFilePath));
    const activeItem = items[activeItemIndex];
    const activeProposal = activeItem?.status === "ready" ? activeItem.proposal : undefined;
    const selectedIds = activeProposal ? selectedIdsByProposal[activeProposal.proposalId] ?? [] : [];
    const appliedIds = activeProposal ? appliedIdsByProposal[activeProposal.proposalId] ?? [] : [];
    const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
    const applied = useMemo(() => new Set(appliedIds), [appliedIds]);
    const busy = operation !== null;
    const hasApplied = appliedIds.length > 0;
    const markedResolved = activeProposal ? resolvedByProposal[activeProposal.proposalId] ?? false : false;
    const anyApplied = Object.values(appliedIdsByProposal).some(ids => ids.length > 0);
    const allApplied = !!activeProposal
        && activeProposal.regions.length > 0
        && appliedIds.length === activeProposal.regions.length;
    const allFilesApplied = items.length > 0 && items.every(item => item.status === "ready" && (
        (appliedIdsByProposal[item.proposal.proposalId]?.length ?? 0) === item.proposal.regions.length
    ));
    const activeRegionIndex = Math.max(0, activeProposal?.regions.findIndex(region => region.id === activeRegionId) ?? 0);
    const activeRegion = activeProposal?.regions[activeRegionIndex];
    const selectedUnappliedIds = selectedIds.filter(id => !applied.has(id));
    const willMarkResolved = !!activeProposal
        && appliedIds.length + selectedUnappliedIds.length === activeProposal.regions.length;
    const knownCosts = proposals.flatMap(proposal => proposal.usage.cost === null ? [] : [proposal.usage.cost]);
    const totalCost = items.length > 1 && proposals.length === items.length && knownCosts.length === proposals.length
        ? knownCosts.reduce((sum, cost) => sum + cost, 0)
        : null;

    useEffect(() => {
        setActiveRegionId(activeProposal?.regions[0]?.id ?? "");
    }, [activeProposal?.proposalId]);

    const toggleRegion = (id: string) => {
        if (!activeProposal || applied.has(id)) return;
        setSelectedIdsByProposal(current => {
            const currentIds = current[activeProposal.proposalId] ?? [];
            return {
                ...current,
                [activeProposal.proposalId]: currentIds.includes(id)
                    ? currentIds.filter(currentId => currentId !== id)
                    : [...currentIds, id],
            };
        });
    };

    const apply = async () => {
        if (!activeProposal) return;
        const regionIds = selectedUnappliedIds;
        if (regionIds.length === 0) return;
        let result: AiConflictResolutionResult;
        try {
            result = await onApply(activeProposal.proposalId, regionIds);
        } catch {
            return;
        }
        if (result.markedResolved) {
            setResolvedByProposal(current => ({...current, [activeProposal.proposalId]: true}));
        }
        setAppliedIdsByProposal(current => ({
            ...current,
            [activeProposal.proposalId]: [
                ...new Set([...(current[activeProposal.proposalId] ?? []), ...regionIds]),
            ],
        }));
        setSelectedIdsByProposal(current => ({
            ...current,
            [activeProposal.proposalId]: (current[activeProposal.proposalId] ?? [])
                .filter(id => !regionIds.includes(id)),
        }));
    };

    const regenerate = (regionIds?: string[]) => {
        if (activeProposal) void onRegenerate(activeProposal.proposalId, regionIds).catch(() => {});
    };

    const undo = () => {
        if (activeProposal) void onUndo(activeProposal.proposalId).catch(() => {});
    };

    const retry = () => {
        if (activeItem?.status === "failed") void onRetry(activeItem.filePath).catch(() => {});
    };

    const handleRegionTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        let nextIndex: number | null = null;
        if (!activeProposal) return;
        if (event.key === "ArrowRight") nextIndex = (index + 1) % activeProposal.regions.length;
        if (event.key === "ArrowLeft") nextIndex = (index - 1 + activeProposal.regions.length) % activeProposal.regions.length;
        if (event.key === "Home") nextIndex = 0;
        if (event.key === "End") nextIndex = activeProposal.regions.length - 1;
        if (nextIndex === null) return;
        event.preventDefault();
        setActiveRegionId(activeProposal.regions[nextIndex].id);
        regionTabRefs.current[nextIndex]?.focus();
    };

    const openNextUnappliedFile = () => {
        if (!activeItem) return;
        for (let offset = 1; offset <= items.length; offset += 1) {
            const item = items[(activeItemIndex + offset) % items.length];
            if (item.status === "failed" || (
                (appliedIdsByProposal[item.proposal.proposalId]?.length ?? 0) < item.proposal.regions.length
            )) {
                setActiveFilePath(item.filePath);
                return;
            }
        }
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Escape") event.preventDefault();
        if (event.key !== "Tab") return;
        const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex='-1'])",
        ) ?? []);
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (document.activeElement === dialogRef.current) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const progress = operation === "apply"
        ? t("conflict.progressApplying")
        : operation === "regenerate"
            ? t("conflict.progressRegenerating")
            : operation === "undo"
                ? t("conflict.progressUndoing")
                : hasApplied
                    ? markedResolved
                        ? t("conflict.fileResolved")
                        : t("conflict.appliedRegions", {count: appliedIds.length})
                    : totalCost === null
                        ? ""
                        : t("conflict.batchCost", {cost: `$${totalCost.toFixed(6)}`});

    return (
        <div className="ai-dialog-backdrop" role="presentation">
            <section
                className="ai-dialog ai-dialog--conflict"
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="ai-conflict-title"
                aria-describedby="ai-conflict-path"
                aria-busy={busy}
                tabIndex={-1}
                onKeyDown={handleKeyDown}
            >
                <header className="ai-dialog__header">
                    <div className="ai-conflict-dialog__heading">
                        <h2 id="ai-conflict-title">{t("conflict.title")}</h2>
                        <p
                            id="ai-conflict-path"
                            className="ai-conflict-dialog__path"
                            title={items.length === 1 ? activeItem?.filePath : undefined}
                        >
                            {items.length === 1
                                ? activeItem?.filePath
                                : t("conflict.reviewFiles", {count: items.length})}
                        </p>
                    </div>
                </header>

                <div className="ai-conflict-review">
                    {items.length > 1 && (
                        <aside className="ai-conflict-files" aria-label={t("conflict.files")}>
                            {items.map(item => {
                                const proposalAppliedIds = item.status === "ready"
                                    ? appliedIdsByProposal[item.proposal.proposalId] ?? []
                                    : [];
                                const proposalApplied = item.status === "ready"
                                    && proposalAppliedIds.length === item.proposal.regions.length;
                                const proposalResolved = item.status === "ready"
                                    && (resolvedByProposal[item.proposal.proposalId] ?? false);
                                return (
                                    <button
                                        className={`ai-conflict-file${item.filePath === activeItem?.filePath ? " ai-conflict-file--active" : ""}${proposalApplied ? " ai-conflict-file--applied" : ""}${item.status === "failed" ? " ai-conflict-file--failed" : ""}`}
                                        key={item.filePath}
                                        type="button"
                                        aria-pressed={item.filePath === activeItem?.filePath}
                                        onClick={() => setActiveFilePath(item.filePath)}
                                        title={item.filePath}
                                    >
                                        <span className="ai-conflict-file__path">{item.filePath}</span>
                                        <span className="ai-conflict-file__status">
                                            {proposalApplied && <CheckIcon size={10}/>}
                                            {item.status === "failed"
                                                ? t("conflict.fileFailed")
                                                : proposalResolved
                                                    ? t("conflict.resolved")
                                                    : proposalApplied
                                                        ? t("conflict.applied")
                                                        : proposalAppliedIds.length > 0
                                                            ? t("conflict.appliedRegions", {count: proposalAppliedIds.length})
                                                            : t("conflict.regionCount", {count: item.proposal.regions.length})}
                                        </span>
                                    </button>
                                );
                            })}
                        </aside>
                    )}

                    <div className="ai-conflict-file-review">
                        {items.length > 1 && activeItem && (
                            <>
                                <select
                                    className="ai-conflict-file-select"
                                    value={activeItem.filePath}
                                    aria-label={t("conflict.files")}
                                    onChange={event => setActiveFilePath(event.target.value)}
                                >
                                    {items.map(item => (
                                        <option key={item.filePath} value={item.filePath}>{item.filePath}</option>
                                    ))}
                                </select>
                                <div className="ai-conflict-active-path" title={activeItem.filePath}>{activeItem.filePath}</div>
                            </>
                        )}

                        <div className="ai-conflict-region-tabs" role="tablist" aria-label={t("conflict.regions")}>
                            {activeProposal?.regions.map((region, index) => {
                                const isActive = region.id === activeRegion?.id;
                                const isApplied = applied.has(region.id);
                                const isSelected = selected.has(region.id);
                                const tabLabel = isApplied
                                    ? t("conflict.regionTabApplied", {count: index + 1})
                                    : isSelected
                                        ? t("conflict.regionTabSelected", {count: index + 1})
                                        : t("conflict.regionTabNotSelected", {count: index + 1});
                                return (
                                    <button
                                        className={`ai-conflict-region-tab${isActive ? " ai-conflict-region-tab--active" : ""}${isApplied ? " ai-conflict-region-tab--applied" : ""}`}
                                        ref={element => { regionTabRefs.current[index] = element; }}
                                        id={`ai-conflict-region-tab-${activeItemIndex}-${index}`}
                                        key={region.id}
                                        type="button"
                                        role="tab"
                                        aria-label={tabLabel}
                                        aria-selected={isActive}
                                        aria-controls={`ai-conflict-region-panel-${activeItemIndex}-${index}`}
                                        tabIndex={isActive ? 0 : -1}
                                        onClick={() => setActiveRegionId(region.id)}
                                        onKeyDown={event => handleRegionTabKeyDown(event, index)}
                                    >
                                        <span className={`ai-conflict-region-tab__status${isSelected || isApplied ? " ai-conflict-region-tab__status--checked" : ""}`} aria-hidden="true">
                                            {(isSelected || isApplied) && <CheckIcon size={9}/>}
                                        </span>
                                        <span>{t("conflict.regionTab", {count: index + 1})}</span>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="ai-dialog__content">
                            {activeProposal && activeRegion && (
                                <article
                                    className={`ai-conflict-region${applied.has(activeRegion.id) ? " ai-conflict-region--applied" : ""}`}
                                    id={`ai-conflict-region-panel-${activeItemIndex}-${activeRegionIndex}`}
                                    role="tabpanel"
                                    aria-labelledby={`ai-conflict-region-tab-${activeItemIndex}-${activeRegionIndex}`}
                                >
                                    <header className="ai-conflict-region__header">
                                        <label className={`ai-conflict-region__choice${busy || applied.has(activeRegion.id) ? " ai-conflict-region__choice--disabled" : ""}`}>
                                            <span className="ai-conflict-region__checkbox">
                                                <input
                                                    type="checkbox"
                                                    checked={applied.has(activeRegion.id) || selected.has(activeRegion.id)}
                                                    onChange={() => toggleRegion(activeRegion.id)}
                                                    disabled={busy || applied.has(activeRegion.id)}
                                                />
                                                <span className="ai-conflict-region__checkbox-indicator" aria-hidden="true">
                                                    {(applied.has(activeRegion.id) || selected.has(activeRegion.id)) && <CheckIcon size={10}/>}
                                                </span>
                                            </span>
                                            <span>{t("conflict.region", {count: activeRegionIndex + 1})}</span>
                                        </label>
                                        <div className="ai-conflict-region__header-actions">
                                            {applied.has(activeRegion.id) && (
                                                <span className="ai-conflict-region__applied"><CheckIcon size={11}/>{t("conflict.applied")}</span>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => regenerate([activeRegion.id])}
                                                disabled={busy || hasApplied}
                                                title={hasApplied ? t("conflict.regenerateAfterUndo") : undefined}
                                            >
                                                {t("actions.regenerateRegion")}
                                            </button>
                                        </div>
                                    </header>
                                    <div className="ai-conflict-region__versions">
                                        <ConflictVersion kind="original" label={t("conflict.original")} value={activeRegion.original}/>
                                        <ConflictVersion kind="ours" label={t("conflict.ours")} value={activeRegion.ours}/>
                                        <ConflictVersion kind="theirs" label={t("conflict.theirs")} value={activeRegion.theirs}/>
                                        {activeRegion.ancestor !== null && (
                                            <ConflictVersion kind="ancestor" label={t("conflict.ancestor")} value={activeRegion.ancestor}/>
                                        )}
                                        <ConflictVersion kind="proposed" label={t("conflict.proposed")} value={activeRegion.proposed}/>
                                    </div>
                                    {activeRegion.explanation && (
                                        <details className="ai-conflict-region__explanation">
                                            <summary>{t("conflict.explanation")}</summary>
                                            <p>{activeRegion.explanation}</p>
                                        </details>
                                    )}
                                </article>
                            )}
                            {activeItem?.status === "failed" && (
                                <section className="ai-conflict-file-error" role="alert">
                                    <h3>{t("conflict.proposalFailed")}</h3>
                                    <p>{activeItem.message}</p>
                                </section>
                            )}
                        </div>
                    </div>
                </div>

                <footer className="ai-dialog__actions" aria-live="polite">
                    <span>{progress}</span>
                    {!allFilesApplied && (
                        <button type="button" onClick={onClose} disabled={busy}>{anyApplied ? t("actions.closeProposal") : t("actions.discard")}</button>
                    )}
                    {activeItem?.status === "ready" && !allApplied && (
                        <button
                            type="button"
                            onClick={() => regenerate()}
                            disabled={busy || hasApplied}
                            title={hasApplied ? t("conflict.regenerateAfterUndo") : undefined}
                        >
                            {t("actions.regenerate")}
                        </button>
                    )}
                    {activeItem?.status === "ready" && hasApplied && (
                        <button type="button" onClick={undo} disabled={busy}>{operation === "undo" ? t("actions.undoing") : t("actions.undo")}</button>
                    )}
                    {activeItem?.status === "failed" ? (
                        <button className="ai-dialog__button--primary" type="button" onClick={retry} disabled={busy}>
                            {operation === "regenerate" ? t("actions.generating") : t("actions.retryFile")}
                        </button>
                    ) : allFilesApplied ? (
                        <button className="ai-dialog__button--primary" type="button" onClick={onClose} disabled={busy}>{t("actions.done")}</button>
                    ) : allApplied ? (
                        <button className="ai-dialog__button--primary" type="button" onClick={openNextUnappliedFile} disabled={busy}>{t("actions.nextFile")}</button>
                    ) : (
                        <button className="ai-dialog__button--primary" type="button" onClick={() => void apply()} disabled={busy || selectedIds.length === 0}>
                            {operation === "apply"
                                ? willMarkResolved
                                    ? t("actions.applyingAndMarkingResolved")
                                    : t("actions.applying")
                                : willMarkResolved
                                    ? t("actions.applyAndMarkResolved")
                                    : t("actions.applySelected", {count: selectedIds.length})}
                        </button>
                    )}
                </footer>
            </section>
        </div>
    );
}

function ConflictVersion({kind, label, value}: {kind: ConflictVersionKind; label: string; value: string}) {
    return (
        <section className={`ai-conflict-version ai-conflict-version--${kind}`}>
            <h3>{label}</h3>
            <pre>{value}</pre>
        </section>
    );
}
