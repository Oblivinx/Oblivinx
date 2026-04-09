//! Client Session and Retryable Write management.
//!
//! Tracks `lsid` (Logical Session ID) and `txnNumber` to ensure
//! that retryable writes are idempotent and not applied twice.

use parking_lot::RwLock;
use std::collections::HashMap;

/// Result of a completed write operation, cached for idempotency.
#[derive(Debug, Clone)]
pub enum WriteResult {
    InsertId(String),
    ModifiedCount(u64),
    DeletedCount(u64),
}

/// Idempotency Cache for Retryable Writes.
pub struct SessionManager {
    /// Maps `lsid` -> (recent_txn_number, write_result)
    cache: RwLock<HashMap<[u8; 16], (u64, WriteResult)>>,
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
        }
    }

    /// Check if an operation has already been completed for this session.
    pub fn check_idempotent(&self, lsid: &[u8; 16], txn_number: u64) -> Option<WriteResult> {
        let cache = self.cache.read();
        if let Some((stored_txn, result)) = cache.get(lsid) {
            if *stored_txn == txn_number {
                return Some(result.clone());
            }
        }
        None
    }

    /// Record a completed write result in the session cache.
    pub fn record_result(&self, lsid: [u8; 16], txn_number: u64, result: WriteResult) {
        let mut cache = self.cache.write();
        cache.insert(lsid, (txn_number, result));
    }
}
