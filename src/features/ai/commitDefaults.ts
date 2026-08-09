import type {AiCommitMessageMode, AiRepositoryPolicy} from "./types";

export type AiCommitDefaults = {
    mode: AiCommitMessageMode;
    commitType: string;
    scope: string;
    language: string;
};

export function resolveAiCommitDefaults(policy: AiRepositoryPolicy): AiCommitDefaults {
    return {
        mode: policy.commitMessageMode
            ?? (policy.conventionalCommits ? "ConventionalCommits" : "RepositoryStyle"),
        commitType: policy.defaultCommitType,
        scope: policy.defaultCommitScope,
        language: policy.defaultLanguage,
    };
}
