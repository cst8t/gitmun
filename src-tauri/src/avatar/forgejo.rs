use super::conditional::ConditionalProvider;
use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::Path;
use url::Url;

// Forgejo/Gitea hash avatars using HMAC-SHA1 with an instance-secret, so
// /avatars/{hash} can't be probed from an email alone - hence the API steps.
pub struct ForgejoProvider {
    client: reqwest::blocking::Client,
}

impl ForgejoProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .user_agent("gitmun/0.1")
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new()),
        }
    }

    fn parse_base_url(repo_path: &str) -> Option<String> {
        let config_path = Path::new(repo_path).join(".git").join("config");
        let content = fs::read_to_string(config_path).ok()?;

        for line in content.lines() {
            let line = line.trim();
            if !line.starts_with("url =") {
                continue;
            }
            let url = line["url =".len()..].trim();

            if let Some(scheme_end) = url.find("://") {
                let scheme = &url[..scheme_end];
                let after_scheme = &url[scheme_end + 3..];
                let authority = match after_scheme.find('/') {
                    Some(slash) => &after_scheme[..slash],
                    None => after_scheme,
                };
                let host = authority
                    .rsplit_once('@')
                    .map(|(_, h)| h)
                    .unwrap_or(authority);
                if !host.is_empty() {
                    let out_scheme = if scheme == "http" || scheme == "https" {
                        scheme
                    } else {
                        "https"
                    };
                    return Some(format!("{}://{}", out_scheme, host));
                }
            }

            // SCP-like SSH: git@host:owner/repo.git
            if let Some(at_pos) = url.find('@') {
                if let Some(colon_offset) = url[at_pos + 1..].find(':') {
                    let host = &url[at_pos + 1..at_pos + 1 + colon_offset];
                    if !host.is_empty() {
                        return Some(format!("https://{}", host));
                    }
                }
            }
        }

        None
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

            if let Some(scheme_end) = url.find("://") {
                let after_scheme = &url[scheme_end + 3..];
                let path_start = after_scheme.find('/')?;
                let path = &after_scheme[path_start + 1..];
                return Self::split_owner_repo(path);
            }

            if let Some(at_pos) = url.find('@') {
                if let Some(colon_offset) = url[at_pos + 1..].find(':') {
                    let path = &url[at_pos + 1 + colon_offset + 1..];
                    return Self::split_owner_repo(path);
                }
            }
        }

        None
    }

    fn split_owner_repo(path: &str) -> Option<(String, String)> {
        let clean = path.trim().trim_start_matches('/').trim_end_matches(".git");
        let mut parts = clean.splitn(2, '/');
        let owner = parts.next()?.trim();
        let repo = parts.next()?.trim();
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        Some((owner.to_string(), repo.to_string()))
    }

    fn host_from_base_url(base_url: &str) -> Option<String> {
        Url::parse(base_url)
            .ok()?
            .host_str()
            .map(|h| h.to_string())
    }

    fn base_domain(host: &str) -> &str {
        host.find('.')
            .map(|i| {
                let rest = &host[i + 1..];
                if rest.contains('.') {
                    rest
                } else {
                    host
                }
            })
            .unwrap_or(host)
    }

    fn extract_instance_username(email: &str, instance_host: &str) -> Option<String> {
        let email = email.trim();
        let (local, domain) = email.split_once('@')?;
        if local.is_empty() || domain.is_empty() {
            return None;
        }
        let domain_lc = domain.to_ascii_lowercase();
        let instance_lc = instance_host.to_ascii_lowercase();
        let base = Self::base_domain(&instance_lc);

        if domain_lc != base && !domain_lc.ends_with(&format!(".{}", base)) {
            return None;
        }

        // Strip optional numeric `id+` prefix (Gitea/Forgejo noreply style).
        let candidate = local.rsplit_once('+').map(|(_, u)| u).unwrap_or(local);
        let candidate = candidate.trim();
        if candidate.is_empty() {
            return None;
        }
        Some(candidate.to_string())
    }

    fn resolve_avatar_url(&self, raw: &str, base_url: &str) -> String {
        if raw.starts_with("http://") || raw.starts_with("https://") {
            raw.to_string()
        } else {
            format!("{}{}", base_url, raw)
        }
    }

    fn fetch_png_as_data_url(&self, url: &str) -> Option<String> {
        let resp = self.client.get(url).send().ok()?;
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

    fn fetch_by_user_api(&self, username: &str, base_url: &str) -> Option<String> {
        let url = format!("{}/api/v1/users/{}", base_url, username);
        let resp = self.client.get(&url).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: serde_json::Value = serde_json::from_str(&resp.text().ok()?).ok()?;
        let avatar_url = body
            .get("avatar_url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())?;
        let resolved = self.resolve_avatar_url(avatar_url, base_url);
        self.fetch_png_as_data_url(&resolved)
    }

    fn fetch_by_user_search(&self, email: &str, base_url: &str) -> Option<String> {
        let mut url = Url::parse(&format!("{}/api/v1/users/search", base_url)).ok()?;
        url.query_pairs_mut()
            .append_pair("q", email.trim())
            .append_pair("limit", "2");
        let resp = self.client.get(url).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let body: serde_json::Value = serde_json::from_str(&resp.text().ok()?).ok()?;
        if !body.get("ok").and_then(|v| v.as_bool()).unwrap_or(true) {
            return None;
        }
        let data = body.get("data")?.as_array()?;
        if data.len() != 1 {
            return None;
        }
        let avatar_url = data[0]
            .get("avatar_url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())?;
        let resolved = self.resolve_avatar_url(avatar_url, base_url);
        self.fetch_png_as_data_url(&resolved)
    }

    fn find_local_commit_sha(email: &str, repo_path: &str) -> Option<String> {
        let output = crate::git_command()
            .arg("-C")
            .arg(repo_path)
            .arg("log")
            .arg("-n")
            .arg("1")
            .arg("--format=%ae%x1f%H")
            .arg(format!("--author={}", email))
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.lines().next()?.trim();
        if line.is_empty() {
            return None;
        }
        let mut parts = line.splitn(2, '\u{1f}');
        let found_email = parts.next()?.trim();
        let sha = parts.next()?.trim();
        if found_email.eq_ignore_ascii_case(email.trim()) {
            Some(sha.to_string())
        } else {
            None
        }
    }

    fn fetch_by_commit_lookup(
        &self,
        email: &str,
        base_url: &str,
        repo_path: &str,
    ) -> Option<String> {
        let (owner, repo) = Self::parse_owner_repo(repo_path)?;
        let sha = Self::find_local_commit_sha(email, repo_path)?;

        let url = format!(
            "{}/api/v1/repos/{}/{}/git/commits/{}",
            base_url, owner, repo, sha
        );
        let resp = self.client.get(&url).send().ok()?;
        if !resp.status().is_success() {
            return None;
        }

        let body: serde_json::Value = serde_json::from_str(&resp.text().ok()?).ok()?;

        // Verify the email in the API response matches to avoid stale data.
        let api_email = body
            .get("commit")
            .and_then(|c| c.get("author"))
            .and_then(|a| a.get("email"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !api_email.eq_ignore_ascii_case(email.trim()) {
            return None;
        }

        let avatar_url = body
            .get("author")
            .and_then(|a| a.get("avatar_url"))
            .and_then(|v| v.as_str())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                body.get("committer")
                    .and_then(|c| c.get("avatar_url"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
            })?;

        let resolved = self.resolve_avatar_url(avatar_url, base_url);
        self.fetch_png_as_data_url(&resolved)
    }
}

impl ConditionalProvider for ForgejoProvider {
    fn applies_to(&self, repo_path: &str) -> bool {
        Self::parse_base_url(repo_path).is_some()
    }

    fn fetch(&self, email: &str, repo_path: &str) -> Option<String> {
        let base_url = Self::parse_base_url(repo_path)?;
        let host = Self::host_from_base_url(&base_url)?;

        // Step 1: email on the instance's domain → /api/v1/users/{username}
        if let Some(username) = Self::extract_instance_username(email, &host) {
            if let Some(found) = self.fetch_by_user_api(&username, &base_url) {
                return Some(found);
            }
        }

        // Step 2: /api/v1/users/search?q=<email> (single unambiguous match only)
        if let Some(found) = self.fetch_by_user_search(email, &base_url) {
            return Some(found);
        }

        // Step 3: local commit → /api/v1/repos/{owner}/{repo}/git/commits/{sha}
        // (fails silently for private repos without auth)
        self.fetch_by_commit_lookup(email, &base_url, repo_path)
    }
}
