use super::conditional::{remote_matches_host, ConditionalProvider};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::Path;

pub struct GitHubProvider {
    client: reqwest::blocking::Client,
}

impl GitHubProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .user_agent("gitmun/0.1")
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new()),
        }
    }

    fn parse_noreply_username(email: &str) -> Option<String> {
        let lower = email.to_lowercase();
        if !lower.ends_with("@users.noreply.github.com") {
            return None;
        }
        let local = lower.split('@').next()?;
        if let Some(plus_pos) = local.find('+') {
            Some(local[plus_pos + 1..].to_string())
        } else {
            Some(local.to_string())
        }
    }

    fn parse_owner_repo(repo_path: &str) -> Option<(String, String)> {
        let config_path = Path::new(repo_path).join(".git").join("config");
        let content = fs::read_to_string(config_path).ok()?;

        for line in content.lines() {
            let line = line.trim();
            if !line.starts_with("url =") {
                continue;
            }
            let url = line["url =".len()..].trim();
            if !url.contains("github.com") {
                continue;
            }

            // HTTPS: https://github.com/owner/repo.git
            // SSH:   git@github.com:owner/repo.git
            let path_part = if let Some(pos) = url.find("github.com/") {
                &url[pos + "github.com/".len()..]
            } else if let Some(pos) = url.find("github.com:") {
                &url[pos + "github.com:".len()..]
            } else {
                continue;
            };

            let path_clean = path_part.trim_end_matches(".git");
            let mut parts = path_clean.splitn(2, '/');
            if let (Some(owner), Some(repo)) = (parts.next(), parts.next()) {
                let owner = owner.trim();
                let repo = repo.trim();
                if !owner.is_empty() && !repo.is_empty() {
                    return Some((owner.to_string(), repo.to_string()));
                }
            }
        }
        None
    }

    fn fetch_by_commits_api(&self, email: &str, owner: &str, repo: &str) -> Option<String> {
        let encoded_email = email
            .replace('%', "%25")
            .replace('+', "%2B")
            .replace('@', "%40")
            .replace(' ', "%20");

        let url = format!(
            "https://api.github.com/repos/{}/{}/commits?author={}&per_page=1",
            owner, repo, encoded_email
        );

        let resp = self
            .client
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28")
            .send()
            .ok()?;

        if !resp.status().is_success() {
            return None;
        }

        let text = resp.text().ok()?;
        let body: serde_json::Value = serde_json::from_str(&text).ok()?;
        let login = body
            .as_array()?
            .first()?
            .get("author")?
            .get("login")?
            .as_str()?
            .to_string();

        self.fetch_png_avatar(&login)
    }

    fn fetch_png_avatar(&self, username: &str) -> Option<String> {
        let url = format!("https://github.com/{}.png?size=64", username);
        let resp = self.client.get(&url).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }

        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .split(';')
            .next()
            .unwrap_or("image/png")
            .trim()
            .to_string();

        let bytes = resp.bytes().ok()?;
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

impl ConditionalProvider for GitHubProvider {
    fn applies_to(&self, repo_path: &str) -> bool {
        remote_matches_host(repo_path, "github.com")
    }

    fn fetch(&self, email: &str, repo_path: &str) -> Option<String> {
        // Fast path: GitHub noreply address - username is encoded in the email.
        if let Some(username) = Self::parse_noreply_username(email) {
            return self.fetch_png_avatar(&username);
        }

        // Slow path: real email - use the commits API to find the GitHub login.
        let (owner, repo) = Self::parse_owner_repo(repo_path)?;
        self.fetch_by_commits_api(email, &owner, &repo)
    }
}
