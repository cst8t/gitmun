use std::collections::HashMap;
use std::sync::Mutex;

use tokio_util::sync::CancellationToken;

use super::AiError;

#[derive(Default)]
pub(crate) struct AiOperationRegistry {
    operations: Mutex<HashMap<String, CancellationToken>>,
}

impl AiOperationRegistry {
    pub fn begin(&self, operation_id: &str) -> Result<CancellationToken, AiError> {
        if operation_id.is_empty()
            || operation_id.len() > 128
            || !operation_id.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            })
        {
            return Err(AiError::new("invalidOperationId"));
        }
        let mut operations = self
            .operations
            .lock()
            .map_err(|_| AiError::new("operationUnavailable"))?;
        if operations.contains_key(operation_id) {
            return Err(AiError::new("operationAlreadyActive"));
        }
        let cancellation = CancellationToken::new();
        operations.insert(operation_id.to_string(), cancellation.clone());
        Ok(cancellation)
    }

    pub fn cancel(&self, operation_id: &str) -> Result<(), AiError> {
        let operations = self
            .operations
            .lock()
            .map_err(|_| AiError::new("operationUnavailable"))?;
        operations
            .get(operation_id)
            .ok_or_else(|| AiError::new("operationNotFound"))?
            .cancel();
        Ok(())
    }

    pub fn finish(&self, operation_id: &str) {
        if let Ok(mut operations) = self.operations.lock() {
            operations.remove(operation_id);
        }
    }
}
