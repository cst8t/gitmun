import {useEffect, useRef, useState} from "react";
import {useTranslation} from "react-i18next";
import {listen} from "@tauri-apps/api/event";
import {CloseIcon} from "../../components/icons";
import {
    cancelAiOperation,
    generateAiCommitMessages,
    getAiCommitContextPreview,
    getAiConfiguration,
    getAiRepositoryPolicy,
    grantAiConsent,
    setAiRepositoryPolicy,
} from "./commands";
import {resolveAiCommitDefaults} from "./commitDefaults";
import {localiseAiError} from "./errors";
import type {AiCommitMessageMode, AiCommitMessageResult, AiCommitWorkflow, AiContextPreview, AiRepositoryPolicy} from "./types";
import "./ai.css";

type Props = {
    repoPath: string;
    subjectLimit: number;
    workflow: AiCommitWorkflow;
    existingMessage: string;
    onAccept: (message: string) => Promise<boolean>;
    onClose: () => void;
};

export function AiCommitComposerDialog({repoPath, subjectLimit, workflow, existingMessage, onAccept, onClose}: Props) {
    const {t} = useTranslation("ai");
    const [candidateCount, setCandidateCount] = useState(1);
    const [mode, setMode] = useState<AiCommitMessageMode>("RepositoryStyle");
    const [commitType, setCommitType] = useState("");
    const [scope, setScope] = useState("");
    const [language, setLanguage] = useState("");
    const [issueKey, setIssueKey] = useState("");
    const [additionalInstruction, setAdditionalInstruction] = useState("");
    const [candidates, setCandidates] = useState<AiCommitMessageResult[]>([]);
    const [selectedCandidate, setSelectedCandidate] = useState(0);
    const [contextPreview, setContextPreview] = useState<AiContextPreview | null>(null);
    const [consentRequired, setConsentRequired] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [progressStage, setProgressStage] = useState("collectingContext");
    const [error, setError] = useState<string | null>(null);
    const [repositoryPolicy, setRepositoryPolicy] = useState<AiRepositoryPolicy | null>(null);
    const [defaultsSaved, setDefaultsSaved] = useState(false);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const operationIdRef = useRef("");

    useEffect(() => {
        closeButtonRef.current?.focus();
        let cancelled = false;
        Promise.all([
            getAiConfiguration(),
            getAiCommitContextPreview(repoPath, subjectLimit, workflow, existingMessage),
            getAiRepositoryPolicy(repoPath),
        ]).then(([configuration, preview, policy]) => {
            if (cancelled) return;
            setConsentRequired(configuration.consentRequired);
            setContextPreview(preview);
            setRepositoryPolicy(policy);
            const defaults = resolveAiCommitDefaults(policy);
            setMode(defaults.mode);
            setCommitType(defaults.commitType);
            setScope(defaults.scope);
            setLanguage(defaults.language);
        }).catch(caught => {
            if (!cancelled) setError(localiseAiError(caught, t));
        });
        return () => {
            cancelled = true;
        };
    }, [existingMessage, repoPath, subjectLimit, t, workflow]);

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
            const operationId = operationIdRef.current;
            if (operationId) void cancelAiOperation(operationId).catch(() => {});
        };
    }, []);

    useEffect(() => {
        if (!generating) return;
        const startedAt = Date.now();
        setElapsedSeconds(0);
        const interval = window.setInterval(() => {
            setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
        }, 1000);
        return () => window.clearInterval(interval);
    }, [generating]);

    const generate = async () => {
        const operationId = `commit-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        operationIdRef.current = operationId;
        setProgressStage("collectingContext");
        setGenerating(true);
        setError(null);
        try {
            const result = await generateAiCommitMessages({
                repoPath,
                subjectLimit,
                operationId,
                candidateCount,
                mode,
                commitType,
                scope,
                language,
                issueKey,
                additionalInstruction,
                workflow,
                existingMessage,
            });
            setCandidates(result.candidates);
            setSelectedCandidate(0);
        } catch (caught) {
            setError(localiseAiError(caught, t));
        } finally {
            setGenerating(false);
        }
    };

    const cancel = async () => {
        const operationId = operationIdRef.current;
        if (!operationId) return;
        try {
            await cancelAiOperation(operationId);
        } catch {
            return;
        }
    };

    const close = () => {
        if (generating) void cancel();
        onClose();
    };

    const grantConsent = async () => {
        setError(null);
        try {
            await grantAiConsent();
            setConsentRequired(false);
        } catch (caught) {
            setError(localiseAiError(caught, t));
        }
    };

    const saveDefaults = async () => {
        if (!repositoryPolicy) return;
        setDefaultsSaved(false);
        setError(null);
        const nextPolicy: AiRepositoryPolicy = {
            ...repositoryPolicy,
            conventionalCommits: mode === "ConventionalCommits",
            commitMessageMode: mode,
            defaultCommitType: commitType.trim(),
            defaultCommitScope: scope.trim(),
            defaultLanguage: language.trim(),
        };
        try {
            await setAiRepositoryPolicy(repoPath, nextPolicy);
            setCommitType(nextPolicy.defaultCommitType);
            setScope(nextPolicy.defaultCommitScope);
            setLanguage(nextPolicy.defaultLanguage);
            setRepositoryPolicy(nextPolicy);
            setDefaultsSaved(true);
        } catch (caught) {
            setError(localiseAiError(caught, t));
        }
    };

    const accept = async () => {
        const candidate = candidates[selectedCandidate];
        if (candidate && await onAccept(candidate.message)) onClose();
    };

    return (
        <div className="ai-dialog-backdrop" role="presentation">
            <section className="ai-dialog ai-dialog--commit" role="dialog" aria-modal="true" aria-labelledby="ai-commit-title">
                <header className="ai-dialog__header">
                    <div>
                        <h2 id="ai-commit-title">{t("commit.title")}</h2>
                        <p>{t("commit.subtitle")}</p>
                    </div>
                    <button className="ai-dialog__close" ref={closeButtonRef} type="button" onClick={close} aria-label={t("actions.close")}>
                        <CloseIcon/>
                    </button>
                </header>

                <div className="ai-dialog__content ai-commit-composer">
                    {contextPreview && (
                        <section className="ai-context-preview">
                            <h3>{t("context.title")}</h3>
                            <p>{t("context.destination", {
                                provider: contextPreview.provider,
                                authority: contextPreview.destinationAuthority,
                            })}</p>
                            <p>{t(
                                contextPreview.contextSizeKib > contextPreview.contextLimitKib
                                    ? "context.sizeRequiresSummary"
                                    : "context.size",
                                {
                                    size: contextPreview.contextSizeKib,
                                    limit: contextPreview.contextLimitKib,
                                },
                            )}</p>
                            <details className="ai-context-preview__files">
                                <summary>{t("context.files", {count: contextPreview.files.length})}</summary>
                                <ul>{contextPreview.files.map(file => <li key={file}>{file}</li>)}</ul>
                            </details>
                        </section>
                    )}

                    <div className="ai-commit-controls">
                        <label>{t("commit.mode")}
                            <select value={mode} onChange={event => setMode(event.target.value as AiCommitMessageMode)}>
                                <option value="RepositoryStyle">{t("commit.modes.repositoryStyle")}</option>
                                <option value="ConventionalCommits">{t("commit.modes.conventionalCommits")}</option>
                                <option value="FreeForm">{t("commit.modes.freeForm")}</option>
                            </select>
                        </label>
                        <label>{t("commit.candidateCount")}
                            <select value={candidateCount} onChange={event => setCandidateCount(Number(event.target.value))}>
                                <option value={1}>1</option>
                                <option value={2}>2</option>
                                <option value={3}>3</option>
                            </select>
                        </label>
                        {mode === "ConventionalCommits" && (
                            <>
                                <label>{t("commit.type")}<input value={commitType} onChange={event => setCommitType(event.target.value)}/></label>
                                <label>{t("commit.scope")}<input value={scope} onChange={event => setScope(event.target.value)}/></label>
                            </>
                        )}
                        <label>{t("commit.language")}<input value={language} onChange={event => setLanguage(event.target.value)}/></label>
                        <label>{t("commit.issueKey")}<input value={issueKey} onChange={event => setIssueKey(event.target.value)}/></label>
                        <label className="ai-commit-controls__wide">{t("commit.additionalInstruction")}
                            <textarea rows={2} value={additionalInstruction} onChange={event => setAdditionalInstruction(event.target.value)}/>
                        </label>
                    </div>

                    {consentRequired && contextPreview && (
                        <div className="ai-consent">
                            <p>{t("context.consent", {authority: contextPreview.destinationAuthority})}</p>
                            <button className="ai-dialog__button--primary" type="button" onClick={grantConsent}>{t("actions.allowDestination")}</button>
                        </div>
                    )}

                    {candidates.length > 0 && (
                        <fieldset className="ai-candidates">
                            <legend>{t("commit.candidates")}</legend>
                            {candidates.map((candidate, index) => (
                                candidates.length === 1 ? (
                                    <div className="ai-candidates__option ai-candidates__option--selected" key={`${candidate.requestId ?? "candidate"}-${index}`}>
                                        <pre>{candidate.message}</pre>
                                    </div>
                                ) : (
                                    <button
                                        className={`ai-candidates__option${selectedCandidate === index ? " ai-candidates__option--selected" : ""}`}
                                        type="button"
                                        aria-pressed={selectedCandidate === index}
                                        onClick={() => setSelectedCandidate(index)}
                                        key={`${candidate.requestId ?? "candidate"}-${index}`}
                                    >
                                        <span className="ai-candidates__option-title">{t("commit.candidate", {count: index + 1})}</span>
                                        <pre>{candidate.message}</pre>
                                    </button>
                                )
                            ))}
                        </fieldset>
                    )}

                    {error && <p className="ai-dialog__error" role="alert">{error}</p>}
                </div>

                <footer className="ai-dialog__actions" aria-live="polite">
                    <span>{generating
                        ? t("commit.progress", {
                            stage: t(`progress.${progressStage}`),
                            count: elapsedSeconds,
                        })
                        : defaultsSaved ? t("commit.defaultsSaved") : ""}</span>
                    {generating && <button type="button" onClick={cancel}>{t("actions.cancel")}</button>}
                    <button type="button" onClick={saveDefaults} disabled={generating || !repositoryPolicy}>{t("actions.saveCommitDefaults")}</button>
                    <button type="button" onClick={close}>{t("actions.discard")}</button>
                    <button className={candidates.length === 0 ? "ai-dialog__button--primary" : undefined} type="button" onClick={generate} disabled={generating || consentRequired || !contextPreview}>
                        {generating ? t("actions.generating") : candidates.length ? t("actions.regenerate") : t("actions.generate")}
                    </button>
                    <button className="ai-dialog__button--primary" type="button" onClick={accept} disabled={generating || candidates.length === 0}>{t("actions.accept")}</button>
                </footer>
            </section>
        </div>
    );
}
