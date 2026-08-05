//! ProviderRegistry, ProviderPreset, and public facades (run, discover).

use std::cmp::Ordering;

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::api::{
    self, AiModelInfo, AiModelPage, AiModelQuery, AiModelSort, AiOutputContract, AiRequestBudget,
    AiRuntime, AiStructuredOutputMode, AiTask, OpenAiCompatibleExtension, ProtocolAdapter,
    ProviderResult, endpoint_with_path, authenticate, network_error, read_response, response_error,
    REQUEST_TIMEOUT, MODEL_DISCOVERY_ATTEMPTS, MAX_MODELS_RESPONSE_BYTES,
};
pub(crate) use super::api::claude::discover_effort;
use super::api::claude::{ClaudeAdapter, normalise_claude_model};
use super::api::openai::{OpenAiAdapter, normalise_openai_compatible_model};
use super::configuration::EffectiveAiConfiguration;
use super::types::{
    AiApiStyle, AiAuthMode, AiEffortCapability, AiProvider,
};
use super::AiError;

use self::openrouter::OpenRouterProvider;

pub(crate) mod openrouter;

const OPENROUTER_CATALOGUE_PAGE_SIZE: usize = 1000;
const MAX_OPENROUTER_CATALOGUE_PAGES: usize = 16;

// ---------------------------------------------------------------------------
// Public facades (re-exported via ai/mod.rs)
// ---------------------------------------------------------------------------

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
    let registry = ProviderRegistry::require(configuration)?;
    api::run_provider(
        runtime,
        configuration,
        api_key,
        system_prompt,
        user_prompt,
        max_tokens,
        task,
        budget,
        cancellation,
        registry.adapter,
        registry.extension,
    )
    .await
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
    let registry = ProviderRegistry::require(configuration)?;
    api::run_provider_with_output(
        runtime,
        configuration,
        api_key,
        system_prompt,
        user_prompt,
        max_tokens,
        task,
        budget,
        output_contract,
        cancellation,
        registry.adapter,
        registry.extension,
    )
    .await
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
    let mut after_id: Option<String> = None;
    let maximum_pages = match configuration.provider {
        AiProvider::OpenRouter | AiProvider::Claude => MAX_OPENROUTER_CATALOGUE_PAGES,
        _ => 1,
    };
    for _ in 0..maximum_pages {
        let value = fetch_model_page(
            runtime,
            configuration,
            api_key,
            &endpoint,
            offset,
            after_id.as_deref(),
        )
        .await?;
        let values = value
            .get("data")
            .or_else(|| value.get("models"))
            .and_then(Value::as_array)
            .ok_or_else(|| AiError::new("invalidResponse"))?;
        let value_count = values.len();
        catalogue.extend(values.iter().filter_map(|value| normalise_model(configuration.provider, value)));
        if configuration.provider == AiProvider::Claude {
            let has_more = value.get("has_more").and_then(Value::as_bool).unwrap_or(false);
            if !has_more {
                break;
            }
            after_id = value.get("last_id").and_then(Value::as_str).map(str::to_string);
            if after_id.is_none() {
                break;
            }
        } else if configuration.provider != AiProvider::OpenRouter
            || value_count < OPENROUTER_CATALOGUE_PAGE_SIZE
        {
            break;
        } else {
            offset += value_count;
            if offset >= OPENROUTER_CATALOGUE_PAGE_SIZE * MAX_OPENROUTER_CATALOGUE_PAGES {
                return Err(AiError::new("modelCatalogueTooLarge"));
            }
        }
    }

    if configuration.provider == AiProvider::OpenRouter {
        let zdr_models = OpenRouterProvider::fetch_zdr_models(runtime, configuration, api_key).await?;
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
    OpenRouterProvider::discover_details(runtime, configuration, api_key, model_id).await
}

// ---------------------------------------------------------------------------
// ProviderPreset
// ---------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub(crate) struct ProviderPreset {
    pub endpoint: &'static str,
    pub api_style: AiApiStyle,
    pub request_path: &'static str,
    pub models_path: &'static str,
    pub auth_mode: AiAuthMode,
    pub auth_header: &'static str,
    pub max_tokens_field: &'static str,
}

// ---------------------------------------------------------------------------
// ProviderRegistry
// ---------------------------------------------------------------------------

pub(crate) struct ProviderRegistry;

pub(crate) struct ResolvedProvider<'a> {
    pub adapter: &'a dyn ProtocolAdapter,
    pub extension: Option<&'a dyn OpenAiCompatibleExtension>,
}

