use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::configuration::{EffectiveAiConfiguration, validate_endpoint};
use super::types::{
    AiApiStyle, AiAuthMode, AiEffortCapability, AiProvider, AiReasoningPreference,
    OpenRouterPrivacy, OpenRouterRoutingStrategy,
};
use super::{AiError, AiProviderResponseMetadata, AiUsage};

pub(crate) const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const CONFLICT_RESOLUTION_REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const MAX_OAUTH_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_MODELS_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MODEL_DISCOVERY_ATTEMPTS: usize = 3;
const OPENROUTER_CATALOGUE_PAGE_SIZE: usize = 1000;
const MAX_OPENROUTER_CATALOGUE_PAGES: usize = 16;
const MAX_AI_OPERATION_REQUESTS: usize = 64;
const MAX_AI_OPERATION_OUTBOUND_BYTES: usize = 2 * 1024 * 1024;
const OPENROUTER_APP_URL: &str = "https://gitmun.org";
const OPENROUTER_APP_TITLE: &str = "Gitmun";
const OPENROUTER_APP_CATEGORIES: &str = "programming-app";

#[derive(Clone, Copy)]
pub(crate) enum AiTask {
    ConnectionTest,
    CommitMessage,
    ConflictResolution,
}

impl AiTask {
    pub(crate) fn request_timeout(self) -> Duration {
        match self {
            Self::ConnectionTest => CONNECTION_TEST_TIMEOUT,
            Self::CommitMessage => REQUEST_TIMEOUT,
            Self::ConflictResolution => CONFLICT_RESOLUTION_REQUEST_TIMEOUT,
        }
    }
}

#[derive(Clone)]
pub(crate) struct AiRuntime {
    client: Client,
    structured_output_modes: Arc<Mutex<HashMap<String, AiStructuredOutputMode>>>,
}

impl AiRuntime {
    pub fn new() -> Result<Self, AiError> {
        let client = Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("gitmun-ai")
            .build()
            .map_err(|_| AiError::new("network"))?;
        Ok(Self {
            client,
            structured_output_modes: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub(crate) fn load_structured_output_modes(&self, modes: &HashMap<String, String>) {
        let mut cache = self
            .structured_output_modes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        cache.extend(
            modes
                .iter()
                .filter_map(|(key, mode)| Some((key.clone(), parse_structured_output_mode(mode)?))),
        );
    }

    pub(crate) fn forget_structured_output_mode(&self, key: &str) {
        self.structured_output_modes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(key);
    }

    pub(crate) fn structured_output_modes(&self) -> HashMap<String, String> {
        self.structured_output_modes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .map(|(key, mode)| (key.clone(), structured_output_mode_name(*mode).to_string()))
            .collect()
    }

    fn structured_output_mode(
        &self,
        configuration: &EffectiveAiConfiguration,
    ) -> Option<AiStructuredOutputMode> {
        let key = structured_output_cache_key(configuration).ok()?;
        self.structured_output_modes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&key)
            .copied()
    }

    fn remember_structured_output_mode(
        &self,
        configuration: &EffectiveAiConfiguration,
        mode: AiStructuredOutputMode,
    ) {
        let Ok(key) = structured_output_cache_key(configuration) else {
            return;
        };
        self.structured_output_modes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(key, mode);
    }
}

fn parse_structured_output_mode(value: &str) -> Option<AiStructuredOutputMode> {
    match value {
        "jsonSchema" => Some(AiStructuredOutputMode::JsonSchema),
        "jsonObject" => Some(AiStructuredOutputMode::JsonObject),
        "promptOnly" => Some(AiStructuredOutputMode::PromptOnly),
        _ => None,
    }
}

fn structured_output_mode_name(mode: AiStructuredOutputMode) -> &'static str {
    match mode {
        AiStructuredOutputMode::JsonSchema => "jsonSchema",
        AiStructuredOutputMode::JsonObject => "jsonObject",
        AiStructuredOutputMode::PromptOnly => "promptOnly",
    }
}

#[derive(Debug, Clone)]
pub(crate) enum AiOutputContract {
    Text,
    JsonSchema { name: &'static str, schema: Value },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AiStructuredOutputMode {
    JsonSchema,
    JsonObject,
    PromptOnly,
}

impl AiStructuredOutputMode {
    fn fallback(self, adapter: &dyn ProtocolAdapter) -> Option<Self> {
        match self {
            Self::JsonSchema if adapter.supports_json_object() => Some(Self::JsonObject),
            Self::JsonSchema | Self::JsonObject => Some(Self::PromptOnly),
            Self::PromptOnly => None,
        }
    }
}

pub(crate) struct AiRequestBudget {
    requests: usize,
    outbound_bytes: usize,
}

impl AiRequestBudget {
    pub(crate) fn new() -> Self {
        Self {
            requests: 0,
            outbound_bytes: 0,
        }
    }

    fn charge(&mut self, body: &Value) -> Result<(), AiError> {
        self.requests += 1;
        self.outbound_bytes = self
            .outbound_bytes
            .saturating_add(serde_json::to_vec(body).map_or(usize::MAX, |body| body.len()));
        if self.requests > MAX_AI_OPERATION_REQUESTS
            || self.outbound_bytes > MAX_AI_OPERATION_OUTBOUND_BYTES
        {
            return Err(AiError::new("operationBudgetExceeded"));
        }
        Ok(())
    }
}

pub(crate) async fn exchange_openrouter_oauth_code(
    runtime: &AiRuntime,
    code: &str,
    code_verifier: &str,
) -> Result<String, AiError> {
    let response = runtime
        .client
        .post("https://openrouter.ai/api/v1/auth/keys")
        .header("HTTP-Referer", OPENROUTER_APP_URL)
        .header("X-OpenRouter-Title", OPENROUTER_APP_TITLE)
        .header("X-OpenRouter-Categories", OPENROUTER_APP_CATEGORIES)
        .json(&json!({
            "code": code,
            "code_verifier": code_verifier,
            "code_challenge_method": "S256",
        }))
        .send()
        .await
        .map_err(network_error)?;
    let (status, _, body) = read_response(response, MAX_OAUTH_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(AiError::with_detail(
            "openRouterOAuthFailed",
            status.as_u16().to_string(),
        ));
    }
    parse_openrouter_oauth_exchange(&body)
}

fn parse_openrouter_oauth_exchange(body: &[u8]) -> Result<String, AiError> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("key").and_then(Value::as_str).map(str::to_string))
        .filter(|key| {
            !key.trim().is_empty() && key.len() <= 1024 && !key.chars().any(char::is_control)
        })
        .ok_or_else(|| AiError::new("invalidResponse"))
}

pub(crate) struct ProviderResult {
    pub(crate) text: String,
    pub(crate) usage: AiUsage,
    pub(crate) request_id: Option<String>,
    pub(crate) generation_id: Option<String>,
    pub(crate) routed_provider: Option<String>,
    pub(crate) routed_model: Option<String>,
    pub(crate) output_truncated: bool,
    pub(crate) finish_reason: Option<String>,
    pub(crate) response_bytes: usize,
}

