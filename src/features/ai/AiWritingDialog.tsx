import {useEffect, useRef, useState} from "react";
import {listen} from "@tauri-apps/api/event";
import {useTranslation} from "react-i18next";
import type {TFunction} from "i18next";
import {CloseIcon} from "../../components/icons";
import {
    cancelAiOperation,
    generateAiWriting,
    getAiConfiguration,
    getAiRepositoryPolicy,
    getAiWritingContextPreview,
    grantAiConsent,
    setAiRepositoryPolicy,
} from "./commands";
import type {AiContextPreview, AiError, AiRepositoryPolicy, AiWritingResult, AiWritingTask} from "./types";
import "./ai.css";

type Props = {
    repoPath: string;
    initialTask?: AiWritingTask;
    onClose: () => void;
};

const DEFAULT_REPOSITORY_POLICY: AiRepositoryPolicy = {
    exclusions: [],
    includeCommitHistory: null,
    conventionalCommits: false,
    commitMessageMode: null,
    defaultCommitType: "",
    defaultCommitScope: "",
    defaultLanguage: "",
    commitPromptFile: "",
    conflictPromptFile: "",
};

export function AiWritingDialog({repoPath, initialTask = "StagedReview", onClose}: Props) {
    const {t} = useTranslation("ai");
    const [task, setTask] = useState<AiWritingTask>(initialTask);
    const [baseReference, setBaseReference] = useState("");
    const [additionalInstruction, setAdditionalInstruction] = useState("");
    const [preview, setPreview] = useState<AiContextPreview | null>(null);
    const [consentRequired, setConsentRequired] = useState(false);
    const [result, setResult] = useState<AiWritingResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [progressStage, setProgressStage] = useState("collectingContext");
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [policy, setPolicy] = useState<AiRepositoryPolicy>(DEFAULT_REPOSITORY_POLICY);
    const [policySaved, setPolicySaved] = useState(false);
    const [copied, setCopied] = useState(false);
    const [environmentFields, setEnvironmentFields] = useState<string[]>([]);
    const operationIdRef = useRef("");
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        closeButtonRef.current?.focus();
        void Promise.all([getAiRepositoryPolicy(repoPath), getAiConfiguration()])
            .then(([repositoryPolicy, configuration]) => {
                setPolicy(repositoryPolicy);
                setEnvironmentFields(configuration.environmentFields ?? []);
            })
            .catch(caught => {
                setError(localiseWritingError(caught, t));
            });
    }, [repoPath, t]);

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
            if (operationIdRef.current) {
                void cancelAiOperation(operationIdRef.current).catch(() => {});
            }
        };
    }, []);

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
        return () => {
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        };
    }, []);

    const clearCopiedFeedback = () => {
        if (copiedTimerRef.current) {
            clearTimeout(copiedTimerRef.current);
            copiedTimerRef.current = null;
        }
        setCopied(false);
    };

    const clearPreparedContext = () => {
        setPreview(null);
        setResult(null);
        setError(null);
        clearCopiedFeedback();
    };

    const loadPreview = async () => {
        setBusy(true);
        setError(null);
        setResult(null);
        clearCopiedFeedback();
        try {
            const [configuration, context] = await Promise.all([
                getAiConfiguration(),
                getAiWritingContextPreview(repoPath, task, baseReference),
            ]);
            setConsentRequired(configuration.consentRequired);
            setPreview(context);
        } catch (caught) {
            setPreview(null);
            setError(localiseWritingError(caught, t));
        } finally {
            setBusy(false);
        }
    };

    const generate = async () => {
        const operationId = `writing-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        operationIdRef.current = operationId;
        setProgressStage("collectingContext");
        setBusy(true);
        setError(null);
        clearCopiedFeedback();
        try {
            setResult(await generateAiWriting({
                repoPath,
                task,
                baseReference,
                additionalInstruction,
                operationId,
            }));
        } catch (caught) {
            setError(localiseWritingError(caught, t));
        } finally {
            operationIdRef.current = "";
            setBusy(false);
        }
    };

    const cancel = async () => {
        if (operationIdRef.current) {
            await cancelAiOperation(operationIdRef.current).catch(() => {});
        }
    };

    const allowDestination = async () => {
        setError(null);
        try {
            await grantAiConsent();
            setConsentRequired(false);
        } catch (caught) {
            setError(localiseWritingError(caught, t));
        }
    };

    const close = () => {
        if (busy) void cancel();
        onClose();
    };

    const copy = () => {
        if (!result) return;
        void navigator.clipboard?.writeText(result.content).catch(() => {});
        setCopied(true);
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => {
            setCopied(false);
            copiedTimerRef.current = null;
        }, 1200);
    };

    const savePolicy = async () => {
        setError(null);
        setPolicySaved(false);
        try {
            await setAiRepositoryPolicy(repoPath, policy);
            setPolicySaved(true);
            clearPreparedContext();
        } catch (caught) {
            setError(localiseWritingError(caught, t));
        }
    };

    return (
        <div className="ai-dialog-backdrop" role="presentation">
            <section className="ai-dialog ai-dialog--commit" role="dialog" aria-modal="true" aria-labelledby="ai-writing-title">
                <header className="ai-dialog__header">
                    <div>
                        <h2 id="ai-writing-title">{t("writing.title")}</h2>
                        <p>{t("writing.subtitle")}</p>
                    </div>
                    <button className="ai-dialog__close" ref={closeButtonRef} type="button" onClick={close} aria-label={t("actions.close")}>
                        <CloseIcon/>
                    </button>
                </header>

                <div className="ai-dialog__content ai-commit-composer">
                    <div className="ai-commit-controls">
                        <label>{t("writing.task")}
                            <select value={task} onChange={event => {
                                setTask(event.target.value as AiWritingTask);
                                clearPreparedContext();
                            }}>
                                <option value="StagedReview">{t("writing.tasks.stagedReview")}</option>
                                <option value="BranchSummary">{t("writing.tasks.branchSummary")}</option>
                                <option value="PullRequestDescription">{t("writing.tasks.pullRequestDescription")}</option>
                                <option value="ReleaseNotes">{t("writing.tasks.releaseNotes")}</option>
                            </select>
                        </label>
                        {task !== "StagedReview" && (
                            <label>{t("writing.baseReference")}
                                <input value={baseReference} onChange={event => {
                                    setBaseReference(event.target.value);
                                    clearPreparedContext();
                                }} placeholder={t(`writing.basePlaceholders.${task}`)}/>
                            </label>
                        )}
                        <label className="ai-commit-controls__wide">{t("writing.additionalInstruction")}
                            <textarea rows={2} value={additionalInstruction} onChange={event => setAdditionalInstruction(event.target.value)}/>
                        </label>
                    </div>

                    <details className="ai-repository-policy">
                        <summary>{t("writing.repositoryPolicy")}</summary>
                        <div className="ai-commit-controls">
                            <label>{t("writing.includeHistory")}
                                <select disabled={environmentFields.includes("includeCommitHistory")} value={policy.includeCommitHistory == null ? "default" : policy.includeCommitHistory ? "yes" : "no"} onChange={event => setPolicy(current => ({
                                    ...current,
                                    includeCommitHistory: event.target.value === "default" ? null : event.target.value === "yes",
                                }))}>
                                    <option value="default">{t("writing.historyDefault")}</option>
                                    <option value="yes">{t("writing.historyInclude")}</option>
                                    <option value="no">{t("writing.historyExclude")}</option>
                                </select>
                            </label>
                            <label>{t("writing.defaultLanguage")}
                                <input value={policy.defaultLanguage} onChange={event => setPolicy(current => ({...current, defaultLanguage: event.target.value}))}/>
                            </label>
                            <div className="ai-commit-controls__wide">
                                <button className="ai-dialog__toggle" type="button" aria-pressed={policy.conventionalCommits} onClick={() => setPolicy(current => {
                                    const conventionalCommits = !current.conventionalCommits;
                                    return {
                                        ...current,
                                        conventionalCommits,
                                        commitMessageMode: conventionalCommits ? "ConventionalCommits" : "RepositoryStyle",
                                    };
                                })}>{t("writing.conventionalCommits")}</button>
                            </div>
                            <label className="ai-commit-controls__wide">{t("writing.repositoryExclusions")}
                                <textarea rows={3} value={policy.exclusions.join("\n")} onChange={event => setPolicy(current => ({
                                    ...current,
                                    exclusions: event.target.value.split("\n").map(value => value.trim()).filter(Boolean),
                                }))}/>
                            </label>
                            <label>{t("writing.commitPromptFile")}
                                <input disabled={environmentFields.includes("commitMessagePrompt")} value={policy.commitPromptFile} onChange={event => setPolicy(current => ({...current, commitPromptFile: event.target.value}))} placeholder={t("writing.promptFilePlaceholder")}/>
                            </label>
                            <label>{t("writing.conflictPromptFile")}
                                <input disabled={environmentFields.includes("conflictResolutionPrompt")} value={policy.conflictPromptFile} onChange={event => setPolicy(current => ({...current, conflictPromptFile: event.target.value}))} placeholder={t("writing.promptFilePlaceholder")}/>
                            </label>
                        </div>
                        <div className="ai-repository-policy__actions">
                            <button type="button" onClick={savePolicy}>{t("actions.savePolicy")}</button>
                            {policySaved && <span role="status">{t("writing.policySaved")}</span>}
                        </div>
                    </details>

                    {preview && (
                        <section className="ai-context-preview">
                            <h3>{t("context.title")}</h3>
                            <p>{t("context.destination", {
                                provider: preview.provider,
                                authority: preview.destinationAuthority,
                            })}</p>
                            <p>{t("context.size", {
                                size: preview.contextSizeKib,
                                limit: preview.contextLimitKib,
                            })}</p>
                            <details className="ai-context-preview__files">
                                <summary>{t("context.files", {count: preview.files.length})}</summary>
                                <ul>{preview.files.map(file => <li key={file}>{file}</li>)}</ul>
                            </details>
                        </section>
                    )}

                    {consentRequired && preview && (
                        <div className="ai-consent">
                            <p>{t("context.consent", {authority: preview.destinationAuthority})}</p>
                            <button type="button" onClick={allowDestination}>{t("actions.allowDestination")}</button>
                        </div>
                    )}

                    {result && (
                        <section className="ai-writing-result">
                            <h3>{t("writing.result")}</h3>
                            <pre>{result.content}</pre>
                        </section>
                    )}

                    {error && <p className="ai-dialog__error" role="alert">{error}</p>}
                </div>

                <footer className="ai-dialog__actions" aria-live="polite">
                    <span>{busy ? t("commit.progress", {
                        stage: t(`progress.${progressStage}`),
                        count: elapsedSeconds,
                    }) : ""}</span>
                    {busy && <button type="button" onClick={cancel}>{t("actions.cancel")}</button>}
                    <button type="button" onClick={close}>{t("actions.discard")}</button>
                    <button type="button" onClick={loadPreview} disabled={busy}>{t("actions.previewContext")}</button>
                    <button className={!result ? "ai-dialog__button--primary" : undefined} type="button" onClick={generate} disabled={busy || !preview || consentRequired}>
                        {busy ? t("actions.generating") : result ? t("actions.regenerate") : t("actions.generate")}
                    </button>
                    <button className={result ? "ai-dialog__button--primary" : undefined} type="button" onClick={copy} disabled={!result}>{copied ? t("actions.copied") : t("actions.copy")}</button>
                </footer>
            </section>
        </div>
    );
}

function localiseWritingError(error: unknown, t: TFunction<"ai">): string {
    const aiError = typeof error === "object" && error !== null && "code" in error
        ? error as AiError
        : null;
    if (aiError?.code === "contextTooLarge" && aiError.contextSizeKib && aiError.contextLimitKib) {
        return t("errors.contextTooLargeWithSize", {
            actual: aiError.contextSizeKib,
            limit: aiError.contextLimitKib,
        });
    }
    return t(`errors.${aiError?.code ?? "unknown"}`);
}
