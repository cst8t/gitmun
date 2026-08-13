use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Deserializer, Serialize};

pub const DEFAULT_COMMIT_CONTEXT_LIMIT_KIB: u32 = 24;
pub const DEFAULT_CONFLICT_CONTEXT_LIMIT_KIB: u32 = 48;
const MIN_CONTEXT_LIMIT_KIB: u32 = 8;
const MAX_CONTEXT_LIMIT_KIB: u32 = 1024;
pub const DEFAULT_COMMIT_MESSAGE_MAX_TOKENS: u32 = 512;
pub const DEFAULT_CONFLICT_RESOLUTION_MAX_TOKENS: u32 = 4096;
const MIN_OUTPUT_TOKENS: u32 = 1;
const MAX_OUTPUT_TOKENS: u32 = 65_536;
pub const DEFAULT_COMMIT_MESSAGE_PROMPT: &str = "Write a concise Git commit message in the style of the supplied recent commits. Return only the commit message as plain text. Put the subject first, then an optional blank line and body. Summarise the staged changes accurately. Do not use Markdown headings, lists, fences, emoji, or commentary.";
pub const DEFAULT_CONFLICT_RESOLUTION_PROMPT: &str = "Resolve the supplied Git conflict regions. Preserve intended behaviour and surrounding style. Return only the requested structured JSON with one replacement for every supplied region ID.";

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub enum AiProvider {
    #[default]
    Disabled,
    OpenAi,
    Claude,
    Bedrock,
    Mistral,
    GoogleGemini,
    OpenRouter,
    AzureOpenAi,
    Ollama,
    LmStudio,
    OpenAiCompatible,
}

