import {useCallback, useEffect, useRef, useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {ask} from "@tauri-apps/plugin-dialog";
import {useTranslation} from "react-i18next";
import type {TFunction} from "i18next";
import {ChevDownIcon} from "../../components/icons";
import {
    cancelAiOperation,
    generateAiCommitMessages,
    getAiCommitContextPreview,
    getAiConfiguration,
    getAiRepositoryPolicy,
    grantAiConsent,
} from "./commands";
import {resolveAiCommitDefaults} from "./commitDefaults";
import {localiseAiError} from "./errors";
import {AiCommitComposerDialog} from "./AiCommitComposerDialog";
import type {AiCommitWorkflow, AiContextPreview} from "./types";
import "./ai.css";

type Props = {
    enabled: boolean;
    configured: boolean;
    repoPath: string | null;
    stagedCount: number;
    subjectLimit: number;
    workflow: AiCommitWorkflow;
    existingMessage: string;
    disabled: boolean;
    canUndo: boolean;
    onApplyMessage: (message: string) => void;
    onUndo: () => void;
    onConfigure: () => void;
    onBusyChange: (busy: boolean) => void;
};

function consentMessage(preview: AiContextPreview, translate: TFunction<"ai">): string {
    return [
        translate("context.destination", {
            provider: preview.provider,
            authority: preview.destinationAuthority,
        }),
        translate("context.files", {count: preview.files.length}),
        translate(
            preview.contextSizeKib > preview.contextLimitKib
                ? "context.sizeRequiresSummary"
                : "context.size",
            {size: preview.contextSizeKib, limit: preview.contextLimitKib},
        ),
        "",
        translate("context.consent", {authority: preview.destinationAuthority}),
    ].join("\n");
}

export function AiCommitControls({
    enabled,
    configured,
    repoPath,
    stagedCount,
    subjectLimit,
    workflow,
    existingMessage,
    disabled,
    canUndo,
    onApplyMessage,
    onUndo,
    onConfigure,
    onBusyChange,
}: Props) {
    const {t} = useTranslation("ai");
    const [menuOpen, setMenuOpen] = useState(false);
    const [composerOpen, setComposerOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [progressStage, setProgressStage] = useState("collectingContext");
    const [error, setError] = useState<string | null>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const operationIdRef = useRef("");
    const operationVersionRef = useRef(0);
    const startingMessageRef = useRef("");
    const latestMessageRef = useRef(existingMessage);

    latestMessageRef.current = existingMessage;

    const cancel = useCallback(async () => {
        operationVersionRef.current += 1;
        const operationId = operationIdRef.current;
        operationIdRef.current = "";
        setBusy(false);
        if (operationId) await cancelAiOperation(operationId).catch(() => {});
    }, []);

    useEffect(() => {
        onBusyChange(busy);
    }, [busy, onBusyChange]);

    useEffect(() => {
        if (!busy) return;
        const startedAt = Date.now();
        setElapsedSeconds(0);
        const interval = window.setInterval(() => {
            setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
        }, 1000);
        return () => window.clearInterval(interval);
    }, [busy]);

    useEffect(() => {
        let removeListener: (() => void) | undefined;
        void listen<{operationId: string; stage: string}>("ai-operation-progress", event => {
            if (event.payload.operationId === operationIdRef.current) {
                setProgressStage(event.payload.stage);
            }
        }).then(remove => {
            removeListener = remove;
        }).catch(() => {
            removeListener = undefined;
        });
        return () => {
            removeListener?.();
            operationVersionRef.current += 1;
            const operationId = operationIdRef.current;
            if (operationId) void cancelAiOperation(operationId).catch(() => {});
        };
    }, []);

    useEffect(() => {
        if (!menuOpen) return;
        const closeMenu = (event: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener("mousedown", closeMenu);
        return () => document.removeEventListener("mousedown", closeMenu);
    }, [menuOpen]);

    useEffect(() => {
        setMenuOpen(false);
        setComposerOpen(false);
        setError(null);
        if (operationIdRef.current) void cancel();
    }, [cancel, repoPath, workflow]);

    useEffect(() => {
        if ((!enabled || !configured || disabled) && operationIdRef.current) {
            void cancel();
        }
    }, [cancel, configured, disabled, enabled]);

    useEffect(() => {
        if (!busy || existingMessage === startingMessageRef.current) return;
        setError(t("commit.editorChanged"));
        void cancel();
    }, [busy, cancel, existingMessage, t]);

    const replacementAllowed = async (): Promise<boolean> => {
        if (!latestMessageRef.current.trim()) return true;
        return ask(t("commit.replaceMessage"), {
            title: t("commit.replaceTitle"),
            kind: "warning",
            okLabel: t("commit.replace"),
            cancelLabel: t("actions.cancel"),
        });
    };

    const quickGenerate = async () => {
        if (!repoPath || stagedCount === 0 || disabled || operationIdRef.current) return;
        if (!await replacementAllowed()) return;

        const startingMessage = latestMessageRef.current;
        const operationVersion = operationVersionRef.current + 1;
        operationVersionRef.current = operationVersion;
        const operationId = `commit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        operationIdRef.current = operationId;
        startingMessageRef.current = startingMessage;
        setMenuOpen(false);
        setProgressStage("collectingContext");
        setError(null);
        setBusy(true);

        try {
            const [configuration, preview, policy] = await Promise.all([
                getAiConfiguration(),
                getAiCommitContextPreview(repoPath, subjectLimit, workflow, startingMessage),
                getAiRepositoryPolicy(repoPath),
            ]);
            if (operationVersion !== operationVersionRef.current) return;

            if (configuration.consentRequired) {
                const allowed = await ask(consentMessage(preview, t), {
                    title: t("context.title"),
                    kind: "warning",
                    okLabel: t("actions.allowDestination"),
                    cancelLabel: t("actions.cancel"),
                });
                if (!allowed || operationVersion !== operationVersionRef.current) return;
                await grantAiConsent();
                if (operationVersion !== operationVersionRef.current) return;
            }

            if (latestMessageRef.current !== startingMessage) {
                setError(t("commit.editorChanged"));
                return;
            }
            const defaults = resolveAiCommitDefaults(policy);
            const result = await generateAiCommitMessages({
                repoPath,
                subjectLimit,
                operationId,
                candidateCount: 1,
                mode: defaults.mode,
                commitType: defaults.mode === "ConventionalCommits" ? defaults.commitType : "",
                scope: defaults.mode === "ConventionalCommits" ? defaults.scope : "",
                language: defaults.language,
                issueKey: "",
                additionalInstruction: "",
                workflow,
                existingMessage: startingMessage,
            });
            if (
                operationVersion !== operationVersionRef.current
                || latestMessageRef.current !== startingMessage
            ) return;
            const candidate = result.candidates[0];
            if (!candidate) throw {code: "invalidResponse"};
            operationIdRef.current = "";
            startingMessageRef.current = candidate.message;
            onApplyMessage(candidate.message);
        } catch (caught) {
            if (
                operationVersion === operationVersionRef.current
                && !(typeof caught === "object" && caught !== null && "code" in caught && caught.code === "operationCancelled")
            ) {
                setError(localiseAiError(caught, t));
            }
        } finally {
            if (operationVersion === operationVersionRef.current) {
                operationIdRef.current = "";
                setBusy(false);
            }
        }
    };

    const acceptComposerMessage = async (message: string): Promise<boolean> => {
        if (!await replacementAllowed()) return false;
        onApplyMessage(message);
        return true;
    };

    if (!enabled) return null;

    if (!configured) {
        return (
            <button
                type="button"
                className="ai-commit-action__configure"
                onClick={onConfigure}
                title={t("commit.configureTitle")}
            >
                {t("commit.configure")}
            </button>
        );
    }

    const actionDisabled = disabled || stagedCount === 0;

    return (
        <div className="ai-commit-action" ref={menuRef}>
            <div className="ai-commit-action__buttons">
                <button
                    type="button"
                    className="ai-commit-action__primary"
                    onClick={busy ? () => void cancel() : () => void quickGenerate()}
                    disabled={!busy && actionDisabled}
                    title={busy ? t("actions.cancel") : t("commit.generateTitle")}
                >
                    {busy ? t("actions.cancel") : t("actions.generate")}
                </button>
                <button
                    type="button"
                    className="ai-commit-action__toggle"
                    aria-label={t("commit.options")}
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    disabled={busy || actionDisabled}
                    onClick={() => setMenuOpen(open => !open)}
                >
                    <ChevDownIcon size={12}/>
                </button>
            </div>
            {menuOpen && (
                <div className="ai-commit-action__menu" role="menu">
                    <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                            setMenuOpen(false);
                            setComposerOpen(true);
                        }}
                    >
                        {t("actions.openComposer")}
                    </button>
                </div>
            )}
            {canUndo && !busy && (
                <button type="button" className="ai-commit-action__undo" onClick={onUndo}>
                    {t("commit.undo")}
                </button>
            )}
            {(busy || error) && (
                <span className={`ai-commit-action__status${error ? " ai-commit-action__status--error" : ""}`} role={error ? "alert" : "status"} aria-live="polite">
                    {error ?? t("commit.progress", {
                        stage: t(`progress.${progressStage}`),
                        count: elapsedSeconds,
                    })}
                </span>
            )}
            {composerOpen && repoPath && (
                <AiCommitComposerDialog
                    repoPath={repoPath}
                    subjectLimit={subjectLimit}
                    workflow={workflow}
                    existingMessage={existingMessage}
                    onAccept={acceptComposerMessage}
                    onClose={() => setComposerOpen(false)}
                />
            )}
        </div>
    );
}