impl ProviderResult {
    pub(crate) fn metadata(&self) -> AiProviderResponseMetadata {
        AiProviderResponseMetadata {
            usage: self.usage.clone(),
            request_id: self.request_id.clone(),
            generation_id: self.generation_id.clone(),
            routed_provider: self.routed_provider.clone(),
            routed_model: self.routed_model.clone(),
            finish_reason: self.finish_reason.clone(),
            response_bytes: self.response_bytes,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AiModelQuery {
    pub search: String,
    pub page: u32,
    pub page_size: u32,
    pub programming_only: bool,
    pub author: String,
    pub hosting_provider: String,
    pub minimum_context_length: Option<u64>,
    pub maximum_prompt_price: Option<f64>,
    pub maximum_completion_price: Option<f64>,
    pub zdr_only: bool,
    pub sort: AiModelSort,
}

#[derive(Debug, Clone, Copy, Default, Deserialize)]
pub enum AiModelSort {
    #[default]
    Popularity,
    PromptPrice,
    CompletionPrice,
    Context,
    Latency,
    Throughput,
    CodingScore,
    Newest,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub id: String,
    pub canonical_slug: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub context_length: Option<u64>,
    pub maximum_completion_tokens: Option<u64>,
    pub input_modalities: Vec<String>,
    pub output_modalities: Vec<String>,
    pub supported_parameters: Vec<String>,
    pub prompt_price: Option<String>,
    pub completion_price: Option<String>,
    pub request_price: Option<String>,
    pub cache_read_price: Option<String>,
    pub cache_write_price: Option<String>,
    pub reasoning: bool,
    pub structured_output: bool,
    pub available_providers: Vec<String>,
    pub quantisations: Vec<String>,
    pub latency: Option<f64>,
    pub throughput: Option<f64>,
    pub uptime: Option<f64>,
    pub coding_score: Option<f64>,
    pub zero_data_retention: Option<bool>,
    pub created: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelPage {
    pub models: Vec<AiModelInfo>,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
}

trait ProtocolAdapter: Send + Sync {
    fn request_body(
        &self,
        configuration: &EffectiveAiConfiguration,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: u32,
        effort: Option<&str>,
        output_contract: &AiOutputContract,
        structured_output_mode: Option<AiStructuredOutputMode>,
    ) -> Value;

    fn parse_response(
        &self,
        value: Value,
        request_id: Option<String>,
        provider_extension: Option<&dyn OpenAiProviderExtension>,
    ) -> Result<ProviderResult, AiError>;

    fn add_protocol_headers(&self, request: RequestBuilder) -> RequestBuilder {
        request
    }

    fn supports_json_object(&self) -> bool {
        false
    }
}

trait OpenAiProviderExtension: Send + Sync {
    fn add_headers(&self, request: RequestBuilder) -> RequestBuilder;
    fn extend_request(
        &self,
        configuration: &EffectiveAiConfiguration,
        body: &mut Map<String, Value>,
    );
    fn extend_result(&self, value: &Value, result: &mut ProviderResult);
    fn normalise_model(&self, value: &Value) -> Option<AiModelInfo>;
}

struct OpenAiAdapter;
struct ClaudeAdapter;
struct OpenRouterExtension;

static OPEN_AI_ADAPTER: OpenAiAdapter = OpenAiAdapter;
static CLAUDE_ADAPTER: ClaudeAdapter = ClaudeAdapter;
static OPENROUTER_EXTENSION: OpenRouterExtension = OpenRouterExtension;

fn adapter_for(
    configuration: &EffectiveAiConfiguration,
) -> Result<&'static dyn ProtocolAdapter, AiError> {
    match configuration.provider {
        AiProvider::Disabled => Err(AiError::new("notConfigured")),
        AiProvider::Claude => Ok(&CLAUDE_ADAPTER),
        _ if configuration.provider.is_openai_compatible() => Ok(&OPEN_AI_ADAPTER),
        _ => Err(AiError::new("notConfigured")),
    }
}

fn extension_for(provider: AiProvider) -> Option<&'static dyn OpenAiProviderExtension> {
    (provider == AiProvider::OpenRouter)
        .then_some(&OPENROUTER_EXTENSION as &dyn OpenAiProviderExtension)
}

impl ProtocolAdapter for OpenAiAdapter {
    fn request_body(
        &self,
        configuration: &EffectiveAiConfiguration,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: u32,
        effort: Option<&str>,
        output_contract: &AiOutputContract,
        structured_output_mode: Option<AiStructuredOutputMode>,
    ) -> Value {
        let mut body = match configuration.api_style {
            AiApiStyle::ChatCompletions => json!({
                "model": configuration.model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ]
            }),
            AiApiStyle::Responses => json!({
                "model": configuration.model,
                "instructions": system_prompt,
                "input": user_prompt
            }),
        };
        body[&configuration.max_tokens_field] = json!(max_tokens);
        if let Some(effort) = effort {
            body["reasoning_effort"] = json!(effort);
        }
        if let (AiOutputContract::JsonSchema { name, schema }, Some(structured_output_mode)) =
            (output_contract, structured_output_mode)
        {
            let format = match structured_output_mode {
                AiStructuredOutputMode::JsonSchema => Some(json!({
                    "type": "json_schema",
                    "name": name,
                    "strict": true,
                    "schema": schema,
                })),
                AiStructuredOutputMode::JsonObject => Some(json!({"type": "json_object"})),
                AiStructuredOutputMode::PromptOnly => None,
            };
            if let Some(format) = format {
                match configuration.api_style {
                    AiApiStyle::ChatCompletions => {
                        body["response_format"] =
                            if structured_output_mode == AiStructuredOutputMode::JsonSchema {
                                json!({
                                    "type": "json_schema",
                                    "json_schema": {
                                        "name": name,
                                        "strict": true,
                                        "schema": schema,
                                    }
                                })
                            } else {
                                format
                            };
                    }
                    AiApiStyle::Responses => body["text"] = json!({"format": format}),
                }
            }
        }
        if let (Some(extension), Some(object)) =
            (extension_for(configuration.provider), body.as_object_mut())
        {
            extension.extend_request(configuration, object);
        }
        body
    }

    fn parse_response(
        &self,
        value: Value,
        request_id: Option<String>,
        provider_extension: Option<&dyn OpenAiProviderExtension>,
    ) -> Result<ProviderResult, AiError> {
        let finish_reason = value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str);
        let text = if value.get("choices").is_some() {
            value
                .pointer("/choices/0/message/content")
                .and_then(response_text)
        } else {
            value
                .get("output_text")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| responses_output_text(&value))
        }
        .ok_or_else(|| AiError::new("invalidResponse"))?;
        let mut result = ProviderResult {
            text,
            usage: AiUsage {
                input_tokens: value
                    .pointer("/usage/prompt_tokens")
                    .or_else(|| value.pointer("/usage/input_tokens"))
                    .and_then(Value::as_u64),
                output_tokens: value
                    .pointer("/usage/completion_tokens")
                    .or_else(|| value.pointer("/usage/output_tokens"))
                    .and_then(Value::as_u64),
                reasoning_tokens: value
                    .pointer("/usage/completion_tokens_details/reasoning_tokens")
                    .or_else(|| value.pointer("/usage/output_tokens_details/reasoning_tokens"))
                    .and_then(Value::as_u64),
                cached_tokens: value
                    .pointer("/usage/prompt_tokens_details/cached_tokens")
                    .or_else(|| value.pointer("/usage/input_tokens_details/cached_tokens"))
                    .and_then(Value::as_u64),
                cost: None,
                byok: None,
            },
            request_id,
            generation_id: value.get("id").and_then(Value::as_str).map(str::to_string),
            routed_provider: None,
            routed_model: None,
            output_truncated: matches!(finish_reason, Some("length"))
                || value.get("status").and_then(Value::as_str) == Some("incomplete"),
            finish_reason: finish_reason
                .or_else(|| value.get("status").and_then(Value::as_str))
                .map(str::to_string),
            response_bytes: 0,
        };
        if let Some(extension) = provider_extension {
            extension.extend_result(&value, &mut result);
        }
        Ok(result)
    }

    fn supports_json_object(&self) -> bool {
        true
    }
}

impl ProtocolAdapter for ClaudeAdapter {
    fn request_body(
        &self,
        configuration: &EffectiveAiConfiguration,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: u32,
        effort: Option<&str>,
        output_contract: &AiOutputContract,
        structured_output_mode: Option<AiStructuredOutputMode>,
    ) -> Value {
        let mut body = json!({
            "model": configuration.model,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
            "max_tokens": max_tokens
        });
        let mut output_config = Map::new();
        if let Some(effort) = effort {
            output_config.insert("effort".to_string(), json!(effort));
        }
        if let (
            AiOutputContract::JsonSchema { schema, .. },
            Some(AiStructuredOutputMode::JsonSchema),
        ) = (output_contract, structured_output_mode)
        {
            output_config.insert(
                "format".to_string(),
                json!({"type": "json_schema", "schema": schema}),
            );
        }
        if !output_config.is_empty() {
            body["output_config"] = Value::Object(output_config);
        }
        body
    }

    fn parse_response(
        &self,
        value: Value,
        request_id: Option<String>,
        _provider_extension: Option<&dyn OpenAiProviderExtension>,
    ) -> Result<ProviderResult, AiError> {
        let text = value
            .get("content")
            .and_then(response_text)
            .ok_or_else(|| AiError::new("invalidResponse"))?;
        Ok(ProviderResult {
            text,
            usage: AiUsage {
                input_tokens: value.pointer("/usage/input_tokens").and_then(Value::as_u64),
                output_tokens: value
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64),
                reasoning_tokens: None,
                cached_tokens: value
                    .pointer("/usage/cache_read_input_tokens")
                    .and_then(Value::as_u64),
                cost: None,
                byok: None,
            },
            request_id,
            generation_id: value.get("id").and_then(Value::as_str).map(str::to_string),
            routed_provider: None,
            routed_model: value
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_string),
            output_truncated: value.get("stop_reason").and_then(Value::as_str)
                == Some("max_tokens"),
            finish_reason: value
                .get("stop_reason")
                .and_then(Value::as_str)
                .map(str::to_string),
            response_bytes: 0,
        })
    }

    fn add_protocol_headers(&self, request: RequestBuilder) -> RequestBuilder {
        request.header("anthropic-version", "2023-06-01")
    }
}

impl OpenAiProviderExtension for OpenRouterExtension {
    fn add_headers(&self, request: RequestBuilder) -> RequestBuilder {
        request
            .header("HTTP-Referer", OPENROUTER_APP_URL)
            .header("X-OpenRouter-Title", OPENROUTER_APP_TITLE)
            .header("X-OpenRouter-Categories", OPENROUTER_APP_CATEGORIES)
    }

