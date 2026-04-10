//! Blob operations for the OvnEngine.

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};

impl OvnEngine {
    // ── Blob Management ────────────────────────────────────────

    /// Store a binary blob.
    pub fn put_blob(&self, data: &[u8]) -> OvnResult<String> {
        self.check_closed()?;
        let (blob_id, _) = self.blob_mgr.put_blob(data)?;
        Ok(uuid::Uuid::from_bytes(blob_id).to_string())
    }

    /// Retrieve a binary blob.
    pub fn get_blob(&self, blob_id_str: &str) -> OvnResult<Option<Vec<u8>>> {
        self.check_closed()?;
        let parsed_uuid = uuid::Uuid::parse_str(blob_id_str).map_err(|_| {
            OvnError::ValidationError(format!("Invalid UUID format: {}", blob_id_str))
        })?;
        self.blob_mgr.get_blob(parsed_uuid.as_bytes())
    }
}
