use super::conditional::ConditionalProvider;
use base64::{Engine, engine::general_purpose::STANDARD};
use url::Url;

pub struct GitLabProvider {
    client: reqwest::blocking::Client,
}

impl GitLabProvider {
    pub fn new() -> Self {
        Self {
            client: reqwest::blocking::Client::builder()
                .timeout(std::time::Duration::from_secs(5))
                .user_agent("gitmun/0.1")
                .build()
                .unwrap_or_else(|_| reqwest::blocking::Client::new()),
        }
    }

    fn remote_project(remote: &str) -> Option<(Url, String)> {
        let mut url = if remote.contains("://") {
            Url::parse(remote).ok()?
        } else {
            let (authority, path) = remote.split_once(':')?;
            if authority.contains('/') || remote.contains('\\') || path.is_empty() {
                return None;
            }
            Url::parse(&format!("ssh://{authority}/{path}")).ok()?
        };
        let project = url
            .path()
            .trim_start_matches('/')
            .trim_end_matches(".git")
            .to_string();
        if project.is_empty() {
            return None;
        }
        match url.scheme() {
            "http" | "https" => {}
            "ssh" => {
                // The SSH port is unrelated to the instance's web port.
                url.set_port(None).ok()?;
                url = Url::parse(&format!("https://{}/", url.host()?)).ok()?;
            }
            _ => return None,
        }
        url.host_str()?;
        url.set_username("").ok()?;
        url.set_password(None).ok()?;
        url.set_path("/");
        url.set_query(None);
        url.set_fragment(None);
        Some((url, project))
    }

    fn remote_projects(repo_path: &str) -> Vec<(Url, String)> {
        let Ok(output) = crate::configured_git_command()
            .args([
                "-C",
                repo_path,
                "config",
                "--get-regexp",
                r"^remote\..*\.url$",
            ])
            .output()
        else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let mut bases = Vec::new();
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some((_, remote)) = line.split_once(' ') {
                if let Some(base) = Self::remote_project(remote.trim()) {
                    if !bases.contains(&base) {
                        bases.push(base);
                    }
                }
            }
        }
        bases
    }

    fn fetch_from_instance(&self, email: &str, base: &Url) -> Option<String> {
        let mut endpoint = base.join("api/v4/avatar").ok()?;
        endpoint
            .query_pairs_mut()
            .append_pair("email", email)
            .append_pair("size", "64");
        let response = self
            .client
            .get(endpoint)
            .send()
            .ok()?
            .error_for_status()
            .ok()?;
        let body: serde_json::Value = response.json().ok()?;
        self.download_avatar(body.get("avatar_url")?.as_str()?, base)
    }

    fn find_author_commit(email: &str, repo_path: &str) -> Option<String> {
        let output = crate::configured_git_command()
            .args([
                "-C",
                repo_path,
                "log",
                "--all",
                "-n",
                "1",
                "--format=%H%x1f%ae",
                "--fixed-strings",
                "--regexp-ignore-case",
                &format!("--author=<{email}>"),
            ])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8(output.stdout).ok()?;
        let (sha, author_email) = text.trim().split_once('\u{1f}')?;
        author_email
            .eq_ignore_ascii_case(email)
            .then(|| sha.to_string())
    }

    fn fetch_commit_author(
        &self,
        email: &str,
        sha: &str,
        base: &Url,
        project: &str,
    ) -> Option<String> {
        let response = self.client.get(base.join("api/graphql").ok()?)
            .query(&[
                ("query", "query($project: ID!, $sha: String!) { project(fullPath: $project) { repository { commit(ref: $sha) { sha authorEmail author { avatarUrl } } } } }".to_string()),
                ("variables", serde_json::json!({"project": project, "sha": sha}).to_string()),
            ])
            .send().ok()?.error_for_status().ok()?;
        let body: serde_json::Value = response.json().ok()?;
        let commit = body.pointer("/data/project/repository/commit")?;
        if commit.get("sha")?.as_str()? != sha
            || !commit
                .get("authorEmail")?
                .as_str()?
                .eq_ignore_ascii_case(email)
        {
            return None;
        }
        self.download_avatar(commit.pointer("/author/avatarUrl")?.as_str()?, base)
    }

    fn download_avatar(&self, raw: &str, base: &Url) -> Option<String> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let avatar = base.join(raw).ok()?;
        if !matches!(avatar.scheme(), "http" | "https") {
            return None;
        }
        let response = self
            .client
            .get(avatar)
            .send()
            .ok()?
            .error_for_status()
            .ok()?;
        let content_type = response
            .headers()
            .get("content-type")?
            .to_str()
            .ok()?
            .split(';')
            .next()?
            .trim()
            .to_string();
        if !content_type.starts_with("image/") {
            return None;
        }
        let bytes = response.bytes().ok()?;
        if bytes.is_empty() {
            return None;
        }
        Some(format!(
            "data:{content_type};base64,{}",
            STANDARD.encode(&bytes)
        ))
    }
}

