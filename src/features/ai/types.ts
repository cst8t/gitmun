export type AiProvider =
    | "Disabled"
    | "OpenAi"
    | "Claude"
    | "Mistral"
    | "GoogleGemini"
    | "OpenRouter"
    | "AzureOpenAi"
    | "Ollama"
    | "LmStudio"
    | "OpenAiCompatible";

export type AiApiStyle = "ChatCompletions" | "Responses";
export type AiAuthMode = "Bearer" | "Header" | "None";
export type AiReasoningPreference = "Automatic" | "ProviderDefault" | "Low" | "Medium" | "High";
export type AiConfigurationSource = "Environment" | "StoredProfile" | "ProviderDefault";
export type OpenRouterPrivacy = "NoDataCollection" | "StrictZdr" | "AccountDefault";
export type OpenRouterRoutingStrategy = "Default" | "Price" | "Latency" | "Throughput";

export type AiEffortCapability =
    | {status: "unknown"}
    | {status: "accepted"}
    | {status: "unsupported"}
    | {status: "supported"; levels: AiReasoningPreference[]};

export type OpenRouterSettings = {
    privacy: OpenRouterPrivacy;
    allowFallbacks: boolean;
    requireParameters: boolean;
    routingStrategy: OpenRouterRoutingStrategy;
    maxPromptPrice: string;
    maxCompletionPrice: string;
    preferredProviders: string[];
    allowedProviders: string[];
    ignoredProviders: string[];
    preferredMaxLatency: string;
    preferredMinThroughput: string;
    diagnostics: boolean;
};

export type AiProfile = {
    id: string;
    name: string;
    provider: AiProvider;
    endpoint: string;
    model: string;
    apiStyle: AiApiStyle;
    requestPath: string;
    modelsPath: string;
    authMode: AiAuthMode;
    authHeader: string;
    maxTokensField: string;
    extraHeaders: Record<string, string>;
    azureDeployment: string;
    azureApiVersion: string;
    reasoningPreference: AiReasoningPreference;
    effortCapability: AiEffortCapability;
    openRouter: OpenRouterSettings;
};

export type AiRepositoryPolicy = {
    exclusions: string[];
    includeCommitHistory: boolean | null;
    conventionalCommits: boolean;
    defaultLanguage: string;
    commitPromptFile: string;
    conflictPromptFile: string;
};

export type AiExtensionSettings = {
    enabled: boolean;
    selectedProfileId: string;
    profiles: AiProfile[];
    commitContextLimitKib: number;
    conflictContextLimitKib: number;
    commitMessageMaxTokens: number;
    conflictResolutionMaxTokens: number;
    commitMessagePrompt: string;
    conflictResolutionPrompt: string;
    includeCommitHistory: boolean;
    globalExclusions: string[];
    consentedDestinations: string[];
    repositoryPolicies: Record<string, AiRepositoryPolicy>;
    usageHistory: AiUsageRecord[];
};

export type AiUsageRecord = {
    timestamp: number;
    provider: AiProvider;
    profileId: string;
    model: string;
    task: string;
    durationMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cachedTokens: number | null;
    cost: number | null;
    byok: boolean | null;
    requestId: string | null;
    generationId: string | null;
    routedProvider: string | null;
    routedModel: string | null;
    diagnostic: string | null;
    status: string;
};

export type AiConfigurationView = {
    enabled: boolean;
    selectedProfileId: string;
    profiles: AiProfile[];
    provider: AiProvider;
    endpoint: string;
    model: string;
    reasoningPreference: AiReasoningPreference;
    effortCapability: AiEffortCapability;
    commitContextLimitKib: number;
    conflictContextLimitKib: number;
    commitMessageMaxTokens: number;
    conflictResolutionMaxTokens: number;
    commitMessagePrompt: string;
    conflictResolutionPrompt: string;
    includeCommitHistory: boolean;
    hasApiKey: boolean;
    credentialManagedByEnvironment: boolean;
    configured: boolean;
    insecureTransport: boolean;
    sources: Record<string, AiConfigurationSource>;
    environmentFields: string[];
    consentRequired: boolean;
};

export type SaveAiConfigurationRequest = {
    enabled?: boolean;
    profileId?: string;
    profileName?: string;
    provider: AiProvider;
    endpoint: string;
    model: string;
    reasoningPreference: AiReasoningPreference;
    apiStyle?: AiApiStyle;
    requestPath?: string;
    modelsPath?: string;
    authMode?: AiAuthMode;
    authHeader?: string;
    maxTokensField?: string;
    azureDeployment?: string;
    azureApiVersion?: string;
    openRouter?: OpenRouterSettings;
    apiKey?: string;
};

export type AiUsage = {
    inputTokens: number | null;
    outputTokens: number | null;
    reasoningTokens: number | null;
    cachedTokens: number | null;
    cost: number | null;
    byok: boolean | null;
};

export type AiProviderResultMetadata = {
    usage: AiUsage;
    requestId: string | null;
    generationId: string | null;
    routedProvider: string | null;
    routedModel: string | null;
};

export type AiConnectionTestResult = AiProviderResultMetadata & {
    effortCapability: AiEffortCapability;
};

export type AiCommitMessageResult = AiProviderResultMetadata & {
    message: string;
};

export type AiCommitMessageMode = "RepositoryStyle" | "ConventionalCommits" | "FreeForm";
export type AiCommitWorkflow = "Normal" | "Amend" | "Merge" | "Rebase" | "CherryPick" | "Revert";