static OPEN_AI_ADAPTER: OpenAiAdapter = OpenAiAdapter;
static CLAUDE_ADAPTER: ClaudeAdapter = ClaudeAdapter;

impl ProviderRegistry {
    pub fn preset(provider: AiProvider) -> ProviderPreset {
        let endpoint = provider.default_endpoint();
        match provider {
            AiProvider::Claude => ProviderPreset {
                endpoint,
                api_style: AiApiStyle::ChatCompletions,
                request_path: "/messages",
                models_path: "/models",
                auth_mode: AiAuthMode::Header,
                auth_header: "x-api-key",
                max_tokens_field: "max_tokens",
            },
            AiProvider::AzureOpenAi => ProviderPreset {
                endpoint,
                api_style: AiApiStyle::ChatCompletions,
                request_path: "/openai/deployments/{deployment}/chat/completions",
                models_path: "",
                auth_mode: AiAuthMode::Header,
                auth_header: "api-key",
                max_tokens_field: "max_completion_tokens",
            },
            AiProvider::OpenAi => ProviderPreset {
                endpoint,
                api_style: AiApiStyle::ChatCompletions,
                request_path: "/chat/completions",
                models_path: "/models",
                auth_mode: AiAuthMode::Bearer,
                auth_header: "Authorization",
                max_tokens_field: "max_completion_tokens",
            },
            AiProvider::Mistral
            | AiProvider::GoogleGemini
            | AiProvider::OpenRouter
            | AiProvider::Ollama
            | AiProvider::LmStudio
            | AiProvider::OpenAiCompatible
            | AiProvider::Disabled => ProviderPreset {
                endpoint,
                api_style: AiApiStyle::ChatCompletions,
                request_path: "/chat/completions",
                models_path: if provider == AiProvider::OpenRouter {
                    "/models/user"
                } else {
                    "/models"
                },
                auth_mode: AiAuthMode::Bearer,
                auth_header: "Authorization",
                max_tokens_field: "max_tokens",
            },
        }
    }

    pub fn require(configuration: &EffectiveAiConfiguration) -> Result<ResolvedProvider<'_>, AiError> {
        let provider = configuration.provider;
        if provider == AiProvider::Disabled {
            return Err(AiError::new("notConfigured"));
        }
        let adapter: &dyn ProtocolAdapter = if provider == AiProvider::Claude {
            &CLAUDE_ADAPTER
        } else if provider.is_openai_compatible() {
            &OPEN_AI_ADAPTER
        } else {
            return Err(AiError::new("notConfigured"));
        };
        let extension: Option<&dyn OpenAiCompatibleExtension> =
            (provider == AiProvider::OpenRouter)
                .then_some(OpenRouterProvider::extension() as &dyn OpenAiCompatibleExtension);
        Ok(ResolvedProvider { adapter, extension })
    }
}

// ---------------------------------------------------------------------------
// Shared model discovery helpers
// ---------------------------------------------------------------------------

fn normalise_model(provider: AiProvider, value: &Value) -> Option<AiModelInfo> {
    if provider == AiProvider::OpenRouter {
        return OpenRouterProvider::normalise_model(value);
    }
    if provider == AiProvider::Claude {
        return normalise_claude_model(value);
    }
    normalise_openai_compatible_model(value)
}

async fn fetch_model_page(
    runtime: &AiRuntime,
    configuration: &EffectiveAiConfiguration,
    api_key: &str,
    endpoint: &url::Url,
    offset: usize,
    after_id: Option<&str>,
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
            request = OpenRouterProvider::add_openrouter_headers(request);
        } else if configuration.provider == AiProvider::Claude {
            if let Some(cursor) = after_id {
                request = request.query(&[("after_id", cursor)]);
            }
            request = CLAUDE_ADAPTER.add_protocol_headers(request);
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
        if status.is_client_error() && status != reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(last_error);
        }
    }
    Err(last_error)
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

#[cfg(test)]
pub(crate) mod test_helpers {
    use super::*;
    use crate::ai::types::OpenRouterSettings;
    use crate::git::types::AiReasoningPreference;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::mpsc;

