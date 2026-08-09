use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::Path;

use reqwest::header::{HeaderName, HeaderValue};
use serde::Serialize;
use serde_json::Value;
use url::{Host, Url};

use crate::git::types::Settings;

use super::AiError;
use super::providers::ProviderRegistry;
use super::types::{
    AiApiStyle, AiAuthMode, AiEffortCapability, AiProfile, AiProvider, AiReasoningPreference,
    OpenRouterPrivacy,
};

const MAX_PROMPT_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
pub enum AiConfigurationSource {
    Environment,
    StoredProfile,
    ProviderDefault,
}

#[derive(Debug, Clone)]
pub(crate) struct EffectiveAiConfiguration {
    pub enabled: bool,
    pub profile_id: String,
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
    pub open_router: super::types::OpenRouterSettings,
    pub commit_context_limit_kib: u32,
    pub conflict_context_limit_kib: u32,
    pub commit_message_max_tokens: u32,
    pub conflict_resolution_max_tokens: u32,
    pub commit_message_prompt: String,
    pub conflict_resolution_prompt: String,
    pub include_commit_history: bool,
    pub global_exclusions: Vec<String>,
    pub sources: BTreeMap<String, AiConfigurationSource>,
    pub environment_fields: Vec<String>,
    pub environment_api_key: bool,
}

impl EffectiveAiConfiguration {
    pub fn endpoint_url(&self) -> Result<Url, AiError> {
        validate_endpoint(&self.endpoint)
    }

    pub fn endpoint_is_loopback(&self) -> bool {
        self.endpoint_url().is_ok_and(|url| is_loopback(&url))
    }

    pub fn credential_scope(&self) -> Result<String, AiError> {
        let url = self.endpoint_url()?;
        let authority = url
            .host_str()
            .map(|host| match url.port() {
                Some(port) => format!("{host}:{port}"),
                None => host.to_string(),
            })
            .ok_or_else(|| AiError::new("endpointInvalid"))?;
        Ok(format!(
            "{}:{:?}:{authority}",
            self.profile_id, self.provider
        ))
    }

    pub fn destination_authority(&self) -> Result<String, AiError> {
        let url = self.endpoint_url()?;
        let host = url
            .host_str()
            .ok_or_else(|| AiError::new("endpointInvalid"))?;
        Ok(match url.port() {
            Some(port) => format!("{}://{host}:{port}", url.scheme()),
            None => format!("{}://{host}", url.scheme()),
        })
    }

    pub fn consent_key(&self) -> Result<String, AiError> {
        Ok(format!(
            "{:?}:{}",
            self.provider,
            self.destination_authority()?
        ))
    }
}

#[derive(Default)]
struct EnvironmentValues {
    enabled: Option<bool>,
    provider: Option<AiProvider>,
    endpoint: Option<String>,
    model: Option<String>,
    api_key: Option<String>,
    reasoning: Option<AiReasoningPreference>,
    api_style: Option<AiApiStyle>,
    request_path: Option<String>,
    models_path: Option<String>,
    auth_mode: Option<AiAuthMode>,
    auth_header: Option<String>,
    max_tokens_field: Option<String>,
    extra_headers: Option<BTreeMap<String, String>>,
    azure_deployment: Option<String>,
    azure_api_version: Option<String>,
    openrouter_privacy: Option<OpenRouterPrivacy>,
    openrouter_allow_fallbacks: Option<bool>,
    openrouter_require_parameters: Option<bool>,
    openrouter_max_prompt_price: Option<String>,
    openrouter_max_completion_price: Option<String>,
    commit_context_limit_kib: Option<u32>,
    conflict_context_limit_kib: Option<u32>,
    commit_max_tokens: Option<u32>,
    conflict_max_tokens: Option<u32>,
    commit_prompt: Option<String>,
    conflict_prompt: Option<String>,
    include_commit_history: Option<bool>,
    standard_keys: BTreeMap<AiProvider, (String, String)>,
    bedrock_iam_credentials: Option<String>,
    standard_endpoints: BTreeMap<AiProvider, (String, String)>,
}

pub(crate) struct AiLaunchOverrides {
    values: EnvironmentValues,
    invalid_variable: Option<String>,
}

impl AiLaunchOverrides {
    pub fn from_process() -> Self {
        Self::from_values(std::env::vars_os())
    }

