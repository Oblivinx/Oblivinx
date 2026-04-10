//! Pragma operations for the OvnEngine.

use super::OvnEngine;

use crate::error::OvnResult;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  PRAGMAS
    // ═══════════════════════════════════════════════════════════════

    /// Set a pragma value.
    pub fn set_pragma(&self, name: &str, value: &serde_json::Value) -> OvnResult<()> {
        log::info!("Pragma '{}' = {:?}", name, value);
        Ok(())
    }

    /// Get a pragma value.
    pub fn get_pragma(&self, _name: &str) -> OvnResult<serde_json::Value> {
        Ok(serde_json::Value::Null)
    }
}