    pub(crate) fn configuration(provider: AiProvider) -> EffectiveAiConfiguration {
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

    pub(crate) fn conflict_contract() -> AiOutputContract {
        AiOutputContract::JsonSchema {
            name: "gitmun_conflict_resolution",
            schema: serde_json::json!({
                "type": "object",
                "properties": {"regions": {"type": "array"}},
                "required": ["regions"],
                "additionalProperties": false
            }),
        }
    }

    pub(crate) fn read_http_request(stream: &mut TcpStream) -> String {
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

    pub(crate) fn mock_provider(
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
}

#[cfg(test)]
mod fallback_tests {
    use super::test_helpers;
    use super::super::api::{AiRuntime, AiRequestBudget, AiStructuredOutputMode, AiTask};
    use crate::ai::types::{AiAuthMode, AiProvider, AiReasoningPreference};
    use serde_json::{Value, json};
    use std::time::Duration;

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
        let (endpoint, requests) = test_helpers::mock_provider(vec![
            (
                "400 Bad Request",
                r#"{"error":{"message":"response_format json_schema is not supported"}}"#
                    .to_string(),
            ),
            ("200 OK", completed.clone()),
            ("200 OK", completed),
        ]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = test_helpers::configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        configuration.reasoning_preference = AiReasoningPreference::ProviderDefault;
        let contract = test_helpers::conflict_contract();

        let mut first_budget = AiRequestBudget::new();
        let (_, _, first_mode) = super::run_provider_with_output(
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
        let (_, _, second_mode) = super::run_provider_with_output(
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
        let (endpoint, requests) = test_helpers::mock_provider(vec![
            ("400 Bad Request", rejection.to_string()),
            ("400 Bad Request", rejection.to_string()),
        ]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = test_helpers::configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        let mut budget = AiRequestBudget::new();

        let error = match super::run_provider(
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
        let (endpoint, requests) = test_helpers::mock_provider(vec![
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
        let mut configuration = test_helpers::configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        configuration.reasoning_preference = AiReasoningPreference::ProviderDefault;
        let mut budget = AiRequestBudget::new();

        let (_, _, mode) = super::run_provider_with_output(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::ConflictResolution,
            &mut budget,
            &test_helpers::conflict_contract(),
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
        let (endpoint, requests) = test_helpers::mock_provider(vec![("200 OK", completed)]);
        let runtime = AiRuntime::new().unwrap();
        let mut configuration = test_helpers::configuration(AiProvider::OpenAiCompatible);
        configuration.endpoint = endpoint;
        configuration.auth_mode = AiAuthMode::None;
        configuration.reasoning_preference = AiReasoningPreference::ProviderDefault;
        let mut budget = AiRequestBudget::new();

        let (result, _, mode) = super::run_provider_with_output(
            &runtime,
            &configuration,
            "",
            "system",
            "user",
            128,
            AiTask::ConflictResolution,
            &mut budget,
            &test_helpers::conflict_contract(),
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
        use super::super::api::rejected_structured_output;
        use super::super::api::AiStructuredOutputMode;
        assert!(!rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"model is unavailable"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(!rejected_structured_output(
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            br#"{"error":{"message":"response_format is temporarily unavailable"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn deprecation_notice_does_not_trigger_structured_output_fallback() {
        use super::super::api::rejected_structured_output;
        use super::super::api::AiStructuredOutputMode;
        assert!(!rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"response_format 'json_schema' is deprecated, use 'json_object' instead"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(!rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            r#"response_format is deprecated"#.as_bytes(),
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn non_english_error_does_not_trigger_structured_output_fallback() {
        use super::super::api::rejected_structured_output;
        use super::super::api::AiStructuredOutputMode;
        assert!(!rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"Das Format 'json_schema' wird nicht unterstützt"}}"#.as_bytes(),
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(!rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            r#"{"error":{"message":"格式 json_schema 不受支持"}}"#.as_bytes(),
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn structured_json_error_param_triggers_fallback() {
        use super::super::api::rejected_structured_output;
        use super::super::api::AiStructuredOutputMode;
        assert!(rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"Invalid response_format: 'json_schema' is not supported with this model.","type":"invalid_request_error","param":"response_format","code":null}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn output_config_param_triggers_fallback() {
        use super::super::api::rejected_structured_output;
        use super::super::api::AiStructuredOutputMode;
        assert!(rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"output_config.format: unsupported value: json_schema","type":"invalid_request_error"}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
    }

    #[test]
    fn structured_error_type_with_format_and_rejection_keywords_triggers_fallback() {
        use super::super::api::rejected_structured_output;
        use super::super::api::AiStructuredOutputMode;
        assert!(rejected_structured_output(
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":{"message":"response_format is not valid for this model","type":"validation_error","param":null}}"#,
            Some(AiStructuredOutputMode::JsonSchema),
        ));
        assert!(rejected_structured_output(
            reqwest::StatusCode::UNPROCESSABLE_ENTITY,
            br#"{"error":{"message":"invalid value for response_format","type":"invalid_request_error"}}"#,
            Some(AiStructuredOutputMode::JsonObject),
        ));
    }
}