import {invoke} from "@tauri-apps/api/core";
import type {
    AiCommitMessageResult,
    AiCommitCandidatesResult,
    AiCommitWorkflow,
    AiConfigurationView,
    AiConflictEligibility,
    AiConflictProposalResult,
    AiConflictResolutionResult,
    AiConnectionTestResult,
    AiContextPreview,
    AiModelPage,
    AiModelInfo,
    AiModelQuery,
    AiRepositoryPolicy,
    AiUsageRecord,
    SaveAiConfigurationRequest,
    GenerateAiCommitMessagesRequest,
    GenerateAiWritingRequest,
    AiWritingResult,
    AiWritingTask,
} from "./types";

export function getAiConfiguration(): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("get_ai_configuration");
}

export function saveAiConfiguration(request: SaveAiConfigurationRequest): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("save_ai_configuration", {request});
}

export function deleteAiProfile(profileId: string): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("delete_ai_profile", {profileId});
}

export function setAiApiKey(apiKey: string): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("set_ai_api_key", {apiKey});
}

export function clearAiApiKey(): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("clear_ai_api_key");
}

export function connectOpenRouter(callbackMessage: string): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("connect_openrouter", {callbackMessage});
}

export function testAiConnection(): Promise<AiConnectionTestResult> {
    return invoke<AiConnectionTestResult>("test_ai_connection");
}

export function testAiConnectionDraft(request: SaveAiConfigurationRequest): Promise<AiConnectionTestResult> {
    return invoke<AiConnectionTestResult>("test_ai_connection_draft", {request});
}

export function discoverAiModels(query: AiModelQuery): Promise<AiModelPage> {
    return invoke<AiModelPage>("discover_ai_models", {query});
}

export function discoverAiModelsDraft(
    request: SaveAiConfigurationRequest,
    query: AiModelQuery,
): Promise<AiModelPage> {
    return invoke<AiModelPage>("discover_ai_models_draft", {request, query});
}

export function discoverAiModelDetailsDraft(
    configuration: SaveAiConfigurationRequest,
    modelId: string,
): Promise<AiModelInfo> {
    return invoke<AiModelInfo>("discover_ai_model_details_draft", {
        request: {configuration, modelId},
    });
}

export function grantAiConsent(): Promise<AiConfigurationView> {
    return invoke<AiConfigurationView>("grant_ai_consent");
}

export function setAiRepositoryPolicy(repoPath: string, policy: AiRepositoryPolicy): Promise<void> {
    return invoke("set_ai_repository_policy", {request: {repoPath, policy}});
}

export function getAiRepositoryPolicy(repoPath: string): Promise<AiRepositoryPolicy> {
    return invoke<AiRepositoryPolicy>("get_ai_repository_policy", {repoPath});
}

export function setAiPrivacySettings(
    includeCommitHistory: boolean,
    globalExclusions: string[],
): Promise<void> {
    return invoke("set_ai_privacy_settings", {
        request: {includeCommitHistory, globalExclusions},
    });
}

export function getAiCommitContextPreview(
    repoPath: string,
    subjectLimit: number,
    workflow: AiCommitWorkflow = "Normal",
    existingMessage = "",
): Promise<AiContextPreview> {
    return invoke<AiContextPreview>("get_ai_commit_context_preview", {
        repoPath,
        subjectLimit,
        workflow,
        existingMessage,
    });
}

export function generateAiCommitMessage(
    repoPath: string,
    subjectLimit: number,
): Promise<AiCommitMessageResult> {
    return invoke<AiCommitMessageResult>("generate_ai_commit_message", {repoPath, subjectLimit});
}

export function generateAiCommitMessages(
    request: GenerateAiCommitMessagesRequest,
): Promise<AiCommitCandidatesResult> {
    return invoke<AiCommitCandidatesResult>("generate_ai_commit_messages", {request});
}

export function getAiWritingContextPreview(
    repoPath: string,
    task: AiWritingTask,
    baseReference: string,
): Promise<AiContextPreview> {
    return invoke<AiContextPreview>("get_ai_writing_context_preview", {
        request: {repoPath, task, baseReference},
    });
}

export function generateAiWriting(request: GenerateAiWritingRequest): Promise<AiWritingResult> {
    return invoke<AiWritingResult>("generate_ai_writing", {request});
}

export function cancelAiOperation(operationId: string): Promise<void> {
    return invoke("cancel_ai_operation", {operationId});
}

export function getAiUsageHistory(): Promise<AiUsageRecord[]> {
    return invoke<AiUsageRecord[]>("get_ai_usage_history");
}

export function clearAiUsageHistory(): Promise<void> {
    return invoke("clear_ai_usage_history");
}

export function getAiConflictContextPreview(repoPath: string, filePath: string): Promise<AiContextPreview> {
    return invoke<AiContextPreview>("get_ai_conflict_context_preview", {request: {repoPath, filePath}});
}

export function resolveConflictWithAi(
    repoPath: string,
    filePath: string,
    operationId = "",
): Promise<AiConflictProposalResult> {
    return invoke<AiConflictProposalResult>("resolve_conflict_with_ai", {request: {repoPath, filePath, operationId}});
}

export function regenerateAiConflictRegions(
    proposalId: string,
    regionIds: string[],
    operationId = "",
): Promise<AiConflictProposalResult> {
    return invoke<AiConflictProposalResult>("regenerate_ai_conflict_regions", {
        request: {proposalId, regionIds, operationId},
    });
}

export function applyAiConflictProposal(
    proposalId: string,
    regionIds: string[],
): Promise<AiConflictResolutionResult> {
    return invoke<AiConflictResolutionResult>("apply_ai_conflict_proposal", {
        request: {proposalId, regionIds},
    });
}

export function undoAiConflictProposal(proposalId: string): Promise<AiConflictResolutionResult> {
    return invoke<AiConflictResolutionResult>("undo_ai_conflict_proposal", {proposalId});
}

export type AiConflictBatchUndoFailure = {
    proposalId: string;
    reason: string;
};

export type AiConflictBatchUndoResult = {
    undone: number;
    failed: AiConflictBatchUndoFailure[];
};

export function undoAiConflictBatch(proposalIds: string[]): Promise<AiConflictBatchUndoResult> {
    return invoke<AiConflictBatchUndoResult>("undo_ai_conflict_batch", {proposalIds});
}

export function getAiConflictEligibility(
    repoPath: string,
    filePath: string,
): Promise<AiConflictEligibility> {
    return invoke<AiConflictEligibility>("get_ai_conflict_eligibility", {
        request: {repoPath, filePath},
    });
}