impl ConditionalProvider for GitLabProvider {
    fn applies_to(&self, repo_path: &str) -> bool {
        !Self::remote_projects(repo_path).is_empty()
    }

    fn fetch(&self, email: &str, repo_path: &str) -> Option<String> {
        let projects = Self::remote_projects(repo_path);
        // The email endpoint only matches public emails; commits can identify other verified emails.
        if let Some(sha) = Self::find_author_commit(email, repo_path) {
            if let Some(avatar) = projects
                .iter()
                .find_map(|(base, project)| self.fetch_commit_author(email, &sha, base, project))
            {
                return Some(avatar);
            }
        }
        projects
            .iter()
            .find_map(|(base, _)| self.fetch_from_instance(email, base))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    #[test]
    fn parses_self_hosted_remotes() {
        for (remote, expected) in [
            (
                "https://user:secret@code.example.org:8443/team/sub/repo.git",
                "https://code.example.org:8443/",
            ),
            (
                "http://code.example.org:8080/team/repo.git",
                "http://code.example.org:8080/",
            ),
            (
                "git@code.example.org:team/sub/repo.git",
                "https://code.example.org/",
            ),
            (
                "ssh://git@code.example.org:2222/team/repo.git",
                "https://code.example.org/",
            ),
        ] {
            assert_eq!(
                GitLabProvider::remote_project(remote).unwrap().0.as_str(),
                expected
            );
        }
        for remote in [
            "/tmp/repo",
            "../repo",
            "file:///tmp/repo",
            "C:\\repo",
            "git://code.example.org/repo",
        ] {
            assert!(GitLabProvider::remote_project(remote).is_none(), "{remote}");
        }
    }

    #[test]
    fn reads_projects_through_a_git_directory_file() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().join("repository");
        let git_directory = directory.path().join("git-directory");
        let output = crate::configured_git_command()
            .arg("init")
            .arg("--separate-git-dir")
            .arg(&git_directory)
            .arg(&repository)
            .output()
            .unwrap();
        assert!(output.status.success());
        std::fs::write(
            git_directory.join("config"),
            "[remote \"origin\"]\nurl = https://code.example.org/team/repo.git\n\
             [remote \"upstream\"]\nurl = git@code.example.org:team/upstream.git\n\
             [remote \"mirror\"]\nurl = https://mirror.example.org/team/repo.git\n",
        )
        .unwrap();
        assert_eq!(
            GitLabProvider::remote_projects(repository.to_str().unwrap()),
            vec![
                (
                    Url::parse("https://code.example.org/").unwrap(),
                    "team/repo".to_string()
                ),
                (
                    Url::parse("https://code.example.org/").unwrap(),
                    "team/upstream".to_string()
                ),
                (
                    Url::parse("https://mirror.example.org/").unwrap(),
                    "team/repo".to_string()
                ),
            ]
        );
    }

