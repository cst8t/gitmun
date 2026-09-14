mod conditional;
mod forgejo;
mod github;
mod gitlab;
mod libravatar;
mod provider;

pub use conditional::ConditionalProvider;
pub use provider::AvatarProvider;

use crate::git::types::AvatarProviderMode;
use forgejo::ForgejoProvider;
use github::GitHubProvider;
use gitlab::GitLabProvider;
use libravatar::LibravatarProvider;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

pub struct AvatarService {
    mode: Mutex<AvatarProviderMode>,
    provider: Mutex<Option<Box<dyn AvatarProvider>>>,
    conditional_providers: Vec<Box<dyn ConditionalProvider>>,
    try_platform_first: Mutex<bool>,
    cache: Mutex<HashMap<(String, String), String>>,
}

fn make_provider(mode: &AvatarProviderMode) -> Option<Box<dyn AvatarProvider>> {
    match mode {
        AvatarProviderMode::Off => None,
        AvatarProviderMode::Libravatar => Some(Box::new(LibravatarProvider::new())),
    }
}

fn lock_or_recover<'a, T>(mutex: &'a Mutex<T>, name: &str) -> MutexGuard<'a, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            eprintln!("Recovering from poisoned avatar mutex: {name}");
            poisoned.into_inner()
        }
    }
}

impl AvatarService {
    pub fn new(mode: AvatarProviderMode, try_platform_first: bool) -> Self {
        let provider = make_provider(&mode);
        Self {
            mode: Mutex::new(mode),
            provider: Mutex::new(provider),
            conditional_providers: vec![
                Box::new(GitHubProvider::new()),
                Box::new(ForgejoProvider::new()),
                Box::new(GitLabProvider::new()),
            ],
            try_platform_first: Mutex::new(try_platform_first),
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_mode(&self, new_mode: AvatarProviderMode) {
        let mut mode = lock_or_recover(&self.mode, "mode");
        if *mode == new_mode {
            return;
        }
        *mode = new_mode.clone();
        *lock_or_recover(&self.provider, "provider") = make_provider(&new_mode);
        lock_or_recover(&self.cache, "cache").clear();
    }

    pub fn set_try_platform_first(&self, value: bool) {
        let mut flag = lock_or_recover(&self.try_platform_first, "try_platform_first");
        if *flag == value {
            return;
        }
        *flag = value;
        lock_or_recover(&self.cache, "cache").clear();
    }

    pub fn fetch(&self, email: &str, repo_path: &str) -> Option<String> {
        let key_email = email.trim().to_lowercase();
        let cache_key = (key_email.clone(), repo_path.to_string());

        {
            let cache = lock_or_recover(&self.cache, "cache");
            if let Some(cached) = cache.get(&cache_key) {
                return Some(cached.clone());
            }
        }

        let try_first = *lock_or_recover(&self.try_platform_first, "try_platform_first");

        let result = if try_first {
            let conditional_result = self
                .conditional_providers
                .iter()
                .filter(|p| p.applies_to(repo_path))
                .find_map(|p| p.fetch(&key_email, repo_path));
            conditional_result.or_else(|| self.fetch_from_provider(&key_email))
        } else {
            self.fetch_from_provider(&key_email)
        };

        if let Some(ref avatar_url) = result {
            lock_or_recover(&self.cache, "cache").insert(cache_key, avatar_url.clone());
        }
        result
    }

    fn fetch_from_provider(&self, email: &str) -> Option<String> {
        let provider = lock_or_recover(&self.provider, "provider");
        provider.as_ref().and_then(|p| p.fetch(email))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct PlatformAvatar(Option<&'static str>);

    impl ConditionalProvider for PlatformAvatar {
        fn applies_to(&self, _repo_path: &str) -> bool {
            true
        }

        fn fetch(&self, _email: &str, _repo_path: &str) -> Option<String> {
            self.0.map(str::to_string)
        }
    }

    #[test]
    fn tries_next_platform_when_first_has_no_avatar() {
        let mut service = AvatarService::new(AvatarProviderMode::Off, true);
        service.conditional_providers = vec![
            Box::new(PlatformAvatar(None)),
            Box::new(PlatformAvatar(Some("data:image/png;base64,YXZhdGFy"))),
        ];
        assert_eq!(
            service.fetch("author@example.com", "/tmp/avatar-repository"),
            Some("data:image/png;base64,YXZhdGFy".to_string())
        );
        service.set_try_platform_first(false);
        assert_eq!(
            service.fetch("author@example.com", "/tmp/avatar-repository"),
            None
        );
    }
}
