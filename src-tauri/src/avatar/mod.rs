mod conditional;
mod forgejo;
mod github;
mod libravatar;
mod provider;

pub use conditional::ConditionalProvider;
pub use provider::AvatarProvider;

use crate::git::types::AvatarProviderMode;
use forgejo::ForgejoProvider;
use github::GitHubProvider;
use libravatar::LibravatarProvider;
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

pub struct AvatarService {
    mode: Mutex<AvatarProviderMode>,
    provider: Mutex<Option<Box<dyn AvatarProvider>>>,
    conditional_providers: Vec<Box<dyn ConditionalProvider>>,
    try_platform_first: Mutex<bool>,
    cache: Mutex<HashMap<(String, String), Option<String>>>,
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
                // Add further platform providers here, e.g.:
                // Box::new(GitLabProvider::new()),
                // Box::new(BitbucketProvider::new()),
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
                return cached.clone();
            }
        }

        let try_first = *lock_or_recover(&self.try_platform_first, "try_platform_first");

        let result = if try_first {
            let conditional_result = self
                .conditional_providers
                .iter()
                .find(|p| p.applies_to(repo_path))
                .and_then(|p| p.fetch(&key_email, repo_path));
            conditional_result.or_else(|| self.fetch_from_provider(&key_email))
        } else {
            self.fetch_from_provider(&key_email)
        };

        lock_or_recover(&self.cache, "cache").insert(cache_key, result.clone());
        result
    }

    fn fetch_from_provider(&self, email: &str) -> Option<String> {
        let provider = lock_or_recover(&self.provider, "provider");
        provider.as_ref().and_then(|p| p.fetch(email))
    }
}
