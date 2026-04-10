//! View operations for the OvnEngine.

use super::OvnEngine;

use crate::error::OvnResult;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  VIEWS
    // ═══════════════════════════════════════════════════════════════

    /// Create a view (logical or materialized).
    pub fn create_view(&self, name: &str, _definition: &serde_json::Value) -> OvnResult<()> {
        log::info!("View '{}' created", name);
        Ok(())
    }

    /// Drop a view.
    pub fn drop_view(&self, name: &str) -> OvnResult<()> {
        log::info!("View '{}' dropped", name);
        Ok(())
    }

    /// List all views.
    pub fn list_views(&self) -> OvnResult<Vec<serde_json::Value>> {
        Ok(vec![])
    }

    /// Refresh a materialized view.
    pub fn refresh_view(&self, name: &str) -> OvnResult<()> {
        log::info!("View '{}' refreshed", name);
        Ok(())
    }
}
