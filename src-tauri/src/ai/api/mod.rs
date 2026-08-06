//! Shared HTTP engine primitives for AI provider requests.

pub(crate) mod claude;
pub(crate) mod openai;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, RequestBuilder, Response, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;
use url::Url;

pub(crate) use super::AiUsage;
use super::configuration::{EffectiveAiConfiguration, validate_endpoint};
use super::types::{AiAuthMode, AiEffortCapability, AiProvider, AiReasoningPreference};
use super::{AiError, AiProviderResponseMetadata};

pub(crate) const CONNECTION_TEST_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const CONFLICT_RESOLUTION_REQUEST_TIMEOUT: Duration = Duration::from_secs(5 * 60);
pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub(crate) const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_OAUTH_RESPONSE_BYTES: usize = 64 * 1024;
pub(crate) const MAX_MODELS_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MODEL_DISCOVERY_ATTEMPTS: usize = 3;
pub(crate) const MAX_AI_OPERATION_REQUESTS: usize = 64;
pub(crate) const MAX_AI_OPERATION_OUTBOUND_BYTES: usize = 2 * 1024 * 1024;

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
    pub(crate) client: Client,
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

    pub(crate) fn structured_output_mode(
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

    pub(crate) fn remember_structured_output_mode(
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

pub(crate) fn parse_structured_output_mode(value: &str) -> Option<AiStructuredOutputMode> {
    match value {
        "jsonSchema" => Some(AiStructuredOutputMode::JsonSchema),
        "jsonObject" => Some(AiStructuredOutputMode::JsonObject),
        "promptOnly" => Some(AiStructuredOutputMode::PromptOnly),
        _ => None,
    }
}

pub(crate) fn structured_output_mode_name(mode: AiStructuredOutputMode) -> &'static str {
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
    pub(crate) fn fallback(self, adapter: &dyn ProtocolAdapter) -> Option<Self> {
        match self {
            Self::JsonSchema if adapter.supports_json_object() => Some(Self::JsonObject),
            Self::JsonSchema | Self::JsonObject => Some(Self::PromptOnly),
            Self::PromptOnly => None,
        }
    }
}

pub(crate) struct AiRequestBudget {
    pub(crate) requests: usize,
    pub(crate) outbound_bytes: usize,
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

#[allow(dead_code)]
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

// ---- Traits ----

pub(crate) trait ProtocolAdapter: Send + Sync {
    fn request_body(
        &self,
        configuration: &EffectiveAiConfiguration,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: u32,
        effort: Option<&str>,
        output_contract: &AiOutputContract,
        structured_output_mode: Option<AiStructuredOutputMode>,
        extension: Option<&dyn OpenAiCompatibleExtension>,
    ) -> Value;

    fn parse_response(
        &self,
        value: Value,
        request_id: Option<String>,
        provider_extension: Option<&dyn OpenAiCompatibleExtension>,
    ) -> Result<ProviderResult, AiError>;

    fn add_protocol_headers(&self, request: RequestBuilder) -> RequestBuilder {
        request
    }

    fn supports_json_object(&self) -> bool {
        false
    }
}

/// Extension trait for OpenAI-compatible providers with additional behaviour
/// (e.g. OpenRouter custom headers, routing, privacy fields).
pub(crate) trait OpenAiCompatibleExtension: Send + Sync {
    fn add_headers(&self, request: RequestBuilder) -> RequestBuilder;
    fn extend_request(
        &self,
        configuration: &EffectiveAiConfiguration,
        body: &mut Map<String, Value>,
    );
    fn extend_result(&self, value: &Value, result: &mut ProviderResult);
    fn normalise_model(&self, value: &Value) -> Option<AiModelInfo>;
}

// ---- Shared helpers ----

pub(crate) fn response_text(value: &Value) -> Option<String> {
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

pub(crate) fn responses_output_text(value: &Value) -> Option<String> {
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

pub(crate) fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect()
}

pub(crate) fn string_number(value: Option<&Value>) -> Option<String> {
    value.and_then(|value| match value {
        Value::String(value) => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    })
}

pub(crate) fn first_f64(value: &Value, pointers: &[&str]) -> Option<f64> {
    pointers.iter().find_map(|pointer| {
        value
            .pointer(pointer)
            .and_then(|value| value.as_f64().or_else(|| value.as_str()?.parse().ok()))
    })
}

pub(crate) fn endpoint_with_path(
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

pub(crate) fn authenticate(
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

pub(crate) fn effort_for(
    configuration: &EffectiveAiConfiguration,
    task: AiTask,
) -> Option<&'static str> {
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

pub(crate) async fn read_response(
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

pub(crate) fn network_error(error: reqwest::Error) -> AiError {
    if error.is_timeout() {
        AiError::new("timeout")
    } else if error.is_redirect() {
        AiError::new("unsafeRedirect")
    } else {
        AiError::new("network")
    }
}

pub(crate) fn rejected_effort(status: StatusCode, body: &[u8]) -> bool {
    status == StatusCode::BAD_REQUEST
        && String::from_utf8_lossy(body)
            .to_ascii_lowercase()
            .contains("effort")
}

pub(crate) fn rejected_structured_output(
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
            // OpenAI / OpenAI-compatible: response_format param set -> clear signal
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

pub(crate) fn response_error(status: StatusCode) -> AiError {
    match status.as_u16() {
        401 | 403 => AiError::new("authentication"),
        408 | 429 => AiError::with_detail("providerUnavailable", status.as_u16().to_string()),
        300..=399 => AiError::new("unsafeRedirect"),
        400..=499 => AiError::with_detail("requestRejected", status.as_u16().to_string()),
        _ => AiError::with_detail("providerUnavailable", status.as_u16().to_string()),
    }
}

pub(crate) fn provider_response_error(
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

pub(crate) fn redacted_diagnostic_value(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.' | '/' | ':')
        }))
    .then(|| value.to_string())
}

// ---- Request orchestration ----

pub(crate) enum ProviderAttempt {
    Completed(ProviderResult),
    EffortRejected,
    StructuredOutputRejected,
}

pub(crate) async fn send_provider_request(
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
    adapter: &dyn ProtocolAdapter,
    extension: Option<&dyn OpenAiCompatibleExtension>,
) -> Result<ProviderAttempt, AiError> {
    let endpoint = endpoint_with_path(configuration, &configuration.request_path)?;
    let body = adapter.request_body(
        configuration,
        system_prompt,
        user_prompt,
        max_tokens,
        effort,
        output_contract,
        structured_output_mode,
        extension,
    );
    budget.charge(&body)?;
    let request = runtime
        .client
        .post(endpoint)
        .timeout(task.request_timeout())
        .header(reqwest::header::CONTENT_TYPE, "application/json");
    let request = adapter.add_protocol_headers(request);
    let request = if let Some(extension) = extension {
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
        .parse_response(value, request_id, extension)
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
    adapter: &dyn ProtocolAdapter,
    extension: Option<&dyn OpenAiCompatibleExtension>,
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
        adapter,
        extension,
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
    adapter: &dyn ProtocolAdapter,
    extension: Option<&dyn OpenAiCompatibleExtension>,
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
            adapter,
            extension,
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
