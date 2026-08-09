//! Amazon Bedrock Converse protocol adapter.

use serde_json::{Value, json};

use super::super::AiError;
use super::super::configuration::EffectiveAiConfiguration;
use super::{
    AiOutputContract, AiStructuredOutputMode, AiUsage, OpenAiCompatibleExtension, ProtocolAdapter,
    ProviderResult, response_text,
};

pub(crate) struct BedrockAdapter;

impl ProtocolAdapter for BedrockAdapter {
    fn request_body(
        &self,
        _configuration: &EffectiveAiConfiguration,
        system_prompt: &str,
        user_prompt: &str,
        max_tokens: u32,
        _effort: Option<&str>,
        output_contract: &AiOutputContract,
        structured_output_mode: Option<AiStructuredOutputMode>,
        _extension: Option<&dyn OpenAiCompatibleExtension>,
    ) -> Value {
        let mut body = json!({
            "system": [{"text": system_prompt}],
            "messages": [{"role": "user", "content": [{"text": user_prompt}]}],
            "inferenceConfig": {"maxTokens": max_tokens},
        });
        if let (
            AiOutputContract::JsonSchema { name, schema },
            Some(AiStructuredOutputMode::JsonSchema),
        ) = (output_contract, structured_output_mode)
        {
            body["outputConfig"] = json!({
                "textFormat": {
                    "type": "json_schema",
                    "structure": {
                        "jsonSchema": {
                            "name": name,
                            "schema": serde_json::to_string(schema).unwrap_or_default(),
                        }
                    }
                }
            });
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
            .pointer("/output/message/content")
            .and_then(response_text)
            .ok_or_else(|| AiError::new("invalidResponse"))?;
        let finish_reason = value
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_string);
        Ok(ProviderResult {
            text,
            usage: AiUsage {
                input_tokens: value.pointer("/usage/inputTokens").and_then(Value::as_u64),
                output_tokens: value.pointer("/usage/outputTokens").and_then(Value::as_u64),
                reasoning_tokens: None,
                cached_tokens: value
                    .pointer("/usage/cacheReadInputTokens")
                    .and_then(Value::as_u64),
                cost: None,
                byok: None,
            },
            request_id,
            generation_id: None,
            routed_provider: None,
            routed_model: value
                .pointer("/trace/promptRouter/invokedModelId")
                .and_then(Value::as_str)
                .map(str::to_string),
            output_truncated: finish_reason.as_deref() == Some("max_tokens"),
            finish_reason,
            response_bytes: 0,
        })
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ai::api::{AiOutputContract, endpoint_with_path};

    #[test]
    fn converse_request_uses_content_blocks() {
        let body = BedrockAdapter.request_body(
            &crate::ai::providers::test_helpers::configuration(crate::ai::AiProvider::Bedrock),
            "system",
            "user",
            128,
            None,
            &AiOutputContract::Text,
            None,
            None,
        );
        assert_eq!(body["system"][0]["text"], "system");
        assert_eq!(body["messages"][0]["content"][0]["text"], "user");
        assert_eq!(body["inferenceConfig"]["maxTokens"], 128);
    }

    #[test]
    fn parses_converse_response() {
        let result = BedrockAdapter
            .parse_response(
                json!({
                    "output": {"message": {"content": [{"text": "OK"}]}},
                    "stopReason": "max_tokens",
                    "usage": {"inputTokens": 2, "outputTokens": 1}
                }),
                Some("request".to_string()),
                None,
            )
            .unwrap();
        assert_eq!(result.text, "OK");
        assert_eq!(result.usage.input_tokens, Some(2));
        assert!(result.output_truncated);
    }

    #[test]
    fn model_id_is_encoded_as_one_path_segment() {
        let mut configuration =
            crate::ai::providers::test_helpers::configuration(crate::ai::AiProvider::Bedrock);
        configuration.request_path = "/model/{model}/converse".to_string();
        configuration.model =
            "arn:aws:bedrock:us-east-1:123456789012:inference-profile/example".to_string();

        let endpoint = endpoint_with_path(&configuration, &configuration.request_path).unwrap();

        assert!(endpoint.as_str().contains("inference-profile%2Fexample"));
    }

    #[test]
    fn bearer_authentication_rejects_iam_json_credentials() {
        let mut configuration =
            crate::ai::providers::test_helpers::configuration(crate::ai::AiProvider::Bedrock);
        configuration.auth_mode = crate::ai::AiAuthMode::Bearer;
        let runtime = crate::ai::api::AiRuntime::new().unwrap();
        let request = runtime
            .client
            .get("https://bedrock.us-east-1.amazonaws.com/foundation-models");
        let error = crate::ai::api::authenticate(
            request,
            &configuration,
            r#"{"accessKeyId":"AKIDEXAMPLE","secretAccessKey":"secret"}"#,
        )
        .unwrap_err();
        assert_eq!(error.code, "apiKeyInvalid");
    }
}
