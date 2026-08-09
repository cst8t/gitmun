import type {TFunction} from "i18next";
import type {AiError} from "./types";

export function localiseAiError(error: unknown, translate: TFunction<"ai">): string {
    const aiError = typeof error === "object" && error !== null && "code" in error
        ? error as AiError
        : null;
    if (aiError?.code === "contextTooLarge" && aiError.contextSizeKib && aiError.contextLimitKib) {
        return translate("errors.contextTooLargeWithSize", {
            actual: aiError.contextSizeKib,
            limit: aiError.contextLimitKib,
        });
    }
    return translate(`errors.${aiError?.code ?? "unknown"}`);
}