    fn extend_request(
        &self,
        configuration: &EffectiveAiConfiguration,
        body: &mut Map<String, Value>,
    ) {
        let settings = &configuration.open_router;
        let mut provider = Map::new();
        provider.insert(
            "allow_fallbacks".to_string(),
            json!(settings.allow_fallbacks),
        );
        provider.insert(
            "require_parameters".to_string(),
            json!(settings.require_parameters),
        );
        match settings.privacy {
            OpenRouterPrivacy::NoDataCollection => {
                provider.insert("data_collection".to_string(), json!("deny"));
            }
            OpenRouterPrivacy::StrictZdr => {
                provider.insert("data_collection".to_string(), json!("deny"));
                provider.insert("zdr".to_string(), json!(true));
            }
            OpenRouterPrivacy::AccountDefault => {}
        }
        let sort = match settings.routing_strategy {
            OpenRouterRoutingStrategy::Default => None,
            OpenRouterRoutingStrategy::Price => Some("price"),
            OpenRouterRoutingStrategy::Latency => Some("latency"),
            OpenRouterRoutingStrategy::Throughput => Some("throughput"),
        };
        if let Some(sort) = sort {
            provider.insert("sort".to_string(), json!(sort));
        }
        let mut maximum_price = Map::new();
        if let Ok(price) = settings.max_prompt_price.parse::<f64>() {
            maximum_price.insert("prompt".to_string(), json!(price));
        }
        if let Ok(price) = settings.max_completion_price.parse::<f64>() {
            maximum_price.insert("completion".to_string(), json!(price));
        }
        if !maximum_price.is_empty() {
            provider.insert("max_price".to_string(), Value::Object(maximum_price));
        }
        if !settings.preferred_providers.is_empty() {
            provider.insert("order".to_string(), json!(settings.preferred_providers));
        }
        if !settings.allowed_providers.is_empty() {
            provider.insert("only".to_string(), json!(settings.allowed_providers));
        }
        if !settings.ignored_providers.is_empty() {
            provider.insert("ignore".to_string(), json!(settings.ignored_providers));
        }
        if let Ok(latency) = settings.preferred_max_latency.parse::<f64>() {
            provider.insert("preferred_max_latency".to_string(), json!(latency));
        }
        if let Ok(throughput) = settings.preferred_min_throughput.parse::<f64>() {
            provider.insert("preferred_min_throughput".to_string(), json!(throughput));
        }
        body.insert("provider".to_string(), Value::Object(provider));
    }

    fn extend_result(&self, value: &Value, result: &mut ProviderResult) {
        result.usage.cost = value.pointer("/usage/cost").and_then(Value::as_f64);
        result.usage.byok = value
            .pointer("/usage/is_byok")
            .or_else(|| value.pointer("/usage/byok"))
            .and_then(Value::as_bool);
        result.routed_provider = value
            .get("provider")
            .or_else(|| value.pointer("/usage/provider"))
            .and_then(Value::as_str)
            .map(str::to_string);
        result.routed_model = value
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string);
    }

    fn normalise_model(&self, value: &Value) -> Option<AiModelInfo> {
        let id = value.get("id")?.as_str()?.to_string();
        let parameters = string_array(value.get("supported_parameters"));
        let available_providers = string_array(value.get("available_providers"))
            .into_iter()
            .chain(
                value
                    .get("endpoints")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|endpoint| endpoint.get("provider_name").and_then(Value::as_str))
                    .map(str::to_string),
            )
            .collect::<Vec<_>>();
        let quantisations = string_array(value.get("quantizations"))
            .into_iter()
            .chain(string_array(value.get("quantisations")))
            .collect();
        Some(AiModelInfo {
            name: value
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string(),
            id,
            canonical_slug: value
                .get("canonical_slug")
                .and_then(Value::as_str)
                .map(str::to_string),
            description: value
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            context_length: value.get("context_length").and_then(Value::as_u64),
            maximum_completion_tokens: value
                .pointer("/top_provider/max_completion_tokens")
                .or_else(|| value.get("max_completion_tokens"))
                .and_then(Value::as_u64),
            input_modalities: string_array(value.pointer("/architecture/input_modalities")),
            output_modalities: string_array(value.pointer("/architecture/output_modalities")),
            reasoning: parameters.iter().any(|parameter| parameter == "reasoning"),
            structured_output: parameters.iter().any(|parameter| {
                matches!(parameter.as_str(), "response_format" | "structured_outputs")
            }),
            supported_parameters: parameters,
            prompt_price: string_number(value.pointer("/pricing/prompt")),
            completion_price: string_number(value.pointer("/pricing/completion")),
            request_price: string_number(value.pointer("/pricing/request")),
            cache_read_price: string_number(value.pointer("/pricing/input_cache_read")),
            cache_write_price: string_number(value.pointer("/pricing/input_cache_write")),
            available_providers,
            quantisations,
            latency: first_f64(value, &["/performance/latency", "/latency"])
                .map(|milliseconds| milliseconds / 1000.0),
            throughput: first_f64(value, &["/performance/throughput", "/throughput"]),
            uptime: first_f64(value, &["/performance/uptime", "/uptime"]),
            coding_score: first_f64(value, &["/performance/coding_score", "/coding_score"]),
            zero_data_retention: value
                .get("zdr")
                .or_else(|| value.get("zero_data_retention"))
                .and_then(Value::as_bool),
            created: value.get("created").and_then(Value::as_u64),
        })
    }
}

fn response_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let text = items
                .iter()
                .filter_map(|item| {
                    item.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| item.get("content").and_then(Value::as_str))
                })
                .collect::<Vec<_>>()
                .join("");
            (!text.is_empty()).then_some(text)
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::Object(_) => None,
    }
}

fn responses_output_text(value: &Value) -> Option<String> {
    let text = value
        .get("output")?
        .as_array()?
        .iter()
        .filter_map(|item| item.get("content").and_then(Value::as_array))
        .flatten()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("output_text"))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("");
    (!text.is_empty()).then_some(text)
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

fn string_number(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

fn first_f64(value: &Value, pointers: &[&str]) -> Option<f64> {
    pointers.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
    })
}

fn endpoint_with_path(
    configuration: &EffectiveAiConfiguration,
    path: &str,
) -> Result<Url, AiError> {
    let mut endpoint = validate_endpoint(&configuration.endpoint)?;
    let path = path.replace("{deployment}", &configuration.azure_deployment);
    if path.contains('{') || path.contains('}') {
        return Err(AiError::new("deploymentRequired"));
    }
    let mut segments = endpoint
        .path_segments_mut()
        .map_err(|_| AiError::new("endpointInvalid"))?;
    segments.pop_if_empty();
    for segment in path.trim_matches('/').split('/') {
        if !segment.is_empty() {
            segments.push(segment);
        }
    }
    drop(segments);
    if configuration.provider == AiProvider::AzureOpenAi {
        if configuration.azure_deployment.trim().is_empty() {
            return Err(AiError::new("deploymentRequired"));
        }
        endpoint
            .query_pairs_mut()
            .append_pair("api-version", &configuration.azure_api_version);
    }
    Ok(endpoint)
}

pub(crate) fn structured_output_cache_key(
    configuration: &EffectiveAiConfiguration,
) -> Result<String, AiError> {
    Ok(format!(
        "{:?}\0{}\0{:?}\0{}",
        configuration.provider,
        endpoint_with_path(configuration, &configuration.request_path)?,
        configuration.api_style,
        configuration.model,
    ))
}

pub(crate) fn api_key_optional(configuration: &EffectiveAiConfiguration) -> bool {
    configuration
        .provider
        .api_key_optional(configuration.endpoint_is_loopback())
        || configuration.auth_mode == AiAuthMode::None
}

fn authenticate(
    request: RequestBuilder,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
) -> Result<RequestBuilder, AiError> {
    let mut request = match configuration.auth_mode {
        AiAuthMode::Bearer if !api_key.is_empty() => request.bearer_auth(api_key),
        AiAuthMode::Header if !api_key.is_empty() => {
            let name = HeaderName::from_bytes(configuration.auth_header.as_bytes())
                .map_err(|_| AiError::new("authHeaderInvalid"))?;
            let value =
                HeaderValue::from_str(api_key).map_err(|_| AiError::new("apiKeyInvalid"))?;
            request.header(name, value)
        }
        AiAuthMode::Bearer | AiAuthMode::Header | AiAuthMode::None => request,
    };
    for (name, value) in &configuration.extra_headers {
        request = request.header(name, value);
    }
    Ok(request)
}

fn effort_for(configuration: &EffectiveAiConfiguration, task: AiTask) -> Option<&'static str> {
    let effort = match configuration.reasoning_preference {
        AiReasoningPreference::ProviderDefault => None,
        AiReasoningPreference::Low => Some("low"),
        AiReasoningPreference::Medium => Some("medium"),
        AiReasoningPreference::High => Some("high"),
        AiReasoningPreference::Automatic => Some(match task {
            AiTask::ConflictResolution => "medium",
            AiTask::ConnectionTest | AiTask::CommitMessage => "low",
        }),
    };
    if configuration.reasoning_preference != AiReasoningPreference::Automatic {
        return effort;
    }
    match &configuration.effort_capability {
        AiEffortCapability::Unsupported => None,
        AiEffortCapability::Supported(levels) => effort.filter(|effort| {
            levels.iter().any(|level| {
                matches!(
                    (level, *effort),
                    (&AiReasoningPreference::Low, "low")
                        | (&AiReasoningPreference::Medium, "medium")
                        | (&AiReasoningPreference::High, "high")
                )
            })
        }),
        AiEffortCapability::Unknown | AiEffortCapability::Accepted => effort,
    }
}

