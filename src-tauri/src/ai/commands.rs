//! Tauri command surface owned by the bundled AI extension.

use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, atomic::Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Emitter;
use url::Url;

use crate::AppState;
use crate::ai::{
    AiApiStyle, AiAuthMode, AiConfigurationSource, AiError, AiExtensionSettings, AiModelInfo,
    AiModelPage, AiModelQuery, AiProfile, AiRepositoryPolicy, AiTask, AiUsage,
    EffectiveAiConfiguration, OpenRouterSettings, ProviderResult, api_key_optional,
    discover_effort, discover_models, discover_openrouter_model_details, run_provider,
};
use crate::git::types::{AiEffortCapability, AiProvider, AiReasoningPreference};

const MAX_COMMIT_TOTAL_CONTEXT_BYTES: usize = 1024 * 1024;
const COMMIT_SUMMARY_MAX_BYTES: usize = 1024;
const COMMIT_SUMMARY_MAX_TOKENS: u32 = 1024;
const COMMIT_PATH_LIST_MAX_BYTES: usize = 1536;
const COMMIT_STYLE_EXAMPLES_MAX_BYTES: usize = 2048;
const MAX_GIT_PATH_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_GIT_METADATA_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_AI_OPERATION_REQUESTS: usize = 64;
const MAX_AI_OPERATION_OUTBOUND_BYTES: usize = 2 * 1024 * 1024;
const AI_OPERATION_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const COMMIT_SUMMARY_PROMPT: &str = "Summarise this staged Git diff chunk for a later commit-message writer in at most 120 words. State only concrete changes and their purpose. Do not review the code, give advice, or write a commit message. Return concise plain text.";
const COMMIT_SUMMARY_REDUCTION_PROMPT: &str = "Consolidate these staged-change summaries for a later commit-message writer in at most 120 words. Preserve concrete changes and their purpose. Do not review the code, give advice, or write a commit message. Return concise plain text.";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAiConfigurationRequest {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub profile_name: Option<String>,
    pub provider: AiProvider,
    pub endpoint: String,
    pub model: String,
    pub reasoning_preference: AiReasoningPreference,
    #[serde(default)]
    pub api_style: Option<AiApiStyle>,
    #[serde(default)]
    pub request_path: Option<String>,
    #[serde(default)]
    pub models_path: Option<String>,
    #[serde(default)]
    pub auth_mode: Option<AiAuthMode>,
    #[serde(default)]
    pub auth_header: Option<String>,
    #[serde(default)]
    pub max_tokens_field: Option<String>,
    #[serde(default)]
    pub azure_deployment: Option<String>,
    #[serde(default)]
    pub azure_api_version: Option<String>,
    #[serde(default)]
    pub open_router: Option<OpenRouterSettings>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfigurationView {
    pub enabled: bool,
    pub selected_profile_id: String,
    pub profiles: Vec<AiProfile>,
    pub provider: AiProvider,
    pub endpoint: String,
    pub model: String,
    pub reasoning_preference: AiReasoningPreference,
    pub effort_capability: AiEffortCapability,
    pub commit_context_limit_kib: u32,
    pub conflict_context_limit_kib: u32,
    pub commit_message_max_tokens: u32,
    pub conflict_resolution_max_tokens: u32,
    pub commit_message_prompt: String,
    pub conflict_resolution_prompt: String,
    pub include_commit_history: bool,
    pub has_api_key: bool,
    pub credential_managed_by_environment: bool,
    pub configured: bool,
    pub insecure_transport: bool,
    pub sources: std::collections::BTreeMap<String, AiConfigurationSource>,
    pub environment_fields: Vec<String>,
    pub consent_required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextPreview {
    pub provider: AiProvider,
    pub destination_authority: String,
    pub task: &'static str,
    pub files: Vec<String>,
    pub context_size_kib: usize,
    pub context_limit_kib: u32,
    pub includes_commit_history: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiRepositoryPolicyRequest {
    pub repo_path: String,
    pub policy: AiRepositoryPolicy,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAiPrivacySettingsRequest {
    pub include_commit_history: bool,
    pub global_exclusions: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverAiModelDetailsRequest {
    pub configuration: SaveAiConfigurationRequest,
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConnectionTestResult {
    pub effort_capability: AiEffortCapability,
    pub usage: AiUsage,
    pub request_id: Option<String>,
    pub generation_id: Option<String>,
    pub routed_provider: Option<String>,
    pub routed_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitMessageResult {
    pub message: String,
    pub usage: AiUsage,
    pub request_id: Option<String>,
    pub generation_id: Option<String>,
    pub routed_provider: Option<String>,
    pub routed_model: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub enum AiCommitMessageMode {
    #[default]
    RepositoryStyle,
    ConventionalCommits,
    FreeForm,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
pub enum AiCommitWorkflow {
    #[default]
    Normal,
    Amend,
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl AiCommitWorkflow {
    fn label(self) -> &'static str {
        match self {
            Self::Normal => "normal commit",
            Self::Amend => "amended commit",
            Self::Merge => "merge commit",
            Self::Rebase => "rebase commit",
            Self::CherryPick => "cherry-pick commit",
            Self::Revert => "revert commit",
        }
    }

    fn expected_repository_operation(self) -> Option<&'static str> {
        match self {
            Self::Normal | Self::Amend => None,
            Self::Merge => Some("merge"),
            Self::Rebase => Some("rebase"),
            Self::CherryPick => Some("cherry-pick"),
            Self::Revert => Some("revert"),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateAiCommitMessagesRequest {
    pub repo_path: String,
    pub subject_limit: u32,
    #[serde(default)]
    pub operation_id: String,
    #[serde(default = "default_candidate_count")]
    pub candidate_count: u8,
    #[serde(default)]
    pub mode: AiCommitMessageMode,
    #[serde(default)]
    pub commit_type: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub language: String,
    #[serde(default)]
    pub issue_key: String,
    #[serde(default)]
    pub additional_instruction: String,
    #[serde(default)]
    pub workflow: AiCommitWorkflow,
    #[serde(default)]
    pub existing_message: String,
}

fn default_candidate_count() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitCandidatesResult {
    pub candidates: Vec<AiCommitMessageResult>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub enum AiWritingTask {
    StagedReview,
    BranchSummary,
    PullRequestDescription,
    ReleaseNotes,
}

impl AiWritingTask {
    fn identifier(self) -> &'static str {
        match self {
            Self::StagedReview => "stagedReview",
            Self::BranchSummary => "branchSummary",
            Self::PullRequestDescription => "pullRequestDescription",
            Self::ReleaseNotes => "releaseNotes",
        }
    }

    fn system_prompt(self) -> &'static str {
        match self {
            Self::StagedReview => {
                "Review the supplied staged changes without modifying them. Return concise Markdown findings ordered by severity. Cite relevant paths, explain concrete correctness, security or testing risks, and omit speculative or cosmetic comments. State clearly when no actionable findings are present."
            }
            Self::BranchSummary => {
                "Summarise the supplied branch changes as concise Markdown. Explain the purpose, main implementation changes, tests and material risks. Do not invent work that is not present in the supplied context."
            }
            Self::PullRequestDescription => {
                "Write a pull request title and concise Markdown description from the supplied branch changes. Include summary, testing and material risk sections. Do not claim tests were run unless the context says so."
            }
            Self::ReleaseNotes => {
                "Write concise user-facing Markdown release notes from the supplied commits and changes. Group related changes, prioritise user impact, and omit implementation detail that is not useful to users. Do not invent changes."
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateAiWritingRequest {
    pub repo_path: String,
    pub task: AiWritingTask,
    #[serde(default)]
    pub base_reference: String,
    #[serde(default)]
    pub additional_instruction: String,
    #[serde(default)]
    pub operation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWritingContextPreviewRequest {
    pub repo_path: String,
    pub task: AiWritingTask,
    #[serde(default)]
    pub base_reference: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiWritingResult {
    pub content: String,
    pub usage: AiUsage,
    pub request_id: Option<String>,
    pub generation_id: Option<String>,
    pub routed_provider: Option<String>,
    pub routed_model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiOperationProgress {
    operation_id: String,
    task: &'static str,
    stage: &'static str,
}

fn emit_ai_progress(
    app: &tauri::AppHandle,
    operation_id: &str,
    task: &'static str,
    stage: &'static str,
) {
    drop(app.emit(
        "ai-operation-progress",
        AiOperationProgress {
            operation_id: operation_id.to_string(),
            task,
            stage,
        },
    ));
}

fn record_ai_usage(
    state: &AppState,
    task: &str,
    started_at: Instant,
    usage: Option<&AiUsage>,
    request_id: Option<&str>,
    generation_id: Option<&str>,
    routed_provider: Option<&str>,
    routed_model: Option<&str>,
    diagnostic: Option<&str>,
    status: &str,
) {
    let settings = state.git_service.get_settings();
    let Ok(configuration) = state.ai_extension.environment.resolve(&settings) else {
        return;
    };
    let usage = usage.cloned().unwrap_or_default();
    state.git_service.record_ai_usage(crate::ai::AiUsageRecord {
        timestamp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        provider: configuration.provider,
        profile_id: configuration.profile_id,
        model: configuration.model,
        task: task.to_string(),
        duration_ms: started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        reasoning_tokens: usage.reasoning_tokens,
        cached_tokens: usage.cached_tokens,
        cost: usage.cost,
        byok: usage.byok,
        request_id: request_id.map(str::to_string),
        generation_id: generation_id.map(str::to_string),
        routed_provider: routed_provider.map(str::to_string),
        routed_model: routed_model.map(str::to_string),
        diagnostic: diagnostic.map(str::to_string),
        status: status.to_string(),
    });
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveConflictWithAiRequest {
    pub repo_path: String,
    pub file_path: String,
    #[serde(default)]
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConflictResolutionResult {
    pub file_path: String,
    pub resolved_regions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConflictRegionProposal {
    pub id: String,
    pub original: String,
    pub ours: String,
    pub theirs: String,
    pub ancestor: Option<String>,
    pub proposed: String,
    pub explanation: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConflictProposalResult {
    pub proposal_id: String,
    pub file_path: String,
    pub regions: Vec<AiConflictRegionProposal>,
    pub usage: AiUsage,
    pub request_id: Option<String>,
    pub generation_id: Option<String>,
    pub routed_provider: Option<String>,
    pub routed_model: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyAiConflictProposalRequest {
    pub proposal_id: String,
    pub region_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegenerateAiConflictRegionsRequest {
    pub proposal_id: String,
    pub region_ids: Vec<String>,
    #[serde(default)]
    pub operation_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConflictEligibility {
    pub eligible: bool,
    pub reason: Option<&'static str>,
}

#[derive(Debug, Clone)]
struct CommitContext {
    branch: String,
    workflow: AiCommitWorkflow,
    existing_message: String,
    subject_limit: u32,
    path_list: String,
    recent_messages: String,
    diff: String,
    staged_snapshot: md5::Digest,
}

#[derive(Debug, Clone)]
struct WritingContext {
    files: Vec<String>,
    content: String,
    snapshot: md5::Digest,
}

struct RequestBudget {
    requests: usize,
    outbound_bytes: usize,
}

impl RequestBudget {
    fn new() -> Self {
        Self {
            requests: 0,
            outbound_bytes: 0,
        }
    }

    fn charge(&mut self, system_prompt: &str, user_prompt: &str) -> Result<(), AiError> {
        self.requests += 1;
        self.outbound_bytes = self
            .outbound_bytes
            .saturating_add(system_prompt.len())
            .saturating_add(user_prompt.len());
        if self.requests > MAX_AI_OPERATION_REQUESTS
            || self.outbound_bytes > MAX_AI_OPERATION_OUTBOUND_BYTES
        {
            return Err(AiError::new("operationBudgetExceeded"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct ConflictRegion {
    id: String,
    start: usize,
    end: usize,
    prompt: String,
    original: String,
    ours: String,
    theirs: String,
    ancestor: Option<String>,
}

struct PreparedConflict {
    repository: PathBuf,
    original_bytes: Vec<u8>,
    operation: &'static str,
    index_hash: md5::Digest,
    regions: Vec<ConflictRegion>,
}

#[derive(Deserialize)]
struct ModelConflictResponse {
    regions: Vec<ModelConflictReplacement>,
}

#[derive(Deserialize)]
struct ModelConflictReplacement {
    id: String,
    replacement: String,
    #[serde(default)]
    explanation: Option<String>,
}

async fn configuration_view(state: &AppState) -> Result<AiConfigurationView, AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    let has_api_key = read_api_key(state, &configuration, true).await?.is_some();
    let insecure_transport =
        Url::parse(&configuration.endpoint).is_ok_and(|url| url.scheme() == "http");
    let configured = validate_effective_configuration(&configuration, true).is_ok()
        && (has_api_key || api_key_optional(&configuration));
    let consent_required = configuration
        .consent_key()
        .is_ok_and(|key| !settings.extensions.ai.consented_destinations.contains(&key));
    Ok(AiConfigurationView {
        enabled: configuration.enabled,
        selected_profile_id: settings.extensions.ai.selected_profile_id,
        profiles: settings.extensions.ai.profiles,
        provider: configuration.provider,
        endpoint: configuration.endpoint,
        model: configuration.model,
        reasoning_preference: configuration.reasoning_preference,
        effort_capability: configuration.effort_capability,
        commit_context_limit_kib: configuration.commit_context_limit_kib,
        conflict_context_limit_kib: configuration.conflict_context_limit_kib,
        commit_message_max_tokens: configuration.commit_message_max_tokens,
        conflict_resolution_max_tokens: configuration.conflict_resolution_max_tokens,
        commit_message_prompt: configuration.commit_message_prompt,
        conflict_resolution_prompt: configuration.conflict_resolution_prompt,
        include_commit_history: configuration.include_commit_history,
        has_api_key,
        credential_managed_by_environment: configuration.environment_api_key,
        configured,
        insecure_transport,
        sources: configuration.sources,
        environment_fields: configuration.environment_fields,
        consent_required,
    })
}

fn require_consent(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
) -> Result<(), AiError> {
    let key = configuration.consent_key()?;
    if state
        .git_service
        .get_settings()
        .extensions
        .ai
        .consented_destinations
        .contains(&key)
    {
        Ok(())
    } else {
        Err(AiError::with_detail(
            "consentRequired",
            configuration.destination_authority()?,
        ))
    }
}

fn repository_context_options(
    state: &AppState,
    repo_path: &str,
    configuration: &EffectiveAiConfiguration,
) -> (bool, Vec<String>) {
    let settings = state.git_service.get_settings();
    let repository_key = Path::new(repo_path)
        .canonicalize()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    let policy = repository_key
        .as_ref()
        .and_then(|key| settings.extensions.ai.repository_policies.get(key))
        .or_else(|| settings.extensions.ai.repository_policies.get(repo_path));
    let include_history = policy
        .and_then(|policy| policy.include_commit_history)
        .unwrap_or(configuration.include_commit_history);
    let mut exclusions = configuration.global_exclusions.clone();
    if let Some(policy) = policy {
        exclusions.extend(policy.exclusions.clone());
    }
    (include_history, exclusions)
}

fn repository_policy(state: &AppState, repo_path: &str) -> AiRepositoryPolicy {
    let settings = state.git_service.get_settings();
    let repository_key = Path::new(repo_path)
        .canonicalize()
        .ok()
        .map(|path| path.to_string_lossy().to_string());
    repository_key
        .as_ref()
        .and_then(|key| settings.extensions.ai.repository_policies.get(key))
        .or_else(|| settings.extensions.ai.repository_policies.get(repo_path))
        .cloned()
        .unwrap_or_default()
}

fn read_repository_prompt(repo_path: &str, prompt_path: &str) -> Result<Option<String>, AiError> {
    if prompt_path.is_empty() {
        return Ok(None);
    }
    let path = safe_repository_file(repo_path, prompt_path)?;
    let file = std::fs::File::open(path).map_err(|_| AiError::new("promptFileUnavailable"))?;
    let mut bytes = Vec::new();
    file.take(MAX_GIT_METADATA_OUTPUT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AiError::new("promptFileUnavailable"))?;
    if bytes.len() > MAX_GIT_METADATA_OUTPUT_BYTES {
        return Err(AiError::new("promptFileTooLarge"));
    }
    let prompt = String::from_utf8(bytes).map_err(|_| AiError::new("promptFileUnavailable"))?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(AiError::new("promptFileUnavailable"));
    }
    Ok(Some(prompt.to_string()))
}

async fn apply_repository_prompts(
    state: &AppState,
    repo_path: &str,
    configuration: &mut EffectiveAiConfiguration,
    task: AiTask,
) -> Result<(), AiError> {
    let policy = repository_policy(state, repo_path);
    match task {
        AiTask::CommitMessage => {
            if !configuration
                .environment_fields
                .iter()
                .any(|field| field == "commitMessagePrompt")
            {
                let repository = repo_path.to_string();
                let prompt_path = policy.commit_prompt_file;
                let prompt = tauri::async_runtime::spawn_blocking(move || {
                    read_repository_prompt(&repository, &prompt_path)
                })
                .await
                .map_err(|_| AiError::new("promptFileUnavailable"))??;
                if let Some(prompt) = prompt {
                    configuration.commit_message_prompt = prompt;
                }
            }
        }
        AiTask::ConflictResolution => {
            if !configuration
                .environment_fields
                .iter()
                .any(|field| field == "conflictResolutionPrompt")
            {
                let repository = repo_path.to_string();
                let prompt_path = policy.conflict_prompt_file;
                let prompt = tauri::async_runtime::spawn_blocking(move || {
                    read_repository_prompt(&repository, &prompt_path)
                })
                .await
                .map_err(|_| AiError::new("promptFileUnavailable"))??;
                if let Some(prompt) = prompt {
                    configuration.conflict_resolution_prompt = prompt;
                }
            }
        }
        AiTask::ConnectionTest => {}
    }
    Ok(())
}

fn validate_configuration(request: &SaveAiConfigurationRequest) -> Result<(), AiError> {
    let endpoint = request.endpoint.trim().to_string();
    if request.provider == AiProvider::Disabled {
        return Ok(());
    }
    if endpoint.is_empty() && request.provider.default_endpoint().is_empty() {
        return Err(AiError::new("endpointRequired"));
    }
    if !endpoint.is_empty() {
        crate::ai::validate_endpoint(&endpoint)?;
    }
    for path in [
        request.request_path.as_deref(),
        request.models_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !path.is_empty() && (!path.starts_with('/') || path.contains(['?', '#'])) {
            return Err(AiError::new("routeInvalid"));
        }
    }
    if request.provider == AiProvider::OpenRouter {
        let settings = request.open_router.as_ref().cloned().unwrap_or_default();
        for value in [&settings.max_prompt_price, &settings.max_completion_price] {
            if !value.is_empty()
                && value
                    .parse::<f64>()
                    .ok()
                    .is_none_or(|price| !price.is_finite() || price < 0.0)
            {
                return Err(AiError::new("routeInvalid"));
            }
        }
        for value in [
            &settings.preferred_max_latency,
            &settings.preferred_min_throughput,
        ] {
            if !value.is_empty()
                && value
                    .parse::<f64>()
                    .ok()
                    .is_none_or(|preference| !preference.is_finite() || preference <= 0.0)
            {
                return Err(AiError::new("routeInvalid"));
            }
        }
        for provider in settings
            .preferred_providers
            .iter()
            .chain(&settings.allowed_providers)
            .chain(&settings.ignored_providers)
        {
            if provider.is_empty() || provider.len() > 128 || provider.chars().any(char::is_control)
            {
                return Err(AiError::new("routeInvalid"));
            }
        }
    }
    Ok(())
}

fn validate_effective_configuration(
    configuration: &EffectiveAiConfiguration,
    require_model: bool,
) -> Result<(), AiError> {
    if !configuration.enabled || configuration.provider == AiProvider::Disabled {
        return Err(AiError::new("notConfigured"));
    }
    configuration.endpoint_url()?;
    if require_model && configuration.model.trim().is_empty() {
        return Err(AiError::new("modelRequired"));
    }
    if configuration.provider == AiProvider::AzureOpenAi
        && configuration.azure_deployment.trim().is_empty()
    {
        return Err(AiError::new("deploymentRequired"));
    }
    Ok(())
}

fn profile_id(request: &SaveAiConfigurationRequest, current: Option<&AiProfile>) -> String {
    request
        .profile_id
        .as_deref()
        .map(str::trim)
        .filter(|id| {
            !id.is_empty()
                && id
                    .chars()
                    .all(|character| character == '-' || character.is_ascii_alphanumeric())
        })
        .map(str::to_string)
        .or_else(|| current.map(|profile| profile.id.clone()))
        .unwrap_or_else(|| {
            let timestamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            format!("profile-{timestamp:x}")
        })
}

fn profile_from_request(
    request: &SaveAiConfigurationRequest,
    current: Option<&AiProfile>,
) -> AiProfile {
    let mut profile = current.cloned().unwrap_or_default();
    profile.id = profile_id(request, current);
    if let Some(name) = &request.profile_name {
        profile.name = name.trim().to_string();
    }
    let destination_changed = profile.provider != request.provider
        || profile.endpoint.trim() != request.endpoint.trim()
        || profile.model.trim() != request.model.trim();
    profile.provider = request.provider;
    profile.endpoint = request.endpoint.trim().to_string();
    profile.model = request.model.trim().to_string();
    profile.reasoning_preference = request.reasoning_preference;
    if destination_changed {
        profile.effort_capability = AiEffortCapability::Unknown;
    }
    if let Some(value) = request.api_style {
        profile.api_style = value;
    }
    if let Some(value) = &request.request_path {
        profile.request_path = value.trim().to_string();
    }
    if let Some(value) = &request.models_path {
        profile.models_path = value.trim().to_string();
    }
    if let Some(value) = request.auth_mode {
        profile.auth_mode = value;
    }
    if let Some(value) = &request.auth_header {
        profile.auth_header = value.trim().to_string();
    }
    if let Some(value) = &request.max_tokens_field {
        profile.max_tokens_field = value.trim().to_string();
    }
    if let Some(value) = &request.azure_deployment {
        profile.azure_deployment = value.trim().to_string();
    }
    if let Some(value) = &request.azure_api_version {
        profile.azure_api_version = value.trim().to_string();
    }
    if let Some(value) = &request.open_router {
        profile.open_router = value.clone();
    }
    profile
}

fn requested_profile<'a>(
    request: &SaveAiConfigurationRequest,
    settings: &'a AiExtensionSettings,
) -> Option<&'a AiProfile> {
    request
        .profile_id
        .as_deref()
        .and_then(|id| settings.profiles.iter().find(|profile| profile.id == id))
}

async fn read_api_key(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
    migrate_legacy: bool,
) -> Result<Option<String>, AiError> {
    if let Some(api_key) = state
        .ai_extension
        .environment
        .api_key(configuration.provider)
    {
        return Ok(Some(api_key));
    }
    let scope = configuration.credential_scope()?;
    let is_migrated_profile = configuration.profile_id == "migrated-default";
    let credentials = Arc::clone(&state.ai_extension.credentials);
    tauri::async_runtime::spawn_blocking(move || {
        if let Some(api_key) = credentials.read_api_key(&scope)? {
            return Ok(Some(api_key));
        }
        if migrate_legacy && is_migrated_profile {
            if let Some(api_key) = credentials.read_legacy_api_key()? {
                credentials.set_api_key(&scope, &api_key)?;
                credentials.clear_legacy_api_key()?;
                return Ok(Some(api_key));
            }
        }
        Ok(None)
    })
    .await
    .map_err(|_| AiError::new("credentialStoreUnavailable"))?
}

async fn write_api_key(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
    api_key: String,
) -> Result<(), AiError> {
    if configuration.environment_api_key {
        return Err(AiError::new("environmentManaged"));
    }
    let scope = configuration.credential_scope()?;
    let credentials = Arc::clone(&state.ai_extension.credentials);
    tauri::async_runtime::spawn_blocking(move || credentials.set_api_key(&scope, api_key.trim()))
        .await
        .map_err(|_| AiError::new("credentialStoreUnavailable"))?
}

async fn clear_api_key_for(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
) -> Result<(), AiError> {
    if configuration.environment_api_key {
        return Err(AiError::new("environmentManaged"));
    }
    let scope = configuration.credential_scope()?;
    let credentials = Arc::clone(&state.ai_extension.credentials);
    tauri::async_runtime::spawn_blocking(move || credentials.clear_api_key(&scope))
        .await
        .map_err(|_| AiError::new("credentialStoreUnavailable"))?
}

async fn read_stored_api_key_for(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
) -> Result<Option<String>, AiError> {
    let scope = configuration.credential_scope()?;
    let credentials = Arc::clone(&state.ai_extension.credentials);
    tauri::async_runtime::spawn_blocking(move || credentials.read_api_key(&scope))
        .await
        .map_err(|_| AiError::new("credentialStoreUnavailable"))?
}

async fn write_stored_api_key_for(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
    api_key: String,
) -> Result<(), AiError> {
    let scope = configuration.credential_scope()?;
    let credentials = Arc::clone(&state.ai_extension.credentials);
    tauri::async_runtime::spawn_blocking(move || credentials.set_api_key(&scope, &api_key))
        .await
        .map_err(|_| AiError::new("credentialStoreUnavailable"))?
}

async fn clear_stored_api_key_for(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
) -> Result<(), AiError> {
    let scope = configuration.credential_scope()?;
    let credentials = Arc::clone(&state.ai_extension.credentials);
    tauri::async_runtime::spawn_blocking(move || credentials.clear_api_key(&scope))
        .await
        .map_err(|_| AiError::new("credentialStoreUnavailable"))?
}

fn emit_configuration_updated(app: &tauri::AppHandle) {
    drop(app.emit("ai-configuration-updated", ()));
    crate::instance_coordinator::broadcast_settings_updated();
}

#[tauri::command]
pub async fn get_ai_configuration(
    state: tauri::State<'_, AppState>,
) -> Result<AiConfigurationView, AiError> {
    configuration_view(&state).await
}

#[tauri::command]
pub async fn save_ai_configuration(
    request: SaveAiConfigurationRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    validate_configuration(&request)?;
    if request
        .api_key
        .as_deref()
        .is_some_and(|api_key| api_key.trim().is_empty())
    {
        return Err(AiError::new("apiKeyRequired"));
    }
    let current = state.git_service.get_settings();
    let current_profile = requested_profile(&request, &current.extensions.ai);
    let profile = profile_from_request(&request, current_profile);
    let enabled = request.enabled.unwrap_or(current.extensions.ai.enabled);
    let mut proposed = current.clone();
    proposed.extensions.ai.enabled = enabled;
    proposed.extensions.ai.selected_profile_id = profile.id.clone();
    if let Some(existing) = proposed
        .extensions
        .ai
        .profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        *existing = profile.clone();
    } else {
        proposed.extensions.ai.profiles.push(profile.clone());
    }
    let proposed_configuration = state.ai_extension.environment.resolve(&proposed)?;
    if proposed_configuration
        .environment_fields
        .iter()
        .any(|field| {
            matches!(
                field.as_str(),
                "enabled" | "provider" | "endpoint" | "model" | "reasoningPreference"
            )
        })
    {
        return Err(AiError::new("environmentManaged"));
    }
    let current_configuration = current_profile.and_then(|profile| {
        let mut current_profile_settings = current.clone();
        current_profile_settings.extensions.ai.selected_profile_id = profile.id.clone();
        state
            .ai_extension
            .environment
            .resolve(&current_profile_settings)
            .ok()
    });
    let destination_changed = current_configuration.as_ref().is_some_and(|current| {
        current.credential_scope().ok() != proposed_configuration.credential_scope().ok()
    });
    let previous_destination_key = if destination_changed {
        let current_configuration = current_configuration.as_ref().unwrap();
        read_stored_api_key_for(&state, current_configuration).await?
    } else {
        None
    };
    let previous_api_key = if request.api_key.is_some() {
        read_stored_api_key_for(&state, &proposed_configuration).await?
    } else {
        None
    };
    if destination_changed {
        clear_stored_api_key_for(&state, current_configuration.as_ref().unwrap()).await?;
    }
    if let Some(api_key) = request.api_key.as_deref() {
        if let Err(error) =
            write_api_key(&state, &proposed_configuration, api_key.to_string()).await
        {
            if let (Some(current_configuration), Some(previous_destination_key)) = (
                current_configuration.as_ref(),
                previous_destination_key.as_ref(),
            ) {
                write_stored_api_key_for(
                    &state,
                    current_configuration,
                    previous_destination_key.clone(),
                )
                .await?;
            }
            return Err(error);
        }
    }
    let save_result = state.git_service.save_ai_profile(enabled, profile);
    if save_result.is_err() {
        if request.api_key.is_some() {
            if let Some(previous_api_key) = previous_api_key {
                write_stored_api_key_for(&state, &proposed_configuration, previous_api_key).await?;
            } else {
                clear_stored_api_key_for(&state, &proposed_configuration).await?;
            }
        }
        if let (Some(current_configuration), Some(previous_destination_key)) = (
            current_configuration.as_ref(),
            previous_destination_key.as_ref(),
        ) {
            write_stored_api_key_for(
                &state,
                current_configuration,
                previous_destination_key.clone(),
            )
            .await?;
        }
    }
    save_result.map_err(|_| AiError::new("configurationWriteFailed"))?;
    emit_configuration_updated(&app);
    configuration_view(&state).await
}

#[tauri::command]
pub async fn set_ai_api_key(
    api_key: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err(AiError::new("apiKeyRequired"));
    }
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    write_api_key(&state, &configuration, key.to_string()).await?;
    emit_configuration_updated(&app);
    configuration_view(&state).await
}

#[tauri::command]
pub async fn clear_ai_api_key(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    clear_api_key_for(&state, &configuration).await?;
    emit_configuration_updated(&app);
    configuration_view(&state).await
}

#[tauri::command]
pub async fn connect_openrouter(
    callback_message: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    if state
        .ai_extension
        .openrouter_oauth_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err(AiError::new("openRouterOAuthInProgress"));
    }
    let result = connect_openrouter_inner(callback_message, &state, &app).await;
    state
        .ai_extension
        .openrouter_oauth_active
        .store(false, Ordering::Release);
    result
}

async fn connect_openrouter_inner(
    callback_message: String,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    if configuration.provider != AiProvider::OpenRouter {
        return Err(AiError::new("openRouterOAuthProviderRequired"));
    }
    if configuration.environment_api_key {
        return Err(AiError::new("environmentManaged"));
    }
    let endpoint = configuration.endpoint_url()?;
    if !openrouter_oauth_endpoint_allowed(&endpoint) {
        return Err(AiError::new("openRouterOAuthOfficialEndpointRequired"));
    }
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    let api_key = crate::ai::openrouter_oauth::authorise(runtime, app, callback_message).await?;
    write_api_key(state, &configuration, api_key).await?;
    emit_configuration_updated(app);
    configuration_view(state).await
}

fn openrouter_oauth_endpoint_allowed(endpoint: &Url) -> bool {
    endpoint.origin().ascii_serialization() == "https://openrouter.ai"
}

#[tauri::command]
pub async fn grant_ai_consent(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    validate_effective_configuration(&configuration, false)?;
    state
        .git_service
        .grant_ai_destination_consent(configuration.consent_key()?)
        .map_err(|_| AiError::new("configurationWriteFailed"))?;
    emit_configuration_updated(&app);
    configuration_view(&state).await
}

#[tauri::command]
pub async fn set_ai_repository_policy(
    mut request: SetAiRepositoryPolicyRequest,
    state: tauri::State<'_, AppState>,
) -> Result<(), AiError> {
    if request.policy.exclusions.len() > 100
        || request.policy.default_language.len() > 64
        || request
            .policy
            .default_language
            .chars()
            .any(char::is_control)
    {
        return Err(AiError::new("invalidRepositoryPolicy"));
    }
    request.policy.exclusions = request
        .policy
        .exclusions
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect();
    if request
        .policy
        .exclusions
        .iter()
        .any(|value| value.len() > 256 || value.chars().any(char::is_control))
        || !valid_optional_repository_path(&request.policy.commit_prompt_file)
        || !valid_optional_repository_path(&request.policy.conflict_prompt_file)
    {
        return Err(AiError::new("invalidRepositoryPolicy"));
    }
    request.policy.default_language = request.policy.default_language.trim().to_string();
    request.policy.commit_prompt_file = request.policy.commit_prompt_file.trim().to_string();
    request.policy.conflict_prompt_file = request.policy.conflict_prompt_file.trim().to_string();
    let repository = tauri::async_runtime::spawn_blocking(move || {
        Path::new(&request.repo_path)
            .canonicalize()
            .map(|path| (path.to_string_lossy().to_string(), request.policy))
            .map_err(|_| AiError::new("invalidRepository"))
    })
    .await
    .map_err(|_| AiError::new("invalidRepository"))??;
    state
        .git_service
        .set_ai_repository_policy(repository.0, repository.1)
        .map_err(|_| AiError::new("configurationWriteFailed"))?;
    Ok(())
}

fn valid_optional_repository_path(value: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || (value.len() <= 512
            && !value.chars().any(char::is_control)
            && !Path::new(value).is_absolute()
            && Path::new(value)
                .components()
                .all(|part| matches!(part, Component::Normal(_))))
}

#[tauri::command]
pub async fn get_ai_repository_policy(
    repo_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<AiRepositoryPolicy, AiError> {
    let repository = tauri::async_runtime::spawn_blocking(move || {
        Path::new(&repo_path)
            .canonicalize()
            .map(|path| path.to_string_lossy().to_string())
            .map_err(|_| AiError::new("invalidRepository"))
    })
    .await
    .map_err(|_| AiError::new("invalidRepository"))??;
    Ok(state
        .git_service
        .get_settings()
        .extensions
        .ai
        .repository_policies
        .get(&repository)
        .cloned()
        .unwrap_or_default())
}

#[tauri::command]
pub fn set_ai_privacy_settings(
    mut request: SetAiPrivacySettingsRequest,
    state: tauri::State<'_, AppState>,
) -> Result<(), AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    if configuration
        .environment_fields
        .iter()
        .any(|field| field == "includeCommitHistory")
    {
        request.include_commit_history = settings.extensions.ai.include_commit_history;
    }
    if request.global_exclusions.len() > 100 {
        return Err(AiError::new("invalidExclusion"));
    }
    let mut exclusions = Vec::with_capacity(request.global_exclusions.len());
    for exclusion in request.global_exclusions {
        let exclusion = exclusion.trim();
        if exclusion.is_empty() {
            continue;
        }
        if exclusion.len() > 256 || exclusion.chars().any(char::is_control) {
            return Err(AiError::new("invalidExclusion"));
        }
        if !exclusions.iter().any(|existing| existing == exclusion) {
            exclusions.push(exclusion.to_string());
        }
    }
    state
        .git_service
        .set_ai_privacy_settings(request.include_commit_history, exclusions)
        .map_err(|_| AiError::new("configurationWriteFailed"))?;
    Ok(())
}

async fn configured_settings(
    state: &AppState,
    require_model: bool,
) -> Result<(EffectiveAiConfiguration, String), AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    validate_effective_configuration(&configuration, require_model)?;
    let key = if api_key_optional(&configuration) {
        String::new()
    } else {
        read_api_key(state, &configuration, true)
            .await?
            .ok_or_else(|| AiError::new("notConfigured"))?
    };
    Ok((configuration, key))
}

#[tauri::command]
pub async fn test_ai_connection(
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConnectionTestResult, AiError> {
    let (configuration, api_key) = configured_settings(&state, true).await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    require_consent(&state, &configuration)?;
    let discovered = discover_effort(runtime, &configuration, &api_key).await;
    let (result, tested_capability) = run_provider(
        runtime,
        &configuration,
        &api_key,
        "Return only the requested text.",
        "Reply with OK only.",
        64,
        AiTask::ConnectionTest,
    )
    .await?;
    if result.output_truncated {
        return Err(AiError::new("outputTruncated"));
    }
    if result.text.trim().is_empty() {
        return Err(AiError::new("invalidResponse"));
    }
    let capability = discovered.unwrap_or(tested_capability);
    state
        .git_service
        .set_ai_effort_capability(&configuration.profile_id, capability.clone());
    emit_configuration_updated(&app);
    Ok(AiConnectionTestResult {
        effort_capability: capability,
        usage: result.usage,
        request_id: result.request_id,
        generation_id: result.generation_id,
        routed_provider: result.routed_provider,
        routed_model: result.routed_model,
    })
}

#[tauri::command]
pub async fn test_ai_connection_draft(
    request: SaveAiConfigurationRequest,
    state: tauri::State<'_, AppState>,
) -> Result<AiConnectionTestResult, AiError> {
    let (configuration, api_key) = draft_configuration(&request, &state, true).await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    let discovered = discover_effort(runtime, &configuration, &api_key).await;
    let (result, tested_capability) = run_provider(
        runtime,
        &configuration,
        &api_key,
        "Return only the requested text.",
        "Reply with OK only.",
        64,
        AiTask::ConnectionTest,
    )
    .await?;
    if result.output_truncated || result.text.trim().is_empty() {
        return Err(AiError::new("invalidResponse"));
    }
    Ok(AiConnectionTestResult {
        effort_capability: discovered.unwrap_or(tested_capability),
        usage: result.usage,
        request_id: result.request_id,
        generation_id: result.generation_id,
        routed_provider: result.routed_provider,
        routed_model: result.routed_model,
    })
}

async fn draft_configuration(
    request: &SaveAiConfigurationRequest,
    state: &AppState,
    require_model: bool,
) -> Result<(EffectiveAiConfiguration, String), AiError> {
    validate_configuration(&request)?;
    let current = state.git_service.get_settings();
    let current_profile = requested_profile(request, &current.extensions.ai);
    let profile = profile_from_request(&request, current_profile);
    let mut proposed = current;
    proposed.extensions.ai.enabled = request.enabled.unwrap_or(true);
    proposed.extensions.ai.selected_profile_id = profile.id.clone();
    if let Some(existing) = proposed
        .extensions
        .ai
        .profiles
        .iter_mut()
        .find(|existing| existing.id == profile.id)
    {
        *existing = profile;
    } else {
        proposed.extensions.ai.profiles.push(profile);
    }
    let configuration = state.ai_extension.environment.resolve(&proposed)?;
    validate_effective_configuration(&configuration, require_model)?;
    let api_key = if configuration.environment_api_key {
        state
            .ai_extension
            .environment
            .api_key(configuration.provider)
            .unwrap_or_default()
    } else if let Some(api_key) = request
        .api_key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
    {
        api_key.to_string()
    } else {
        read_api_key(&state, &configuration, false)
            .await?
            .unwrap_or_default()
    };
    if api_key.is_empty() && !api_key_optional(&configuration) {
        return Err(AiError::new("apiKeyRequired"));
    }
    Ok((configuration, api_key))
}

#[tauri::command]
pub async fn discover_ai_models_draft(
    request: SaveAiConfigurationRequest,
    query: AiModelQuery,
    state: tauri::State<'_, AppState>,
) -> Result<AiModelPage, AiError> {
    let (configuration, api_key) = draft_configuration(&request, &state, false).await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    discover_models(runtime, &configuration, &api_key, &query).await
}

#[tauri::command]
pub async fn discover_ai_model_details_draft(
    request: DiscoverAiModelDetailsRequest,
    state: tauri::State<'_, AppState>,
) -> Result<AiModelInfo, AiError> {
    let (configuration, api_key) =
        draft_configuration(&request.configuration, &state, false).await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    discover_openrouter_model_details(runtime, &configuration, &api_key, &request.model_id).await
}

#[tauri::command]
pub async fn discover_ai_models(
    query: AiModelQuery,
    state: tauri::State<'_, AppState>,
) -> Result<AiModelPage, AiError> {
    let (configuration, api_key) = configured_settings(&state, false).await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    discover_models(runtime, &configuration, &api_key, &query).await
}

#[tauri::command]
pub async fn delete_ai_profile(
    profile_id: String,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConfigurationView, AiError> {
    let settings = state.git_service.get_settings();
    let profile = settings
        .extensions
        .ai
        .profiles
        .iter()
        .find(|profile| profile.id == profile_id)
        .cloned()
        .ok_or_else(|| AiError::new("profileNotFound"))?;
    let mut profile_settings = settings.clone();
    profile_settings.extensions.ai.selected_profile_id = profile.id.clone();
    let configuration = state.ai_extension.environment.resolve(&profile_settings)?;
    let previous_key = read_stored_api_key_for(&state, &configuration).await?;
    clear_stored_api_key_for(&state, &configuration).await?;
    let result = state
        .git_service
        .delete_ai_profile(&profile_id)
        .map_err(|_| AiError::new("configurationWriteFailed"));
    if result.is_err() {
        if let Some(previous_key) = previous_key {
            write_stored_api_key_for(&state, &configuration, previous_key).await?;
        }
    }
    result?;
    emit_configuration_updated(&app);
    configuration_view(&state).await
}

fn git_output(
    repo_path: &str,
    arguments: &[&str],
    maximum_bytes: usize,
) -> Result<Vec<u8>, AiError> {
    let mut command = crate::git_command();
    command
        .arg("-C")
        .arg(repo_path)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|_| AiError::new("gitUnavailable"))?;
    let mut output = Vec::new();
    child
        .stdout
        .take()
        .ok_or_else(|| AiError::new("gitFailed"))?
        .take(maximum_bytes as u64 + 1)
        .read_to_end(&mut output)
        .map_err(|_| AiError::new("gitFailed"))?;
    if output.len() > maximum_bytes {
        drop(child.kill());
        drop(child.wait());
        return Err(AiError::new("contextTooLarge"));
    }
    let status = child.wait().map_err(|_| AiError::new("gitFailed"))?;
    if !status.success() {
        return Err(AiError::new("gitFailed"));
    }
    Ok(output)
}

fn repository_operation(repo_path: &str) -> Result<Option<&'static str>, AiError> {
    let git_dir = String::from_utf8(git_output(
        repo_path,
        &["rev-parse", "--absolute-git-dir"],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )?)
    .map_err(|_| AiError::new("gitFailed"))?;
    let git_dir = PathBuf::from(git_dir.trim());
    if git_dir.join("MERGE_HEAD").exists() {
        Ok(Some("merge"))
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Ok(Some("rebase"))
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Ok(Some("cherry-pick"))
    } else if git_dir.join("REVERT_HEAD").exists() {
        Ok(Some("revert"))
    } else {
        Ok(None)
    }
}

fn is_sensitive_path(path: &str) -> bool {
    let normalised = path.replace('\\', "/");
    let lower = normalised.to_ascii_lowercase();
    let components = lower.split('/').collect::<Vec<_>>();
    let file_name = components.last().copied().unwrap_or_default();
    file_name == ".env"
        || file_name.starts_with(".env.")
        || matches!(file_name, ".npmrc" | ".pypirc" | ".netrc")
        || components
            .iter()
            .any(|part| matches!(*part, ".ssh" | ".aws" | ".gnupg"))
        || file_name.starts_with("id_rsa")
        || file_name.starts_with("id_ed25519")
        || [".pem", ".key", ".p12", ".pfx"]
            .iter()
            .any(|suffix| file_name.ends_with(suffix))
}

fn parse_name_status(output: &[u8]) -> Result<Vec<(String, String)>, AiError> {
    let fields = output
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect::<Vec<_>>();
    let mut result = Vec::new();
    let mut index = 0;
    while index < fields.len() {
        let status = String::from_utf8_lossy(fields[index]).to_string();
        index += 1;
        if index >= fields.len() {
            return Err(AiError::new("gitFailed"));
        }
        if status.starts_with('R') || status.starts_with('C') {
            if index + 1 >= fields.len() {
                return Err(AiError::new("gitFailed"));
            }
            let old_path = String::from_utf8_lossy(fields[index]).to_string();
            let new_path = String::from_utf8_lossy(fields[index + 1]).to_string();
            result.push((status, format!("{old_path} -> {new_path}")));
            index += 2;
        } else {
            result.push((status, String::from_utf8_lossy(fields[index]).to_string()));
            index += 1;
        }
    }
    Ok(result)
}

fn staged_paths(repo_path: &str) -> Result<Vec<(String, String)>, AiError> {
    let output = git_output(
        repo_path,
        &["diff", "--cached", "--name-status", "-z"],
        MAX_GIT_PATH_OUTPUT_BYTES,
    )?;
    parse_name_status(&output)
}

fn recent_commit_messages(repo_path: &str) -> String {
    let Ok(output) = git_output(
        repo_path,
        &["log", "-n", "20", "--no-merges", "--format=%B%x00"],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    ) else {
        return "None available.".to_string();
    };
    let messages = String::from_utf8_lossy(&output)
        .split('\0')
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    if messages.is_empty() {
        "None available.".to_string()
    } else {
        messages.join("\n---\n")
    }
}

fn validate_context_size(context_bytes: usize, context_limit_kib: u32) -> Result<(), AiError> {
    if context_bytes > context_limit_kib as usize * 1024 {
        return Err(AiError::context_too_large(context_bytes, context_limit_kib));
    }
    Ok(())
}

fn final_commit_instruction(subject_limit: u32) -> String {
    if subject_limit == 0 {
        "Now return only the commit message. Do not review or explain the changes.".to_string()
    } else {
        format!(
            "Now return only the commit message. Keep its subject to no more than {subject_limit} characters. Do not review or explain the changes."
        )
    }
}

fn render_commit_context(context: &CommitContext) -> String {
    let subject_limit = if context.subject_limit == 0 {
        "Disabled".to_string()
    } else {
        context.subject_limit.to_string()
    };
    format!(
        "Branch: {}\nWorkflow: {}\nSubject limit: {subject_limit}\nExisting Git-provided or user message:\n{}\n\nStaged files:\n{}\n\nRecent commit messages for style:\n{}\n\nStaged diff:\n{}\n\n{}",
        context.branch,
        context.workflow.label(),
        if context.existing_message.is_empty() {
            "None."
        } else {
            &context.existing_message
        },
        context.path_list,
        context.recent_messages,
        context.diff,
        final_commit_instruction(context.subject_limit)
    )
}

fn wildcard_matches(pattern: &str, value: &str) -> bool {
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    let (mut pattern_index, mut value_index, mut star, mut star_value) = (0, 0, None, 0);
    while value_index < value.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
        {
            pattern_index += 1;
            value_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star = Some(pattern_index);
            pattern_index += 1;
            star_value = value_index;
        } else if let Some(star_index) = star {
            pattern_index = star_index + 1;
            star_value += 1;
            value_index = star_value;
        } else {
            return false;
        }
    }
    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }
    pattern_index == pattern.len()
}

fn excluded_path(path: &str, exclusions: &[String]) -> bool {
    exclusions
        .iter()
        .map(|pattern| pattern.trim().replace('\\', "/"))
        .filter(|pattern| !pattern.is_empty())
        .any(|pattern| wildcard_matches(&pattern, &path.replace('\\', "/")))
}

fn staged_diff(repo_path: &str) -> Result<String, AiError> {
    String::from_utf8(git_output(
        repo_path,
        &[
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=1",
        ],
        MAX_COMMIT_TOTAL_CONTEXT_BYTES,
    )?)
    .map_err(|_| AiError::new("gitFailed"))
}

fn staged_snapshot(repo_path: &str) -> Result<md5::Digest, AiError> {
    let path_list = staged_paths(repo_path)?
        .iter()
        .map(|(status, path)| format!("{status}\t{path}"))
        .collect::<Vec<_>>()
        .join("\n");
    let diff = staged_diff(repo_path)?;
    let head = git_output(
        repo_path,
        &["rev-parse", "--verify", "HEAD"],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )
    .ok()
    .and_then(|value| String::from_utf8(value).ok())
    .unwrap_or_else(|| "unborn".to_string());
    let operation = repository_operation(repo_path)?.unwrap_or("none");
    Ok(md5::compute(format!(
        "{}\0{operation}\0{path_list}\0{diff}",
        head.trim()
    )))
}

fn build_commit_context(
    repo_path: &str,
    subject_limit: u32,
    include_commit_history: bool,
    exclusions: &[String],
    workflow: AiCommitWorkflow,
    existing_message: &str,
) -> Result<CommitContext, AiError> {
    if repository_operation(repo_path)? != workflow.expected_repository_operation() {
        return Err(AiError::new("operationInProgress"));
    }
    validate_commit_control(existing_message, 4096)?;
    let paths = staged_paths(repo_path)?;
    if paths.is_empty() {
        return Err(AiError::new("noStagedChanges"));
    }
    if paths.iter().any(|(_, path)| {
        path.split(" -> ")
            .any(|path| is_sensitive_path(path) || excluded_path(path, exclusions))
    }) {
        return Err(AiError::new("sensitivePath"));
    }
    let branch = git_output(
        repo_path,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )
    .ok()
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .map(|branch| branch.trim().to_string())
    .filter(|branch| !branch.is_empty())
    .unwrap_or_else(|| "detached HEAD".to_string());
    let diff = staged_diff(repo_path)?;
    let path_list = paths
        .iter()
        .map(|(status, path)| format!("{status}\t{path}"))
        .collect::<Vec<_>>()
        .join("\n");
    let recent_messages = if include_commit_history {
        recent_commit_messages(repo_path)
    } else {
        "Not included.".to_string()
    };
    let staged_snapshot = staged_snapshot(repo_path)?;
    let context = CommitContext {
        branch,
        workflow,
        existing_message: existing_message.trim().to_string(),
        subject_limit,
        path_list,
        recent_messages,
        diff,
        staged_snapshot,
    };
    validate_context_size(
        render_commit_context(&context).len(),
        (MAX_COMMIT_TOTAL_CONTEXT_BYTES / 1024) as u32,
    )?;
    Ok(context)
}

fn default_writing_base_reference(repo_path: &str, task: AiWritingTask) -> Result<String, AiError> {
    let arguments: &[&str] = match task {
        AiWritingTask::BranchSummary | AiWritingTask::PullRequestDescription => &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
        AiWritingTask::ReleaseNotes => &["describe", "--tags", "--abbrev=0"],
        AiWritingTask::StagedReview => return Ok(String::new()),
    };
    let value = git_output(repo_path, arguments, MAX_GIT_METADATA_OUTPUT_BYTES)
        .ok()
        .and_then(|value| String::from_utf8(value).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AiError::new("baseReferenceRequired"))?;
    Ok(value)
}

fn validate_base_reference(repo_path: &str, reference: &str) -> Result<String, AiError> {
    validate_commit_control(reference, 256)?;
    if reference.trim().is_empty() || reference.starts_with('-') {
        return Err(AiError::new("baseReferenceInvalid"));
    }
    let revision = format!("{}^{{commit}}", reference.trim());
    let value = git_output(
        repo_path,
        &["rev-parse", "--verify", &revision],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )
    .map_err(|_| AiError::new("baseReferenceInvalid"))?;
    String::from_utf8(value)
        .map(|value| value.trim().to_string())
        .map_err(|_| AiError::new("baseReferenceInvalid"))
}

fn writing_context(
    repo_path: &str,
    task: AiWritingTask,
    base_reference: &str,
    include_commit_history: bool,
    exclusions: &[String],
) -> Result<WritingContext, AiError> {
    if matches!(task, AiWritingTask::StagedReview) {
        let context = build_commit_context(
            repo_path,
            0,
            include_commit_history,
            exclusions,
            AiCommitWorkflow::Normal,
            "",
        )?;
        let content = format!(
            "Branch: {}\nStaged files:\n{}\n\nRecent commit messages:\n{}\n\nStaged diff:\n{}",
            context.branch, context.path_list, context.recent_messages, context.diff
        );
        return Ok(WritingContext {
            files: context
                .path_list
                .lines()
                .filter_map(|line| line.split_once('\t').map(|(_, path)| path.to_string()))
                .collect(),
            content,
            snapshot: context.staged_snapshot,
        });
    }
    if repository_operation(repo_path)?.is_some() {
        return Err(AiError::new("operationInProgress"));
    }
    let base_reference = if base_reference.trim().is_empty() {
        default_writing_base_reference(repo_path, task)?
    } else {
        base_reference.trim().to_string()
    };
    let base_commit = validate_base_reference(repo_path, &base_reference)?;
    let separator = match task {
        AiWritingTask::BranchSummary | AiWritingTask::PullRequestDescription => "...",
        AiWritingTask::ReleaseNotes => "..",
        AiWritingTask::StagedReview => unreachable!(),
    };
    let range = format!("{base_commit}{separator}HEAD");
    let path_output = git_output(
        repo_path,
        &["diff", "--name-status", "-z", &range],
        MAX_GIT_PATH_OUTPUT_BYTES,
    )?;
    let paths = parse_name_status(&path_output)?;
    if paths.is_empty() {
        return Err(AiError::new("noChanges"));
    }
    if paths.iter().any(|(_, path)| {
        path.split(" -> ")
            .any(|path| is_sensitive_path(path) || excluded_path(path, exclusions))
    }) {
        return Err(AiError::new("sensitivePath"));
    }
    let diff = String::from_utf8(git_output(
        repo_path,
        &[
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--unified=1",
            &range,
        ],
        MAX_COMMIT_TOTAL_CONTEXT_BYTES,
    )?)
    .map_err(|_| AiError::new("gitFailed"))?;
    let commit_range = format!("{base_commit}..HEAD");
    let commits = if include_commit_history {
        String::from_utf8(git_output(
            repo_path,
            &["log", "--format=%h %s", &commit_range],
            MAX_GIT_METADATA_OUTPUT_BYTES,
        )?)
        .map_err(|_| AiError::new("gitFailed"))?
    } else {
        "Not included.\n".to_string()
    };
    let branch = git_output(
        repo_path,
        &["symbolic-ref", "--short", "-q", "HEAD"],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )
    .ok()
    .and_then(|value| String::from_utf8(value).ok())
    .map(|value| value.trim().to_string())
    .filter(|value| !value.is_empty())
    .unwrap_or_else(|| "detached HEAD".to_string());
    let path_list = paths
        .iter()
        .map(|(status, path)| format!("{status}\t{path}"))
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        "Branch: {branch}\nBase reference: {base_reference}\nChanged files:\n{path_list}\n\nCommits:\n{}\nChanges:\n{diff}",
        commits.trim()
    );
    let head = String::from_utf8(git_output(
        repo_path,
        &["rev-parse", "--verify", "HEAD"],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )?)
    .map_err(|_| AiError::new("gitFailed"))?;
    Ok(WritingContext {
        files: paths.into_iter().map(|(_, path)| path).collect(),
        snapshot: md5::compute(format!("{}\0{base_commit}\0{content}", head.trim())),
        content,
    })
}

fn truncate_text(text: &str, maximum_bytes: usize) -> String {
    if text.len() <= maximum_bytes {
        return text.to_string();
    }
    const SUFFIX: &str = "\n[truncated]";
    let mut end = maximum_bytes.saturating_sub(SUFFIX.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{SUFFIX}", &text[..end])
}

fn split_text(text: &str, maximum_bytes: usize) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut remaining = text;
    while !remaining.is_empty() {
        let mut end = remaining.len().min(maximum_bytes);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        if end < remaining.len() {
            if let Some(line_end) = remaining[..end].rfind('\n') {
                end = line_end + 1;
            }
        }
        chunks.push(remaining[..end].to_string());
        remaining = &remaining[end..];
    }
    chunks
}

fn commit_request_context_bytes(configuration: &EffectiveAiConfiguration) -> usize {
    configuration.commit_context_limit_kib as usize * 1024
}

fn commit_summary_diff_bytes(configuration: &EffectiveAiConfiguration) -> usize {
    commit_request_context_bytes(configuration) * 5 / 8
}

fn commit_summary_max_tokens(configuration: &EffectiveAiConfiguration) -> u32 {
    configuration
        .commit_message_max_tokens
        .min(COMMIT_SUMMARY_MAX_TOKENS)
}

fn render_summary_context(context: &CommitContext, summaries: &[String]) -> String {
    let subject_limit = if context.subject_limit == 0 {
        "Disabled".to_string()
    } else {
        context.subject_limit.to_string()
    };
    format!(
        "Branch: {}\nWorkflow: {}\nSubject limit: {subject_limit}\nExisting Git-provided or user message:\n{}\n\nStaged files:\n{}\n\nRecent commit messages for style:\n{}\n\nStaged change summaries:\n{}\n\n{}",
        context.branch,
        context.workflow.label(),
        if context.existing_message.is_empty() {
            "None."
        } else {
            &context.existing_message
        },
        truncate_text(&context.path_list, COMMIT_PATH_LIST_MAX_BYTES),
        truncate_text(&context.recent_messages, COMMIT_STYLE_EXAMPLES_MAX_BYTES),
        summaries.join("\n\n"),
        final_commit_instruction(context.subject_limit)
    )
}

fn combined_usage(left: AiUsage, right: AiUsage) -> AiUsage {
    fn add(left: Option<u64>, right: Option<u64>) -> Option<u64> {
        match (left, right) {
            (None, None) => None,
            (left, right) => Some(
                left.unwrap_or_default()
                    .saturating_add(right.unwrap_or_default()),
            ),
        }
    }

    AiUsage {
        input_tokens: add(left.input_tokens, right.input_tokens),
        output_tokens: add(left.output_tokens, right.output_tokens),
        reasoning_tokens: add(left.reasoning_tokens, right.reasoning_tokens),
        cached_tokens: add(left.cached_tokens, right.cached_tokens),
        cost: match (left.cost, right.cost) {
            (None, None) => None,
            (left, right) => Some(left.unwrap_or_default() + right.unwrap_or_default()),
        },
        byok: left.byok.or(right.byok),
    }
}

async fn run_commit_provider(
    runtime: &crate::ai::AiRuntime,
    configuration: &mut EffectiveAiConfiguration,
    budget: &mut RequestBudget,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u32,
) -> Result<ProviderResult, AiError> {
    validate_context_size(
        system_prompt.len().saturating_add(user_prompt.len()),
        configuration.commit_context_limit_kib,
    )?;
    budget.charge(system_prompt, user_prompt)?;
    let (result, capability) = run_provider(
        runtime,
        configuration,
        api_key,
        system_prompt,
        user_prompt,
        max_tokens,
        AiTask::CommitMessage,
    )
    .await?;
    if capability == AiEffortCapability::Unsupported {
        configuration.effort_capability = capability;
    }
    Ok(result)
}

async fn summarise_commit_diff(
    runtime: &crate::ai::AiRuntime,
    configuration: &mut EffectiveAiConfiguration,
    budget: &mut RequestBudget,
    api_key: &str,
    diff: &str,
) -> Result<(Vec<String>, AiUsage), AiError> {
    let chunks = split_text(diff, commit_summary_diff_bytes(configuration));
    let chunk_count = chunks.len();
    let mut summaries = Vec::with_capacity(chunk_count);
    let mut usage = AiUsage::default();
    for (index, chunk) in chunks.into_iter().enumerate() {
        let prompt = format!(
            "Diff chunk {} of {chunk_count}:\n{chunk}\n\nSummarise this chunk now.",
            index + 1
        );
        validate_context_size(prompt.len(), configuration.commit_context_limit_kib)?;
        let max_tokens = commit_summary_max_tokens(configuration);
        let result = run_commit_provider(
            runtime,
            configuration,
            budget,
            api_key,
            COMMIT_SUMMARY_PROMPT,
            &prompt,
            max_tokens,
        )
        .await?;
        if result.output_truncated {
            return Err(AiError::new("outputTruncated"));
        }
        let summary = result.text.trim();
        if summary.is_empty() {
            return Err(AiError::new("invalidResponse"));
        }
        summaries.push(truncate_text(summary, COMMIT_SUMMARY_MAX_BYTES));
        usage = combined_usage(usage, result.usage);
    }
    Ok((summaries, usage))
}

async fn reduce_commit_summaries(
    runtime: &crate::ai::AiRuntime,
    configuration: &mut EffectiveAiConfiguration,
    budget: &mut RequestBudget,
    api_key: &str,
    summaries: Vec<String>,
) -> Result<(Vec<String>, AiUsage), AiError> {
    let joined = summaries.join("\n\n");
    let chunks = split_text(&joined, commit_summary_diff_bytes(configuration));
    if chunks.len() >= summaries.len() {
        return Err(AiError::new("contextTooLarge"));
    }
    let chunk_count = chunks.len();
    let mut reduced = Vec::with_capacity(chunk_count);
    let mut usage = AiUsage::default();
    for (index, chunk) in chunks.into_iter().enumerate() {
        let prompt = format!(
            "Summary group {} of {chunk_count}:\n{chunk}\n\nConsolidate this group now.",
            index + 1
        );
        let max_tokens = commit_summary_max_tokens(configuration);
        let result = run_commit_provider(
            runtime,
            configuration,
            budget,
            api_key,
            COMMIT_SUMMARY_REDUCTION_PROMPT,
            &prompt,
            max_tokens,
        )
        .await?;
        if result.output_truncated {
            return Err(AiError::new("outputTruncated"));
        }
        let summary = result.text.trim();
        if summary.is_empty() {
            return Err(AiError::new("invalidResponse"));
        }
        reduced.push(truncate_text(summary, COMMIT_SUMMARY_MAX_BYTES));
        usage = combined_usage(usage, result.usage);
    }
    Ok((reduced, usage))
}

fn validate_commit_message(message: String, subject_limit: u32) -> Result<String, AiError> {
    let message = message.trim().to_string();
    let subject = message.lines().next().unwrap_or_default();
    if message.is_empty()
        || message.len() > 4096
        || message.contains("```")
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
        || (subject_limit > 0 && subject.chars().count() > subject_limit as usize)
        || subject.trim().is_empty()
    {
        return Err(AiError::new("invalidResponse"));
    }
    Ok(message)
}

async fn generate_commit_message_from_context(
    runtime: &crate::ai::AiRuntime,
    mut configuration: EffectiveAiConfiguration,
    api_key: &str,
    context: CommitContext,
    system_prompt: &str,
    budget: &mut RequestBudget,
) -> Result<AiCommitMessageResult, AiError> {
    let full_context = render_commit_context(&context);
    let request_context_bytes = commit_request_context_bytes(&configuration);
    let available_user_context_bytes = request_context_bytes.saturating_sub(system_prompt.len());
    if available_user_context_bytes == 0 {
        return Err(AiError::context_too_large(
            system_prompt.len(),
            configuration.commit_context_limit_kib,
        ));
    }
    let mut usage = AiUsage::default();
    let user_prompt = if full_context.len() <= available_user_context_bytes {
        full_context
    } else {
        let (mut summaries, summary_usage) =
            summarise_commit_diff(runtime, &mut configuration, budget, api_key, &context.diff)
                .await?;
        usage = combined_usage(usage, summary_usage);
        let mut summary_context = render_summary_context(&context, &summaries);
        while summary_context.len() > available_user_context_bytes {
            let (reduced, reduction_usage) =
                reduce_commit_summaries(runtime, &mut configuration, budget, api_key, summaries)
                    .await?;
            summaries = reduced;
            usage = combined_usage(usage, reduction_usage);
            summary_context = render_summary_context(&context, &summaries);
        }
        summary_context
    };
    let max_tokens = configuration.commit_message_max_tokens;
    let result = run_commit_provider(
        runtime,
        &mut configuration,
        budget,
        api_key,
        system_prompt,
        &user_prompt,
        max_tokens,
    )
    .await?;
    if result.output_truncated {
        return Err(AiError::new("outputTruncated"));
    }
    usage = combined_usage(usage, result.usage);
    Ok(AiCommitMessageResult {
        message: validate_commit_message(result.text, context.subject_limit)?,
        usage,
        request_id: result.request_id,
        generation_id: result.generation_id,
        routed_provider: result.routed_provider,
        routed_model: result.routed_model,
    })
}

#[tauri::command]
pub async fn generate_ai_commit_message(
    repo_path: String,
    subject_limit: u32,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiCommitMessageResult, AiError> {
    let result = generate_ai_commit_messages(
        GenerateAiCommitMessagesRequest {
            repo_path,
            subject_limit,
            operation_id: format!("commit-{}", operation_nonce()),
            candidate_count: 1,
            mode: AiCommitMessageMode::RepositoryStyle,
            commit_type: String::new(),
            scope: String::new(),
            language: String::new(),
            issue_key: String::new(),
            additional_instruction: String::new(),
            workflow: AiCommitWorkflow::Normal,
            existing_message: String::new(),
        },
        state,
        app,
    )
    .await?;
    result
        .candidates
        .into_iter()
        .next()
        .ok_or_else(|| AiError::new("invalidResponse"))
}

fn validate_commit_control(value: &str, maximum_length: usize) -> Result<(), AiError> {
    if value.len() > maximum_length
        || value
            .chars()
            .any(|character| character.is_control() && character != '\t')
    {
        return Err(AiError::new("invalidCommitControl"));
    }
    Ok(())
}

fn commit_system_prompt(
    configuration: &EffectiveAiConfiguration,
    request: &GenerateAiCommitMessagesRequest,
) -> Result<String, AiError> {
    validate_commit_control(&request.commit_type, 32)?;
    validate_commit_control(&request.scope, 64)?;
    validate_commit_control(&request.language, 64)?;
    validate_commit_control(&request.issue_key, 64)?;
    validate_commit_control(&request.additional_instruction, 1000)?;
    validate_commit_control(&request.existing_message, 4096)?;
    let mut prompt = configuration.commit_message_prompt.clone();
    if request.subject_limit > 0 {
        prompt.push_str(&format!(
            "\n\nThe commit subject must not exceed {} characters.",
            request.subject_limit
        ));
    }
    match request.mode {
        AiCommitMessageMode::RepositoryStyle => {
            prompt
                .push_str("\nFollow the supplied repository commit style where it is consistent.");
        }
        AiCommitMessageMode::ConventionalCommits => {
            prompt.push_str("\nUse Conventional Commits format for the subject.");
        }
        AiCommitMessageMode::FreeForm => {}
    }
    if !request.commit_type.trim().is_empty() {
        prompt.push_str(&format!(
            "\nUse commit type: {}.",
            request.commit_type.trim()
        ));
    }
    if !request.scope.trim().is_empty() {
        prompt.push_str(&format!("\nUse commit scope: {}.", request.scope.trim()));
    }
    if !request.language.trim().is_empty() {
        prompt.push_str(&format!("\nWrite in {}.", request.language.trim()));
    }
    if !request.issue_key.trim().is_empty() {
        prompt.push_str(&format!(
            "\nInclude issue key: {}.",
            request.issue_key.trim()
        ));
    }
    if !request.additional_instruction.trim().is_empty() {
        prompt.push_str(&format!(
            "\nAdditional user instruction: {}",
            request.additional_instruction.trim()
        ));
    }
    if request.workflow != AiCommitWorkflow::Normal {
        prompt.push_str(&format!(
            "\nThis is a {}. Treat the supplied existing message as context, but return a complete replacement candidate.",
            request.workflow.label()
        ));
    }
    Ok(prompt)
}

async fn generate_ai_commit_messages_inner(
    request: GenerateAiCommitMessagesRequest,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<AiCommitCandidatesResult, AiError> {
    if !(1..=3).contains(&request.candidate_count) {
        return Err(AiError::new("invalidCandidateCount"));
    }
    emit_ai_progress(
        app,
        &request.operation_id,
        "commitMessage",
        "collectingContext",
    );
    let (mut configuration, api_key) = configured_settings(state, true).await?;
    apply_repository_prompts(
        state,
        &request.repo_path,
        &mut configuration,
        AiTask::CommitMessage,
    )
    .await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    require_consent(state, &configuration)?;
    let (include_commit_history, exclusions) =
        repository_context_options(state, &request.repo_path, &configuration);
    let context_repo_path = request.repo_path.clone();
    let subject_limit = request.subject_limit;
    let workflow = request.workflow;
    let existing_message = request.existing_message.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        build_commit_context(
            &context_repo_path,
            subject_limit,
            include_commit_history,
            &exclusions,
            workflow,
            &existing_message,
        )
    })
    .await
    .map_err(|_| AiError::new("gitFailed"))??;
    let expected_snapshot = context.staged_snapshot;
    let system_prompt = commit_system_prompt(&configuration, &request)?;
    emit_ai_progress(
        app,
        &request.operation_id,
        "commitMessage",
        "contactingProvider",
    );
    let mut budget = RequestBudget::new();
    let mut candidates = Vec::with_capacity(request.candidate_count as usize);
    for _ in 0..request.candidate_count {
        candidates.push(
            generate_commit_message_from_context(
                runtime,
                configuration.clone(),
                &api_key,
                context.clone(),
                &system_prompt,
                &mut budget,
            )
            .await?,
        );
    }
    let current_snapshot =
        tauri::async_runtime::spawn_blocking(move || staged_snapshot(&request.repo_path))
            .await
            .map_err(|_| AiError::new("gitFailed"))??;
    if current_snapshot != expected_snapshot {
        return Err(AiError::new("stagedChangesChanged"));
    }
    emit_ai_progress(app, &request.operation_id, "commitMessage", "complete");
    Ok(AiCommitCandidatesResult { candidates })
}

#[tauri::command]
pub async fn generate_ai_commit_messages(
    mut request: GenerateAiCommitMessagesRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiCommitCandidatesResult, AiError> {
    let started_at = Instant::now();
    if request.operation_id.is_empty() {
        request.operation_id = format!("commit-{}", operation_nonce());
    }
    let operation_id = request.operation_id.clone();
    let cancellation = state.ai_extension.operations.begin(&operation_id)?;
    let result = tokio::select! {
        _ = cancellation.cancelled() => Err(AiError::new("operationCancelled")),
        result = tokio::time::timeout(AI_OPERATION_TIMEOUT, generate_ai_commit_messages_inner(request, &state, &app)) => {
            result.map_err(|_| AiError::new("timeout")).and_then(|result| result)
        },
    };
    state.ai_extension.operations.finish(&operation_id);
    match &result {
        Ok(result) => {
            let usage = result
                .candidates
                .iter()
                .fold(AiUsage::default(), |total, candidate| {
                    combined_usage(total, candidate.usage.clone())
                });
            record_ai_usage(
                &state,
                "commitMessage",
                started_at,
                Some(&usage),
                result
                    .candidates
                    .first()
                    .and_then(|candidate| candidate.request_id.as_deref()),
                result
                    .candidates
                    .first()
                    .and_then(|candidate| candidate.generation_id.as_deref()),
                result
                    .candidates
                    .first()
                    .and_then(|candidate| candidate.routed_provider.as_deref()),
                result
                    .candidates
                    .first()
                    .and_then(|candidate| candidate.routed_model.as_deref()),
                None,
                "completed",
            );
        }
        Err(error) => record_ai_usage(
            &state,
            "commitMessage",
            started_at,
            None,
            None,
            None,
            None,
            None,
            error.detail.as_deref(),
            error.code,
        ),
    }
    result
}

fn operation_nonce() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[tauri::command]
pub fn cancel_ai_operation(
    operation_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), AiError> {
    state.ai_extension.operations.cancel(&operation_id)
}

#[tauri::command]
pub async fn get_ai_commit_context_preview(
    repo_path: String,
    subject_limit: u32,
    workflow: Option<AiCommitWorkflow>,
    existing_message: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<AiContextPreview, AiError> {
    let settings = state.git_service.get_settings();
    let mut configuration = state.ai_extension.environment.resolve(&settings)?;
    apply_repository_prompts(
        &state,
        &repo_path,
        &mut configuration,
        AiTask::CommitMessage,
    )
    .await?;
    validate_effective_configuration(&configuration, true)?;
    let (include_commit_history, exclusions) =
        repository_context_options(&state, &repo_path, &configuration);
    let workflow = workflow.unwrap_or_default();
    let existing_message = existing_message.unwrap_or_default();
    let context = tauri::async_runtime::spawn_blocking(move || {
        build_commit_context(
            &repo_path,
            subject_limit,
            include_commit_history,
            &exclusions,
            workflow,
            &existing_message,
        )
    })
    .await
    .map_err(|_| AiError::new("gitFailed"))??;
    let files = context
        .path_list
        .lines()
        .filter_map(|line| line.split_once('\t').map(|(_, path)| path.to_string()))
        .collect();
    let context_bytes = render_commit_context(&context)
        .len()
        .saturating_add(configuration.commit_message_prompt.len());
    Ok(AiContextPreview {
        provider: configuration.provider,
        destination_authority: configuration.destination_authority()?,
        task: "commitMessage",
        files,
        context_size_kib: context_bytes.div_ceil(1024),
        context_limit_kib: configuration.commit_context_limit_kib,
        includes_commit_history: include_commit_history,
    })
}

async fn prepare_writing_context(
    state: &AppState,
    configuration: &EffectiveAiConfiguration,
    repo_path: String,
    task: AiWritingTask,
    base_reference: String,
) -> Result<(WritingContext, bool), AiError> {
    let (include_commit_history, exclusions) =
        repository_context_options(state, &repo_path, configuration);
    let context_exclusions = exclusions.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        writing_context(
            &repo_path,
            task,
            &base_reference,
            include_commit_history,
            &context_exclusions,
        )
    })
    .await
    .map_err(|_| AiError::new("gitFailed"))??;
    Ok((context, include_commit_history))
}

#[tauri::command]
pub async fn get_ai_writing_context_preview(
    request: AiWritingContextPreviewRequest,
    state: tauri::State<'_, AppState>,
) -> Result<AiContextPreview, AiError> {
    let settings = state.git_service.get_settings();
    let configuration = state.ai_extension.environment.resolve(&settings)?;
    validate_effective_configuration(&configuration, true)?;
    let (context, include_commit_history) = prepare_writing_context(
        &state,
        &configuration,
        request.repo_path,
        request.task,
        request.base_reference,
    )
    .await?;
    let context_bytes = context
        .content
        .len()
        .saturating_add(request.task.system_prompt().len());
    validate_context_size(context_bytes, configuration.commit_context_limit_kib)?;
    Ok(AiContextPreview {
        provider: configuration.provider,
        destination_authority: configuration.destination_authority()?,
        task: request.task.identifier(),
        files: context.files,
        context_size_kib: context_bytes.div_ceil(1024),
        context_limit_kib: configuration.commit_context_limit_kib,
        includes_commit_history: include_commit_history,
    })
}

async fn generate_ai_writing_inner(
    request: &GenerateAiWritingRequest,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<AiWritingResult, AiError> {
    validate_commit_control(&request.additional_instruction, 1000)?;
    emit_ai_progress(
        app,
        &request.operation_id,
        request.task.identifier(),
        "collectingContext",
    );
    let (configuration, api_key) = configured_settings(state, true).await?;
    require_consent(state, &configuration)?;
    let (context, _) = prepare_writing_context(
        state,
        &configuration,
        request.repo_path.clone(),
        request.task,
        request.base_reference.clone(),
    )
    .await?;
    let mut system_prompt = request.task.system_prompt().to_string();
    if !request.additional_instruction.trim().is_empty() {
        system_prompt.push_str(&format!(
            "\n\nAdditional user instruction: {}",
            request.additional_instruction.trim()
        ));
    }
    validate_context_size(
        system_prompt.len().saturating_add(context.content.len()),
        configuration.commit_context_limit_kib,
    )?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    let mut budget = RequestBudget::new();
    budget.charge(&system_prompt, &context.content)?;
    emit_ai_progress(
        app,
        &request.operation_id,
        request.task.identifier(),
        "contactingProvider",
    );
    let (result, _) = run_provider(
        runtime,
        &configuration,
        &api_key,
        &system_prompt,
        &context.content,
        configuration.commit_message_max_tokens,
        AiTask::CommitMessage,
    )
    .await?;
    if result.output_truncated {
        return Err(AiError::new("outputTruncated"));
    }
    let content = result.text.trim().to_string();
    if content.is_empty()
        || content.len() > 64 * 1024
        || content
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AiError::new("invalidResponse"));
    }
    let current = prepare_writing_context(
        state,
        &configuration,
        request.repo_path.clone(),
        request.task,
        request.base_reference.clone(),
    )
    .await?
    .0;
    if current.snapshot != context.snapshot {
        return Err(AiError::new("repositoryChanged"));
    }
    emit_ai_progress(
        app,
        &request.operation_id,
        request.task.identifier(),
        "complete",
    );
    Ok(AiWritingResult {
        content,
        usage: result.usage,
        request_id: result.request_id,
        generation_id: result.generation_id,
        routed_provider: result.routed_provider,
        routed_model: result.routed_model,
    })
}

#[tauri::command]
pub async fn generate_ai_writing(
    mut request: GenerateAiWritingRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiWritingResult, AiError> {
    let started_at = Instant::now();
    if request.operation_id.is_empty() {
        request.operation_id = format!("writing-{}", operation_nonce());
    }
    let operation_id = request.operation_id.clone();
    let task = request.task.identifier();
    let cancellation = state.ai_extension.operations.begin(&operation_id)?;
    let result = tokio::select! {
        _ = cancellation.cancelled() => Err(AiError::new("operationCancelled")),
        result = tokio::time::timeout(AI_OPERATION_TIMEOUT, generate_ai_writing_inner(&request, &state, &app)) => {
            result.map_err(|_| AiError::new("timeout")).and_then(|result| result)
        },
    };
    state.ai_extension.operations.finish(&operation_id);
    match &result {
        Ok(result) => record_ai_usage(
            &state,
            task,
            started_at,
            Some(&result.usage),
            result.request_id.as_deref(),
            result.generation_id.as_deref(),
            result.routed_provider.as_deref(),
            result.routed_model.as_deref(),
            None,
            "completed",
        ),
        Err(error) => record_ai_usage(
            &state,
            task,
            started_at,
            None,
            None,
            None,
            None,
            None,
            error.detail.as_deref(),
            error.code,
        ),
    }
    result
}

fn safe_repository_file(repo_path: &str, file_path: &str) -> Result<PathBuf, AiError> {
    if file_path.is_empty() || is_sensitive_path(file_path) {
        return Err(AiError::new(if file_path.is_empty() {
            "invalidPath"
        } else {
            "sensitivePath"
        }));
    }
    let relative = Path::new(file_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(AiError::new("invalidPath"));
    }
    let repository = Path::new(repo_path)
        .canonicalize()
        .map_err(|_| AiError::new("invalidRepository"))?;
    let candidate = repository.join(relative);
    let metadata = candidate
        .symlink_metadata()
        .map_err(|_| AiError::new("fileUnavailable"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(AiError::new("unsupportedFile"));
    }
    let canonical = candidate
        .canonicalize()
        .map_err(|_| AiError::new("fileUnavailable"))?;
    if !canonical.starts_with(&repository) {
        return Err(AiError::new("invalidPath"));
    }
    Ok(canonical)
}

fn line_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    for (index, byte) in text.bytes().enumerate() {
        if byte == b'\n' {
            ranges.push((start, index + 1));
            start = index + 1;
        }
    }
    if start < text.len() {
        ranges.push((start, text.len()));
    }
    ranges
}

fn trimmed_line<'a>(text: &'a str, range: (usize, usize)) -> &'a str {
    text[range.0..range.1].trim_end_matches(['\r', '\n'])
}

fn marker_size(line: &str, marker: char) -> Option<usize> {
    let count = line
        .chars()
        .take_while(|character| *character == marker)
        .count();
    (count >= 7).then_some(count)
}

fn marker_line(line: &str, marker: char, size: usize, allows_label: bool) -> bool {
    let marker_text = marker.to_string().repeat(size);
    let Some(remainder) = line.strip_prefix(&marker_text) else {
        return false;
    };
    if allows_label {
        remainder.is_empty() || remainder.starts_with(char::is_whitespace)
    } else {
        remainder.is_empty()
    }
}

fn parse_conflict_regions(text: &str) -> Result<Vec<ConflictRegion>, AiError> {
    let lines = line_ranges(text);
    let mut regions = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let outside_line = trimmed_line(text, lines[index]);
        let Some(size) = marker_size(outside_line, '<') else {
            if marker_size(outside_line, '=').is_some()
                || marker_size(outside_line, '>').is_some()
                || marker_size(outside_line, '|').is_some()
            {
                return Err(AiError::new("malformedConflict"));
            }
            index += 1;
            continue;
        };
        if !marker_line(outside_line, '<', size, true) {
            index += 1;
            continue;
        }
        let start_line = index;
        let mut base_line = None;
        let mut separator = None;
        let mut end_line = None;
        index += 1;
        while index < lines.len() {
            let line = trimmed_line(text, lines[index]);
            if marker_size(line, '<').is_some() {
                return Err(AiError::new("malformedConflict"));
            }
            if marker_line(line, '|', size, true) {
                if separator.is_some() || base_line.replace(index).is_some() {
                    return Err(AiError::new("malformedConflict"));
                }
            } else if marker_line(line, '=', size, false) {
                if separator.replace(index).is_some() {
                    return Err(AiError::new("malformedConflict"));
                }
            } else if marker_line(line, '>', size, true) {
                end_line = Some(index);
                break;
            }
            index += 1;
        }
        if separator.is_none() || end_line.is_none() {
            return Err(AiError::new("malformedConflict"));
        }
        let separator = separator.unwrap();
        let end_line = end_line.unwrap();
        if base_line.is_some_and(|base| base >= separator) {
            return Err(AiError::new("malformedConflict"));
        }
        let context_start = start_line.saturating_sub(12);
        let context_end = (end_line + 13).min(lines.len());
        let start = lines[start_line].0;
        let end = lines[end_line].1;
        let ours_end = base_line.unwrap_or(separator);
        let ours = text[lines[start_line].1..lines[ours_end].0].to_string();
        let ancestor = base_line.map(|base| text[lines[base].1..lines[separator].0].to_string());
        let theirs = text[lines[separator].1..lines[end_line].0].to_string();
        let original = text[start..end].to_string();
        let id = format!("{:x}", md5::compute(format!("{start}:{end}:{original}")));
        regions.push(ConflictRegion {
            id,
            start,
            end,
            prompt: text[lines[context_start].0..lines[context_end - 1].1].to_string(),
            original,
            ours,
            theirs,
            ancestor,
        });
        index = end_line + 1;
    }
    if regions.is_empty() {
        return Err(AiError::new("noConflictMarkers"));
    }
    Ok(regions)
}

fn build_conflict_prompt(file_path: &str, operation: &str, regions: &[ConflictRegion]) -> String {
    let mut prompt = format!("Path: {file_path}\nGit operation: {operation}\n\n");
    for region in regions {
        prompt.push_str(&format!(
            "Region ID: {}\nOriginal with context:\n{}\n\nOurs:\n{}\n\nAncestor:\n{}\n\nTheirs:\n{}\n\n",
            region.id,
            region.prompt,
            region.ours,
            region.ancestor.as_deref().unwrap_or("Not available."),
            region.theirs,
        ));
    }
    prompt.push_str(
        "Return only JSON matching this shape: {\"regions\":[{\"id\":\"the exact region ID\",\"replacement\":\"resolved text\",\"explanation\":\"brief rationale\"}]}. Include every region exactly once.",
    );
    prompt
}

fn parse_conflict_replacements(
    response: &str,
    regions: &[ConflictRegion],
) -> Result<Vec<ModelConflictReplacement>, AiError> {
    let parsed: ModelConflictResponse =
        serde_json::from_str(response.trim()).map_err(|_| AiError::new("invalidResponse"))?;
    if parsed.regions.len() != regions.len() {
        return Err(AiError::new("invalidResponse"));
    }
    let mut replacements = Vec::with_capacity(regions.len());
    for region in regions {
        let matching = parsed
            .regions
            .iter()
            .filter(|replacement| replacement.id == region.id)
            .collect::<Vec<_>>();
        if matching.len() != 1 {
            return Err(AiError::new("invalidResponse"));
        }
        let replacement = matching[0];
        if replacement.replacement.contains("<<<<<<<")
            || replacement.replacement.contains("=======")
            || replacement.replacement.contains(">>>>>>>")
        {
            return Err(AiError::new("invalidResponse"));
        }
        replacements.push(ModelConflictReplacement {
            id: replacement.id.clone(),
            replacement: replacement.replacement.clone(),
            explanation: replacement.explanation.clone(),
        });
    }
    Ok(replacements)
}

fn normalise_replacement_line_endings(replacement: &str, original: &str) -> String {
    if original.contains("\r\n") {
        replacement.replace("\r\n", "\n").replace('\n', "\r\n")
    } else {
        replacement.replace("\r\n", "\n")
    }
}

fn write_atomically(path: &Path, contents: &[u8]) -> Result<(), AiError> {
    let parent = path
        .parent()
        .ok_or_else(|| AiError::new("fileWriteFailed"))?;
    let permissions = path
        .metadata()
        .map_err(|_| AiError::new("fileWriteFailed"))?
        .permissions();
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|_| AiError::new("fileWriteFailed"))?;
    temporary
        .write_all(contents)
        .map_err(|_| AiError::new("fileWriteFailed"))?;
    temporary
        .flush()
        .map_err(|_| AiError::new("fileWriteFailed"))?;
    temporary
        .as_file()
        .set_permissions(permissions)
        .map_err(|_| AiError::new("fileWriteFailed"))?;
    temporary
        .persist(path)
        .map_err(|_| AiError::new("fileWriteFailed"))?;
    Ok(())
}

fn read_bounded_file(path: &Path, maximum_bytes: usize) -> Result<Vec<u8>, AiError> {
    let file = std::fs::File::open(path).map_err(|_| AiError::new("fileUnavailable"))?;
    let mut bytes = Vec::new();
    file.take(maximum_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| AiError::new("fileUnavailable"))?;
    if bytes.len() > maximum_bytes {
        return Err(AiError::new("contextTooLarge"));
    }
    Ok(bytes)
}

fn unmerged_index_hash(repo_path: &str, file_path: &str) -> Result<md5::Digest, AiError> {
    let output = git_output(
        repo_path,
        &["ls-files", "-u", "-z", "--", file_path],
        MAX_GIT_METADATA_OUTPUT_BYTES,
    )?;
    if output.is_empty() {
        return Err(AiError::new("noUnmergedIndex"));
    }
    Ok(md5::compute(output))
}

fn prepare_conflict(
    repo_path: &str,
    file_path: &str,
    maximum_bytes: usize,
) -> Result<PreparedConflict, AiError> {
    let repository = Path::new(repo_path)
        .canonicalize()
        .map_err(|_| AiError::new("invalidRepository"))?;
    let index_hash = unmerged_index_hash(repo_path, file_path)?;
    let operation = repository_operation(repo_path)?.unwrap_or("unmerged index");
    let path = safe_repository_file(repo_path, file_path)?;
    let original_bytes = read_bounded_file(&path, maximum_bytes)?;
    if original_bytes.contains(&0) {
        return Err(AiError::new("unsupportedFile"));
    }
    let original =
        String::from_utf8(original_bytes.clone()).map_err(|_| AiError::new("unsupportedFile"))?;
    let regions = parse_conflict_regions(&original)?;
    Ok(PreparedConflict {
        repository,
        original_bytes,
        operation,
        index_hash,
        regions,
    })
}

fn proposal_id(original: &[u8]) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!(
        "{:x}",
        md5::compute(format!(
            "{}:{timestamp}:{:x}",
            std::process::id(),
            md5::compute(original)
        ))
    )
}

#[tauri::command]
pub async fn get_ai_conflict_eligibility(
    request: ResolveConflictWithAiRequest,
) -> AiConflictEligibility {
    let result = tauri::async_runtime::spawn_blocking(move || {
        prepare_conflict(
            &request.repo_path,
            &request.file_path,
            MAX_COMMIT_TOTAL_CONTEXT_BYTES,
        )
        .map(|_| ())
    })
    .await
    .map_err(|_| AiError::new("fileUnavailable"))
    .and_then(|result| result);
    match result {
        Ok(()) => AiConflictEligibility {
            eligible: true,
            reason: None,
        },
        Err(error) => AiConflictEligibility {
            eligible: false,
            reason: Some(error.code),
        },
    }
}

async fn resolve_conflict_with_ai_inner(
    request: ResolveConflictWithAiRequest,
    state: &AppState,
    app: &tauri::AppHandle,
) -> Result<AiConflictProposalResult, AiError> {
    emit_ai_progress(
        app,
        &request.operation_id,
        "conflictResolution",
        "collectingContext",
    );
    let (mut configuration, api_key) = configured_settings(state, true).await?;
    apply_repository_prompts(
        state,
        &request.repo_path,
        &mut configuration,
        AiTask::ConflictResolution,
    )
    .await?;
    let runtime = state
        .ai_extension
        .runtime
        .as_ref()
        .ok_or_else(|| AiError::new("network"))?;
    require_consent(state, &configuration)?;
    let maximum_bytes = configuration.conflict_context_limit_kib as usize * 1024;
    let repo_path = request.repo_path.clone();
    let file_path = request.file_path.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_conflict(&repo_path, &file_path, maximum_bytes)
    })
    .await
    .map_err(|_| AiError::new("fileUnavailable"))??;
    let prompt = build_conflict_prompt(&request.file_path, prepared.operation, &prepared.regions);
    validate_context_size(
        prompt
            .len()
            .saturating_add(configuration.conflict_resolution_prompt.len()),
        configuration.conflict_context_limit_kib,
    )?;
    emit_ai_progress(
        app,
        &request.operation_id,
        "conflictResolution",
        "contactingProvider",
    );
    let (result, _) = run_provider(
        runtime,
        &configuration,
        &api_key,
        &configuration.conflict_resolution_prompt,
        &prompt,
        configuration.conflict_resolution_max_tokens,
        AiTask::ConflictResolution,
    )
    .await?;
    if result.output_truncated {
        return Err(AiError::new("outputTruncated"));
    }
    let replacements = parse_conflict_replacements(&result.text, &prepared.regions)?;
    let proposal_id = proposal_id(&prepared.original_bytes);
    let proposals = prepared
        .regions
        .iter()
        .zip(&replacements)
        .map(|(region, replacement)| AiConflictRegionProposal {
            id: region.id.clone(),
            original: region.original.clone(),
            ours: region.ours.clone(),
            theirs: region.theirs.clone(),
            ancestor: region.ancestor.clone(),
            proposed: replacement.replacement.clone(),
            explanation: replacement.explanation.clone(),
        })
        .collect::<Vec<_>>();
    let session_replacements = prepared
        .regions
        .iter()
        .zip(replacements)
        .map(|(region, replacement)| crate::ai::ConflictReplacement {
            id: region.id.clone(),
            start: region.start,
            end: region.end,
            replacement: replacement.replacement,
        })
        .collect();
    state.ai_extension.conflict_sessions.insert(
        proposal_id.clone(),
        crate::ai::ConflictSession::new(
            prepared.repository,
            request.file_path.clone(),
            prepared.original_bytes,
            prepared.index_hash,
            session_replacements,
        ),
    )?;
    emit_ai_progress(app, &request.operation_id, "conflictResolution", "complete");
    Ok(AiConflictProposalResult {
        proposal_id,
        file_path: request.file_path,
        regions: proposals,
        usage: result.usage,
        request_id: result.request_id,
        generation_id: result.generation_id,
        routed_provider: result.routed_provider,
        routed_model: result.routed_model,
    })
}

#[tauri::command]
pub async fn resolve_conflict_with_ai(
    mut request: ResolveConflictWithAiRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConflictProposalResult, AiError> {
    let started_at = Instant::now();
    if request.operation_id.is_empty() {
        request.operation_id = format!("conflict-{}", operation_nonce());
    }
    let operation_id = request.operation_id.clone();
    let cancellation = state.ai_extension.operations.begin(&operation_id)?;
    let result = tokio::select! {
        _ = cancellation.cancelled() => Err(AiError::new("operationCancelled")),
        result = tokio::time::timeout(AI_OPERATION_TIMEOUT, resolve_conflict_with_ai_inner(request, &state, &app)) => {
            result.map_err(|_| AiError::new("timeout")).and_then(|result| result)
        },
    };
    state.ai_extension.operations.finish(&operation_id);
    match &result {
        Ok(result) => record_ai_usage(
            &state,
            "conflictResolution",
            started_at,
            Some(&result.usage),
            result.request_id.as_deref(),
            result.generation_id.as_deref(),
            result.routed_provider.as_deref(),
            result.routed_model.as_deref(),
            None,
            "completed",
        ),
        Err(error) => record_ai_usage(
            &state,
            "conflictResolution",
            started_at,
            None,
            None,
            None,
            None,
            None,
            error.detail.as_deref(),
            error.code,
        ),
    }
    result
}

#[tauri::command]
pub async fn regenerate_ai_conflict_regions(
    mut request: RegenerateAiConflictRegionsRequest,
    state: tauri::State<'_, AppState>,
    app: tauri::AppHandle,
) -> Result<AiConflictProposalResult, AiError> {
    if request.region_ids.is_empty() {
        return Err(AiError::new("noConflictRegionsSelected"));
    }
    let mut session = state
        .ai_extension
        .conflict_sessions
        .get(&request.proposal_id)?;
    if !session.applied_ids.is_empty() {
        return Err(AiError::new("fileChanged"));
    }
    if request.region_ids.iter().any(|id| {
        !session
            .replacements
            .iter()
            .any(|replacement| &replacement.id == id)
    }) {
        return Err(AiError::new("conflictRegionUnknown"));
    }
    if request.operation_id.is_empty() {
        request.operation_id = format!("conflict-{}", operation_nonce());
    }
    let operation_id = request.operation_id.clone();
    let conflict_request = ResolveConflictWithAiRequest {
        repo_path: session.repository.to_string_lossy().to_string(),
        file_path: session.file_path.clone(),
        operation_id: operation_id.clone(),
    };
    let cancellation = state.ai_extension.operations.begin(&operation_id)?;
    let result = tokio::select! {
        _ = cancellation.cancelled() => Err(AiError::new("operationCancelled")),
        result = tokio::time::timeout(AI_OPERATION_TIMEOUT, resolve_conflict_with_ai_inner(conflict_request, &state, &app)) => {
            result.map_err(|_| AiError::new("timeout")).and_then(|result| result)
        },
    };
    state.ai_extension.operations.finish(&operation_id);
    let mut result = result?;
    let generated_session = state
        .ai_extension
        .conflict_sessions
        .get(&result.proposal_id)?;
    for replacement in &mut session.replacements {
        if request.region_ids.contains(&replacement.id) {
            let generated = generated_session
                .replacements
                .iter()
                .find(|generated| generated.id == replacement.id)
                .ok_or_else(|| AiError::new("conflictRegionUnknown"))?;
            replacement.replacement = generated.replacement.clone();
        }
    }
    state
        .ai_extension
        .conflict_sessions
        .update(&request.proposal_id, session)?;
    state
        .ai_extension
        .conflict_sessions
        .remove(&result.proposal_id)?;
    result.proposal_id = request.proposal_id;
    result
        .regions
        .retain(|region| request.region_ids.contains(&region.id));
    Ok(result)
}

#[tauri::command]
pub fn get_ai_usage_history(state: tauri::State<'_, AppState>) -> Vec<crate::ai::AiUsageRecord> {
    state.git_service.get_settings().extensions.ai.usage_history
}

#[tauri::command]
pub fn clear_ai_usage_history(state: tauri::State<'_, AppState>) -> Result<(), AiError> {
    state
        .git_service
        .clear_ai_usage_history()
        .map(|_| ())
        .map_err(|_| AiError::new("configurationWriteFailed"))
}

#[tauri::command]
pub async fn get_ai_conflict_context_preview(
    request: ResolveConflictWithAiRequest,
    state: tauri::State<'_, AppState>,
) -> Result<AiContextPreview, AiError> {
    let settings = state.git_service.get_settings();
    let mut configuration = state.ai_extension.environment.resolve(&settings)?;
    apply_repository_prompts(
        &state,
        &request.repo_path,
        &mut configuration,
        AiTask::ConflictResolution,
    )
    .await?;
    validate_effective_configuration(&configuration, true)?;
    let maximum_bytes = configuration.conflict_context_limit_kib as usize * 1024;
    let file_path = request.file_path.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        prepare_conflict(&request.repo_path, &request.file_path, maximum_bytes)
    })
    .await
    .map_err(|_| AiError::new("fileUnavailable"))??;
    let context_bytes = build_conflict_prompt(&file_path, prepared.operation, &prepared.regions)
        .len()
        .saturating_add(configuration.conflict_resolution_prompt.len());
    Ok(AiContextPreview {
        provider: configuration.provider,
        destination_authority: configuration.destination_authority()?,
        task: "conflictResolution",
        files: vec![file_path],
        context_size_kib: context_bytes.div_ceil(1024),
        context_limit_kib: configuration.conflict_context_limit_kib,
        includes_commit_history: false,
    })
}

#[tauri::command]
pub async fn apply_ai_conflict_proposal(
    request: ApplyAiConflictProposalRequest,
    state: tauri::State<'_, AppState>,
) -> Result<AiConflictResolutionResult, AiError> {
    let mut session = state
        .ai_extension
        .conflict_sessions
        .get(&request.proposal_id)?;
    if request.region_ids.is_empty() {
        return Err(AiError::new("noConflictRegionsSelected"));
    }
    if request.region_ids.iter().any(|id| {
        !session
            .replacements
            .iter()
            .any(|replacement| &replacement.id == id)
    }) {
        return Err(AiError::new("conflictRegionUnknown"));
    }
    session.applied_ids.extend(request.region_ids);
    let proposal_id = request.proposal_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let repository = session.repository.to_string_lossy().to_string();
        let path = safe_repository_file(&repository, &session.file_path)?;
        let current = read_bounded_file(&path, MAX_COMMIT_TOTAL_CONTEXT_BYTES)?;
        if md5::compute(&current) != session.current_hash {
            return Err(AiError::new("fileChanged"));
        }
        if unmerged_index_hash(&repository, &session.file_path)? != session.index_hash {
            return Err(AiError::new("indexChanged"));
        }
        let original = String::from_utf8(session.original.clone())
            .map_err(|_| AiError::new("unsupportedFile"))?;
        let mut resolved = original.clone();
        for replacement in session.replacements.iter().rev() {
            if session.applied_ids.contains(&replacement.id) {
                let replacement_text =
                    normalise_replacement_line_endings(&replacement.replacement, &original);
                resolved.replace_range(replacement.start..replacement.end, &replacement_text);
            }
        }
        write_atomically(&path, resolved.as_bytes())?;
        session.current_hash = md5::compute(resolved.as_bytes());
        Ok((session, path))
    })
    .await
    .map_err(|_| AiError::new("fileWriteFailed"))??;
    let resolved_regions = result.0.applied_ids.len();
    let file_path = result.0.file_path.clone();
    state
        .ai_extension
        .conflict_sessions
        .update(&proposal_id, result.0)?;
    Ok(AiConflictResolutionResult {
        file_path,
        resolved_regions,
    })
}

#[tauri::command]
pub async fn undo_ai_conflict_proposal(
    proposal_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<AiConflictResolutionResult, AiError> {
    let session = state.ai_extension.conflict_sessions.get(&proposal_id)?;
    let file_path = session.file_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = session.repository.to_string_lossy().to_string();
        let path = safe_repository_file(&repository, &session.file_path)?;
        let current = read_bounded_file(&path, MAX_COMMIT_TOTAL_CONTEXT_BYTES)?;
        if md5::compute(&current) != session.current_hash {
            return Err(AiError::new("fileChanged"));
        }
        write_atomically(&path, &session.original)
    })
    .await
    .map_err(|_| AiError::new("fileWriteFailed"))??;
    state.ai_extension.conflict_sessions.remove(&proposal_id)?;
    Ok(AiConflictResolutionResult {
        file_path,
        resolved_regions: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    fn provider_configuration(provider: AiProvider, endpoint: String) -> EffectiveAiConfiguration {
        EffectiveAiConfiguration {
            enabled: true,
            profile_id: "test".to_string(),
            provider,
            endpoint,
            model: "test-model".to_string(),
            api_style: AiApiStyle::ChatCompletions,
            request_path: if provider == AiProvider::Claude {
                "/messages".to_string()
            } else {
                "/chat/completions".to_string()
            },
            models_path: "/models".to_string(),
            auth_mode: AiAuthMode::Bearer,
            auth_header: "Authorization".to_string(),
            max_tokens_field: "max_completion_tokens".to_string(),
            extra_headers: Default::default(),
            azure_deployment: String::new(),
            azure_api_version: String::new(),
            reasoning_preference: AiReasoningPreference::Automatic,
            effort_capability: AiEffortCapability::Unknown,
            open_router: OpenRouterSettings::default(),
            commit_context_limit_kib: 24,
            conflict_context_limit_kib: 48,
            commit_message_max_tokens: 512,
            conflict_resolution_max_tokens: 4096,
            commit_message_prompt: String::new(),
            conflict_resolution_prompt: String::new(),
            include_commit_history: true,
            global_exclusions: Vec::new(),
            sources: Default::default(),
            environment_fields: Vec::new(),
            environment_api_key: false,
        }
    }

    fn configuration_request(profile_id: Option<&str>) -> SaveAiConfigurationRequest {
        SaveAiConfigurationRequest {
            enabled: Some(true),
            profile_id: profile_id.map(str::to_string),
            profile_name: Some("Profile".to_string()),
            provider: AiProvider::OpenAi,
            endpoint: "https://api.openai.com/v1".to_string(),
            model: "test-model".to_string(),
            reasoning_preference: AiReasoningPreference::Automatic,
            api_style: None,
            request_path: None,
            models_path: None,
            auth_mode: None,
            auth_header: None,
            max_tokens_field: None,
            azure_deployment: None,
            azure_api_version: None,
            open_router: None,
            api_key: None,
        }
    }

    #[test]
    fn a_request_without_a_profile_id_creates_a_new_profile() {
        let mut settings = AiExtensionSettings::default();
        settings.selected_profile_id = "existing".to_string();
        settings.profiles.push(AiProfile {
            id: "existing".to_string(),
            name: "Existing".to_string(),
            ..AiProfile::default()
        });

        let request = configuration_request(None);
        let created = profile_from_request(&request, requested_profile(&request, &settings));
        assert_ne!(created.id, "existing");
        settings.profiles.push(created);
        assert_eq!(settings.profiles.len(), 2);
        assert_eq!(settings.profiles[0].name, "Existing");
        assert_eq!(
            requested_profile(&configuration_request(Some("existing")), &settings)
                .map(|profile| profile.id.as_str()),
            Some("existing")
        );
    }

    #[test]
    fn allows_openrouter_oauth_only_for_the_official_https_origin() {
        assert!(openrouter_oauth_endpoint_allowed(
            &Url::parse("https://openrouter.ai/api/v1").unwrap()
        ));
        assert!(!openrouter_oauth_endpoint_allowed(
            &Url::parse("http://openrouter.ai/api/v1").unwrap()
        ));
        assert!(!openrouter_oauth_endpoint_allowed(
            &Url::parse("https://openrouter.ai.example/api/v1").unwrap()
        ));
        assert!(!openrouter_oauth_endpoint_allowed(
            &Url::parse("https://example.com/api/v1").unwrap()
        ));
    }

    fn run_git(repo: &Path, arguments: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(arguments)
            .status()
            .unwrap();
        assert!(status.success());
    }

    fn read_http_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
            if let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(str::trim)
                            .map(str::to_string)
                    })
                    .and_then(|value| value.parse::<usize>().ok())
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8(request).unwrap()
    }

    fn write_http_response(stream: &mut TcpStream, status: &str, body: &str) {
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nX-Request-Id: request-1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).unwrap();
    }

    fn mock_responses(responses: Vec<(String, String)>) -> (String, mpsc::Receiver<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_http_request(&mut stream));
                write_http_response(&mut stream, &status, &body);
            }
            drop(sender.send(requests));
        });
        (endpoint, receiver)
    }

    #[test]
    fn blocks_sensitive_paths() {
        for path in [
            ".env",
            "config/.env.local",
            ".ssh/config",
            "keys/id_ed25519.pub",
            "certs/client.pem",
        ] {
            assert!(is_sensitive_path(path), "{path}");
        }
        assert!(!is_sensitive_path("src/environment.ts"));
    }

    #[test]
    fn parses_multiple_conflict_regions() {
        let text = "before\n<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> branch\nmiddle\n<<<<<<< HEAD\nthree\n||||||| base\nbase\n=======\nfour\n>>>>>>> branch\nafter\n";
        let regions = parse_conflict_regions(text).unwrap();
        assert_eq!(regions.len(), 2);
        assert!(regions[0].prompt.contains("before"));
        assert!(regions[1].prompt.contains("after"));
    }

    #[test]
    fn rejects_malformed_conflict_regions() {
        let error = parse_conflict_regions("<<<<<<< HEAD\none\n>>>>>>> branch\n").unwrap_err();
        assert_eq!(error.code, "malformedConflict");
    }

    #[test]
    fn parses_only_complete_structured_conflict_replacements() {
        let regions =
            parse_conflict_regions("<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> branch\n").unwrap();
        let response = json!({
            "regions": [{
                "id": regions[0].id,
                "replacement": "resolved\n",
                "explanation": "Kept both changes."
            }]
        })
        .to_string();
        let replacements = parse_conflict_replacements(&response, &regions).unwrap();

        assert_eq!(replacements[0].replacement, "resolved\n");
        assert_eq!(
            replacements[0].explanation.as_deref(),
            Some("Kept both changes.")
        );
        assert!(parse_conflict_replacements(r#"{"regions":[]}"#, &regions).is_err());
    }

    #[test]
    fn commit_messages_reject_markdown_fences() {
        assert!(validate_commit_message("```text\nmessage\n```".to_string(), 72).is_err());
        assert_eq!(
            validate_commit_message("subject\n\nbody".to_string(), 72).unwrap(),
            "subject\n\nbody"
        );
        assert!(validate_commit_message("x".repeat(73), 72).is_err());
    }

    #[test]
    fn commit_context_contains_only_the_staged_version() {
        let repository = tempfile::tempdir().unwrap();
        run_git(repository.path(), &["init", "-q"]);
        let path = repository.path().join("notes.txt");
        std::fs::write(&path, "staged line\n").unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);
        std::fs::write(&path, "staged line\nunstaged secret\n").unwrap();

        let context = render_commit_context(
            &build_commit_context(
                repository.path().to_str().unwrap(),
                72,
                false,
                &[],
                AiCommitWorkflow::Normal,
                "",
            )
            .unwrap(),
        );

        assert!(context.contains("staged line"));
        assert!(!context.contains("unstaged secret"));
    }

    #[test]
    fn commit_context_includes_recent_commit_messages_for_style() {
        let repository = tempfile::tempdir().unwrap();
        run_git(repository.path(), &["init", "-q"]);
        std::fs::write(repository.path().join("notes.txt"), "first\n").unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);
        run_git(
            repository.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "feat: record baseline",
            ],
        );
        std::fs::write(repository.path().join("notes.txt"), "first\nsecond\n").unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);

        let context = render_commit_context(
            &build_commit_context(
                repository.path().to_str().unwrap(),
                72,
                true,
                &[],
                AiCommitWorkflow::Normal,
                "",
            )
            .unwrap(),
        );

        assert!(context.contains("Recent commit messages for style:"));
        assert!(context.contains("feat: record baseline"));
    }

    #[test]
    fn commit_context_requires_and_describes_the_active_git_workflow() {
        let repository = tempfile::tempdir().unwrap();
        run_git(repository.path(), &["init", "-q"]);
        std::fs::write(repository.path().join("notes.txt"), "first\n").unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);
        run_git(
            repository.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "baseline",
            ],
        );
        std::fs::write(repository.path().join("notes.txt"), "first\nmerged\n").unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);
        let git_directory = String::from_utf8(
            git_output(
                repository.path().to_str().unwrap(),
                &["rev-parse", "--absolute-git-dir"],
                MAX_GIT_METADATA_OUTPUT_BYTES,
            )
            .unwrap(),
        )
        .unwrap();
        std::fs::write(Path::new(git_directory.trim()).join("MERGE_HEAD"), "test\n").unwrap();

        let normal_error = build_commit_context(
            repository.path().to_str().unwrap(),
            72,
            false,
            &[],
            AiCommitWorkflow::Normal,
            "",
        )
        .unwrap_err();
        assert_eq!(normal_error.code, "operationInProgress");

        let context = build_commit_context(
            repository.path().to_str().unwrap(),
            72,
            false,
            &[],
            AiCommitWorkflow::Merge,
            "Merge feature branch",
        )
        .unwrap();
        let rendered = render_commit_context(&context);
        assert!(rendered.contains("Workflow: merge commit"));
        assert!(rendered.contains("Merge feature branch"));
    }

    #[test]
    fn writing_contexts_cover_staged_and_branch_changes_without_writing() {
        let repository = tempfile::tempdir().unwrap();
        run_git(repository.path(), &["init", "-q"]);
        std::fs::write(repository.path().join("notes.txt"), "baseline\n").unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);

        let staged = writing_context(
            repository.path().to_str().unwrap(),
            AiWritingTask::StagedReview,
            "",
            false,
            &[],
        )
        .unwrap();
        assert_eq!(staged.files, vec!["notes.txt"]);
        assert!(staged.content.contains("baseline"));

        run_git(
            repository.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "baseline",
            ],
        );
        let base = String::from_utf8(
            git_output(
                repository.path().to_str().unwrap(),
                &["rev-parse", "HEAD"],
                MAX_GIT_METADATA_OUTPUT_BYTES,
            )
            .unwrap(),
        )
        .unwrap();
        std::fs::write(
            repository.path().join("notes.txt"),
            "baseline\nbranch change\n",
        )
        .unwrap();
        run_git(repository.path(), &["add", "notes.txt"]);
        run_git(
            repository.path(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "-m",
                "record branch change",
            ],
        );

        let branch = writing_context(
            repository.path().to_str().unwrap(),
            AiWritingTask::BranchSummary,
            base.trim(),
            true,
            &[],
        )
        .unwrap();
        assert_eq!(branch.files, vec!["notes.txt"]);
        assert!(branch.content.contains("record branch change"));
        assert!(branch.content.contains("branch change"));
    }

    #[test]
    fn commit_context_refuses_sensitive_and_oversized_changes() {
        let sensitive_repository = tempfile::tempdir().unwrap();
        run_git(sensitive_repository.path(), &["init", "-q"]);
        std::fs::write(sensitive_repository.path().join(".env"), "TOKEN=value\n").unwrap();
        run_git(sensitive_repository.path(), &["add", ".env"]);
        let error = build_commit_context(
            sensitive_repository.path().to_str().unwrap(),
            72,
            false,
            &[],
            AiCommitWorkflow::Normal,
            "",
        )
        .unwrap_err();
        assert_eq!(error.code, "sensitivePath");

        let large_repository = tempfile::tempdir().unwrap();
        run_git(large_repository.path(), &["init", "-q"]);
        std::fs::write(
            large_repository.path().join("large.txt"),
            "x".repeat(MAX_COMMIT_TOTAL_CONTEXT_BYTES + 1),
        )
        .unwrap();
        run_git(large_repository.path(), &["add", "large.txt"]);
        let error = build_commit_context(
            large_repository.path().to_str().unwrap(),
            72,
            false,
            &[],
            AiCommitWorkflow::Normal,
            "",
        )
        .unwrap_err();
        assert_eq!(error.code, "contextTooLarge");
        assert_eq!(error.context_size_kib, None);
    }

    #[test]
    fn context_size_limit_is_inclusive_and_reports_rounded_size() {
        assert!(validate_context_size(8 * 1024, 8).is_ok());

        let error = validate_context_size(8 * 1024 + 1, 8).unwrap_err();
        assert_eq!(error.code, "contextTooLarge");
        assert_eq!(error.context_size_kib, Some(9));
        assert_eq!(error.context_limit_kib, Some(8));
    }

    #[test]
    fn splits_commit_context_without_losing_unicode_text() {
        let maximum_bytes = 5 * 1024;
        let text = format!("{}\n{}", "a".repeat(maximum_bytes), "£".repeat(20));
        let chunks = split_text(&text, maximum_bytes);

        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| chunk.len() <= maximum_bytes));
        assert_eq!(chunks.concat(), text);
    }

    #[test]
    fn repeats_commit_requirements_after_the_supplied_context() {
        let context = CommitContext {
            branch: "main".to_string(),
            workflow: AiCommitWorkflow::Normal,
            existing_message: String::new(),
            subject_limit: 72,
            path_list: "M\tsrc/main.rs".to_string(),
            recent_messages: "feat: existing style".to_string(),
            diff: "diff --git a/src/main.rs b/src/main.rs".to_string(),
            staged_snapshot: md5::compute("snapshot"),
        };

        let prompt = render_commit_context(&context);

        assert!(prompt.ends_with(
            "Now return only the commit message. Keep its subject to no more than 72 characters. Do not review or explain the changes."
        ));
    }

    #[test]
    fn generates_commit_messages_from_bounded_diff_summaries() {
        let summary_response = |text: &str, finish_reason: &str| {
            json!({
                "choices": [{"message": {"content": text}, "finish_reason": finish_reason}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 3}
            })
            .to_string()
        };
        let final_response = json!({
            "choices": [{
                "message": {"content": "feat: summarise staged changes"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 20, "completion_tokens": 5}
        })
        .to_string();
        let (endpoint, requests) = mock_responses(vec![
            (
                "200 OK".to_string(),
                summary_response("Changed the first part.", "stop"),
            ),
            (
                "200 OK".to_string(),
                summary_response("Changed the second part.", "stop"),
            ),
            ("200 OK".to_string(), final_response),
        ]);
        let mut configuration = provider_configuration(AiProvider::OpenAiCompatible, endpoint);
        configuration.commit_context_limit_kib = 8;
        let request_context_bytes = commit_request_context_bytes(&configuration);
        let summary_max_tokens = commit_summary_max_tokens(&configuration);
        let context = CommitContext {
            branch: "main".to_string(),
            workflow: AiCommitWorkflow::Normal,
            existing_message: String::new(),
            subject_limit: 72,
            path_list: "M\tsrc/main.rs".to_string(),
            recent_messages: "feat: existing style".to_string(),
            diff: "x".repeat(request_context_bytes + 1),
            staged_snapshot: md5::compute("snapshot"),
        };
        let runtime = crate::ai::AiRuntime::new().unwrap();
        let mut budget = RequestBudget::new();

        let result = tauri::async_runtime::block_on(generate_commit_message_from_context(
            &runtime,
            configuration,
            "secret",
            context,
            "Custom commit prompt",
            &mut budget,
        ))
        .unwrap();

        assert_eq!(result.message, "feat: summarise staged changes");
        assert_eq!(result.usage.input_tokens, Some(40));
        assert_eq!(result.usage.output_tokens, Some(11));
        let requests = requests.recv().unwrap();
        assert_eq!(requests.len(), 3);
        let bodies = requests
            .iter()
            .map(|request| {
                serde_json::from_str::<Value>(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
            })
            .collect::<Vec<_>>();
        assert_eq!(
            bodies[0]
                .pointer("/messages/0/content")
                .and_then(Value::as_str),
            Some(COMMIT_SUMMARY_PROMPT)
        );
        assert_eq!(bodies[0]["max_completion_tokens"], summary_max_tokens);
        assert_eq!(bodies[1]["max_completion_tokens"], summary_max_tokens);
        assert_eq!(
            bodies[2]
                .pointer("/messages/0/content")
                .and_then(Value::as_str),
            Some("Custom commit prompt")
        );
        let final_context = bodies[2]
            .pointer("/messages/1/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(final_context.contains("Changed the first part."));
        assert!(final_context.contains("Changed the second part."));
        assert!(final_context.ends_with(
            "Now return only the commit message. Keep its subject to no more than 72 characters. Do not review or explain the changes."
        ));
        assert!(final_context.len() <= request_context_bytes);
    }

    #[test]
    fn sends_the_full_diff_when_the_configured_request_limit_allows_it() {
        let response = json!({
            "choices": [{
                "message": {"content": "feat: use configured request limit"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 2000, "completion_tokens": 7}
        });
        let (endpoint, requests) =
            mock_responses(vec![("200 OK".to_string(), response.to_string())]);
        let configuration = provider_configuration(AiProvider::OpenAiCompatible, endpoint);
        let diff = "x".repeat(9 * 1024);
        let context = CommitContext {
            branch: "main".to_string(),
            workflow: AiCommitWorkflow::Normal,
            existing_message: String::new(),
            subject_limit: 72,
            path_list: "M\tsrc/main.rs".to_string(),
            recent_messages: "feat: existing style".to_string(),
            diff: diff.clone(),
            staged_snapshot: md5::compute("snapshot"),
        };
        let runtime = crate::ai::AiRuntime::new().unwrap();
        let mut budget = RequestBudget::new();

        let result = tauri::async_runtime::block_on(generate_commit_message_from_context(
            &runtime,
            configuration,
            "secret",
            context,
            "Custom commit prompt",
            &mut budget,
        ))
        .unwrap();

        assert_eq!(result.message, "feat: use configured request limit");
        let requests = requests.recv().unwrap();
        assert_eq!(requests.len(), 1);
        let body: Value =
            serde_json::from_str(requests[0].split("\r\n\r\n").nth(1).unwrap()).unwrap();
        let prompt = body
            .pointer("/messages/1/content")
            .and_then(Value::as_str)
            .unwrap();
        assert!(prompt.contains(&diff));
        assert!(!prompt.contains("Staged change summaries:"));
    }
}
