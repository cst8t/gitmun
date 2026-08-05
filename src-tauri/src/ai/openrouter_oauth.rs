use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use super::AiError;
use super::api::AiRuntime;
use super::providers::openrouter::exchange_openrouter_oauth_code;

const OPENROUTER_AUTH_URL: &str = "https://openrouter.ai/auth";
const CALLBACK_PATH: &str = "/callback";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(2 * 60);
const CALLBACK_POLL_INTERVAL: Duration = Duration::from_millis(25);
const CALLBACK_READ_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_CALLBACK_REQUEST_BYTES: usize = 16 * 1024;
const MAX_AUTH_CODE_BYTES: usize = 4096;
const MAX_CALLBACK_MESSAGE_BYTES: usize = 512;

pub(crate) async fn authorise(
    runtime: &AiRuntime,
    app: &tauri::AppHandle,
    callback_message: String,
) -> Result<String, AiError> {
    validate_callback_message(&callback_message)?;
    let (code_verifier, code_challenge) = create_pkce_pair()?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|_| AiError::new("openRouterOAuthUnavailable"))?;
    listener
        .set_nonblocking(true)
        .map_err(|_| AiError::new("openRouterOAuthUnavailable"))?;
    let port = listener
        .local_addr()
        .map_err(|_| AiError::new("openRouterOAuthUnavailable"))?
        .port();
    let callback_url = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let authorisation_url = authorisation_url(&callback_url, &code_challenge)?;
    app.opener()
        .open_url(authorisation_url.to_string(), None::<&str>)
        .map_err(|_| AiError::new("openRouterOAuthUnavailable"))?;

    let code = tauri::async_runtime::spawn_blocking(move || {
        wait_for_callback(listener, &callback_message)
    })
    .await
    .map_err(|_| AiError::new("openRouterOAuthUnavailable"))??;

    exchange_openrouter_oauth_code(runtime, &code, &code_verifier).await
}

fn validate_callback_message(message: &str) -> Result<(), AiError> {
    if message.trim().is_empty()
        || message.len() > MAX_CALLBACK_MESSAGE_BYTES
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(AiError::new("openRouterOAuthUnavailable"));
    }
    Ok(())
}

fn create_pkce_pair() -> Result<(String, String), AiError> {
    let mut random_bytes = [0_u8; 32];
    getrandom::fill(&mut random_bytes).map_err(|_| AiError::new("openRouterOAuthUnavailable"))?;
    let code_verifier = URL_SAFE_NO_PAD.encode(random_bytes);
    let code_challenge = pkce_challenge(&code_verifier);
    Ok((code_verifier, code_challenge))
}

fn pkce_challenge(code_verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()))
}

fn authorisation_url(callback_url: &str, code_challenge: &str) -> Result<Url, AiError> {
    let mut url =
        Url::parse(OPENROUTER_AUTH_URL).map_err(|_| AiError::new("openRouterOAuthUnavailable"))?;
    url.query_pairs_mut()
        .append_pair("callback_url", callback_url)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url)
}

fn wait_for_callback(listener: TcpListener, callback_message: &str) -> Result<String, AiError> {
    let deadline = Instant::now() + CALLBACK_TIMEOUT;
    while Instant::now() < deadline {
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(CALLBACK_READ_TIMEOUT))
                    .map_err(|_| AiError::new("openRouterOAuthInvalidCallback"))?;
                let request = read_callback_request(&mut stream)?;
                match parse_callback_code(&request) {
                    Ok(Some(code)) => {
                        write_callback_page(&mut stream, callback_message);
                        return Ok(code);
                    }
                    Ok(None) => write_empty_response(&mut stream, "404 Not Found"),
                    Err(error) => {
                        write_callback_page(&mut stream, callback_message);
                        return Err(error);
                    }
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {
                std::thread::sleep(CALLBACK_POLL_INTERVAL);
            }
            Err(_) => return Err(AiError::new("openRouterOAuthUnavailable")),
        }
    }
    Err(AiError::new("openRouterOAuthTimedOut"))
}