async fn read_response(
    response: Response,
    maximum_bytes: usize,
) -> Result<(StatusCode, HeaderMap, Vec<u8>), AiError> {
    let status = response.status();
    let headers = response.headers().clone();
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err(AiError::new("responseTooLarge"));
    }
    let mut response = response;
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network_error)? {
        if body.len() + chunk.len() > maximum_bytes {
            return Err(AiError::new("responseTooLarge"));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((status, headers, body))
}

fn network_error(error: reqwest::Error) -> AiError {
    if error.is_timeout() {
        AiError::new("timeout")
    } else if error.is_redirect() {
        AiError::new("unsafeRedirect")
    } else {
        AiError::new("network")
    }
}

fn rejected_effort(status: StatusCode, body: &[u8]) -> bool {
    status == StatusCode::BAD_REQUEST
        && String::from_utf8_lossy(body)
            .to_ascii_lowercase()
            .contains("effort")
}

fn rejected_structured_output(
    status: StatusCode,
    body: &[u8],
    mode: Option<AiStructuredOutputMode>,
) -> bool {
    if !matches!(status.as_u16(), 400 | 422)
        || !matches!(
            mode,
            Some(AiStructuredOutputMode::JsonSchema | AiStructuredOutputMode::JsonObject)
        )
    {
        return false;
    }

    let body_str = String::from_utf8_lossy(body);
    let lower = body_str.to_ascii_lowercase();

    // Guard against false positives from deprecation or sunset notices
    if lower.contains("deprecated")
        && lower.contains("response_format")
        && !lower.contains("not")
        && !lower.contains("invalid")
        && !lower.contains("unrecogni")
    {
        return false;
    }

    // Structured JSON detection: many providers return typed error objects
    if let Ok(value) = serde_json::from_slice::<Value>(body) {
        if let Some(error) = value.get("error") {
            // OpenAI / OpenAI-compatible: response_format param set → clear signal
            if let Some(param) = error.get("param").and_then(|v| v.as_str()) {
                if matches!(
                    param.to_ascii_lowercase().as_str(),
                    "response_format" | "output_config"
                ) {
                    return true;
                }
            }
            // Check message for combined format + rejection keywords
            if let Some(msg) = error.get("message").and_then(|v| v.as_str()) {
                let msg_lower = msg.to_ascii_lowercase();
                // Deprecation warnings are not active rejections
                if msg_lower.contains("deprecated") || msg_lower.contains("sunset") {
                    return false;
                }
                let type_lower = error
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if matches!(
                    type_lower.as_str(),
                    "invalid_request_error" | "validation_error"
                ) {
                    let has_format = msg_lower.contains("response_format")
                        || msg_lower.contains("json_schema")
                        || msg_lower.contains("structured_output")
                        || msg_lower.contains("structured output")
                        || msg_lower.contains("text.format")
                        || msg_lower.contains("output_config.format")
                        || msg_lower.contains("output_config");
                    let has_rejection = msg_lower.contains("unsupported")
                        || msg_lower.contains("not supported")
                        || msg_lower.contains("unknown parameter")
                        || msg_lower.contains("unrecogni")
                        || msg_lower.contains("invalid")
                        || msg_lower.contains("must be")
                        || msg_lower.contains("not allowed")
                        || msg_lower.contains("not permitted")
                        || msg_lower.contains("extra inputs")
                        || msg_lower.contains("not valid")
                        || msg_lower.contains("bad value")
                        || msg_lower.contains("wrong type");
                    if has_format && has_rejection {
                        return true;
                    }
                }
                // If we have structured JSON with a message but no match, fall through
            }
        }
    }

    // Heuristic fallback: keyword matching across the full body
    let identifies_format = [
        "response_format",
        "json_schema",
        "structured_output",
        "structured output",
        "text.format",
        "output_config.format",
        "output_config",
        "format.",
        "format type",
    ]
    .iter()
    .any(|field| lower.contains(field));
    let identifies_rejection = [
        "unsupported",
        "not supported",
        "unknown parameter",
        "unknown",
        "unrecognized",
        "unrecognised",
        "invalid parameter",
        "invalid value",
        "must be",
        "not allowed",
        "not permitted",
        "extra inputs",
        "not valid",
        "bad value",
        "wrong type",
    ]
    .iter()
    .any(|reason| lower.contains(reason));
    identifies_format && (identifies_rejection || status == StatusCode::UNPROCESSABLE_ENTITY)
}

fn response_error(status: StatusCode) -> AiError {
    match status.as_u16() {
        401 | 403 => AiError::new("authentication"),
        408 | 429 => AiError::with_detail("providerUnavailable", status.as_u16().to_string()),
        300..=399 => AiError::new("unsafeRedirect"),
        400..=499 => AiError::with_detail("requestRejected", status.as_u16().to_string()),
        _ => AiError::with_detail("providerUnavailable", status.as_u16().to_string()),
    }
}

fn provider_response_error(
    configuration: &EffectiveAiConfiguration,
    status: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> AiError {
    let mut error = response_error(status);
    if configuration.provider != AiProvider::OpenRouter || !configuration.open_router.diagnostics {
        return error;
    }
    let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
    let mut diagnostics = vec![format!("status={}", status.as_u16())];
    for (label, value) in [
        (
            "request",
            headers
                .get("x-request-id")
                .or_else(|| headers.get("request-id"))
                .and_then(|value| value.to_str().ok()),
        ),
        (
            "generation",
            value
                .pointer("/error/metadata/generation_id")
                .and_then(Value::as_str),
        ),
        (
            "provider",
            value
                .pointer("/error/metadata/provider_name")
                .or_else(|| value.pointer("/error/metadata/provider"))
                .and_then(Value::as_str),
        ),
    ] {
        if let Some(value) = value.and_then(redacted_diagnostic_value) {
            diagnostics.push(format!("{label}={value}"));
        }
    }
    if let Some(attempts) = value
        .pointer("/error/metadata/provider_attempts")
        .and_then(Value::as_array)
    {
        let attempts = attempts
            .iter()
            .take(8)
            .filter_map(|attempt| {
                attempt
                    .get("provider")
                    .or_else(|| attempt.get("provider_name"))
                    .and_then(Value::as_str)
                    .and_then(redacted_diagnostic_value)
            })
            .collect::<Vec<_>>();
        if !attempts.is_empty() {
            diagnostics.push(format!("attempts={}", attempts.join(",")));
        }
    }
    error.detail = Some(diagnostics.join("; "));
    error
}

fn redacted_diagnostic_value(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | ':')
        }))
    .then(|| value.to_string())
}

enum ProviderAttempt {
    Completed(ProviderResult),
    EffortRejected,
    StructuredOutputRejected,
}

async fn send_provider_request(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u32,
    effort: Option<&str>,
    task: AiTask,
    output_contract: &AiOutputContract,
    structured_output_mode: Option<AiStructuredOutputMode>,
    budget: &mut AiRequestBudget,
    cancellation: Option<CancellationToken>,
) -> Result<ProviderAttempt, AiError> {
    let adapter = adapter_for(configuration)?;
    let endpoint = endpoint_with_path(configuration, &configuration.request_path)?;
    let body = adapter.request_body(
        configuration,
        system_prompt,
        user_prompt,
        max_tokens,
        effort,
        output_contract,
        structured_output_mode,
    );
    budget.charge(&body)?;
    let request = runtime
        .client
        .post(endpoint)
        .timeout(task.request_timeout())
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    let request = adapter.add_protocol_headers(request);
    let request = if let Some(extension) = extension_for(configuration.provider) {
        extension.add_headers(request)
    } else {
        request
    };
    let request = authenticate(request, configuration, api_key)?.json(&body);
    let response = if let Some(cancellation) = &cancellation {
        tokio::select! {
            result = request.send() => result.map_err(network_error)?,
            _ = cancellation.cancelled() => return Err(AiError::new("operationCancelled")),
        }
    } else {
        request.send().await.map_err(network_error)?
    };
    let (status, headers, bytes) = if let Some(cancellation) = &cancellation {
        tokio::select! {
            result = read_response(response, MAX_RESPONSE_BYTES) => result?,
            _ = cancellation.cancelled() => return Err(AiError::new("operationCancelled")),
        }
    } else {
        read_response(response, MAX_RESPONSE_BYTES).await?
    };
    if !status.is_success() {
        if rejected_effort(status, &bytes) {
            return Ok(ProviderAttempt::EffortRejected);
        }
        if rejected_structured_output(status, &bytes, structured_output_mode) {
            return Ok(ProviderAttempt::StructuredOutputRejected);
        }
        return Err(provider_response_error(
            configuration,
            status,
            &headers,
            &bytes,
        ));
    }
    let response_bytes = bytes.len();
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
        AiError::new("invalidResponse").with_provider_response(AiProviderResponseMetadata {
            usage: AiUsage::default(),
            request_id: None,
            generation_id: None,
            routed_provider: None,
            routed_model: None,
            finish_reason: None,
            response_bytes,
        })
    })?;
    let request_id = headers
        .get("x-request-id")
        .or_else(|| headers.get("request-id"))
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let mut result = adapter
        .parse_response(value, request_id, extension_for(configuration.provider))
        .map_err(|error| {
            error.with_provider_response(AiProviderResponseMetadata {
                usage: AiUsage::default(),
                request_id: None,
                generation_id: None,
                routed_provider: None,
                routed_model: None,
                finish_reason: None,
                response_bytes,
            })
        })?;
    result.response_bytes = response_bytes;
    Ok(ProviderAttempt::Completed(result))
}

pub(crate) async fn run_provider(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u32,
    task: AiTask,
    budget: &mut AiRequestBudget,
    cancellation: Option<CancellationToken>,
) -> Result<(ProviderResult, AiEffortCapability), AiError> {
    let result = run_provider_with_output(
        runtime,
        configuration,
        api_key,
        system_prompt,
        user_prompt,
        max_tokens,
        task,
        budget,
        &AiOutputContract::Text,
        cancellation,
    )
    .await?;
    Ok((result.0, result.1))
}

