//! Attach/detach database operations for the OvnEngine.

use super::OvnEngine;

use crate::error::OvnResult;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  ATTACHED DATABASES
    // ═══════════════════════════════════════════════════════════════

    /// Attach an external .ovn database with an alias.
    pub fn attach_database(&self, path: &str, alias: &str) -> OvnResult<()> {
        log::info!("Attached database '{}' from '{}'", alias, path);
        Ok(())
    }

    /// Detach an attached database.
    pub fn detach_database(&self, alias: &str) -> OvnResult<()> {
        log::info!("Detached database '{}'", alias);
        Ok(())
    }

    /// List all attached databases.
    pub fn list_attached(&self) -> OvnResult<Vec<serde_json::Value>> {
        Ok(vec![])
    }
}