fn read_callback_request(stream: &mut TcpStream) -> Result<Vec<u8>, AiError> {
    let mut request = Vec::with_capacity(1024);
    let mut buffer = [0_u8; 1024];
    loop {
        let bytes_read = stream
            .read(&mut buffer)
            .map_err(|_| AiError::new("openRouterOAuthInvalidCallback"))?;
        if bytes_read == 0 {
            break;
        }
        if request.len().saturating_add(bytes_read) > MAX_CALLBACK_REQUEST_BYTES {
            return Err(AiError::new("openRouterOAuthInvalidCallback"));
        }
        request.extend_from_slice(&buffer[..bytes_read]);
        if request.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    Ok(request)
}

fn parse_callback_code(request: &[u8]) -> Result<Option<String>, AiError> {
    let request =
        std::str::from_utf8(request).map_err(|_| AiError::new("openRouterOAuthInvalidCallback"))?;
    let Some(request_line) = request.lines().next() else {
        return Ok(None);
    };
    let mut parts = request_line.split_whitespace();
    if parts.next() != Some("GET") {
        return Ok(None);
    }
    let Some(target) = parts.next() else {
        return Ok(None);
    };
    if !matches!(parts.next(), Some("HTTP/1.0" | "HTTP/1.1")) || parts.next().is_some() {
        return Ok(None);
    }
    let callback = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| AiError::new("openRouterOAuthInvalidCallback"))?;
    if callback.path() != CALLBACK_PATH {
        return Ok(None);
    }
    if callback.query_pairs().any(|(name, _)| name == "error") {
        return Err(AiError::new("openRouterOAuthDenied"));
    }
    let codes: Vec<String> = callback
        .query_pairs()
        .filter(|(name, _)| name == "code")
        .map(|(_, value)| value.into_owned())
        .collect();
    if codes.len() != 1
        || codes[0].is_empty()
        || codes[0].len() > MAX_AUTH_CODE_BYTES
        || codes[0].chars().any(char::is_control)
    {
        return Err(AiError::new("openRouterOAuthInvalidCallback"));
    }
    Ok(codes.into_iter().next())
}

fn write_callback_page(stream: &mut TcpStream, message: &str) {
    let message = escape_html(message);
    let body = format!(
        "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Gitmun</title><style>body{{margin:0;padding:32px;background:#111827;color:#e5e7eb;font:16px system-ui,sans-serif}}main{{max-width:560px;margin:15vh auto;padding:24px;border:1px solid #374151;border-radius:12px;background:#1f2937}}h1{{margin:0 0 12px;font-size:22px}}p{{margin:0;line-height:1.5}}</style><main><h1>Gitmun</h1><p>{message}</p></main>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    drop(stream.write_all(response.as_bytes()));
}

fn write_empty_response(stream: &mut TcpStream, status: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    drop(stream.write_all(response.as_bytes()));
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_the_rfc_7636_s256_challenge() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn builds_an_openrouter_authorisation_url_for_the_loopback_callback() {
        let url = authorisation_url("http://127.0.0.1:51423/callback", "challenge").unwrap();
        let parameters: std::collections::HashMap<_, _> = url.query_pairs().collect();

        assert_eq!(url.origin().ascii_serialization(), "https://openrouter.ai");
        assert_eq!(
            parameters.get("callback_url").unwrap(),
            "http://127.0.0.1:51423/callback"
        );
        assert_eq!(parameters.get("code_challenge").unwrap(), "challenge");
        assert_eq!(parameters.get("code_challenge_method").unwrap(), "S256");
    }

    #[test]
    fn accepts_only_one_code_on_the_expected_callback_path() {
        let code = parse_callback_code(
            b"GET /callback?code=auth_code_123 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .unwrap();
        assert_eq!(code.as_deref(), Some("auth_code_123"));

        let error = parse_callback_code(
            b"GET /callback?code=one&code=two HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .unwrap_err();
        assert_eq!(error.code, "openRouterOAuthInvalidCallback");
        assert!(
            parse_callback_code(b"GET /favicon.ico HTTP/1.1\r\n\r\n")
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn recognises_denied_authorisation_and_escapes_callback_copy() {
        let error = parse_callback_code(
            b"GET /callback?error=access_denied HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        )
        .unwrap_err();
        assert_eq!(error.code, "openRouterOAuthDenied");
        assert_eq!(
            escape_html("Return to <Gitmun> & close"),
            "Return to &lt;Gitmun&gt; &amp; close"
        );
    }
}