pub(crate) async fn run_provider_with_output(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    system_prompt: &str,
    user_prompt: &str,
    max_tokens: u32,
    task: AiTask,
    budget: &mut AiRequestBudget,
    output_contract: &AiOutputContract,
    cancellation: Option<CancellationToken>,
) -> Result<
    (
        ProviderResult,
        AiEffortCapability,
        Option<AiStructuredOutputMode>,
    ),
    AiError,
> {
    if matches!(
        configuration.reasoning_preference,
        AiReasoningPreference::Low | AiReasoningPreference::Medium | AiReasoningPreference::High
    ) {
        let supported = match &configuration.effort_capability {
            AiEffortCapability::Unsupported => false,
            AiEffortCapability::Supported(levels) => {
                levels.contains(&configuration.reasoning_preference)
            }
            AiEffortCapability::Unknown | AiEffortCapability::Accepted => true,
        };
        if !supported {
            return Err(AiError::new("reasoningUnsupported"));
        }
    }
    let adapter = adapter_for(configuration)?;
    let mut effort = effort_for(configuration, task);
    let mut effort_capability = configuration.effort_capability.clone();
    let mut structured_output_mode = match output_contract {
        AiOutputContract::Text => None,
        AiOutputContract::JsonSchema { .. } => Some(
            runtime
                .structured_output_mode(configuration)
                .unwrap_or(AiStructuredOutputMode::JsonSchema),
        ),
    };
    loop {
        match send_provider_request(
            runtime,
            configuration,
            api_key,
            system_prompt,
            user_prompt,
            max_tokens,
            effort,
            task,
            output_contract,
            structured_output_mode,
            budget,
            cancellation.clone(),
        )
        .await?
        {
            ProviderAttempt::Completed(result) => {
                if effort.is_some() {
                    effort_capability = AiEffortCapability::Accepted;
                }
                if let Some(mode) = structured_output_mode {
                    runtime.remember_structured_output_mode(configuration, mode);
                }
                return Ok((result, effort_capability, structured_output_mode));
            }
            ProviderAttempt::EffortRejected => {
                if effort.is_none() {
                    return Err(AiError::new("requestRejected"));
                }
                if configuration.reasoning_preference != AiReasoningPreference::Automatic
                    && !matches!(task, AiTask::ConnectionTest)
                {
                    return Err(AiError::new("reasoningUnsupported"));
                }
                effort = None;
                effort_capability = AiEffortCapability::Unsupported;
            }
            ProviderAttempt::StructuredOutputRejected => {
                let Some(fallback) = structured_output_mode.and_then(|mode| mode.fallback(adapter))
                else {
                    return Err(AiError::new("requestRejected"));
                };
                structured_output_mode = Some(fallback);
                runtime.remember_structured_output_mode(configuration, fallback);
            }
        }
    }
}

pub(crate) async fn discover_effort(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
) -> Option<AiEffortCapability> {
    if configuration.provider != AiProvider::Claude || configuration.models_path.is_empty() {
        return None;
    }
    let path = format!(
        "{}/{}",
        configuration.models_path.trim_end_matches('/'),
        configuration.model
    );
    let endpoint = endpoint_with_path(configuration, &path).ok()?;
    let request = runtime.client.get(endpoint).timeout(REQUEST_TIMEOUT);
    let request = CLAUDE_ADAPTER.add_protocol_headers(request);
    let response = authenticate(request, configuration, api_key)
        .ok()?
        .send()
        .await
        .ok()?;
    let (status, _, bytes) = read_response(response, MAX_RESPONSE_BYTES).await.ok()?;
    if !status.is_success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    claude_effort_capability(&value)
}

pub(crate) async fn discover_models(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    query: &AiModelQuery,
) -> Result<AiModelPage, AiError> {
    if configuration.models_path.is_empty() {
        return Err(AiError::new("modelDiscoveryUnavailable"));
    }
    let endpoint = endpoint_with_path(configuration, &configuration.models_path)?;
    let page_size = query.page_size.clamp(1, 100);
    let page = query.page.max(1);
    let mut catalogue = Vec::new();
    let mut offset = 0;
    let maximum_pages = if configuration.provider == AiProvider::OpenRouter {
        MAX_OPENROUTER_CATALOGUE_PAGES
    } else {
        1
    };
    for _ in 0..maximum_pages {
        let value = fetch_model_page(runtime, configuration, api_key, &endpoint, offset).await?;
        let values = value
            .get("data")
            .or_else(|| value.get("models"))
            .and_then(Value::as_array)
            .ok_or_else(|| AiError::new("invalidResponse"))?;
        let value_count = values.len();
        catalogue.extend(
            values
                .iter()
                .filter_map(|value| normalise_model(configuration.provider, value)),
        );
        if configuration.provider != AiProvider::OpenRouter
            || value_count < OPENROUTER_CATALOGUE_PAGE_SIZE
        {
            break;
        }
        offset += value_count;
        if offset >= OPENROUTER_CATALOGUE_PAGE_SIZE * MAX_OPENROUTER_CATALOGUE_PAGES {
            return Err(AiError::new("modelCatalogueTooLarge"));
        }
    }

    if configuration.provider == AiProvider::OpenRouter {
        let zdr_models = fetch_openrouter_zdr_models(runtime, configuration, api_key).await?;
        for model in &mut catalogue {
            model.zero_data_retention = Some(zdr_models.contains(&model.id));
        }
    }

    let mut models = catalogue
        .into_iter()
        .filter(|model| model_matches(model, query))
        .collect::<Vec<_>>();
    sort_models(&mut models, query.sort);
    let start = ((page - 1) * page_size) as usize;
    let end = (start + page_size as usize).min(models.len());
    let has_more = end < models.len();
    let models = if start < models.len() {
        models.drain(start..end).collect()
    } else {
        Vec::new()
    };
    Ok(AiModelPage {
        models,
        page,
        page_size,
        has_more,
    })
}

pub(crate) async fn discover_openrouter_model_details(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    model_id: &str,
) -> Result<AiModelInfo, AiError> {
    if configuration.provider != AiProvider::OpenRouter
        || model_id.is_empty()
        || model_id.len() > 256
        || model_id.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || segment.chars().any(char::is_control)
        })
    {
        return Err(AiError::new("modelDiscoveryUnavailable"));
    }
    let endpoint = endpoint_with_path(configuration, &format!("/models/{model_id}/endpoints"))?;
    let value = fetch_openrouter_metadata(runtime, configuration, api_key, endpoint).await?;
    let model = normalise_openrouter_endpoint_details(&value, model_id)?;
    if configuration.model == model_id {
        if let Some(mode) = discovered_structured_output_mode(&model.supported_parameters) {
            runtime.remember_structured_output_mode(configuration, mode);
        }
    }
    Ok(model)
}

fn discovered_structured_output_mode(
    supported_parameters: &[String],
) -> Option<AiStructuredOutputMode> {
    if supported_parameters
        .iter()
        .any(|parameter| parameter == "structured_outputs")
    {
        Some(AiStructuredOutputMode::JsonSchema)
    } else if supported_parameters
        .iter()
        .any(|parameter| parameter == "response_format")
    {
        Some(AiStructuredOutputMode::JsonObject)
    } else if supported_parameters.is_empty() {
        None
    } else {
        Some(AiStructuredOutputMode::PromptOnly)
    }
}

async fn fetch_openrouter_metadata(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    endpoint: Url,
) -> Result<Value, AiError> {
    let mut last_error = AiError::new("providerUnavailable");
    for _ in 0..MODEL_DISCOVERY_ATTEMPTS {
        let request = OPENROUTER_EXTENSION.add_headers(
            runtime
                .client
                .get(endpoint.clone())
                .timeout(REQUEST_TIMEOUT),
        );
        let response = match authenticate(request, configuration, api_key)?.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = network_error(error);
                continue;
            }
        };
        let (status, _, bytes) = read_response(response, MAX_MODELS_RESPONSE_BYTES).await?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|_| AiError::new("invalidResponse"));
        }
        last_error = response_error(status);
        if status.is_client_error() && status != StatusCode::TOO_MANY_REQUESTS {
            return Err(last_error);
        }
    }
    Err(last_error)
}

