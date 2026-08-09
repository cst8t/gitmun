//! OpenRouter provider: extension, catalogue, details, ZDR, OAuth exchange, diagnostics.

use std::collections::HashSet;

use reqwest::{RequestBuilder, StatusCode};
use serde_json::{Map, Value, json};
use url::Url;

use super::super::AiError;
use super::super::api::{
    AiModelInfo, AiRuntime, AiStructuredOutputMode, MAX_MODELS_RESPONSE_BYTES,
    MAX_OAUTH_RESPONSE_BYTES, MODEL_DISCOVERY_ATTEMPTS, OpenAiCompatibleExtension, ProviderResult,
    REQUEST_TIMEOUT, authenticate, endpoint_with_path, first_f64, network_error, read_response,
    response_error, string_array, string_number,
};
use super::super::configuration::EffectiveAiConfiguration;
use super::super::types::{OpenRouterPrivacy, OpenRouterRoutingStrategy};

const OPENROUTER_APP_URL: &str = "https://gitmun.org";
const OPENROUTER_APP_TITLE: &str = "Gitmun";
const OPENROUTER_APP_CATEGORIES: &str = "programming-app";

// ---------------------------------------------------------------------------
// OpenRouterProvider
// ---------------------------------------------------------------------------

pub(crate) struct OpenRouterProvider;

static OPENROUTER_EXTENSION: OpenRouterExtension = OpenRouterExtension;

impl OpenRouterProvider {
    pub(crate) fn extension() -> &'static OpenRouterExtension {
        &OPENROUTER_EXTENSION
    }

    /// Add OpenRouter attribution headers to any request builder.
    pub(crate) fn add_openrouter_headers(request: RequestBuilder) -> RequestBuilder {
        OPENROUTER_EXTENSION.add_headers(request)
    }

    pub(crate) fn normalise_model(value: &Value) -> Option<AiModelInfo> {
        OPENROUTER_EXTENSION.normalise_model(value)
    }

    pub(crate) async fn discover_details(
        runtime: &AiRuntime,
        configuration: &EffectiveAiConfiguration,
        api_key: &str,
        model_id: &str,
    ) -> Result<AiModelInfo, AiError> {
        if configuration.provider != super::super::types::AiProvider::OpenRouter
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

    pub(crate) async fn fetch_zdr_models(
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
}

// ---------------------------------------------------------------------------
// OpenRouterExtension
// ---------------------------------------------------------------------------

pub(crate) struct OpenRouterExtension;

impl OpenAiCompatibleExtension for OpenRouterExtension {
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

// ---------------------------------------------------------------------------
// OAuth exchange
// ---------------------------------------------------------------------------

pub(crate) async fn exchange_openrouter_oauth_code(
    runtime: &AiRuntime,
    code: &str,
    code_verifier: &str,
) -> Result<String, AiError> {
    let response = OPENROUTER_EXTENSION
        .add_headers(
            runtime
                .client
                .post("https://openrouter.ai/api/v1/auth/keys"),
        )
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

pub(crate) fn parse_openrouter_oauth_exchange(body: &[u8]) -> Result<String, AiError> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|value| value.get("key").and_then(Value::as_str).map(str::to_string))
        .filter(|key| {
            !key.trim().is_empty() && key.len() <= 1024 && !key.chars().any(char::is_control)
        })
        .ok_or_else(|| AiError::new("invalidResponse"))
}

// ---------------------------------------------------------------------------
// Detailed endpoint metadata aggregation
// ---------------------------------------------------------------------------

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
            model.prompt_price.clone(),
            string_number(endpoint.pointer("/pricing/prompt")),
        );
        model.completion_price = minimum_price(
            model.completion_price.clone(),
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

#[cfg(test)]
mod tests {
    use super::super::test_helpers;
    use super::*;
    use crate::ai::api::ProtocolAdapter;
    use crate::ai::api::openai::OpenAiAdapter;
    use crate::ai::providers::openrouter::OpenRouterProvider;
    use crate::ai::types::OpenRouterPrivacy;
    use reqwest::{Client, header::HeaderMap};
    use serde_json::json;

    #[test]
    fn openrouter_extension_adds_privacy_and_routing_fields() {
        let mut configuration =
            test_helpers::configuration(super::super::super::types::AiProvider::OpenRouter);
        configuration.open_router.privacy = OpenRouterPrivacy::StrictZdr;
        configuration.open_router.max_prompt_price = "2.5".to_string();
        let body = OpenAiAdapter.request_body(
            &configuration,
            "system",
            "user",
            100,
            None,
            &crate::ai::api::AiOutputContract::Text,
            None,
            Some(&OpenRouterExtension),
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
        let request = OpenRouterExtension
            .add_headers(Client::new().get("https://openrouter.ai/api/v1/models/user"))
            .build()
            .unwrap();

        assert_eq!(
            request.headers().get("HTTP-Referer").unwrap(),
            "https://gitmun.org"
        );
        assert_eq!(
            request.headers().get("X-OpenRouter-Title").unwrap(),
            "Gitmun"
        );
        assert_eq!(
            request.headers().get("X-OpenRouter-Categories").unwrap(),
            "programming-app"
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
        let model = OpenRouterProvider::normalise_model(&json!({
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
            super::discovered_structured_output_mode(&["structured_outputs".to_string()]),
            Some(crate::ai::api::AiStructuredOutputMode::JsonSchema)
        );
        assert_eq!(
            super::discovered_structured_output_mode(&["response_format".to_string()]),
            Some(crate::ai::api::AiStructuredOutputMode::JsonObject)
        );
        assert_eq!(
            super::discovered_structured_output_mode(&["temperature".to_string()]),
            Some(crate::ai::api::AiStructuredOutputMode::PromptOnly)
        );
        assert_eq!(super::discovered_structured_output_mode(&[]), None);
    }

    #[test]
    fn openrouter_error_diagnostics_exclude_messages_and_unsafe_values() {
        let mut configuration =
            test_helpers::configuration(super::super::super::types::AiProvider::OpenRouter);
        configuration.open_router.diagnostics = true;
        use crate::ai::api::provider_response_error;
        let error = provider_response_error(
            &configuration,
            reqwest::StatusCode::BAD_REQUEST,
            &HeaderMap::new(),
            br#"{"error":{"message":"secret prompt text","metadata":{"provider_name":"safe-provider","generation_id":"unsafe value"}}}"#,
        );

        assert_eq!(
            error.detail.as_deref(),
            Some("status=400; provider=safe-provider")
        );
    }
}
