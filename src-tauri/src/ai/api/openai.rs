//! OpenAI-compatible protocol adapter (chat completions + responses API).

use serde_json::{Value, json};

use super::super::configuration::EffectiveAiConfiguration;
use super::super::types::AiApiStyle;
use super::{
    AiModelInfo, AiOutputContract, AiStructuredOutputMode, AiUsage, OpenAiCompatibleExtension,
    ProtocolAdapter, ProviderResult, response_text, responses_output_text,
};
use super::super::AiError;

pub(crate) struct OpenAiAdapter;

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
        extension: Option<&dyn OpenAiCompatibleExtension>,
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
        if let (Some(extension), Some(object)) = (extension, body.as_object_mut()) {
            extension.extend_request(configuration, object);
        }
        body
    }

    fn parse_response(
        &self,
        value: Value,
        request_id: Option<String>,
        provider_extension: Option<&dyn OpenAiCompatibleExtension>,
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

/// Default model normalisation for non-OpenRouter, non-Claude providers.
pub(crate) fn normalise_openai_compatible_model(value: &Value) -> Option<AiModelInfo> {
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

#[cfg(test)]
mod tests {
    use super::super::super::providers::test_helpers;
    use super::super::claude::ClaudeAdapter;
    use super::super::*;
    use super::OpenAiAdapter;
    use crate::ai::types::{AiApiStyle, AiProvider};
    use serde_json::json;
    use std::time::Duration;

    #[test]
    fn mistral_and_gemini_use_the_openai_request_shape() {
        for provider in [AiProvider::Mistral, AiProvider::GoogleGemini] {
            let configuration = test_helpers::configuration(provider);
            let body = OpenAiAdapter.request_body(
                &configuration,
                "system",
                "user",
                128,
                None,
                &AiOutputContract::Text,
                None,
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
            let configuration = test_helpers::configuration(provider);
            let body = OpenAiAdapter.request_body(
                &configuration,
                "system",
                "user",
                128,
                None,
                &test_helpers::conflict_contract(),
                Some(AiStructuredOutputMode::JsonSchema),
                None,
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
        let mut responses = test_helpers::configuration(AiProvider::OpenAi);
        responses.api_style = AiApiStyle::Responses;
        responses.request_path = "/responses".to_string();
        let responses_body = OpenAiAdapter.request_body(
            &responses,
            "system",
            "user",
            128,
            None,
            &test_helpers::conflict_contract(),
            Some(AiStructuredOutputMode::JsonSchema),
            None,
        );
        assert_eq!(
            responses_body.pointer("/text/format/type"),
            Some(&json!("json_schema"))
        );
        assert_eq!(
            responses_body.pointer("/text/format/name"),
            Some(&json!("gitmun_conflict_resolution"))
        );

        let claude = test_helpers::configuration(AiProvider::Claude);
        let claude_body = ClaudeAdapter.request_body(
            &claude,
            "system",
            "user",
            128,
            Some("medium"),
            &test_helpers::conflict_contract(),
            Some(AiStructuredOutputMode::JsonSchema),
            None,
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
        let configuration = test_helpers::configuration(AiProvider::OpenAi);
        let json_object = OpenAiAdapter.request_body(
            &configuration,
            "system",
            "user",
            128,
            None,
            &test_helpers::conflict_contract(),
            Some(AiStructuredOutputMode::JsonObject),
            None,
        );
        let prompt_only = OpenAiAdapter.request_body(
            &configuration,
            "system",
            "user",
            128,
            None,
            &test_helpers::conflict_contract(),
            Some(AiStructuredOutputMode::PromptOnly),
            None,
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
            AiStructuredOutputMode::JsonSchema.fallback(&ClaudeAdapter),
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

        let result = OpenAiAdapter.parse_response(value, None, None).unwrap();

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

        let result = OpenAiAdapter
            .parse_response(value, None, None)
            .unwrap();

        // Without the OpenRouter extension, cost/routing aren't extracted
        assert_eq!(result.text, "done");
        assert!(result.routed_provider.is_none());
    }

    #[test]
    fn openrouter_cost_and_routing_with_extension_are_parsed() {
        use crate::ai::providers::openrouter::OpenRouterExtension;

        let value = json!({
            "id": "generation-1",
            "model": "author/model",
            "provider": "Example",
            "choices": [{"message": {"content": "done"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 5, "completion_tokens": 2, "cost": 0.0003, "is_byok": true}
        });

        let extension = OpenRouterExtension;
        let result = OpenAiAdapter
            .parse_response(value, None, Some(&extension))
            .unwrap();

        assert_eq!(result.usage.cost, Some(0.0003));
        assert_eq!(result.usage.byok, Some(true));
        assert_eq!(result.routed_provider.as_deref(), Some("Example"));
    }
}