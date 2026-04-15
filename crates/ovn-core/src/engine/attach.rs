//! Attach/detach database operations for the OvnEngine.
//!
//! Implements SQLite-like ATTACH/DETACH support for cross-database queries.

use std::sync::Arc;

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};
use crate::engine::config::OvnConfig;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  ATTACHED DATABASES
    // ═══════════════════════════════════════════════════════════════

    /// Attach an external .ovn database with an alias.
    pub fn attach_database(&self, path: &str, alias: &str) -> OvnResult<()> {
        self.check_closed()?;

        // Check if alias is already in use
        let attached = self.attached_databases.lock().unwrap();
        if attached.contains_key(alias) {
            return Err(OvnError::InvalidConfig(
                format!("Alias '{}' is already in use", alias)
            ));
        }
        drop(attached);

        // Open the external database
        let config = OvnConfig::default();
        let external_engine = OvnEngine::open(path, config)?;

        // Store the attached database
        self.attached_databases.lock().unwrap()
            .insert(alias.to_string(), Arc::new(external_engine));

        log::info!("Attached database '{}' from '{}'", alias, path);
        Ok(())
    }

    /// Detach an attached database.
    pub fn detach_database(&self, alias: &str) -> OvnResult<()> {
        self.check_closed()?;

        let mut attached = self.attached_databases.lock().unwrap();
        let removed = attached.remove(alias);

        if removed.is_none() {
            return Err(OvnError::InvalidConfig(
                format!("Alias '{}' is not attached", alias)
            ));
        }

        // Close the detached database
        if let Some(engine) = removed {
            if let Err(e) = engine.close() {
                log::warn!("Error closing detached database '{}': {}", alias, e);
            }
        }

        log::info!("Detached database '{}'", alias);
        Ok(())
    }

    /// List all attached databases.
    pub fn list_attached(&self) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;

        let attached = self.attached_databases.lock().unwrap();
        Ok(attached.keys().map(|alias| {
            serde_json::json!({
                "alias": alias,
                "type": "attached"
            })
        }).collect())
    }

    /// Get an attached database engine by alias.
    pub fn get_attached(&self, alias: &str) -> OvnResult<Arc<OvnEngine>> {
        let attached = self.attached_databases.lock().unwrap();
        attached.get(alias).cloned().ok_or_else(|| OvnError::InvalidConfig(
            format!("Alias '{}' is not attached", alias)
        ))
    }

    /// Query a collection in an attached database.
    pub fn query_attached(
        &self,
        alias: &str,
        collection: &str,
        filter: &serde_json::Value,
    ) -> OvnResult<Vec<serde_json::Value>> {
        let attached_engine = self.get_attached(alias)?;
        attached_engine.find(collection, filter, None)
    }
}