export type GenerateAiCommitMessagesRequest = {
    repoPath: string;
    subjectLimit: number;
    operationId: string;
    candidateCount: number;
    mode: AiCommitMessageMode;
    commitType: string;
    scope: string;
    language: string;
    issueKey: string;
    additionalInstruction: string;
    workflow: AiCommitWorkflow;
    existingMessage: string;
};

export type AiCommitCandidatesResult = {
    candidates: AiCommitMessageResult[];
};

export type AiWritingTask = "StagedReview" | "BranchSummary" | "PullRequestDescription" | "ReleaseNotes";

export type GenerateAiWritingRequest = {
    repoPath: string;
    task: AiWritingTask;
    baseReference: string;
    additionalInstruction: string;
    operationId: string;
};

export type AiWritingResult = AiProviderResultMetadata & {
    content: string;
};

export type AiConflictRegionProposal = {
    id: string;
    original: string;
    ours: string;
    theirs: string;
    ancestor: string | null;
    proposed: string;
    explanation: string | null;
};

export type AiConflictProposalResult = AiProviderResultMetadata & {
    proposalId: string;
    filePath: string;
    regions: AiConflictRegionProposal[];
};

export type AiConflictResolutionResult = {
    filePath: string;
    resolvedRegions: number;
};

export type AiConflictEligibility = {
    eligible: boolean;
    reason: string | null;
};

export type AiContextPreview = {
    provider: AiProvider;
    destinationAuthority: string;
    task: "commitMessage" | "conflictResolution" | "stagedReview" | "branchSummary" | "pullRequestDescription" | "releaseNotes";
    files: string[];
    contextSizeKib: number;
    contextLimitKib: number;
    includesCommitHistory: boolean;
};

export type AiModelSort =
    | "Popularity"
    | "PromptPrice"
    | "CompletionPrice"
    | "Context"
    | "Latency"
    | "Throughput"
    | "CodingScore"
    | "Newest";

export type AiModelQuery = {
    search: string;
    page: number;
    pageSize: number;
    programmingOnly: boolean;
    author: string;
    hostingProvider: string;
    minimumContextLength: number | null;
    maximumPromptPrice: number | null;
    maximumCompletionPrice: number | null;
    zdrOnly: boolean;
    sort: AiModelSort;
};

export type AiModelInfo = {
    id: string;
    canonicalSlug: string | null;
    name: string;
    description: string | null;
    contextLength: number | null;
    maximumCompletionTokens: number | null;
    inputModalities: string[];
    outputModalities: string[];
    supportedParameters: string[];
    promptPrice: string | null;
    completionPrice: string | null;
    requestPrice: string | null;
    cacheReadPrice: string | null;
    cacheWritePrice: string | null;
    reasoning: boolean;
    structuredOutput: boolean;
    availableProviders: string[];
    quantisations: string[];
    latency: number | null;
    throughput: number | null;
    uptime: number | null;
    codingScore: number | null;
    zeroDataRetention: boolean | null;
    created: number | null;
};

export type AiModelPage = {
    models: AiModelInfo[];
    page: number;
    pageSize: number;
    hasMore: boolean;
};

export type AiErrorCode =
    | "apiKeyInvalid"
    | "notConfigured"
    | "extensionDisabled"
    | "apiKeyRequired"
    | "baseReferenceInvalid"
    | "baseReferenceRequired"
    | "authHeaderInvalid"
    | "authentication"
    | "configurationWriteFailed"
    | "consentRequired"
    | "conflictProposalExpired"
    | "conflictRegionUnknown"
    | "conflictSessionUnavailable"
    | "contextTooLarge"
    | "credentialStoreUnavailable"
    | "deploymentRequired"
    | "endpointCredentialsForbidden"
    | "endpointInvalid"
    | "endpointRequired"
    | "endpointSchemeInvalid"
    | "fileUnavailable"
    | "fileWriteFailed"
    | "gitFailed"
    | "gitUnavailable"
    | "insecureRemoteEndpoint"
    | "invalidCandidateCount"
    | "invalidCommitControl"
    | "invalidEnvironment"
    | "invalidExclusion"
    | "invalidOperationId"
    | "invalidPath"
    | "invalidRepository"
    | "invalidRepositoryPolicy"
    | "malformedConflict"
    | "modelCatalogueTooLarge"
    | "modelDiscoveryUnavailable"
    | "modelRequired"
    | "noConflictMarkers"
    | "noConflictRegionsSelected"
    | "noChanges"
    | "noStagedChanges"
    | "noUnmergedIndex"
    | "operationAlreadyActive"
    | "sensitivePath"
    | "stagedChangesChanged"
    | "fileChanged"
    | "indexChanged"
    | "operationCancelled"
    | "operationBudgetExceeded"
    | "operationInProgress"
    | "operationNotFound"
    | "operationUnavailable"
    | "outputTruncated"
    | "profileNotFound"
    | "promptFileTooLarge"
    | "promptFileUnavailable"
    | "reasoningUnsupported"
    | "repositoryChanged"
    | "requestRejected"
    | "responseTooLarge"
    | "routeInvalid"
    | "timeout"
    | "unsafeRedirect"
    | "unsupportedFile"
    | "invalidResponse"
    | "environmentManaged"
    | "network"
    | "providerUnavailable"
    | "unknown";

export type AiError = {
    code: AiErrorCode;
    detail?: string | null;
    contextSizeKib?: number | null;
    contextLimitKib?: number | null;
};