fn normalise_openrouter_endpoint_details(
    value: &Value,
    model_id: &str,
) -> Result<AiModelInfo, AiError> {
    let data = value.get("data").unwrap_or(value);
    let endpoints = data
        .get("endpoints")
        .and_then(Value::as_array)
        .ok_or_else(|| AiError::new("invalidResponse"))?;
    let mut model = OPENROUTER_EXTENSION
        .normalise_model(data)
        .unwrap_or_else(|| AiModelInfo {
            id: model_id.to_string(),
            name: data
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(model_id)
                .to_string(),
            ..AiModelInfo::default()
        });
    for endpoint in endpoints {
        push_unique(
            &mut model.available_providers,
            endpoint
                .get("provider_name")
                .or_else(|| endpoint.get("provider"))
                .and_then(Value::as_str),
        );
        push_unique(
            &mut model.quantisations,
            endpoint
                .get("quantization")
                .or_else(|| endpoint.get("quantisation"))
                .and_then(Value::as_str),
        );
        for parameter in string_array(endpoint.get("supported_parameters")) {
            push_unique(&mut model.supported_parameters, Some(&parameter));
        }
        model.context_length = maximum_u64(
            model.context_length,
            endpoint.get("context_length").and_then(Value::as_u64),
        );
        model.maximum_completion_tokens = maximum_u64(
            model.maximum_completion_tokens,
            endpoint
                .get("max_completion_tokens")
                .and_then(Value::as_u64),
        );
        model.prompt_price = minimum_price(
            model.prompt_price,
            string_number(endpoint.pointer("/pricing/prompt")),
        );
        model.completion_price = minimum_price(
            model.completion_price,
            string_number(endpoint.pointer("/pricing/completion")),
        );
        let endpoint_latency = first_f64(endpoint, &["/latency_last_30m/p50"]).or_else(|| {
            first_f64(endpoint, &["/performance/latency", "/latency"])
                .map(|milliseconds| milliseconds / 1000.0)
        });
        model.latency = match (model.latency, endpoint_latency) {
            (Some(current), Some(candidate)) => Some(current.min(candidate)),
            (current, candidate) => current.or(candidate),
        };
        model.throughput = maximum_f64(
            model.throughput,
            first_f64(
                endpoint,
                &[
                    "/throughput_last_30m/p50",
                    "/performance/throughput",
                    "/throughput",
                ],
            ),
        );
        model.uptime = maximum_f64(
            model.uptime,
            first_f64(
                endpoint,
                &["/uptime_last_30m", "/performance/uptime", "/uptime"],
            ),
        );
    }
    model.reasoning = model
        .supported_parameters
        .iter()
        .any(|parameter| parameter == "reasoning");
    model.structured_output = model
        .supported_parameters
        .iter()
        .any(|parameter| matches!(parameter.as_str(), "response_format" | "structured_outputs"));
    Ok(model)
}

fn push_unique(values: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty())
        && !values.iter().any(|existing| existing == value)
    {
        values.push(value.to_string());
    }
}

fn maximum_u64(left: Option<u64>, right: Option<u64>) -> Option<u64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn maximum_f64(left: Option<f64>, right: Option<f64>) -> Option<f64> {
    match (left, right) {
        (Some(left), Some(right)) => Some(left.max(right)),
        (left, right) => left.or(right),
    }
}

fn minimum_price(left: Option<String>, right: Option<String>) -> Option<String> {
    match (
        left.as_deref().and_then(|value| value.parse::<f64>().ok()),
        right.as_deref().and_then(|value| value.parse::<f64>().ok()),
    ) {
        (Some(left_price), Some(right_price)) if right_price < left_price => right,
        (Some(_), _) => left,
        (None, Some(_)) => right,
        (None, None) => left.or(right),
    }
}

async fn fetch_openrouter_zdr_models(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
) -> Result<HashSet<String>, AiError> {
    let endpoint = endpoint_with_path(configuration, "/endpoints/zdr")?;
    let mut last_error = AiError::new("providerUnavailable");
    for _ in 0..MODEL_DISCOVERY_ATTEMPTS {
        let request = OPENROUTER_EXTENSION.add_headers(
            runtime
                .client
                .get(endpoint.clone())
                .timeout(REQUEST_TIMEOUT),
        );
        let response = match authenticate(request, configuration, api_key)?.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = network_error(error);
                continue;
            }
        };
        let (status, _, bytes) = read_response(response, MAX_MODELS_RESPONSE_BYTES).await?;
        if status.is_success() {
            let value: Value =
                serde_json::from_slice(&bytes).map_err(|_| AiError::new("invalidResponse"))?;
            return parse_zdr_model_ids(&value);
        }
        last_error = response_error(status);
        if status.is_client_error() && status != StatusCode::TOO_MANY_REQUESTS {
            return Err(last_error);
        }
    }
    Err(last_error)
}

fn parse_zdr_model_ids(value: &Value) -> Result<HashSet<String>, AiError> {
    value
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(|| AiError::new("invalidResponse"))
        .map(|endpoints| {
            endpoints
                .iter()
                .filter_map(|endpoint| endpoint.get("model_id").and_then(Value::as_str))
                .map(str::to_string)
                .collect()
        })
}

async fn fetch_model_page(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    endpoint: &Url,
    offset: usize,
) -> Result<Value, AiError> {
    let mut last_error = AiError::new("providerUnavailable");
    for _ in 0..MODEL_DISCOVERY_ATTEMPTS {
        let mut request = runtime
            .client
            .get(endpoint.clone())
            .timeout(REQUEST_TIMEOUT);
        if configuration.provider == AiProvider::OpenRouter {
            request = request.query(&[
                ("limit", OPENROUTER_CATALOGUE_PAGE_SIZE),
                ("offset", offset),
            ]);
            request = OPENROUTER_EXTENSION.add_headers(request);
        }
        let response = match authenticate(request, configuration, api_key)?.send().await {
            Ok(response) => response,
            Err(error) => {
                last_error = network_error(error);
                continue;
            }
        };
        let (status, _, bytes) = read_response(response, MAX_MODELS_RESPONSE_BYTES).await?;
        if status.is_success() {
            return serde_json::from_slice(&bytes).map_err(|_| AiError::new("invalidResponse"));
        }
        last_error = response_error(status);
        if status.is_client_error() && status != StatusCode::TOO_MANY_REQUESTS {
            return Err(last_error);
        }
    }
    Err(last_error)
}

