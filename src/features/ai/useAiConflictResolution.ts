import {useCallback, useEffect, useRef, useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {ask} from "@tauri-apps/plugin-dialog";
import {useTranslation} from "react-i18next";
import type {TFunction} from "i18next";
import {
    applyAiConflictProposal,
    cancelAiOperation,
    getAiConfiguration,
    getAiConflictContextPreview,
    getAiConflictEligibility,
    grantAiConsent,
    regenerateAiConflictRegions,
    resolveConflictWithAi,
    undoAiConflictBatch,
    undoAiConflictProposal,
} from "./commands";
import type {
    AiConflictOperation,
    AiConflictProposalResult,
    AiConflictReviewItem,
    AiContextPreview,
    AiError,
    AiConflictResolutionResult,
} from "./types";

type ToastType = "success" | "error" | "info";

export type AiConflictBatchProgress = {
    current: number;
    total: number;
    preparing: boolean;
};

export type AiConflictBatchFailure = {
    filePath: string;
    message: string;
};

type UseAiConflictResolutionOptions = {
    repoPath: string | null;
    settingsRevision: number;
    showToast: (message: string, type?: ToastType) => void;
    refreshStatus: () => Promise<void>;
};

export function localiseAiError(error: unknown, translate: TFunction<"projectView">): string {
    const aiError = typeof error === "object" && error !== null && "code" in error
        ? error as AiError
        : null;
    if (
        aiError?.code === "contextTooLarge"
        && Number.isFinite(aiError.contextSizeKib)
        && Number.isFinite(aiError.contextLimitKib)
    ) {
        return translate("aiErrors.contextTooLargeWithSize", {
            actual: aiError.contextSizeKib,
            limit: aiError.contextLimitKib,
        });
    }
    return translate(`aiErrors.${aiError?.code ?? "unknown"}`);
}

function isAiOperationCancelled(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "operationCancelled";
}

function getFileName(path: string): string {
    return path.split("/").pop() ?? path;
}

/**
 * Owns the optional AI conflict-resolution workflow. Core conflict handling
 * only consumes this capability when the AI extension is enabled and configured.
 */
export function useAiConflictResolution({
    repoPath,
    settingsRevision,
    showToast,
    refreshStatus,
}: UseAiConflictResolutionOptions) {
    const {t} = useTranslation("projectView");
    const {t: tAi} = useTranslation("ai");
    const [enabled, setEnabled] = useState(false);
    const [configured, setConfigured] = useState(false);
    const [resolvingPath, setResolvingPath] = useState<string | null>(null);
    const [reviewItems, setReviewItems] = useState<AiConflictReviewItem[]>([]);
    const [batchProgress, setBatchProgress] = useState<AiConflictBatchProgress | null>(null);
    const [batchFailure, setBatchFailure] = useState<AiConflictBatchFailure | null>(null);
    const [operation, setOperation] = useState<AiConflictOperation>(null);
    const operationIdRef = useRef("");
    const batchCancelledRef = useRef(false);
    const batchDecisionRef = useRef<((continueBatch: boolean) => void) | null>(null);

    useEffect(() => () => {
        batchCancelledRef.current = true;
        batchDecisionRef.current?.(false);
        batchDecisionRef.current = null;
        const operationId = operationIdRef.current;
        if (operationId) void cancelAiOperation(operationId).catch(() => {});
    }, []);

    useEffect(() => {
        let cancelled = false;
        const refreshConfiguration = () => {
            getAiConfiguration()
                .then(configuration => {
                    if (!cancelled) {
                        setEnabled(configuration.enabled);
                        setConfigured(configuration.configured);
                    }
                })
                .catch(() => {
                    if (!cancelled) {
                        setEnabled(false);
                        setConfigured(false);
                    }
                });
        };
        refreshConfiguration();
        let unlisten: (() => void) | null = null;
        listen("ai-configuration-updated", refreshConfiguration).then(remove => {
            if (cancelled) remove(); else unlisten = remove;
        }).catch(() => {});
        return () => {
            cancelled = true;
            unlisten?.();
        };
    }, [settingsRevision]);

    const resolveWithAi = useCallback(async (path: string) => {
        if (!repoPath || !enabled || !configured || resolvingPath || operationIdRef.current) return;
        const operationId = `conflict-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        batchCancelledRef.current = false;
        operationIdRef.current = operationId;
        setBatchProgress(null);
        setResolvingPath(path);
        try {
            const configuration = await getAiConfiguration();
            if (configuration.consentRequired) {
                const preview = await getAiConflictContextPreview(repoPath, path);
                const confirmed = await ask([
                    tAi("context.destination", {provider: preview.provider, authority: preview.destinationAuthority}),
                    tAi("context.files", {count: preview.files.length}),
                    tAi("context.size", {size: preview.contextSizeKib, limit: preview.contextLimitKib}),
                    "",
                    tAi("context.consent", {authority: preview.destinationAuthority}),
                ].join("\n"), {title: tAi("context.title"), kind: "warning"});
                if (!confirmed) return;
                await grantAiConsent();
            }
            const result = await resolveConflictWithAi(repoPath, path, operationId);
            if (batchCancelledRef.current) return;
            setReviewItems([{status: "ready", filePath: result.filePath, proposal: result}]);
        } catch (error) {
            if (isAiOperationCancelled(error)) return;
            showToast(localiseAiError(error, t), "error");
        } finally {
            operationIdRef.current = "";
            setResolvingPath(null);
        }
    }, [configured, enabled, repoPath, resolvingPath, showToast, t, tAi]);

    const getConflictEligibility = useCallback(async (path: string) => {
        if (!repoPath || !enabled || !configured) {
            return {eligible: false, reason: null};
        }
        return getAiConflictEligibility(repoPath, path);
    }, [configured, enabled, repoPath]);

    const cancel = useCallback(async () => {
        const operationId = operationIdRef.current;
        if (!operationId) return;
        batchCancelledRef.current = true;
        batchDecisionRef.current?.(false);
        batchDecisionRef.current = null;
        await cancelAiOperation(operationId).catch(() => {});
    }, []);

    const skipBatchFailure = useCallback(() => {
        setBatchFailure(null);
        batchDecisionRef.current?.(true);
        batchDecisionRef.current = null;
    }, []);

    const stopBatchFailure = useCallback(() => {
        setBatchFailure(null);
        batchCancelledRef.current = true;
        batchDecisionRef.current?.(false);
        batchDecisionRef.current = null;
    }, []);

    const resolveAllWithAi = useCallback(async (paths: string[]) => {
        if (!repoPath || !enabled || !configured || paths.length === 0 || resolvingPath || operationIdRef.current) return;
        const batchId = `conflict-batch-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        batchCancelledRef.current = false;
        setBatchFailure(null);
        operationIdRef.current = batchId;
        setBatchProgress({current: 1, total: paths.length, preparing: true});
        setResolvingPath(paths[0]);
        try {
            const configuration = await getAiConfiguration();
            const previews = new Map<string, AiContextPreview>();
            const failures = new Map<string, string>();
            for (const path of paths) {
                if (batchCancelledRef.current) return;
                try {
                    previews.set(path, await getAiConflictContextPreview(repoPath, path));
                } catch (error) {
                    const message = localiseAiError(error, t);
                    failures.set(path, message);
                    setBatchFailure({filePath: path, message});
                    const continueBatch = await new Promise<boolean>(resolve => { batchDecisionRef.current = resolve; });
                    if (!continueBatch) break;
                }
            }
            const preparedPaths = paths.filter(path => previews.has(path));
            if (preparedPaths.length === 0) {
                setReviewItems(paths.map(path => ({status: "failed", filePath: path, message: failures.get(path) ?? t("aiErrors.unknown")})));
                return;
            }
            const firstPreview = previews.get(preparedPaths[0])!;
            const totalContextSizeKib = preparedPaths.reduce((total, path) => total + (previews.get(path)?.contextSizeKib ?? 0), 0);
            const warning = [
                tAi("conflict.batchRequestWarning", {count: preparedPaths.length, provider: firstPreview.provider, authority: firstPreview.destinationAuthority}),
                tAi("conflict.batchContext", {count: preparedPaths.length, size: totalContextSizeKib, limit: firstPreview.contextLimitKib}),
                failures.size > 0 ? tAi("conflict.batchExcluded", {count: failures.size}) : "",
                failures.size > 0 ? tAi("conflict.batchExcludedDetails", {files: [...failures].map(([path, message]) => `${path}: ${message}`).join("\n")}) : "",
                tAi("conflict.batchSequential"),
                configuration.consentRequired ? tAi("context.consent", {authority: firstPreview.destinationAuthority}) : "",
            ].filter(Boolean).join("\n\n");
            const confirmed = await ask(warning, {title: tAi("conflict.batchTitle"), kind: "warning", okLabel: tAi("actions.generate"), cancelLabel: tAi("actions.cancel")});
            if (!confirmed || batchCancelledRef.current) return;
            if (configuration.consentRequired) await grantAiConsent();
            setReviewItems([]);
            const proposals = new Map<string, AiConflictProposalResult>();
            for (const [index, path] of preparedPaths.entries()) {
                if (batchCancelledRef.current) break;
                const operationId = `${batchId}-${index + 1}`;
                operationIdRef.current = operationId;
                setBatchProgress({current: index + 1, total: preparedPaths.length, preparing: false});
                setResolvingPath(path);
                try {
                    const proposal = await resolveConflictWithAi(repoPath, path, operationId);
                    if (batchCancelledRef.current) break;
                    proposals.set(path, proposal);
                } catch (error) {
                    if (isAiOperationCancelled(error) || batchCancelledRef.current) {
                        batchCancelledRef.current = true;
                        break;
                    }
                    const message = localiseAiError(error, t);
                    failures.set(path, message);
                    setBatchFailure({filePath: path, message});
                    const continueBatch = await new Promise<boolean>(resolve => { batchDecisionRef.current = resolve; });
                    if (!continueBatch) break;
                }
            }
            const nextReviewItems = paths.flatMap((path): AiConflictReviewItem[] => {
                const proposal = proposals.get(path);
                if (proposal) return [{status: "ready", filePath: path, proposal}];
                const message = failures.get(path);
                return message ? [{status: "failed", filePath: path, message}] : [];
            });
            if (nextReviewItems.length > 0) setReviewItems(nextReviewItems);
            if (batchCancelledRef.current) {
                showToast(tAi("conflict.batchCancelled", {completed: proposals.size, total: preparedPaths.length}), "info");
            } else if (failures.size > 0) {
                const [firstFailedFile, firstFailure] = failures.entries().next().value!;
                showToast(tAi("conflict.batchFailed", {count: failures.size, completed: proposals.size, failed: failures.size, total: paths.length, file: firstFailedFile, message: firstFailure}), "error");
            }
        } catch (error) {
            if (!isAiOperationCancelled(error) && !batchCancelledRef.current) showToast(localiseAiError(error, t), "error");
        } finally {
            batchDecisionRef.current = null;
            setBatchFailure(null);
            operationIdRef.current = "";
            setResolvingPath(null);
            setBatchProgress(null);
        }
    }, [configured, enabled, repoPath, resolvingPath, showToast, t, tAi]);

    const applyProposal = useCallback(async (proposalId: string, regionIds: string[]): Promise<AiConflictResolutionResult> => {
        if (operation) throw {code: "operationInProgress"} satisfies AiError;
        setOperation("apply");
        try {
            const result = await applyAiConflictProposal(proposalId, regionIds);
            showToast(t(result.markedResolved ? "toast.aiConflictFileResolved" : "toast.aiConflictRegionsApplied", {file: getFileName(result.filePath), count: result.resolvedRegions}), "success");
            await refreshStatus();
            return result;
        } catch (error) {
            showToast(localiseAiError(error, t), "error");
            throw error;
        } finally { setOperation(null); }
    }, [operation, refreshStatus, showToast, t]);

    const regenerateProposal = useCallback(async (proposalId: string, regionIds?: string[]) => {
        if (!repoPath || operation) return;
        const reviewItem = reviewItems.find(item => item.status === "ready" && item.proposal.proposalId === proposalId);
        if (!reviewItem || reviewItem.status !== "ready") return;
        const proposal = reviewItem.proposal;
        setOperation("regenerate");
        try {
            if (!regionIds?.length) {
                const regenerated = await resolveConflictWithAi(repoPath, proposal.filePath);
                setReviewItems(current => current.map(item => item.status === "ready" && item.proposal.proposalId === proposalId ? {status: "ready", filePath: regenerated.filePath, proposal: regenerated} : item));
                return;
            }
            const refreshed = await regenerateAiConflictRegions(proposalId, regionIds);
            const replacements = new Map(refreshed.regions.map(region => [region.id, region]));
            setReviewItems(current => current.map(item => item.status === "ready" && item.proposal.proposalId === refreshed.proposalId ? {...item, proposal: {...item.proposal, usage: refreshed.usage, requestId: refreshed.requestId, generationId: refreshed.generationId, routedProvider: refreshed.routedProvider, routedModel: refreshed.routedModel, regions: item.proposal.regions.map(region => replacements.get(region.id) ?? region)}} : item));
        } catch (error) {
            showToast(localiseAiError(error, t), "error");
            throw error;
        } finally { setOperation(null); }
    }, [operation, repoPath, reviewItems, showToast, t]);

    const retryFile = useCallback(async (filePath: string) => {
        if (!repoPath || operation) return;
        setOperation("regenerate");
        try {
            const proposal = await resolveConflictWithAi(repoPath, filePath);
            setReviewItems(current => current.map(item => item.filePath === filePath ? {status: "ready", filePath: proposal.filePath, proposal} : item));
        } catch (error) {
            const message = localiseAiError(error, t);
            setReviewItems(current => current.map(item => item.filePath === filePath ? {status: "failed", filePath, message} : item));
            showToast(message, "error");
            throw error;
        } finally { setOperation(null); }
    }, [operation, repoPath, showToast, t]);

    const undoProposal = useCallback(async (proposalId: string) => {
        if (operation) return;
        setOperation("undo");
        try {
            await undoAiConflictProposal(proposalId);
            await refreshStatus();
            setReviewItems(current => current.filter(item => item.status !== "ready" || item.proposal.proposalId !== proposalId));
        } catch (error) {
            showToast(localiseAiError(error, t), "error");
            throw error;
        } finally { setOperation(null); }
    }, [operation, refreshStatus, showToast, t]);

    const undoBatch = useCallback(async (proposalIds: string[]) => {
        if (operation) return;
        setOperation("undo");
        try {
            const result = await undoAiConflictBatch(proposalIds);
            await refreshStatus();
            const failedIds = new Set(result.failed.map(failure => failure.proposalId));
            const undoneIds = new Set(proposalIds.filter(id => !failedIds.has(id)));
            setReviewItems(current => current.filter(item => item.status !== "ready" || !undoneIds.has(item.proposal.proposalId)));
            if (result.failed.length > 0) showToast(tAi("conflict.batchUndoFailed", {count: result.failed.length}) as string, "error");
        } catch (error) {
            showToast(localiseAiError(error, t), "error");
        } finally { setOperation(null); }
    }, [operation, refreshStatus, showToast, t, tAi]);

    return {
        enabled,
        configured,
        isAvailable: enabled && configured,
        resolvingPath,
        operationId: resolvingPath ? operationIdRef.current : null,
        reviewItems,
        batchProgress,
        batchFailure,
        operation,
        resolveWithAi,
        getConflictEligibility,
        resolveAllWithAi,
        cancel,
        skipBatchFailure,
        stopBatchFailure,
        applyProposal,
        regenerateProposal,
        retryFile,
        undoProposal,
        undoBatch,
        closeReview: () => setReviewItems([]),
    };
}
