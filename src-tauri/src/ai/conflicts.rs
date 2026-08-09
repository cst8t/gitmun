use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::AiError;

const SESSION_LIFETIME: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub(crate) struct ConflictReplacement {
    pub id: String,
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

#[derive(Clone)]
pub(crate) struct ConflictSession {
    pub repository: PathBuf,
    pub file_path: String,
    pub original: Vec<u8>,
    pub current_hash: md5::Digest,
    pub unmerged_index: Vec<u8>,
    pub resolved_index: Option<Vec<u8>>,
    pub replacements: Vec<ConflictReplacement>,
    pub applied_ids: HashSet<String>,
    created_at: Instant,
}

impl ConflictSession {
    pub fn new(
        repository: PathBuf,
        file_path: String,
        original: Vec<u8>,
        unmerged_index: Vec<u8>,
        replacements: Vec<ConflictReplacement>,
    ) -> Self {
        Self {
            repository,
            file_path,
            current_hash: md5::compute(&original),
            original,
            unmerged_index,
            resolved_index: None,
            replacements,
            applied_ids: HashSet::new(),
            created_at: Instant::now(),
        }
    }
}

#[derive(Default)]
pub(crate) struct ConflictSessionStore {
    sessions: Mutex<HashMap<String, ConflictSession>>,
}

impl ConflictSessionStore {
    pub fn insert(&self, id: String, session: ConflictSession) -> Result<(), AiError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AiError::new("conflictSessionUnavailable"))?;
        sessions.retain(|_, session| session.created_at.elapsed() <= SESSION_LIFETIME);
        sessions.insert(id, session);
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<ConflictSession, AiError> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AiError::new("conflictSessionUnavailable"))?;
        sessions
            .get(id)
            .filter(|session| session.created_at.elapsed() <= SESSION_LIFETIME)
            .cloned()
            .ok_or_else(|| AiError::new("conflictProposalExpired"))
    }

    pub fn mutate<T>(
        &self,
        id: &str,
        f: impl FnOnce(&mut ConflictSession) -> Result<T, AiError>,
    ) -> Result<T, AiError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AiError::new("conflictSessionUnavailable"))?;
        let session = sessions
            .get_mut(id)
            .filter(|session| session.created_at.elapsed() <= SESSION_LIFETIME)
            .ok_or_else(|| AiError::new("conflictProposalExpired"))?;
        f(session)
    }

    pub fn remove(&self, id: &str) -> Result<(), AiError> {
        self.sessions
            .lock()
            .map_err(|_| AiError::new("conflictSessionUnavailable"))?
            .remove(id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn mutate_serialises_concurrent_updates() {
        let store = Arc::new(ConflictSessionStore::default());
        store
            .insert(
                "proposal".to_string(),
                ConflictSession::new(
                    PathBuf::from("/tmp/repo"),
                    "conflicted.txt".to_string(),
                    b"original".to_vec(),
                    b"index".to_vec(),
                    vec![
                        ConflictReplacement {
                            id: "a".to_string(),
                            start: 0,
                            end: 1,
                            replacement: "one".to_string(),
                        },
                        ConflictReplacement {
                            id: "b".to_string(),
                            start: 2,
                            end: 3,
                            replacement: "two".to_string(),
                        },
                    ],
                ),
            )
            .unwrap();

        let left = Arc::clone(&store);
        let right = Arc::clone(&store);
        let first = thread::spawn(move || {
            left.mutate("proposal", |session| {
                session.applied_ids.insert("a".to_string());
                Ok(())
            })
        });
        let second = thread::spawn(move || {
            right.mutate("proposal", |session| {
                session.applied_ids.insert("b".to_string());
                Ok(())
            })
        });
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();

        let session = store.get("proposal").unwrap();
        assert!(session.applied_ids.contains("a"));
        assert!(session.applied_ids.contains("b"));
    }
}
