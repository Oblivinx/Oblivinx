//! Explain and query diagnostics for the OvnEngine.
//!
//! Returns detailed execution plans with cost estimates,
//! index usage, and stage-by-stage breakdown.

use std::time::Instant;

use super::OvnEngine;

use crate::error::OvnResult;
use crate::query::filter::{extract_filter_fields, parse_filter};
use crate::query::planner::{plan_query, PlanType};

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  EXPLAIN & QUERY DIAGNOSTICS
    // ═══════════════════════════════════════════════════════════════

    /// Explain a find query -- return execution plan without executing.
    ///
    /// Verbosity modes:
    /// - "queryPlanner": Returns the chosen plan with index info
    /// - "executionStats": Actually runs the query and returns timing + stats
    /// - "allPlansExecution": Shows all candidate plans with their costs
    pub fn explain(
        &self,
        collection: &str,
        filter: &serde_json::Value,
        options: Option<&serde_json::Value>,
    ) -> OvnResult<serde_json::Value> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let verbosity = options
            .and_then(|o| o.get("verbosity"))
            .and_then(|v| v.as_str())
            .unwrap_or("queryPlanner");

        let filter_parsed = parse_filter(filter)?;
        let filter_fields = extract_filter_fields(&filter_parsed);

        // Get available indexes
        let collections = self.collections.read();
        let (indexes, index_specs) = if let Some(coll) = collections.get(collection) {
            let specs = coll.index_manager.list_indexes();
            let names: Vec<String> = specs.iter()
                .filter(|s| !s.hidden)
                .map(|s| s.name.clone())
                .collect();
            (names, specs)
        } else {
            (Vec::new(), Vec::new())
        };
        drop(collections);

        // Get collection size
        let collection_size = self.btree.scan_all()
            .iter()
            .filter(|e| !e.tombstone)
            .count() as u64;

        // Generate the optimal plan
        let plan = plan_query(&filter_parsed, &indexes, collection_size);

        // Build stages
        let mut stages = Vec::new();
        let scan_type = match &plan.plan_type {
            PlanType::IndexPointLookup { index_name } => {
                stages.push(serde_json::json!({
                    "stage": "IXSCAN",
                    "indexName": index_name,
                    "keyPattern": index_specs.iter()
                        .find(|s| &s.name == index_name)
                        .map(|s| {
                            serde_json::Value::Object(s.fields.iter()
                                .map(|(f, d)| (f.clone(), serde_json::Value::from(*d)))
                                .collect())
                        }),
                    "direction": "forward",
                }));
                stages.push(serde_json::json!({
                    "stage": "FETCH",
                    "filterApplied": false,
                }));
                "indexPointLookup"
            }
            PlanType::IndexRangeScan { index_name } => {
                stages.push(serde_json::json!({
                    "stage": "IXSCAN",
                    "indexName": index_name,
                    "keyPattern": index_specs.iter()
                        .find(|s| &s.name == index_name)
                        .map(|s| {
                            serde_json::Value::Object(s.fields.iter()
                                .map(|(f, d)| (f.clone(), serde_json::Value::from(*d)))
                                .collect())
                        }),
                    "direction": "forward",
                }));
                stages.push(serde_json::json!({
                    "stage": "FETCH",
                    "filterApplied": false,
                }));
                "indexRangeScan"
            }
            PlanType::CoveredIndexScan { index_name } => {
                stages.push(serde_json::json!({
                    "stage": "IXSCAN",
                    "indexName": index_name,
                    "note": "Covered query -- no document fetch needed",
                }));
                "coveredIndexScan"
            }
            PlanType::CollectionScan => {
                stages.push(serde_json::json!({
                    "stage": "COLLSCAN",
                    "filterApplied": true,
                    "note": "No suitable index found -- full collection scan",
                }));
                "collectionScan"
            }
            PlanType::TimeSeriesScan { min_time, max_time } => {
                stages.push(serde_json::json!({
                    "stage": "TIMESERIES_SCAN",
                    "minTime": min_time,
                    "maxTime": max_time,
                }));
                "timeSeriesScan"
            }
        };

        let mut result = serde_json::json!({
            "queryPlanner": {
                "collection": collection,
                "filter": filter,
                "indexUsed": match &plan.plan_type {
                    PlanType::IndexPointLookup { index_name } |
                    PlanType::IndexRangeScan { index_name } |
                    PlanType::CoveredIndexScan { index_name } => serde_json::Value::String(index_name.clone()),
                    _ => serde_json::Value::Null,
                },
                "scanType": scan_type,
                "estimatedCost": plan.estimated_cost,
                "estimatedDocsExamined": plan.estimated_docs,
                "estimatedDocsReturned": plan.estimated_docs,
                "collectionSize": collection_size,
                "availableIndexes": indexes,
                "stages": stages,
                "fallbackReason": if matches!(plan.plan_type, PlanType::CollectionScan) {
                    Some("No suitable index found for the query filter".to_string())
                } else {
                    None
                },
            }
        });

        // For "executionStats" mode, actually run the query
        if verbosity == "executionStats" || verbosity == "allPlansExecution" {
            let start = Instant::now();
            let results = self.find(collection, filter, None)?;
            let elapsed = start.elapsed();

            // Re-parse to get filter for evaluation
            let results_count = results.len() as u64;

            // Count docs examined (all non-tombstone entries)
            let docs_examined = self.btree.scan_all()
                .iter()
                .filter(|e| !e.tombstone)
                .count() as u64;

            result["executionStats"] = serde_json::json!({
                "executionTimeMillis": elapsed.as_micros() as f64 / 1000.0,
                "totalDocsExamined": docs_examined,
                "totalDocsReturned": results_count,
                "totalKeysExamined": if matches!(plan.plan_type, PlanType::CollectionScan) {
                    0
                } else {
                    results_count
                },
                "nReturned": results_count,
            });
        }

        // For "allPlansExecution", show all candidate plans
        if verbosity == "allPlansExecution" {
            let mut all_plans = Vec::new();

            // The chosen plan
            all_plans.push(serde_json::json!({
                "plan": serde_json::to_value(&format!("{:?}", plan.plan_type)).unwrap_or_default(),
                "estimatedCost": plan.estimated_cost,
                "chosen": true,
            }));

            // The collection scan as alternative
            if !matches!(plan.plan_type, PlanType::CollectionScan) {
                let coll_cost = collection_size as f64 * 1.11;
                all_plans.push(serde_json::json!({
                    "plan": "CollectionScan",
                    "estimatedCost": coll_cost,
                    "chosen": false,
                }));
            }

            result["allPlans"] = serde_json::Value::Array(all_plans);
        }

        Ok(result)
    }

    /// Explain an aggregation pipeline.
    pub fn explain_aggregate(
        &self,
        collection: &str,
        pipeline: &serde_json::Value,
        options: Option<&serde_json::Value>,
    ) -> OvnResult<serde_json::Value> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let verbosity = options
            .and_then(|o| o.get("verbosity"))
            .and_then(|v| v.as_str())
            .unwrap_or("queryPlanner");

        // Parse pipeline stages
        let stages_array = pipeline.as_array().cloned().unwrap_or_default();
        let mut stage_details = Vec::new();

        for stage in &stages_array {
            if let Some(obj) = stage.as_object() {
                for (key, _) in obj {
                    stage_details.push(serde_json::json!({
                        "stage": key.trim_start_matches('$'),
                        "operator": key,
                    }));
                }
            }
        }

        // Get collection size
        let collection_size = self.btree.scan_all()
            .iter()
            .filter(|e| !e.tombstone)
            .count() as u64;

        let mut result = serde_json::json!({
            "queryPlanner": {
                "collection": collection,
                "pipeline": pipeline,
                "stages": stage_details,
                "collectionSize": collection_size,
                "scanType": "aggregationPipeline",
                "estimatedCost": collection_size as f64 * 1.1, // Base cost: scan + decode
                "note": "Aggregation always scans full collection unless $match is first stage",
            }
        });

        // Run and collect stats for executionStats mode
        if verbosity == "executionStats" {
            let start = Instant::now();
            let results = self.aggregate(collection, &stages_array)?;
            let elapsed = start.elapsed();

            result["executionStats"] = serde_json::json!({
                "executionTimeMillis": elapsed.as_micros() as f64 / 1000.0,
                "totalDocsExamined": collection_size,
                "totalDocsReturned": results.len(),
                "nReturned": results.len(),
            });
        }

        Ok(result)
    }

    /// Get detailed index statistics.
    pub fn index_stats(&self, collection: &str) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            let indexes = coll.index_manager.list_indexes();
            Ok(indexes.iter().map(|idx| {
                serde_json::json!({
                    "name": idx.name,
                    "fields": serde_json::Value::Object(idx.fields.iter()
                        .map(|(f, d)| (f.clone(), serde_json::Value::from(*d)))
                        .collect()),
                    "unique": idx.unique,
                    "text": idx.text,
                    "hidden": idx.hidden,
                    // In a real implementation, these would be tracked:
                    "accessCount": 0,
                    "lastAccessed": null,
                })
            }).collect())
        } else {
            Err(crate::error::OvnError::CollectionNotFound {
                name: collection.to_string()
            })
        }
    }
}