impl AiProvider {
    pub fn default_endpoint(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1",
            Self::Claude => "https://api.anthropic.com/v1",
            Self::Bedrock => "https://bedrock-runtime.eu-west-2.amazonaws.com",
            Self::Mistral => "https://api.mistral.ai/v1",
            Self::GoogleGemini => "https://generativelanguage.googleapis.com/v1beta/openai",
            Self::OpenRouter => "https://openrouter.ai/api/v1",
            Self::Ollama => "http://127.0.0.1:11434/v1",
            Self::LmStudio => "http://127.0.0.1:1234/v1",
            Self::AzureOpenAi | Self::OpenAiCompatible | Self::Disabled => "",
        }
    }

    pub fn is_openai_compatible(self) -> bool {
        !matches!(self, Self::Disabled | Self::Claude | Self::Bedrock)
    }

    pub fn api_key_optional(self, endpoint_is_loopback: bool) -> bool {
        endpoint_is_loopback
            && matches!(self, Self::Ollama | Self::LmStudio | Self::OpenAiCompatible)
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum AiApiStyle {
    #[default]
    ChatCompletions,
    Responses,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum AiCommitMessageMode {
    #[default]
    RepositoryStyle,
    ConventionalCommits,
    FreeForm,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum AiAuthMode {
    #[default]
    Bearer,
    Header,
    AwsSigV4,
    None,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum AiReasoningPreference {
    #[default]
    Automatic,
    Off,
    ProviderDefault,
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "status", content = "levels", rename_all = "camelCase")]
pub enum AiEffortCapability {
    #[default]
    Unknown,
    Accepted,
    Unsupported,
    Supported(Vec<AiReasoningPreference>),
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpenRouterPrivacy {
    #[default]
    NoDataCollection,
    StrictZdr,
    AccountDefault,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
pub enum OpenRouterRoutingStrategy {
    #[default]
    Default,
    Price,
    Latency,
    Throughput,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct OpenRouterSettings {
    pub privacy: OpenRouterPrivacy,
    pub allow_fallbacks: bool,
    pub require_parameters: bool,
    pub routing_strategy: OpenRouterRoutingStrategy,
    pub max_prompt_price: String,
    pub max_completion_price: String,
    pub preferred_providers: Vec<String>,
    pub allowed_providers: Vec<String>,
    pub ignored_providers: Vec<String>,
    pub preferred_max_latency: String,
    pub preferred_min_throughput: String,
    pub diagnostics: bool,
}

impl Default for OpenRouterSettings {
    fn default() -> Self {
        Self {
            privacy: OpenRouterPrivacy::NoDataCollection,
            allow_fallbacks: true,
            require_parameters: true,
            routing_strategy: OpenRouterRoutingStrategy::Default,
            max_prompt_price: String::new(),
            max_completion_price: String::new(),
            preferred_providers: Vec::new(),
            allowed_providers: Vec::new(),
            ignored_providers: Vec::new(),
            preferred_max_latency: String::new(),
            preferred_min_throughput: String::new(),
            diagnostics: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AiProfile {
    pub id: String,
    pub name: String,
    pub provider: AiProvider,
    pub endpoint: String,
    pub model: String,
    pub api_style: AiApiStyle,
    pub request_path: String,
    pub models_path: String,
    pub auth_mode: AiAuthMode,
    pub auth_header: String,
    pub max_tokens_field: String,
    pub extra_headers: BTreeMap<String, String>,
    pub azure_deployment: String,
    pub azure_api_version: String,
    pub reasoning_preference: AiReasoningPreference,
    pub effort_capability: AiEffortCapability,
    pub open_router: OpenRouterSettings,
}

impl Default for AiProfile {
    fn default() -> Self {
        Self {
            id: "default".to_string(),
            name: String::new(),
            provider: AiProvider::OpenRouter,
            endpoint: String::new(),
            model: String::new(),
            api_style: AiApiStyle::ChatCompletions,
            request_path: String::new(),
            models_path: String::new(),
            auth_mode: AiAuthMode::Bearer,
            auth_header: String::new(),
            max_tokens_field: String::new(),
            extra_headers: BTreeMap::new(),
            azure_deployment: String::new(),
            azure_api_version: String::new(),
            reasoning_preference: AiReasoningPreference::Automatic,
            effort_capability: AiEffortCapability::Unknown,
            open_router: OpenRouterSettings::default(),
        }
    }
}

fn default_commit_context_limit_kib() -> u32 {
    DEFAULT_COMMIT_CONTEXT_LIMIT_KIB
}

fn default_conflict_context_limit_kib() -> u32 {
    DEFAULT_CONFLICT_CONTEXT_LIMIT_KIB
}

fn default_commit_message_max_tokens() -> u32 {
    DEFAULT_COMMIT_MESSAGE_MAX_TOKENS
}

fn default_conflict_resolution_max_tokens() -> u32 {
    DEFAULT_CONFLICT_RESOLUTION_MAX_TOKENS
}

fn default_commit_message_prompt() -> String {
    DEFAULT_COMMIT_MESSAGE_PROMPT.to_string()
}

fn default_conflict_resolution_prompt() -> String {
    DEFAULT_CONFLICT_RESOLUTION_PROMPT.to_string()
}

fn deserialise_context_limit<'de, D>(deserialiser: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(normalise_context_limit(u32::deserialize(deserialiser)?))
}

fn deserialise_output_tokens<'de, D>(deserialiser: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(normalise_output_tokens(u32::deserialize(deserialiser)?))
}

fn deserialise_commit_prompt<'de, D>(deserialiser: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(normalise_prompt(
        String::deserialize(deserialiser)?,
        DEFAULT_COMMIT_MESSAGE_PROMPT,
    ))
}

fn deserialise_conflict_prompt<'de, D>(deserialiser: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(normalise_prompt(
        String::deserialize(deserialiser)?,
        DEFAULT_CONFLICT_RESOLUTION_PROMPT,
    ))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AiExtensionSettings {
    pub enabled: bool,
    pub selected_profile_id: String,
    pub profiles: Vec<AiProfile>,
    #[serde(
        default = "default_commit_context_limit_kib",
        deserialize_with = "deserialise_context_limit"
    )]
    pub commit_context_limit_kib: u32,
    #[serde(
        default = "default_conflict_context_limit_kib",
        deserialize_with = "deserialise_context_limit"
    )]
    pub conflict_context_limit_kib: u32,
    #[serde(
        default = "default_commit_message_max_tokens",
        deserialize_with = "deserialise_output_tokens"
    )]
    pub commit_message_max_tokens: u32,
    #[serde(
        default = "default_conflict_resolution_max_tokens",
        deserialize_with = "deserialise_output_tokens"
    )]
    pub conflict_resolution_max_tokens: u32,
    #[serde(
        default = "default_commit_message_prompt",
        deserialize_with = "deserialise_commit_prompt"
    )]
    pub commit_message_prompt: String,
    #[serde(
        default = "default_conflict_resolution_prompt",
        deserialize_with = "deserialise_conflict_prompt"
    )]
    pub conflict_resolution_prompt: String,
    pub include_commit_history: bool,
    pub global_exclusions: Vec<String>,
    pub consented_destinations: Vec<String>,
    pub repository_policies: BTreeMap<String, AiRepositoryPolicy>,
    pub structured_output_modes: HashMap<String, String>,
    pub usage_history: Vec<AiUsageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AiUsageRecord {
    pub timestamp: u64,
    pub provider: AiProvider,
    pub profile_id: String,
    pub model: String,
    pub task: String,
    pub duration_ms: u64,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub cost: Option<f64>,
    pub byok: Option<bool>,
    pub request_id: Option<String>,
    pub generation_id: Option<String>,
    pub routed_provider: Option<String>,
    pub routed_model: Option<String>,
    pub diagnostic: Option<String>,
    pub status: String,
}

