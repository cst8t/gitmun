use super::provider::AvatarProvider;
use base64::{engine::general_purpose::STANDARD, Engine};

/// Fetches avatars from Libravatar (https://libravatar.org).
///
/// Uses `d=404` so that a missing avatar returns HTTP 404 rather than a
/// default placeholder image.
pub struct LibravatarProvider {
    client: reqwest::blocking::Client,
}

impl LibravatarProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .user_agent("gitmun/0.1")
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new()),
        }
    }
}

impl AvatarProvider for LibravatarProvider {
    fn fetch(&self, email: &str) -> Option<String> {
        let hash = format!("{:x}", md5::compute(email.as_bytes()));
        let url = format!("https://seccdn.libravatar.org/avatar/{}?s=64&d=404", hash);

        let response = self.client.get(&url).send().ok()?;
        if !response.status().is_success() {
            return None;
        }

        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .trim()
            .to_string();

        let bytes = response.bytes().ok()?;
        if bytes.is_empty() {
            return None;
        }

        Some(format!(
            "data:{};base64,{}",
            content_type,
            STANDARD.encode(&bytes)
        ))
    }
}