    fn from_values(values: impl IntoIterator<Item = (OsString, OsString)>) -> Self {
        let environment = values
            .into_iter()
            .filter_map(|(key, value)| Some((key.into_string().ok()?, value.into_string().ok()?)))
            .collect::<BTreeMap<_, _>>();
        let mut overrides = Self {
            values: EnvironmentValues::default(),
            invalid_variable: None,
        };
        overrides.parse(&environment);
        overrides
    }

    fn parse(&mut self, environment: &BTreeMap<String, String>) {
        self.values.enabled = self.parse_value(environment, "GITMUN_AI_ENABLED", parse_bool);
        self.values.provider = self.parse_value(environment, "GITMUN_AI_PROVIDER", parse_provider);
        self.values.endpoint = self.string_value(environment, "GITMUN_AI_ENDPOINT");
        self.values.model = self.string_value(environment, "GITMUN_AI_MODEL");
        self.values.api_key = self.secret_value(environment, "GITMUN_AI_API_KEY");
        self.values.reasoning =
            self.parse_value(environment, "GITMUN_AI_REASONING", parse_reasoning);
        self.values.api_style =
            self.parse_value(environment, "GITMUN_AI_API_STYLE", parse_api_style);
        self.values.request_path = self.path_value(environment, "GITMUN_AI_REQUEST_PATH");
        self.values.models_path = self.path_value(environment, "GITMUN_AI_MODELS_PATH");
        self.values.auth_mode =
            self.parse_value(environment, "GITMUN_AI_AUTH_MODE", parse_auth_mode);
        self.values.auth_header = self.header_name_value(environment, "GITMUN_AI_AUTH_HEADER");
        self.values.max_tokens_field =
            self.json_field_value(environment, "GITMUN_AI_MAX_TOKENS_FIELD");
        self.values.extra_headers =
            self.extra_headers_value(environment, "GITMUN_AI_EXTRA_HEADERS_JSON");
        self.values.azure_deployment = self.string_value(environment, "GITMUN_AI_AZURE_DEPLOYMENT");
        self.values.azure_api_version =
            self.string_value(environment, "GITMUN_AI_AZURE_API_VERSION");
        self.values.openrouter_privacy = self.parse_value(
            environment,
            "GITMUN_AI_OPENROUTER_PRIVACY",
            parse_openrouter_privacy,
        );
        self.values.openrouter_allow_fallbacks = self.parse_value(
            environment,
            "GITMUN_AI_OPENROUTER_ALLOW_FALLBACKS",
            parse_bool,
        );
        self.values.openrouter_require_parameters = self.parse_value(
            environment,
            "GITMUN_AI_OPENROUTER_REQUIRE_PARAMETERS",
            parse_bool,
        );
        self.values.openrouter_max_prompt_price =
            self.price_value(environment, "GITMUN_AI_OPENROUTER_MAX_PROMPT_PRICE");
        self.values.openrouter_max_completion_price =
            self.price_value(environment, "GITMUN_AI_OPENROUTER_MAX_COMPLETION_PRICE");
        self.values.commit_context_limit_kib = self.parse_value(
            environment,
            "GITMUN_AI_COMMIT_CONTEXT_LIMIT_KIB",
            parse_context_limit,
        );
        self.values.conflict_context_limit_kib = self.parse_value(
            environment,
            "GITMUN_AI_CONFLICT_CONTEXT_LIMIT_KIB",
            parse_context_limit,
        );
        self.values.commit_max_tokens = self.parse_value(
            environment,
            "GITMUN_AI_COMMIT_MAX_TOKENS",
            parse_output_tokens,
        );
        self.values.conflict_max_tokens = self.parse_value(
            environment,
            "GITMUN_AI_CONFLICT_MAX_TOKENS",
            parse_output_tokens,
        );
        self.values.commit_prompt =
            self.prompt_file_value(environment, "GITMUN_AI_COMMIT_PROMPT_FILE");
        self.values.conflict_prompt =
            self.prompt_file_value(environment, "GITMUN_AI_CONFLICT_PROMPT_FILE");
        self.values.include_commit_history =
            self.parse_value(environment, "GITMUN_AI_INCLUDE_COMMIT_HISTORY", parse_bool);

        for (provider, variable) in [
            (AiProvider::OpenAi, "OPENAI_API_KEY"),
            (AiProvider::Claude, "ANTHROPIC_API_KEY"),
            (AiProvider::Bedrock, "AWS_BEARER_TOKEN_BEDROCK"),
            (AiProvider::Mistral, "MISTRAL_API_KEY"),
            (AiProvider::OpenRouter, "OPENROUTER_API_KEY"),
            (AiProvider::AzureOpenAi, "AZURE_OPENAI_API_KEY"),
        ] {
            if let Some(value) = environment.get(variable) {
                self.values
                    .standard_keys
                    .insert(provider, (variable.to_string(), value.trim().to_string()));
            }
        }
        let gemini_key = environment
            .get("GEMINI_API_KEY")
            .map(|value| ("GEMINI_API_KEY", value))
            .or_else(|| {
                environment
                    .get("GOOGLE_API_KEY")
                    .map(|value| ("GOOGLE_API_KEY", value))
            });
        if let Some((variable, value)) = gemini_key {
            self.values.standard_keys.insert(
                AiProvider::GoogleGemini,
                (variable.to_string(), value.trim().to_string()),
            );
        }
        let access_key_id = environment
            .get("AWS_ACCESS_KEY_ID")
            .map(|value| value.trim());
        let secret_access_key = environment
            .get("AWS_SECRET_ACCESS_KEY")
            .map(|value| value.trim());
        if let (Some(access_key_id), Some(secret_access_key)) = (access_key_id, secret_access_key) {
            if !access_key_id.is_empty() && !secret_access_key.is_empty() {
                self.values.bedrock_iam_credentials = Some(
                    serde_json::json!({
                        "accessKeyId": access_key_id,
                        "secretAccessKey": secret_access_key,
                        "sessionToken": environment.get("AWS_SESSION_TOKEN").map(|value| value.trim()),
                    })
                    .to_string(),
                );
            }
        }
        for (provider, variable) in [
            (AiProvider::OpenAi, "OPENAI_BASE_URL"),
            (AiProvider::Claude, "ANTHROPIC_BASE_URL"),
            (AiProvider::Bedrock, "AWS_BEDROCK_RUNTIME_ENDPOINT"),
            (AiProvider::Mistral, "MISTRAL_BASE_URL"),
            (AiProvider::OpenRouter, "OPENROUTER_BASE_URL"),
            (AiProvider::AzureOpenAi, "AZURE_OPENAI_ENDPOINT"),
        ] {
            if let Some(value) = environment.get(variable) {
                self.values
                    .standard_endpoints
                    .insert(provider, (variable.to_string(), value.trim().to_string()));
            }
        }
    }