impl Default for AiUsageRecord {
    fn default() -> Self {
        Self {
            timestamp: 0,
            provider: AiProvider::Disabled,
            profile_id: String::new(),
            model: String::new(),
            task: String::new(),
            duration_ms: 0,
            input_tokens: None,
            output_tokens: None,
            reasoning_tokens: None,
            cached_tokens: None,
            cost: None,
            byok: None,
            request_id: None,
            generation_id: None,
            routed_provider: None,
            routed_model: None,
            diagnostic: None,
            status: String::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AiRepositoryPolicy {
    pub exclusions: Vec<String>,
    pub include_commit_history: Option<bool>,
    pub conventional_commits: bool,
    pub commit_message_mode: Option<AiCommitMessageMode>,
    pub default_commit_type: String,
    pub default_commit_scope: String,
    pub default_language: String,
    pub commit_prompt_file: String,
    pub conflict_prompt_file: String,
}

impl AiRepositoryPolicy {
    pub fn effective_commit_message_mode(&self) -> AiCommitMessageMode {
        self.commit_message_mode
            .unwrap_or(if self.conventional_commits {
                AiCommitMessageMode::ConventionalCommits
            } else {
                AiCommitMessageMode::RepositoryStyle
            })
    }
}

impl Default for AiExtensionSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            selected_profile_id: String::new(),
            profiles: Vec::new(),
            commit_context_limit_kib: DEFAULT_COMMIT_CONTEXT_LIMIT_KIB,
            conflict_context_limit_kib: DEFAULT_CONFLICT_CONTEXT_LIMIT_KIB,
            commit_message_max_tokens: DEFAULT_COMMIT_MESSAGE_MAX_TOKENS,
            conflict_resolution_max_tokens: DEFAULT_CONFLICT_RESOLUTION_MAX_TOKENS,
            commit_message_prompt: default_commit_message_prompt(),
            conflict_resolution_prompt: default_conflict_resolution_prompt(),
            include_commit_history: true,
            global_exclusions: Vec::new(),
            consented_destinations: Vec::new(),
            repository_policies: BTreeMap::new(),
            structured_output_modes: HashMap::new(),
            usage_history: Vec::new(),
        }
    }
}

impl AiExtensionSettings {
    pub fn selected_profile(&self) -> Option<&AiProfile> {
        self.profiles
            .iter()
            .find(|profile| profile.id == self.selected_profile_id)
            .or_else(|| self.profiles.first())
    }

    pub fn selected_profile_mut(&mut self) -> Option<&mut AiProfile> {
        let selected = self.selected_profile_id.clone();
        let index = self
            .profiles
            .iter()
            .position(|profile| profile.id == selected)
            .or_else(|| (!self.profiles.is_empty()).then_some(0))?;
        self.profiles.get_mut(index)
    }

