pub mod commands;
mod configuration;
mod conflicts;
mod credentials;
mod openrouter_oauth;
mod operations;
mod provider;
pub mod types;

use serde::Serialize;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

pub(crate) use conflicts::{ConflictReplacement, ConflictSession, ConflictSessionStore};

pub use configuration::AiConfigurationSource;
pub(crate) use configuration::{AiLaunchOverrides, EffectiveAiConfiguration, validate_endpoint};
pub(crate) use credentials::{AiCredentialStore, KeyringAiCredentialStore};
pub(crate) use operations::AiOperationRegistry;
pub(crate) use provider::{
    AiModelInfo, AiModelPage, AiModelQuery, AiRuntime, AiTask, ProviderResult, api_key_optional,
    discover_effort, discover_models, discover_openrouter_model_details, run_provider,
};
pub use types::{
    AiApiStyle, AiAuthMode, AiEffortCapability, AiExtensionSettings, AiProfile, AiProvider,
    AiReasoningPreference, AiRepositoryPolicy, AiUsageRecord, ExtensionSettings, OpenRouterPrivacy,
    OpenRouterRoutingStrategy, OpenRouterSettings,
};

pub(crate) struct AiExtensionState {
    pub environment: AiLaunchOverrides,
    pub runtime: Option<AiRuntime>,
    pub credentials: Arc<dyn AiCredentialStore>,
    pub conflict_sessions: ConflictSessionStore,
    pub operations: AiOperationRegistry,
    pub openrouter_oauth_active: AtomicBool,
}

impl AiExtensionState {
    pub fn new() -> Self {
        Self {
            environment: AiLaunchOverrides::from_process(),
            runtime: AiRuntime::new().ok(),
            credentials: Arc::new(KeyringAiCredentialStore),
            conflict_sessions: ConflictSessionStore::default(),
            operations: AiOperationRegistry::default(),
            openrouter_oauth_active: AtomicBool::new(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiError {
    pub code: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_size_kib: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_limit_kib: Option<u32>,
}

impl AiError {
    pub(crate) fn new(code: &'static str) -> Self {
        Self {
            code,
            detail: None,
            context_size_kib: None,
            context_limit_kib: None,
        }
    }

    pub(crate) fn with_detail(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: Some(detail.into()),
            context_size_kib: None,
            context_limit_kib: None,
        }
    }

    pub(crate) fn context_too_large(context_bytes: usize, context_limit_kib: u32) -> Self {
        Self {
            code: "contextTooLarge",
            detail: None,
            context_size_kib: Some(context_bytes.div_ceil(1024)),
            context_limit_kib: Some(context_limit_kib),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiUsage {
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
    pub cached_tokens: Option<u64>,
    pub cost: Option<f64>,
    pub byok: Option<bool>,
}
