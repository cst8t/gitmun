//! AWS Signature Version 4 support for Amazon Bedrock requests.

use std::time::SystemTime;

use aws_credential_types::Credentials;
use aws_sigv4::{
    http_request::{SignableBody, SignableRequest, SigningSettings, sign},
    sign::v4,
};
use reqwest::header::{HeaderName, HeaderValue};
use serde::Deserialize;

use super::super::AiError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IamCredentials {
    access_key_id: String,
    secret_access_key: String,
    #[serde(default)]
    session_token: Option<String>,
}

pub(crate) fn is_iam_credentials_json(value: &str) -> bool {
    parse_iam_credentials(value).is_ok()
}

pub(crate) fn sign_bedrock_request(
    request: &mut reqwest::Request,
    credential_value: &str,
    body: &[u8],
) -> Result<(), AiError> {
    sign_bedrock_request_at(request, credential_value, body, SystemTime::now())
}

fn parse_iam_credentials(credential_value: &str) -> Result<IamCredentials, AiError> {
    let credentials: IamCredentials =
        serde_json::from_str(credential_value).map_err(|_| AiError::new("apiKeyInvalid"))?;
    if credentials.access_key_id.trim().is_empty()
        || credentials.secret_access_key.trim().is_empty()
    {
        return Err(AiError::new("apiKeyInvalid"));
    }
    Ok(IamCredentials {
        access_key_id: credentials.access_key_id,
        secret_access_key: credentials.secret_access_key,
        session_token: credentials
            .session_token
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty()),
    })
}

fn sign_bedrock_request_at(
    request: &mut reqwest::Request,
    credential_value: &str,
    body: &[u8],
    signing_time: SystemTime,
) -> Result<(), AiError> {
    let credentials = parse_iam_credentials(credential_value)?;
    let region = bedrock_region(request.url()).ok_or_else(|| AiError::new("endpointInvalid"))?;
    let credentials = Credentials::new(
        credentials.access_key_id,
        credentials.secret_access_key,
        credentials.session_token,
        None,
        "gitmun-user-supplied",
    );
    let identity = credentials.into();
    let signing_params = v4::SigningParams::builder()
        .identity(&identity)
        .region(&region)
        .name("bedrock")
        .time(signing_time)
        .settings(SigningSettings::default())
        .build()
        .map_err(|_| AiError::new("authentication"))?
        .into();
    if request
        .headers()
        .values()
        .any(|value| value.to_str().is_err())
    {
        return Err(AiError::new("authHeaderInvalid"));
    }
    let signable = SignableRequest::new(
        request.method().as_str(),
        request.url().as_str(),
        request
            .headers()
            .iter()
            .map(|(name, value)| (name.as_str(), value.to_str().unwrap_or_default())),
        SignableBody::Bytes(body),
    )
    .map_err(|_| AiError::new("authentication"))?;
    let (instructions, _) = sign(signable, &signing_params)
        .map_err(|_| AiError::new("authentication"))?
        .into_parts();
    let (headers, query_parameters) = instructions.into_parts();
    if !query_parameters.is_empty() {
        return Err(AiError::new("authentication"));
    }
    for header in headers {
        let name = HeaderName::from_bytes(header.name().as_bytes())
            .map_err(|_| AiError::new("authentication"))?;
        let mut value = HeaderValue::from_bytes(header.value().as_bytes())
            .map_err(|_| AiError::new("authentication"))?;
        value.set_sensitive(header.sensitive());
        request.headers_mut().insert(name, value);
    }
    Ok(())
}

fn bedrock_region(url: &url::Url) -> Option<String> {
    let host = url.host_str()?;
    let suffix = ".amazonaws.com";
    let host = host.strip_suffix(suffix)?;
    host.strip_prefix("bedrock-runtime.")
        .or_else(|| host.strip_prefix("bedrock-runtime-fips."))
        .or_else(|| host.strip_prefix("bedrock."))
        .filter(|region| !region.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, UNIX_EPOCH};

    use reqwest::header::CONTENT_TYPE;

    use super::*;

    #[test]
    fn signs_runtime_requests_with_bedrock_scope() {
        let client = reqwest::Client::new();
        let mut request = client
            .post("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse")
            .header(CONTENT_TYPE, "application/json")
            .body(b"{}".to_vec())
            .build()
            .unwrap();
        sign_bedrock_request_at(
            &mut request,
            r#"{"accessKeyId":"AKIDEXAMPLE","secretAccessKey":"secret","sessionToken":"session"}"#,
            b"{}",
            UNIX_EPOCH + Duration::from_secs(1_440_938_160),
        )
        .unwrap();
        let authorisation = request
            .headers()
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap();
        assert!(authorisation.contains("/us-east-1/bedrock/aws4_request"));
        assert!(request.headers().contains_key("x-amz-security-token"));
    }

    #[test]
    fn derives_regions_from_runtime_and_control_plane_hosts() {
        assert_eq!(
            bedrock_region(
                &url::Url::parse("https://bedrock-runtime.eu-west-1.amazonaws.com").unwrap()
            ),
            Some("eu-west-1".to_string())
        );
        assert_eq!(
            bedrock_region(&url::Url::parse("https://bedrock.us-east-1.amazonaws.com").unwrap()),
            Some("us-east-1".to_string())
        );
        assert_eq!(
            bedrock_region(
                &url::Url::parse("https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com")
                    .unwrap()
            ),
            Some("us-gov-west-1".to_string())
        );
    }

    #[test]
    fn distinguishes_iam_json_from_bearer_tokens() {
        assert!(is_iam_credentials_json(
            r#"{"accessKeyId":"AKIDEXAMPLE","secretAccessKey":"secret"}"#
        ));
        assert!(!is_iam_credentials_json("bedrock-api-key-token"));
        assert!(!is_iam_credentials_json(""));
        assert!(!is_iam_credentials_json(
            r#"{"accessKeyId":"","secretAccessKey":"secret"}"#
        ));
    }

    #[test]
    fn rejects_bearer_tokens_for_sigv4_signing() {
        let client = reqwest::Client::new();
        let mut request = client
            .post("https://bedrock-runtime.us-east-1.amazonaws.com/model/test/converse")
            .body(b"{}".to_vec())
            .build()
            .unwrap();
        let error = sign_bedrock_request(&mut request, "bedrock-api-key-token", b"{}").unwrap_err();
        assert_eq!(error.code, "apiKeyInvalid");
    }
}