    fn record_invalid(&mut self, variable: &str) {
        if self.invalid_variable.is_none() {
            self.invalid_variable = Some(variable.to_string());
        }
    }

    fn parse_value<T>(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
        parse: impl FnOnce(&str) -> Option<T>,
    ) -> Option<T> {
        let value = environment.get(variable)?;
        match parse(value.trim()) {
            Some(value) => Some(value),
            None => {
                self.record_invalid(variable);
                None
            }
        }
    }

    fn string_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        let value = environment.get(variable)?;
        let value = value.trim();
        if value.is_empty() {
            self.record_invalid(variable);
            None
        } else {
            Some(value.to_string())
        }
    }

    fn secret_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        self.string_value(environment, variable)
    }

    fn path_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        let value = self.string_value(environment, variable)?;
        if value.starts_with('/') && !value.contains(['?', '#']) {
            Some(value)
        } else {
            self.record_invalid(variable);
            None
        }
    }

    fn header_name_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        let value = self.string_value(environment, variable)?;
        if HeaderName::from_bytes(value.as_bytes()).is_ok() {
            Some(value)
        } else {
            self.record_invalid(variable);
            None
        }
    }

    fn json_field_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        let value = self.string_value(environment, variable)?;
        if value
            .chars()
            .all(|character| character == '_' || character.is_ascii_alphanumeric())
        {
            Some(value)
        } else {
            self.record_invalid(variable);
            None
        }
    }

    fn price_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        let value = self.string_value(environment, variable)?;
        if value.parse::<f64>().is_ok_and(|price| price >= 0.0) {
            Some(value)
        } else {
            self.record_invalid(variable);
            None
        }
    }

    fn extra_headers_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<BTreeMap<String, String>> {
        let raw = environment.get(variable)?;
        let parsed = serde_json::from_str::<BTreeMap<String, Value>>(raw);
        let Ok(values) = parsed else {
            self.record_invalid(variable);
            return None;
        };
        let mut headers = BTreeMap::new();
        for (name, value) in values {
            let lower = name.to_ascii_lowercase();
            let Some(value) = value.as_str() else {
                self.record_invalid(variable);
                return None;
            };
            if matches!(
                lower.as_str(),
                "authorization"
                    | "proxy-authorization"
                    | "cookie"
                    | "host"
                    | "content-length"
                    | "transfer-encoding"
            ) || HeaderName::from_bytes(name.as_bytes()).is_err()
                || HeaderValue::from_str(value).is_err()
            {
                self.record_invalid(variable);
                return None;
            }
            headers.insert(name, value.to_string());
        }
        Some(headers)
    }

    fn prompt_file_value(
        &mut self,
        environment: &BTreeMap<String, String>,
        variable: &str,
    ) -> Option<String> {
        let path = self.string_value(environment, variable)?;
        let metadata = std::fs::metadata(Path::new(&path));
        let value = metadata
            .ok()
            .filter(|metadata| metadata.is_file() && metadata.len() <= MAX_PROMPT_FILE_BYTES)
            .and_then(|_| std::fs::read_to_string(&path).ok())
            .filter(|prompt| !prompt.trim().is_empty());
        if value.is_none() {
            self.record_invalid(variable);
        }
        value
    }

    pub fn resolve(&self, settings: &Settings) -> Result<EffectiveAiConfiguration, AiError> {
        if let Some(variable) = &self.invalid_variable {
            return Err(AiError::with_detail("invalidEnvironment", variable.clone()));
        }
        let stored_ai = &settings.extensions.ai;
        let stored_profile = stored_ai.selected_profile();
        let stored_provider = stored_profile
            .map(|profile| profile.provider)
            .unwrap_or(AiProvider::Disabled);
        let provider = self.values.provider.unwrap_or(stored_provider);
        for values in [
            self.values.standard_keys.get(&provider),
            self.values.standard_endpoints.get(&provider),
        ]
        .into_iter()
        .flatten()
        {
            if values.1.is_empty() {
                return Err(AiError::with_detail("invalidEnvironment", values.0.clone()));
            }
        }
        let provider_matches_profile =
            stored_profile.is_some_and(|profile| profile.provider == provider);
        let preset = ProviderRegistry::preset(provider);
        let mut sources = BTreeMap::new();
        let mut environment_fields = Vec::new();

        let enabled = choose(
            "enabled",
            self.values.enabled,
            stored_ai.enabled,
            &mut sources,
            &mut environment_fields,
        );
        sources.insert(
            "provider".to_string(),
            if self.values.provider.is_some() {
                environment_fields.push("provider".to_string());
                AiConfigurationSource::Environment
            } else if stored_profile.is_some() {
                AiConfigurationSource::StoredProfile
            } else {
                AiConfigurationSource::ProviderDefault
            },
        );

        let standard_endpoint = self
            .values
            .standard_endpoints
            .get(&provider)
            .map(|(_, value)| value.clone());
        let endpoint_environment = self.values.endpoint.clone().or(standard_endpoint);
        let stored_endpoint = provider_matches_profile
            .then(|| stored_profile.map(|profile| profile.endpoint.trim().to_string()))
            .flatten()
            .filter(|endpoint| !endpoint.is_empty());
        let endpoint = choose_string(
            "endpoint",
            endpoint_environment,
            stored_endpoint,
            preset.endpoint,
            &mut sources,
            &mut environment_fields,
        );
        let stored_model = provider_matches_profile
            .then(|| stored_profile.map(|profile| profile.model.trim().to_string()))
            .flatten()
            .filter(|model| !model.is_empty());
        let model = choose_string(
            "model",
            self.values.model.clone(),
            stored_model,
            "",
            &mut sources,
            &mut environment_fields,
        );
        let fallback_profile = AiProfile::default();
        let profile = stored_profile.unwrap_or(&fallback_profile);
        let api_style = choose_profile_value(
            "apiStyle",
            self.values.api_style,
            provider_matches_profile.then_some(profile.api_style),
            preset.api_style,
            &mut sources,
            &mut environment_fields,
        );
        let request_path = choose_string(
            "requestPath",
            self.values.request_path.clone(),
            profile_string(provider_matches_profile, &profile.request_path),
            preset.request_path,
            &mut sources,
            &mut environment_fields,
        );
        let models_path = choose_string(
            "modelsPath",
            self.values.models_path.clone(),
            profile_string(provider_matches_profile, &profile.models_path),
            preset.models_path,
            &mut sources,
            &mut environment_fields,
        );
        let auth_mode = choose_profile_value(
            "authMode",
            self.values.auth_mode,
            provider_matches_profile.then_some(profile.auth_mode),
            preset.auth_mode,
            &mut sources,
            &mut environment_fields,
        );
        let auth_header = choose_string(
            "authHeader",
            self.values.auth_header.clone(),
            profile_string(provider_matches_profile, &profile.auth_header),
            preset.auth_header,
            &mut sources,
            &mut environment_fields,
        );
        let max_tokens_field = choose_string(
            "maxTokensField",
            self.values.max_tokens_field.clone(),
            profile_string(provider_matches_profile, &profile.max_tokens_field),
            preset.max_tokens_field,
            &mut sources,
            &mut environment_fields,
        );
        let extra_headers = choose_profile_value(
            "extraHeaders",
            self.values.extra_headers.clone(),
            provider_matches_profile.then(|| profile.extra_headers.clone()),
            BTreeMap::new(),
            &mut sources,
            &mut environment_fields,
        );
        let azure_deployment = choose_string(
            "azureDeployment",
            self.values.azure_deployment.clone(),
            profile_string(provider_matches_profile, &profile.azure_deployment),
            "",
            &mut sources,
            &mut environment_fields,
        );
        let azure_api_version = choose_string(
            "azureApiVersion",
            self.values.azure_api_version.clone(),
            profile_string(provider_matches_profile, &profile.azure_api_version),
            "2024-10-21",
            &mut sources,
            &mut environment_fields,
        );
        let reasoning_preference = choose_profile_value(
            "reasoningPreference",
            self.values.reasoning,
            provider_matches_profile.then_some(profile.reasoning_preference),
            AiReasoningPreference::Automatic,
            &mut sources,
            &mut environment_fields,
        );

        let mut open_router = if provider_matches_profile {
            profile.open_router.clone()
        } else {
            super::types::OpenRouterSettings::default()
        };
        apply_environment_value(
            "openRouterPrivacy",
            self.values.openrouter_privacy,
            &mut open_router.privacy,
            &mut sources,
            &mut environment_fields,
        );
        apply_environment_value(
            "openRouterAllowFallbacks",
            self.values.openrouter_allow_fallbacks,
            &mut open_router.allow_fallbacks,
            &mut sources,
            &mut environment_fields,
        );
        apply_environment_value(
            "openRouterRequireParameters",
            self.values.openrouter_require_parameters,
            &mut open_router.require_parameters,
            &mut sources,
            &mut environment_fields,
        );
        apply_environment_value(
            "openRouterMaxPromptPrice",
            self.values.openrouter_max_prompt_price.clone(),
            &mut open_router.max_prompt_price,
            &mut sources,
            &mut environment_fields,
        );
        apply_environment_value(
            "openRouterMaxCompletionPrice",
            self.values.openrouter_max_completion_price.clone(),
            &mut open_router.max_completion_price,
            &mut sources,
            &mut environment_fields,
        );

        Ok(EffectiveAiConfiguration {
            enabled,
            profile_id: stored_profile
                .map(|profile| profile.id.clone())
                .unwrap_or_else(|| "environment".to_string()),
            provider,
            endpoint,
            model,
            api_style,
            request_path,
            models_path,
            auth_mode,
            auth_header,
            max_tokens_field,
            extra_headers,
            azure_deployment,
            azure_api_version,
            reasoning_preference,
            effort_capability: if provider_matches_profile {
                profile.effort_capability.clone()
            } else {
                AiEffortCapability::Unknown
            },
            open_router,
            commit_context_limit_kib: choose(
                "commitContextLimitKib",
                self.values.commit_context_limit_kib,
                stored_ai.commit_context_limit_kib,
                &mut sources,
                &mut environment_fields,
            ),
            conflict_context_limit_kib: choose(
                "conflictContextLimitKib",
                self.values.conflict_context_limit_kib,
                stored_ai.conflict_context_limit_kib,
                &mut sources,
                &mut environment_fields,
            ),
            commit_message_max_tokens: choose(
                "commitMessageMaxTokens",
                self.values.commit_max_tokens,
                stored_ai.commit_message_max_tokens,
                &mut sources,
                &mut environment_fields,
            ),
            conflict_resolution_max_tokens: choose(
                "conflictResolutionMaxTokens",
                self.values.conflict_max_tokens,
                stored_ai.conflict_resolution_max_tokens,
                &mut sources,
                &mut environment_fields,
            ),
            commit_message_prompt: choose(
                "commitMessagePrompt",
                self.values.commit_prompt.clone(),
                stored_ai.commit_message_prompt.clone(),
                &mut sources,
                &mut environment_fields,
            ),
            conflict_resolution_prompt: choose(
                "conflictResolutionPrompt",
                self.values.conflict_prompt.clone(),
                stored_ai.conflict_resolution_prompt.clone(),
                &mut sources,
                &mut environment_fields,
            ),
            include_commit_history: choose(
                "includeCommitHistory",
                self.values.include_commit_history,
                stored_ai.include_commit_history,
                &mut sources,
                &mut environment_fields,
            ),
            global_exclusions: stored_ai.global_exclusions.clone(),
            sources,
            environment_fields,
            environment_api_key: self.api_key(provider, auth_mode).is_some(),
        })
    }

    pub fn api_key(&self, provider: AiProvider, auth_mode: AiAuthMode) -> Option<String> {
        if provider == AiProvider::Bedrock {
            return match auth_mode {
                AiAuthMode::AwsSigV4 => self
                    .values
                    .api_key
                    .clone()
                    .filter(|value| super::api::aws_sigv4::is_iam_credentials_json(value))
                    .or_else(|| self.values.bedrock_iam_credentials.clone()),
                AiAuthMode::Bearer => self
                    .values
                    .api_key
                    .clone()
                    .filter(|value| !super::api::aws_sigv4::is_iam_credentials_json(value))
                    .or_else(|| {
                        self.values
                            .standard_keys
                            .get(&provider)
                            .map(|(_, value)| value.clone())
                            .filter(|value| !super::api::aws_sigv4::is_iam_credentials_json(value))
                    }),
                AiAuthMode::Header | AiAuthMode::None => {
                    self.values.api_key.clone().or_else(|| {
                        self.values
                            .standard_keys
                            .get(&provider)
                            .map(|(_, value)| value.clone())
                    })
                }
            };
        }
        self.values.api_key.clone().or_else(|| {
            self.values
                .standard_keys
                .get(&provider)
                .map(|(_, value)| value.clone())
        })
    }
}