    pub fn ensure_profile(&mut self) -> &mut AiProfile {
        if self.selected_profile().is_none() {
            self.profiles.push(AiProfile::default());
            self.selected_profile_id = "default".to_string();
        }
        let index = self
            .profiles
            .iter()
            .position(|profile| profile.id == self.selected_profile_id)
            .unwrap_or(0);
        &mut self.profiles[index]
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ExtensionSettings {
    pub ai: AiExtensionSettings,
}

pub fn normalise_context_limit(value: u32) -> u32 {
    value.clamp(MIN_CONTEXT_LIMIT_KIB, MAX_CONTEXT_LIMIT_KIB)
}

pub fn normalise_output_tokens(value: u32) -> u32 {
    value.clamp(MIN_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS)
}

pub fn normalise_prompt(value: String, default: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        default.to_string()
    } else {
        value.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_defaults_are_centralised() {
        assert_eq!(
            AiProvider::Mistral.default_endpoint(),
            "https://api.mistral.ai/v1"
        );
        assert_eq!(
            AiProvider::GoogleGemini.default_endpoint(),
            "https://generativelanguage.googleapis.com/v1beta/openai"
        );
        assert_eq!(
            AiProvider::OpenRouter.default_endpoint(),
            "https://openrouter.ai/api/v1"
        );
        assert_eq!(
            AiProvider::Bedrock.default_endpoint(),
            "https://bedrock-runtime.eu-west-2.amazonaws.com"
        );
        assert!(!AiProvider::Bedrock.is_openai_compatible());
    }

    #[test]
    fn extension_is_opt_in() {
        let settings = AiExtensionSettings::default();
        assert!(!settings.enabled);
        assert!(settings.profiles.is_empty());
        assert_eq!(AiProfile::default().provider, AiProvider::OpenRouter);
    }

    #[test]
    fn openrouter_defaults_prevent_data_collection() {
        let settings = OpenRouterSettings::default();
        assert_eq!(settings.privacy, OpenRouterPrivacy::NoDataCollection);
        assert!(settings.allow_fallbacks);
        assert!(settings.require_parameters);
    }

    #[test]
    fn reasoning_off_round_trips_in_profiles() {
        let profile = AiProfile {
            reasoning_preference: AiReasoningPreference::Off,
            ..AiProfile::default()
        };

        let value = serde_json::to_value(&profile).unwrap();
        let restored: AiProfile = serde_json::from_value(value.clone()).unwrap();

        assert_eq!(
            value.get("reasoningPreference"),
            Some(&serde_json::json!("Off"))
        );
        assert_eq!(restored.reasoning_preference, AiReasoningPreference::Off);
    }

    #[test]
    fn legacy_repository_policy_uses_conventional_commit_mode() {
        let policy: AiRepositoryPolicy = serde_json::from_value(serde_json::json!({
            "conventionalCommits": true,
            "defaultLanguage": "English"
        }))
        .unwrap();

        assert_eq!(policy.commit_message_mode, None);
        assert_eq!(
            policy.effective_commit_message_mode(),
            AiCommitMessageMode::ConventionalCommits
        );
        assert_eq!(policy.default_language, "English");
    }

    #[test]
    fn repository_commit_defaults_round_trip() {
        let policy = AiRepositoryPolicy {
            commit_message_mode: Some(AiCommitMessageMode::FreeForm),
            default_commit_type: "docs".to_string(),
            default_commit_scope: "ai".to_string(),
            default_language: "British English".to_string(),
            ..AiRepositoryPolicy::default()
        };

        let restored: AiRepositoryPolicy =
            serde_json::from_value(serde_json::to_value(&policy).unwrap()).unwrap();

        assert_eq!(restored, policy);
        assert_eq!(
            restored.effective_commit_message_mode(),
            AiCommitMessageMode::FreeForm
        );
    }

    #[test]
    fn custom_conflict_prompt_is_preserved() {
        let custom: AiExtensionSettings = serde_json::from_value(serde_json::json!({
            "conflictResolutionPrompt": "Resolve conflicts using the repository conventions."
        }))
        .unwrap();

        assert_eq!(
            custom.conflict_resolution_prompt,
            "Resolve conflicts using the repository conventions."
        );
    }
}
