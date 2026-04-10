//! Explain and query diagnostics for the OvnEngine.

use super::OvnEngine;

use crate::error::OvnResult;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  EXPLAIN & QUERY DIAGNOSTICS
    // ═══════════════════════════════════════════════════════════════

    /// Explain a find query -- return execution plan without executing.
    pub fn explain(
        &self,
        collection: &str,
        filter: &serde_json::Value,
        options: Option<&serde_json::Value>,
    ) -> OvnResult<serde_json::Value> {
        let verbosity = options
            .and_then(|o| o.get("verbosity"))
            .and_then(|v| v.as_str())
            .unwrap_or("queryPlanner");

        Ok(serde_json::json!({
            "verbosity": verbosity,
            "collection": collection,
            "filter": filter,
            "index": null,
            "scanType": "collectionScan",
            "estimatedCost": 0,
            "docsExamined": 0,
            "docsReturned": 0,
            "fallbackReason": null,
            "stages": vec!["CollectionScan"]
        }))
    }

    /// Explain an aggregation pipeline.
    pub fn explain_aggregate(
        &self,
        collection: &str,
        pipeline: &serde_json::Value,
        _options: Option<&serde_json::Value>,
    ) -> OvnResult<serde_json::Value> {
        Ok(serde_json::json!({
            "collection": collection,
            "pipeline": pipeline,
            "stages": vec!["Aggregation"]
        }))
    }
}