fn normalise_model(provider: AiProvider, value: &Value) -> Option<AiModelInfo> {
    if provider == AiProvider::OpenRouter {
        return OPENROUTER_EXTENSION.normalise_model(value);
    }
    let id = value.get("id")?.as_str()?.to_string();
    Some(AiModelInfo {
        name: value
            .get("display_name")
            .or_else(|| value.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(&id)
            .to_string(),
        id,
        created: value.get("created").and_then(Value::as_u64),
        ..AiModelInfo::default()
    })
}

fn model_matches(model: &AiModelInfo, query: &AiModelQuery) -> bool {
    let search = query.search.trim().to_ascii_lowercase();
    (search.is_empty()
        || model.id.to_ascii_lowercase().contains(&search)
        || model.name.to_ascii_lowercase().contains(&search)
        || model
            .description
            .as_deref()
            .is_some_and(|description| description.to_ascii_lowercase().contains(&search)))
        && (!query.programming_only
            || model
                .description
                .as_deref()
                .is_some_and(|description| description.to_ascii_lowercase().contains("code"))
            || model.coding_score.is_some())
        && (query.author.trim().is_empty()
            || model
                .id
                .split('/')
                .next()
                .is_some_and(|author| author.eq_ignore_ascii_case(query.author.trim())))
        && (query.hosting_provider.trim().is_empty()
            || model
                .available_providers
                .iter()
                .any(|provider| provider.eq_ignore_ascii_case(query.hosting_provider.trim())))
        && query
            .minimum_context_length
            .is_none_or(|minimum| model.context_length.is_some_and(|length| length >= minimum))
        && price_within(model.prompt_price.as_deref(), query.maximum_prompt_price)
        && price_within(
            model.completion_price.as_deref(),
            query.maximum_completion_price,
        )
        && (!query.zdr_only || model.zero_data_retention == Some(true))
        && (model.output_modalities.is_empty()
            || model
                .output_modalities
                .iter()
                .any(|modality| modality == "text"))
}

fn price_within(price: Option<&str>, maximum: Option<f64>) -> bool {
    maximum.is_none_or(|maximum| {
        price
            .and_then(|price| price.parse::<f64>().ok())
            .is_some_and(|price| price <= maximum)
    })
}

fn sort_models(models: &mut [AiModelInfo], sort: AiModelSort) {
    models.sort_by(|left, right| match sort {
        AiModelSort::Popularity => Ordering::Equal,
        AiModelSort::PromptPrice => compare_price(&left.prompt_price, &right.prompt_price),
        AiModelSort::CompletionPrice => {
            compare_price(&left.completion_price, &right.completion_price)
        }
        AiModelSort::Context => right.context_length.cmp(&left.context_length),
        AiModelSort::Latency => compare_optional(left.latency, right.latency),
        AiModelSort::Throughput => compare_optional(right.throughput, left.throughput),
        AiModelSort::CodingScore => compare_optional(right.coding_score, left.coding_score),
        AiModelSort::Newest => right.created.cmp(&left.created),
    });
}

fn compare_price(left: &Option<String>, right: &Option<String>) -> Ordering {
    compare_optional(
        left.as_deref().and_then(|value| value.parse().ok()),
        right.as_deref().and_then(|value| value.parse().ok()),
    )
}

fn compare_optional(left: Option<f64>, right: Option<f64>) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.partial_cmp(&right).unwrap_or(Ordering::Equal),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn claude_effort_capability(value: &Value) -> Option<AiEffortCapability> {
    let effort = value.pointer("/capabilities/effort")?;
    let levels = [
        ("low", AiReasoningPreference::Low),
        ("medium", AiReasoningPreference::Medium),
        ("high", AiReasoningPreference::High),
    ]
    .into_iter()
    .filter_map(|(name, level)| {
        effort
            .pointer(&format!("/{name}/supported"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
            .then_some(level)
    })
    .collect::<Vec<_>>();
    if levels.is_empty() {
        Some(AiEffortCapability::Unsupported)
    } else {
        Some(AiEffortCapability::Supported(levels))
    }
}

#[cfg(test)]
mod tests {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    use super::*;
    use crate::ai::types::OpenRouterSettings;

    fn configuration(provider: AiProvider) -> EffectiveAiConfiguration {
        EffectiveAiConfiguration {
            enabled: true,
            profile_id: "test".to_string(),
            provider,
            endpoint: provider.default_endpoint().to_string(),
            model: "test-model".to_string(),
            api_style: AiApiStyle::ChatCompletions,
            request_path: "/chat/completions".to_string(),
            models_path: "/models".to_string(),
            auth_mode: AiAuthMode::Bearer,
            auth_header: "Authorization".to_string(),
            max_tokens_field: "max_tokens".to_string(),
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

    fn conflict_contract() -> AiOutputContract {
        AiOutputContract::JsonSchema {
            name: "gitmun_conflict_resolution",
            schema: json!({
                "type": "object",
                "properties": {"regions": {"type": "array"}},
                "required": ["regions"],
                "additionalProperties": false
            }),
        }
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
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or_default();
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8(request).unwrap()
    }

    fn mock_provider(
        responses: Vec<(&'static str, String)>,
    ) -> (String, mpsc::Receiver<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut stream, _) = listener.accept().unwrap();
                requests.push(read_http_request(&mut stream));
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                stream.write_all(response.as_bytes()).unwrap();
            }
            drop(sender.send(requests));
        });
        (endpoint, receiver)
    }

    #[test]
    fn mistral_and_gemini_use_the_openai_request_shape() {
        for provider in [AiProvider::Mistral, AiProvider::GoogleGemini] {
            let configuration = configuration(provider);
            let body = adapter_for(&configuration).unwrap().request_body(
                &configuration,
                "system",
                "user",
                128,
                None,
                &AiOutputContract::Text,
                None,
            );

            assert_eq!(body.pointer("/messages/0/role"), Some(&json!("system")));
            assert_eq!(body.pointer("/messages/1/role"), Some(&json!("user")));
        }
    }

    #[test]
    fn openai_compatible_providers_share_structured_chat_requests() {
        for provider in [
            AiProvider::OpenAi,
            AiProvider::Mistral,
            AiProvider::GoogleGemini,
            AiProvider::OpenRouter,
            AiProvider::AzureOpenAi,
            AiProvider::Ollama,
            AiProvider::LmStudio,
            AiProvider::OpenAiCompatible,
        ] {
            let configuration = configuration(provider);
            let body = adapter_for(&configuration).unwrap().request_body(
                &configuration,
                "system",
                "user",
                128,
                None,
                &conflict_contract(),
                Some(AiStructuredOutputMode::JsonSchema),
            );

            assert_eq!(
                body.pointer("/response_format/type"),
                Some(&json!("json_schema")),
                "{provider:?}"
            );
            assert_eq!(
                body.pointer("/response_format/json_schema/strict"),
                Some(&json!(true)),
                "{provider:?}"
            );
        }
    }

    #[test]
    fn responses_and_claude_use_their_structured_output_shapes() {
        let mut responses = configuration(AiProvider::OpenAi);
        responses.api_style = AiApiStyle::Responses;
        responses.request_path = "/responses".to_string();
        let responses_body = OPEN_AI_ADAPTER.request_body(
            &responses,
            "system",
            "user",
            128,
            None,
            &conflict_contract(),
            Some(AiStructuredOutputMode::JsonSchema),
        );
        assert_eq!(
            responses_body.pointer("/text/format/type"),
            Some(&json!("json_schema"))
        );
        assert_eq!(
            responses_body.pointer("/text/format/name"),
            Some(&json!("gitmun_conflict_resolution"))
        );

        let claude = configuration(AiProvider::Claude);
        let claude_body = CLAUDE_ADAPTER.request_body(
            &claude,
            "system",
            "user",
            128,
            Some("medium"),
            &conflict_contract(),
            Some(AiStructuredOutputMode::JsonSchema),
        );
        assert_eq!(
            claude_body.pointer("/output_config/format/type"),
            Some(&json!("json_schema"))
        );
        assert_eq!(
            claude_body.pointer("/output_config/effort"),
            Some(&json!("medium"))
        );
    }

    #[test]
    fn json_object_and_prompt_only_modes_remove_strict_schema_fields() {
        let configuration = configuration(AiProvider::OpenAi);
        let json_object = OPEN_AI_ADAPTER.request_body(
            &configuration,
            "system",
            "user",
            128,
            None,
            &conflict_contract(),
            Some(AiStructuredOutputMode::JsonObject),
        );
        let prompt_only = OPEN_AI_ADAPTER.request_body(
            &configuration,
            "system",
            "user",
            128,
            None,
            &conflict_contract(),
            Some(AiStructuredOutputMode::PromptOnly),
        );

        assert_eq!(
            json_object.pointer("/response_format/type"),
            Some(&json!("json_object"))
        );
        assert!(
            json_object
                .pointer("/response_format/json_schema")
                .is_none()
        );
        assert!(prompt_only.get("response_format").is_none());
        assert_eq!(
            AiStructuredOutputMode::JsonSchema.fallback(&CLAUDE_ADAPTER),
            Some(AiStructuredOutputMode::PromptOnly)
        );
    }

    #[test]
    fn conflict_resolution_allows_slow_reasoning_responses() {
        assert_eq!(
            AiTask::ConflictResolution.request_timeout(),
            Duration::from_secs(5 * 60)
        );
        assert_eq!(
            AiTask::CommitMessage.request_timeout(),
            Duration::from_secs(120)
        );
    }

    #[tokio::test]
    async fn structured_output_falls_back_once_and_caches_the_supported_mode() {
        let completed = json!({
            "id": "generation-1",
            "choices": [{
                "message": {"content": "{\"regions\":[]}"},
                "finish_reason": "stop"
            }],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2}
        })
        .to_string();
        let (endpoint, requests) = mock_provider(vec![
            (
                "400 Bad Request",
                r#"{"error":{"message":"response_format json_schema is not supported"}}"#
                    .to_string(),
            ),
            ("200 OK", completed.clone()),
            ("200 OK", completed),
        ]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        configuration.reasoning_preference = AiReasoningPreference::ProviderDefault;
        let contract = conflict_contract();

        let mut first_budget = AiRequestBudget::new();
        let (_, _, first_mode) = run_provider_with_output(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::ConflictResolution,
            &mut first_budget,
            &contract,
            None,
        )
        .await
        .unwrap();
        let mut second_budget = AiRequestBudget::new();
        let (_, _, second_mode) = run_provider_with_output(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::ConflictResolution,
            &mut second_budget,
            &contract,
            None,
        )
        .await
        .unwrap();
        let requests = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        let bodies = requests
            .iter()
            .map(|request| {
                serde_json::from_str::<Value>(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(first_mode, Some(AiStructuredOutputMode::JsonObject));
        assert_eq!(second_mode, Some(AiStructuredOutputMode::JsonObject));
        assert_eq!(first_budget.requests, 2);
        assert_eq!(second_budget.requests, 1);
        assert_eq!(
            bodies[0].pointer("/response_format/type"),
            Some(&json!("json_schema"))
        );
        assert_eq!(
            bodies[1].pointer("/response_format/type"),
            Some(&json!("json_object"))
        );
        assert_eq!(
            bodies[2].pointer("/response_format/type"),
            Some(&json!("json_object"))
        );
    }

    #[tokio::test]
    async fn automatic_effort_is_removed_only_once() {
        let rejection = r#"{"error":{"message":"reasoning effort is not supported"}}"#;
        let (endpoint, requests) = mock_provider(vec![
            ("400 Bad Request", rejection.to_string()),
            ("400 Bad Request", rejection.to_string()),
        ]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        let mut budget = AiRequestBudget::new();

        let error = match run_provider(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::CommitMessage,
            &mut budget,
            None,
        )
        .await
        {
            Ok(_) => panic!("a second effort rejection must fail"),
            Err(error) => error,
        };
        let requests = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        let bodies = requests
            .iter()
            .map(|request| {
                serde_json::from_str::<Value>(request.split("\r\n\r\n").nth(1).unwrap()).unwrap()
            })
            .collect::<Vec<_>>();

        assert_eq!(error.code, "requestRejected");
        assert_eq!(budget.requests, 2);
        assert_eq!(bodies[0].get("reasoning_effort"), Some(&json!("low")));
        assert!(bodies[1].get("reasoning_effort").is_none());
    }

    #[tokio::test]
    async fn unsupported_schema_and_json_mode_fall_back_to_prompt_only() {
        let completed = json!({
            "choices": [{"message": {"content": "{\"regions\":[]}"}, "finish_reason": "stop"}]
        })
        .to_string();
        let (endpoint, requests) = mock_provider(vec![
            (
                "400 Bad Request",
                r#"{"error":{"message":"response_format json_schema is unsupported"}}"#.to_string(),
            ),
            (
                "422 Unprocessable Entity",
                r#"{"error":{"message":"invalid value for response_format"}}"#.to_string(),
            ),
            ("200 OK", completed),
        ]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        configuration.reasoning_preference = AiReasoningPreference::ProviderDefault;
        let mut budget = AiRequestBudget::new();

        let (_, _, mode) = run_provider_with_output(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::ConflictResolution,
            &mut budget,
            &conflict_contract(),
            None,
        )
        .await
        .unwrap();
        let requests = requests.recv_timeout(Duration::from_secs(2)).unwrap();
        let final_body: Value =
            serde_json::from_str(requests[2].split("\r\n\r\n").nth(1).unwrap()).unwrap();

        assert_eq!(mode, Some(AiStructuredOutputMode::PromptOnly));
        assert_eq!(budget.requests, 3);
        assert!(final_body.get("response_format").is_none());
    }

    #[tokio::test]
    async fn completed_generation_is_not_retried_for_invalid_content() {
        let completed = json!({
            "choices": [{"message": {"content": "not json"}, "finish_reason": "stop"}]
        })
        .to_string();
        let (endpoint, requests) = mock_provider(vec![("200 OK", completed)]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        configuration.reasoning_preference = AiReasoningPreference::ProviderDefault;
        let mut budget = AiRequestBudget::new();

        let (result, _, mode) = run_provider_with_output(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::ConflictResolution,
            &mut budget,
            &conflict_contract(),
            None,
        )
        .await
        .unwrap();
        let requests = requests.recv_timeout(Duration::from_secs(2)).unwrap();

        assert_eq!(result.text, "not json");
        assert_eq!(mode, Some(AiStructuredOutputMode::JsonSchema));
        assert_eq!(budget.requests, 1);
        assert_eq!(requests.len(), 1);
    }

    #[test]
    fn unrelated_client_errors_do_not_trigger_structured_output_fallback() {
        assert!(!rejected_structured_output(
            StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"model is unavailable"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(!rejected_structured_output(
            StatusCode::TOO_MANY_REQUESTS,
            br#"{"error":{"message":"response_format is temporarily unavailable"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn deprecation_notice_does_not_trigger_structured_output_fallback() {
        assert!(!rejected_structured_output(
            StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"response_format 'json_schema' is deprecated, use 'json_object' instead"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(!rejected_structured_output(
            StatusCode::BAD_REQUEST,
            r#"response_format is deprecated"#.as_bytes(),
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn non_english_error_does_not_trigger_structured_output_fallback() {
        assert!(!rejected_structured_output(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"Das Format 'json_schema' wird nicht unterstützt"}}"#.as_bytes(),
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(!rejected_structured_output(
            StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"格式 json_schema 不受支持"}}"#.as_bytes(),
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn structured_json_error_param_triggers_fallback() {
        assert!(rejected_structured_output(
            StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"Invalid response_format: 'json_schema' is not supported with this model.","type":"invalid_request_error","param":"response_format","code":null}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn output_config_param_triggers_fallback() {
        assert!(rejected_structured_output(
            StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"output_config.format: unsupported value: json_schema","type":"invalid_request_error"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn structured_error_type_with_format_and_rejection_keywords_triggers_fallback() {
        assert!(rejected_structured_output(
            StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"response_format is not valid for this model","type":"validation_error","param":null}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(rejected_structured_output(
            StatusCode::UNPROCESSABLE_ENTITY,
            br#"{"error":{"message":"invalid value for response_format","type":"invalid_request_error"}}"#,
            Some(AiStructuredOutputMode::JsonObject),
        ));
    }

    #[test]
    fn openrouter_extension_adds_privacy_and_routing_fields() {
        let mut configuration = configuration(AiProvider::OpenRouter);
        configuration.open_router.privacy = OpenRouterPrivacy::StrictZdr;
        configuration.open_router.max_prompt_price = "2.5".to_string();
        let body = OPEN_AI_ADAPTER.request_body(
            &configuration,
            "system",
            "user",
            100,
            None,
            &AiOutputContract::Text,
            None,
        );

        assert_eq!(
            body.pointer("/provider/data_collection"),
            Some(&json!("deny"))
        );
        assert_eq!(body.pointer("/provider/zdr"), Some(&json!(true)));
        assert_eq!(
            body.pointer("/provider/require_parameters"),
            Some(&json!(true))
        );
        assert_eq!(
            body.pointer("/provider/max_price/prompt"),
            Some(&json!(2.5))
        );
    }

    #[test]
    fn openrouter_extension_adds_app_attribution_headers() {
        let request = OPENROUTER_EXTENSION
            .add_headers(Client::new().get("https://openrouter.ai/api/v1/models/user"))
            .build()
            .unwrap();

        assert_eq!(
            request.headers().get("HTTP-Referer").unwrap(),
            OPENROUTER_APP_URL
        );
        assert_eq!(
            request.headers().get("X-OpenRouter-Title").unwrap(),
            OPENROUTER_APP_TITLE
        );
        assert_eq!(
            request.headers().get("X-OpenRouter-Categories").unwrap(),
            OPENROUTER_APP_CATEGORIES
        );
    }

    #[test]
    fn parses_only_a_bounded_openrouter_oauth_key() {
        assert_eq!(
            parse_openrouter_oauth_exchange(br#"{"key":"sk-or-test"}"#).unwrap(),
            "sk-or-test"
        );
        assert_eq!(
            parse_openrouter_oauth_exchange(br#"{"user_id":"user"}"#)
                .unwrap_err()
                .code,
            "invalidResponse"
        );
        assert_eq!(
            parse_openrouter_oauth_exchange(b"{\"key\":\"line\\nbreak\"}")
                .unwrap_err()
                .code,
            "invalidResponse"
        );
    }

    #[test]
    fn typed_openai_content_is_combined() {
        let value = json!({
            "choices": [{
                "message": {"content": [
                    {"type": "text", "text": "first"},
                    {"type": "text", "text": " second"}
                ]},
                "finish_reason": "stop"
            }]
        });

        let result = OPEN_AI_ADAPTER.parse_response(value, None, None).unwrap();

        assert_eq!(result.text, "first second");
    }

    #[test]
    fn openrouter_exact_cost_and_routing_are_parsed() {
        let value = json!({
            "id": "generation-1",
            "model": "author/model",
            "provider": "Example",
            "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "cost": 0.0003, "is_byok": true}
        });

        let result = OPEN_AI_ADAPTER
            .parse_response(value, None, Some(&OPENROUTER_EXTENSION))
            .unwrap();

        assert_eq!(result.usage.cost, Some(0.0003));
        assert_eq!(result.usage.byok, Some(true));
        assert_eq!(result.routed_provider.as_deref(), Some("Example"));
    }

    #[test]
    fn openrouter_zdr_catalogue_is_normalised_without_adding_models() {
        let models = parse_zdr_model_ids(&json!({
            "data": [
                {"model_id": "author/private-model", "provider_name": "Example"},
                {"model_id": "author/second-model", "provider_name": "Other"}
            ]
        }))
        .unwrap();

        assert_eq!(models.len(), 2);
        assert!(models.contains("author/private-model"));
    }

    #[test]
    fn openrouter_catalogue_latency_is_converted_from_milliseconds() {
        let model = OPENROUTER_EXTENSION
            .normalise_model(&json!({
                "id": "author/model",
                "name": "Model",
                "latency": 1912,
                "throughput": 74.25,
                "uptime": 99.93280607445571
            }))
            .unwrap();

        assert_eq!(model.latency, Some(1.912));
        assert_eq!(model.throughput, Some(74.25));
        assert_eq!(model.uptime, Some(99.93280607445571));
    }

    #[test]
    fn openrouter_endpoint_metadata_is_aggregated() {
        let model = normalise_openrouter_endpoint_details(
            &json!({
                "data": {
                    "id": "author/model",
                    "name": "Model",
                    "endpoints": [{
                        "provider_name": "Example",
                        "quantization": "fp8",
                        "context_length": 128000,
                        "max_completion_tokens": 16000,
                        "supported_parameters": ["reasoning", "response_format"],
                        "pricing": {"prompt": "0.000001", "completion": "0.000002"},
                        "latency_last_30m": {"p50": 0.4},
                        "throughput_last_30m": {"p50": 90.0},
                        "uptime_last_30m": 99.9
                    }]
                }
            }),
            "author/model",
        )
        .unwrap();

        assert_eq!(model.available_providers, vec!["Example"]);
        assert_eq!(model.quantisations, vec!["fp8"]);
        assert_eq!(model.context_length, Some(128000));
        assert!(model.reasoning);
        assert!(model.structured_output);
        assert_eq!(model.latency, Some(0.4));
        assert_eq!(model.uptime, Some(99.9));
    }

    #[test]
    fn openrouter_endpoint_parameters_select_the_best_structured_output_mode() {
        assert_eq!(
            discovered_structured_output_mode(&["structured_outputs".to_string()]),
            Some(AiStructuredOutputMode::JsonSchema)
        );
        assert_eq!(
            discovered_structured_output_mode(&["response_format".to_string()]),
            Some(AiStructuredOutputMode::JsonObject)
        );
        assert_eq!(
            discovered_structured_output_mode(&["temperature".to_string()]),
            Some(AiStructuredOutputMode::PromptOnly)
        );
        assert_eq!(discovered_structured_output_mode(&[]), None);
    }

    #[test]
    fn openrouter_error_diagnostics_exclude_messages_and_unsafe_values() {
        let mut configuration = configuration(AiProvider::OpenRouter);
        configuration.open_router.diagnostics = true;
        let error = provider_response_error(
            &configuration,
            StatusCode::BAD_REQUEST,
            &HeaderMap::new(),
            br#"{"error":{"message":"secret prompt text","metadata":{"provider_name":"safe-provider","generation_id":"unsafe value"}}}"#,
        );

        assert_eq!(
            error.detail.as_deref(),
            Some("status=400; provider=safe-provider")
        );
    }
}
