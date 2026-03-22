pub trait ConditionalProvider: Send + Sync {
    fn applies_to(&self, repo_path: &str) -> bool;
    fn fetch(&self, email: &str, repo_path: &str) -> Option<String>;
}

pub fn remote_matches_host(repo_path: &str, host: &str) -> bool {
    let config_path = std::path::Path::new(repo_path).join(".git").join("config");
    std::fs::read_to_string(config_path)
        .map(|content| content.contains(host))
        .unwrap_or(false)
}
