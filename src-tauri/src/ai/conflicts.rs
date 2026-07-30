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

    pub fn update(&self, id: &str, session: ConflictSession) -> Result<(), AiError> {
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AiError::new("conflictSessionUnavailable"))?;
        if !sessions.contains_key(id) {
            return Err(AiError::new("conflictProposalExpired"));
        }
        sessions.insert(id.to_string(), session);
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), AiError> {
        self.sessions
            .lock()
            .map_err(|_| AiError::new("conflictSessionUnavailable"))?
            .remove(id);
        Ok(())
    }
}