    #[test]
    fn prefers_commit_account_avatar_and_falls_back_when_unavailable() {
        for outcome in [
            "account",
            "no account",
            "wrong email",
            "wrong sha",
            "errors",
            "forbidden",
        ] {
            let repository = tempfile::tempdir().unwrap();
            for args in [
                vec!["init"],
                vec![
                    "-c",
                    "user.name=Example Author",
                    "-c",
                    "user.email=author+git@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Avatar fixture",
                ],
            ] {
                assert!(
                    crate::configured_git_command()
                        .arg("-C")
                        .arg(repository.path())
                        .args(args)
                        .output()
                        .unwrap()
                        .status
                        .success()
                );
            }
            let sha = GitLabProvider::find_author_commit(
                "author+git@example.com",
                repository.path().to_str().unwrap(),
            )
            .unwrap();
            assert!(
                GitLabProvider::find_author_commit(
                    "git@example.com",
                    repository.path().to_str().unwrap()
                )
                .is_none()
            );
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let base = format!("http://{}/", listener.local_addr().unwrap());
            assert!(
                crate::configured_git_command()
                    .arg("-C")
                    .arg(repository.path())
                    .args([
                        "remote",
                        "add",
                        "origin",
                        &format!("{base}team/subgroup/repo.git")
                    ])
                    .output()
                    .unwrap()
                    .status
                    .success()
            );
            let server = std::thread::spawn(move || {
                let mut commit = serde_json::json!({
                    "sha": sha, "authorEmail": "author+git@example.com",
                    "author": {"avatarUrl": "/uploads/local.png"}
                });
                match outcome {
                    "no account" => commit["author"] = serde_json::Value::Null,
                    "wrong email" => commit["authorEmail"] = "other@example.com".into(),
                    "wrong sha" => commit["sha"] = "different".into(),
                    _ => {}
                }
                let body = if outcome == "errors" {
                    serde_json::json!({"errors": [{"message": "Unavailable"}]})
                } else {
                    serde_json::json!({"data": {"project": {"repository": {"commit": commit}}}})
                };
                let mut responses = vec![("/api/graphql", "application/json", body.to_string())];
                if outcome != "account" {
                    responses.push((
                        "/api/v4/avatar",
                        "application/json",
                        r#"{"avatar_url":"/fallback.png"}"#.to_string(),
                    ));
                }
                responses.push((
                    if outcome == "account" {
                        "/uploads/local.png"
                    } else {
                        "/fallback.png"
                    },
                    "image/png",
                    outcome.to_string(),
                ));
                for (path, content_type, body) in responses {
                    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
                    let mut stream = loop {
                        match listener.accept() {
                            Ok((stream, _)) => break stream,
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                assert!(
                                    std::time::Instant::now() < deadline,
                                    "Missing request for {path}"
                                );
                                std::thread::sleep(std::time::Duration::from_millis(10));
                            }
                            Err(error) => panic!("{error}"),
                        }
                    };
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    reader.read_line(&mut request).unwrap();
                    let url = Url::parse(&format!(
                        "http://localhost{}",
                        request.split_whitespace().nth(1).unwrap()
                    ))
                    .unwrap();
                    assert_eq!(url.path(), path);
                    if path == "/api/graphql" {
                        let variables = url
                            .query_pairs()
                            .find(|(key, _)| key == "variables")
                            .unwrap()
                            .1
                            .into_owned();
                        let variables: serde_json::Value =
                            serde_json::from_str(&variables).unwrap();
                        assert_eq!(
                            variables,
                            serde_json::json!({"project": "team/subgroup/repo", "sha": sha})
                        );
                    }
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        if header == "\r\n" || header.is_empty() {
                            break;
                        }
                    }
                    let status = if outcome == "forbidden" && path == "/api/graphql" {
                        "403 Forbidden"
                    } else {
                        "200 OK"
                    };
                    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            });
            let provider = GitLabProvider {
                client: reqwest::blocking::Client::builder()
                    .no_proxy()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .unwrap(),
            };
            assert_eq!(
                provider.fetch(
                    "author+git@example.com",
                    repository.path().to_str().unwrap()
                ),
                Some(format!(
                    "data:image/png;base64,{}",
                    STANDARD.encode(outcome)
                ))
            );
            server.join().unwrap();
        }
    }

    #[test]
    fn downloads_uploaded_avatar_and_handles_missing_or_restricted_avatars() {
        for (status, body, image_type, expected) in [
            (
                "200 OK",
                r#"{"avatar_url":"/uploads/-/system/user/avatar/42/avatar.png"}"#,
                "image/png",
                Some("data:image/png;base64,YXZhdGFy"),
            ),
            ("200 OK", r#"{"avatar_url":null}"#, "", None),
            ("200 OK", r#"{"avatar_url":""}"#, "", None),
            ("403 Forbidden", r#"{"message":"403 Forbidden"}"#, "", None),
            (
                "200 OK",
                r#"{"avatar_url":"/users/sign_in"}"#,
                "text/html",
                None,
            ),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let server = std::thread::spawn(move || {
                for (index, (response_status, response_type, response_body)) in
                    std::iter::once((status, "application/json", body))
                        .chain((!image_type.is_empty()).then_some(("200 OK", image_type, "avatar")))
                        .enumerate()
                {
                    let (mut stream, _) = listener.accept().unwrap();
                    stream
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    reader.read_line(&mut request).unwrap();
                    if index == 0 {
                        assert_eq!(
                            request.trim(),
                            "GET /api/v4/avatar?email=author%2Bgit%40example.com&size=64 HTTP/1.1"
                        );
                    } else {
                        assert!(
                            request.contains("/uploads/") || request.contains("/users/sign_in")
                        );
                    }
                    loop {
                        let mut header = String::new();
                        reader.read_line(&mut header).unwrap();
                        if header == "\r\n" || header.is_empty() {
                            break;
                        }
                    }
                    write!(stream, "HTTP/1.1 {response_status}\r\nContent-Type: {response_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response_body}", response_body.len()).unwrap();
                }
            });
            let provider = GitLabProvider {
                client: reqwest::blocking::Client::builder()
                    .no_proxy()
                    .timeout(std::time::Duration::from_secs(5))
                    .build()
                    .unwrap(),
            };
            assert_eq!(
                provider
                    .fetch_from_instance("author+git@example.com", &base)
                    .as_deref(),
                expected
            );
            server.join().unwrap();
        }
    }
}
