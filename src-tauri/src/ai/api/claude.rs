//! Claude Messages protocol adapter, model normalisation, and effort discovery.

use reqwest::RequestBuilder;
use serde_json::{Map, Value, json};

use super::super::AiError;
use super::super::configuration::EffectiveAiConfiguration;
use super::super::types::{AiEffortCapability, AiProvider, AiReasoningPreference};
use super::{
    AiModelInfo, AiOutputContract, AiStructuredOutputMode, AiUsage, MAX_RESPONSE_BYTES,
    OpenAiCompatibleExtension, ProtocolAdapter, ProviderResult, REQUEST_TIMEOUT, authenticate,
    endpoint_with_path, read_response, response_text,
};

use super::AiRuntime;

pub(crate) struct ClaudeAdapter;

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
        _extension: Option<&dyn OpenAiCompatibleExtension>,
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
        _provider_extension: Option<&dyn OpenAiCompatibleExtension>,
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

/// Claude model normalisation.
pub(crate) fn normalise_claude_model(value: &Value) -> Option<AiModelInfo> {
    let id = value.get("id")?.as_str()?.to_string();
    let name = value
        .get("display_name")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_string();
    let capabilities = value.get("capabilities");
    let image_input = capabilities
        .and_then(|c| c.get("image_input"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(AiModelInfo {
        name,
        id,
        created: value.get("created_at").and_then(Value::as_u64),
        context_length: value.get("max_input_tokens").and_then(Value::as_u64),
        maximum_completion_tokens: value.get("max_tokens").and_then(Value::as_u64),
        structured_output: capabilities
            .and_then(|c| c.get("structured_outputs"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        reasoning: capabilities
            .and_then(|c| c.get("thinking"))
            .is_some_and(|v| !v.is_null()),
        input_modalities: if image_input {
            vec!["text".to_string(), "image".to_string()]
        } else {
            vec!["text".to_string()]
        },
        ..AiModelInfo::default()
    })
}

/// Discover effort capability from Claude's per-model endpoint.
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
    let request = ClaudeAdapter.add_protocol_headers(request);
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

pub(crate) fn claude_effort_capability(value: &Value) -> Option<AiEffortCapability> {
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