fn profile_string(matches: bool, value: &str) -> Option<String> {
    matches
        .then(|| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn choose<T: Clone>(
    field: &str,
    environment: Option<T>,
    stored: T,
    sources: &mut BTreeMap<String, AiConfigurationSource>,
    environment_fields: &mut Vec<String>,
) -> T {
    if let Some(value) = environment {
        sources.insert(field.to_string(), AiConfigurationSource::Environment);
        environment_fields.push(field.to_string());
        value
    } else {
        sources.insert(field.to_string(), AiConfigurationSource::StoredProfile);
        stored
    }
}

fn choose_profile_value<T: Clone>(
    field: &str,
    environment: Option<T>,
    stored: Option<T>,
    default: T,
    sources: &mut BTreeMap<String, AiConfigurationSource>,
    environment_fields: &mut Vec<String>,
) -> T {
    if let Some(value) = environment {
        sources.insert(field.to_string(), AiConfigurationSource::Environment);
        environment_fields.push(field.to_string());
        value
    } else if let Some(value) = stored {
        sources.insert(field.to_string(), AiConfigurationSource::StoredProfile);
        value
    } else {
        sources.insert(field.to_string(), AiConfigurationSource::ProviderDefault);
        default
    }
}

fn choose_string(
    field: &str,
    environment: Option<String>,
    stored: Option<String>,
    default: &str,
    sources: &mut BTreeMap<String, AiConfigurationSource>,
    environment_fields: &mut Vec<String>,
) -> String {
    choose_profile_value(
        field,
        environment,
        stored,
        default.to_string(),
        sources,
        environment_fields,
    )
}

fn apply_environment_value<T>(
    field: &str,
    environment: Option<T>,
    target: &mut T,
    sources: &mut BTreeMap<String, AiConfigurationSource>,
    environment_fields: &mut Vec<String>,
) {
    if let Some(value) = environment {
        *target = value;
        sources.insert(field.to_string(), AiConfigurationSource::Environment);
        environment_fields.push(field.to_string());
    }
}

pub(crate) fn validate_endpoint(endpoint: &str) -> Result<Url, AiError> {
    let url = Url::parse(endpoint.trim()).map_err(|_| AiError::new("endpointInvalid"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AiError::new("endpointSchemeInvalid"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AiError::new("endpointCredentialsForbidden"));
    }
    if url.query().is_some() || url.fragment().is_some() || url.host().is_none() {
        return Err(AiError::new("endpointInvalid"));
    }
    if url.scheme() == "http" && !is_loopback(&url) {
        return Err(AiError::new("insecureRemoteEndpoint"));
    }
    Ok(url)
}

pub(crate) fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn compact(value: &str) -> String {
    value
        .chars()
        .filter(|character| !matches!(character, '-' | '_' | ' '))
        .flat_map(char::to_lowercase)
        .collect()
}

fn parse_provider(value: &str) -> Option<AiProvider> {
    match compact(value).as_str() {
        "disabled" => Some(AiProvider::Disabled),
        "openai" => Some(AiProvider::OpenAi),
        "claude" | "anthropic" => Some(AiProvider::Claude),
        "bedrock" | "amazonbedrock" => Some(AiProvider::Bedrock),
        "mistral" => Some(AiProvider::Mistral),
        "googlegemini" | "gemini" => Some(AiProvider::GoogleGemini),
        "openrouter" => Some(AiProvider::OpenRouter),
        "azureopenai" | "azure" => Some(AiProvider::AzureOpenAi),
        "ollama" => Some(AiProvider::Ollama),
        "lmstudio" => Some(AiProvider::LmStudio),
        "openaicompatible" | "custom" => Some(AiProvider::OpenAiCompatible),
        _ => None,
    }
}

fn parse_reasoning(value: &str) -> Option<AiReasoningPreference> {
    match compact(value).as_str() {
        "automatic" | "auto" => Some(AiReasoningPreference::Automatic),
        "providerdefault" | "default" => Some(AiReasoningPreference::ProviderDefault),
        "low" => Some(AiReasoningPreference::Low),
        "medium" => Some(AiReasoningPreference::Medium),
        "high" => Some(AiReasoningPreference::High),
        _ => None,
    }
}

fn parse_api_style(value: &str) -> Option<AiApiStyle> {
    match compact(value).as_str() {
        "chatcompletions" | "chat" => Some(AiApiStyle::ChatCompletions),
        "responses" => Some(AiApiStyle::Responses),
        _ => None,
    }
}

fn parse_auth_mode(value: &str) -> Option<AiAuthMode> {
    match compact(value).as_str() {
        "bearer" => Some(AiAuthMode::Bearer),
        "header" | "apikey" => Some(AiAuthMode::Header),
        "awssigv4" | "sigv4" => Some(AiAuthMode::AwsSigV4),
        "none" => Some(AiAuthMode::None),
        _ => None,
    }
}

fn parse_openrouter_privacy(value: &str) -> Option<OpenRouterPrivacy> {
    match compact(value).as_str() {
        "nodatacollection" | "deny" => Some(OpenRouterPrivacy::NoDataCollection),
        "strictzdr" | "zdr" => Some(OpenRouterPrivacy::StrictZdr),
        "accountdefault" | "default" => Some(OpenRouterPrivacy::AccountDefault),
        _ => None,
    }
}

fn parse_context_limit(value: &str) -> Option<u32> {
    let parsed = value.parse::<u32>().ok()?;
    (super::types::normalise_context_limit(parsed) == parsed).then_some(parsed)
}

fn parse_output_tokens(value: &str) -> Option<u32> {
    let parsed = value.parse::<u32>().ok()?;
    (super::types::normalise_output_tokens(parsed) == parsed).then_some(parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overrides(values: &[(&str, &str)]) -> AiLaunchOverrides {
        AiLaunchOverrides::from_values(
            values
                .iter()
                .map(|(key, value)| (OsString::from(key), OsString::from(value))),
        )
    }

    #[test]
    fn explicit_values_override_standard_and_stored_values() {
        let mut settings = Settings::default();
        settings.extensions.ai.enabled = true;
        let profile = settings.extensions.ai.ensure_profile();
        profile.provider = AiProvider::OpenAi;
        profile.endpoint = "https://stored.example/v1".to_string();
        profile.model = "stored-model".to_string();
        let environment = overrides(&[
            ("GITMUN_AI_PROVIDER", "mistral"),
            ("GITMUN_AI_ENDPOINT", "https://override.example/v1"),
            ("GITMUN_AI_MODEL", "override-model"),
            ("MISTRAL_API_KEY", "standard-secret"),
            ("GITMUN_AI_API_KEY", "explicit-secret"),
        ]);

        let effective = environment.resolve(&settings).unwrap();

        assert_eq!(effective.provider, AiProvider::Mistral);
        assert_eq!(effective.endpoint, "https://override.example/v1");
        assert_eq!(effective.model, "override-model");
        assert_eq!(
            environment
                .api_key(effective.provider, effective.auth_mode)
                .as_deref(),
            Some("explicit-secret")
        );
    }

    #[test]
    fn standard_secret_is_used_only_for_selected_provider() {
        let mut settings = Settings::default();
        settings.extensions.ai.enabled = true;
        let profile = settings.extensions.ai.ensure_profile();
        profile.provider = AiProvider::Claude;
        let environment = overrides(&[("OPENAI_API_KEY", "openai-secret")]);

        let effective = environment.resolve(&settings).unwrap();

        assert_eq!(effective.provider, AiProvider::Claude);
        assert_eq!(
            environment.api_key(effective.provider, effective.auth_mode),
            None
        );
    }

    #[test]
    fn bedrock_iam_credentials_are_selected_for_sigv4_authentication() {
        let mut settings = Settings::default();
        settings.extensions.ai.enabled = true;
        let profile = settings.extensions.ai.ensure_profile();
        profile.provider = AiProvider::Bedrock;
        profile.auth_mode = AiAuthMode::AwsSigV4;
        let environment = overrides(&[
            ("AWS_ACCESS_KEY_ID", "access-key"),
            ("AWS_SECRET_ACCESS_KEY", "secret-key"),
            ("AWS_SESSION_TOKEN", "session-token"),
        ]);

        let effective = environment.resolve(&settings).unwrap();

        assert!(effective.environment_api_key);
        assert_eq!(
            environment
                .api_key(effective.provider, effective.auth_mode)
                .as_deref()
                .and_then(|credentials| serde_json::from_str::<Value>(credentials).ok())
                .and_then(|credentials| credentials
                    .get("accessKeyId")
                    .and_then(Value::as_str)
                    .map(str::to_string)),
            Some("access-key".to_string())
        );
    }

    #[test]
    fn bedrock_does_not_cross_wire_bearer_and_iam_environment_credentials() {
        let mut settings = Settings::default();
        settings.extensions.ai.enabled = true;
        let profile = settings.extensions.ai.ensure_profile();
        profile.provider = AiProvider::Bedrock;
        profile.auth_mode = AiAuthMode::Bearer;
        let environment = overrides(&[
            (
                "GITMUN_AI_API_KEY",
                r#"{"accessKeyId":"access-key","secretAccessKey":"secret-key"}"#,
            ),
            ("AWS_BEARER_TOKEN_BEDROCK", "bedrock-bearer"),
            ("AWS_ACCESS_KEY_ID", "access-key"),
            ("AWS_SECRET_ACCESS_KEY", "secret-key"),
        ]);

        let bearer = environment.resolve(&settings).unwrap();
        assert_eq!(
            environment
                .api_key(bearer.provider, AiAuthMode::Bearer)
                .as_deref(),
            Some("bedrock-bearer")
        );

        settings.extensions.ai.ensure_profile().auth_mode = AiAuthMode::AwsSigV4;
        let sigv4 = environment.resolve(&settings).unwrap();
        let credentials = environment
            .api_key(sigv4.provider, AiAuthMode::AwsSigV4)
            .unwrap();
        assert!(super::super::api::aws_sigv4::is_iam_credentials_json(
            &credentials
        ));
        assert!(!credentials.contains("bedrock-bearer"));
    }

    #[test]
    fn invalid_value_reports_only_its_variable_name() {
        let environment = overrides(&[("GITMUN_AI_ENABLED", "perhaps")]);
        let error = environment.resolve(&Settings::default()).unwrap_err();

        assert_eq!(error.code, "invalidEnvironment");
        assert_eq!(error.detail.as_deref(), Some("GITMUN_AI_ENABLED"));
    }

    #[test]
    fn remote_http_is_rejected_but_loopback_is_allowed() {
        assert!(validate_endpoint("http://127.0.0.1:11434/v1").is_ok());
        assert_eq!(
            validate_endpoint("http://example.test/v1")
                .unwrap_err()
                .code,
            "insecureRemoteEndpoint"
        );
    }
}
