import type { TFunction } from "i18next";
import type { InterpretedGitError, PushRejectionAnalysis, PushResult } from "../types";

export type GitAdviceTranslator = TFunction<"gitAdvice">;

export type PushFailureDisplay = {
  dialogRejection: PushRejectionAnalysis | null;
  toastMessage: string | null;
  logMessage: string;
  logDetails: string | null;
};

const DIALOG_PUSH_REJECTION_KINDS = ["non-fast-forward", "no-upstream", "upstream-missing"];

function localisedActionLabels(
  actions: string[],
  tGitAdvice: GitAdviceTranslator,
): string {
  return actions
    .slice(0, 3)
    .map((action) => tGitAdvice(`actions.${action}`, { defaultValue: action }))
    .join(", ");
}

export function formatInterpretedGitError(
  interpretedError: InterpretedGitError,
  tGitAdvice: GitAdviceTranslator,
): string {
  const actions = localisedActionLabels(interpretedError.suggestedActions, tGitAdvice);

  return actions
    ? tGitAdvice("withActions", { summary: interpretedError.summary, actions })
    : interpretedError.summary;
}

function rawGitDetails(result: PushResult): string | null {
  const rawMessage = result.interpretedError?.rawMessage.trim();
  if (rawMessage) {
    return rawMessage;
  }

  const output = result.output?.trim();
  return output || null;
}

export function buildPushFailureDisplay(
  result: PushResult,
  tGitAdvice: GitAdviceTranslator,
): PushFailureDisplay {
  const interpretedMessage = result.interpretedError
    ? formatInterpretedGitError(result.interpretedError, tGitAdvice)
    : null;
  const logMessage = result.interpretedError?.summary ?? (result.output?.trim() || result.message);
  const logDetails = result.interpretedError ? rawGitDetails(result) : null;
  const dialogRejection = result.rejection
    && DIALOG_PUSH_REJECTION_KINDS.includes(result.rejection.kind)
    ? result.rejection
    : null;

  return {
    dialogRejection,
    toastMessage: dialogRejection ? null : interpretedMessage ?? result.message,
    logMessage,
    logDetails,
  };
}
