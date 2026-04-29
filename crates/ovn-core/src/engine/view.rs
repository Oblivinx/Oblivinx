//! View operations for the OvnEngine.
//!
//! Implements both logical views (stored pipeline that transforms queries)
//! and materialized views (precomputed result sets cached on disk).

use crate::error::{OvnError, OvnResult};
use crate::format::obe::{ObeDocument, ObeValue};
use crate::query::aggregation::{execute_stage_single, parse_pipeline, AggregateStage};

use super::OvnEngine;

/// View definition stored in metadata.
#[derive(Debug, Clone)]
pub struct ViewDefinition {
    /// View name
    pub name: String,
    /// Source collection
    pub source_collection: String,
    /// Pipeline stages (JSON)
    pub pipeline: Vec<serde_json::Value>,
    /// View type: 'logical' or 'materialized'
    pub view_type: String,
    /// Refresh policy for materialized views: 'on_write', 'scheduled', 'manual'
    pub refresh_policy: String,
    /// Last refresh timestamp (Unix epoch seconds) for materialized views
    pub last_refresh: Option<i64>,
}

/// Materialized view cached data.
#[derive(Debug, Clone)]
pub struct MaterializedViewCache {
    /// Cached result documents
    pub results: Vec<ObeDocument>,
    /// TxID at which this cache was computed
    #[allow(dead_code)]
    pub computed_at_txid: u64,
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  VIEWS
    // ═══════════════════════════════════════════════════════════════

    /// Create a view (logical or materialized).
    ///
    /// Logical views store a pipeline that is applied at query time.
    /// Materialized views precompute results and cache them.
    pub fn create_view(&self, name: &str, definition: &serde_json::Value) -> OvnResult<()> {
        self.check_closed()?;

        let obj = definition.as_object().ok_or_else(|| {
            OvnError::ValidationError("View definition must be an object".to_string())
        })?;

        let source = obj.get("source").and_then(|v| v.as_str()).ok_or_else(|| {
            OvnError::ValidationError("View definition must have a 'source' field".to_string())
        })?;

        let pipeline = obj
            .get("pipeline")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                OvnError::ValidationError(
                    "View definition must have a 'pipeline' field".to_string(),
                )
            })?;

        let view_type = obj
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("logical");

        let refresh_policy = obj
            .get("refreshPolicy")
            .and_then(|v| v.as_str())
            .unwrap_or("manual");

        let view_def = ViewDefinition {
            name: name.to_string(),
            source_collection: source.to_string(),
            pipeline: pipeline.clone(),
            view_type: view_type.to_string(),
            refresh_policy: refresh_policy.to_string(),
            last_refresh: None,
        };

        self.views
            .lock()
            .unwrap()
            .insert(name.to_string(), view_def);

        // For materialized views, precompute the cache
        if view_type == "materialized" {
            self.refresh_materialized_view(name)?;
        }

        log::info!(
            "View '{}' created (type={}, source={})",
            name,
            view_type,
            source
        );
        Ok(())
    }

    /// Drop a view.
    pub fn drop_view(&self, name: &str) -> OvnResult<()> {
        self.check_closed()?;

        if self.views.lock().unwrap().remove(name).is_none() {
            return Err(OvnError::ValidationError(format!(
                "View '{}' not found",
                name
            )));
        }

        // Also clear materialized cache if present
        self.materialized_caches.lock().unwrap().remove(name);

        log::info!("View '{}' dropped", name);
        Ok(())
    }

    /// List all views.
    pub fn list_views(&self) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;

        let views = self.views.lock().unwrap();
        Ok(views
            .values()
            .map(|v| {
                serde_json::json!({
                    "name": v.name,
                    "source": v.source_collection,
                    "type": v.view_type,
                    "refreshPolicy": v.refresh_policy,
                    "lastRefresh": v.last_refresh,
                })
            })
            .collect())
    }

    /// Refresh a materialized view.
    pub fn refresh_materialized_view(&self, name: &str) -> OvnResult<()> {
        self.check_closed()?;

        let views = self.views.lock().unwrap();
        let view = views
            .get(name)
            .ok_or_else(|| OvnError::ValidationError(format!("View '{}' not found", name)))?
            .clone();
        drop(views);

        if view.view_type != "materialized" {
            return Err(OvnError::ValidationError(format!(
                "View '{}' is not materialized",
                name
            )));
        }

        // Execute the pipeline on the source collection
        let pipeline_stages = parse_pipeline(&view.pipeline)?;
        let results = self.execute_aggregate_pipeline(&view.source_collection, &pipeline_stages)?;

        // Convert JSON results to ObeDocuments
        let mut docs = Vec::new();
        for result in results {
            let doc = ObeDocument::from_json(&result)?;
            docs.push(doc);
        }

        // Store in cache
        let docs_count = docs.len();
        let cache = MaterializedViewCache {
            results: docs,
            computed_at_txid: self.mvcc.next_txid(),
        };
        self.materialized_caches
            .lock()
            .unwrap()
            .insert(name.to_string(), cache);

        // Update last refresh timestamp
        let mut views = self.views.lock().unwrap();
        if let Some(v) = views.get_mut(name) {
            v.last_refresh = Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64,
            );
        }

        log::info!(
            "Materialized view '{}' refreshed ({} docs)",
            name,
            docs_count
        );
        Ok(())
    }

    /// Public alias for refresh_materialized_view
    pub fn refresh_view(&self, name: &str) -> OvnResult<()> {
        self.refresh_materialized_view(name)
    }

    /// Query a view. Returns the view's results.
    /// For logical views, applies the pipeline at query time.
    /// For materialized views, returns the cached result.
    pub fn query_view(&self, name: &str) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;

        let views = self.views.lock().unwrap();
        let view = views
            .get(name)
            .ok_or_else(|| OvnError::ValidationError(format!("View '{}' not found", name)))?
            .clone();
        drop(views);

        match view.view_type.as_str() {
            "logical" => {
                // Apply pipeline at query time
                let pipeline_stages = parse_pipeline(&view.pipeline)?;
                self.execute_aggregate_pipeline(&view.source_collection, &pipeline_stages)
            }
            "materialized" => {
                // Return cached results
                let caches = self.materialized_caches.lock().unwrap();
                let cache = caches.get(name).ok_or_else(|| {
                    OvnError::ValidationError(format!(
                        "Materialized view '{}' cache not found",
                        name
                    ))
                })?;

                Ok(cache.results.iter().map(|d| d.to_json()).collect())
            }
            _ => Err(OvnError::ValidationError(format!(
                "Unknown view type: {}",
                view.view_type
            ))),
        }
    }

    /// Helper: Execute an aggregation pipeline on a collection.
    fn execute_aggregate_pipeline(
        &self,
        collection: &str,
        stages: &[AggregateStage],
    ) -> OvnResult<Vec<serde_json::Value>> {
        self.ensure_collection(collection)?;

        let collection_id = Self::collection_id(collection);

        // Scan all documents (collection-prefixed keys only).
        let all_entries = self.btree.scan_all();
        let mut docs: Vec<ObeDocument> = all_entries
            .into_iter()
            .filter(|e| Self::key_in_collection(&e.key, collection_id) && !e.tombstone)
            .filter_map(|e| ObeDocument::decode(&e.value).ok())
            .collect();

        // Also check MemTable
        let memtable_entries = self.memtable.entries_for_collection(collection_id);
        for entry in memtable_entries {
            if !entry.tombstone && !docs.iter().any(|d| d.id.to_vec() == entry.key) {
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    docs.push(doc);
                }
            }
        }

        // Execute pipeline stages
        for stage in stages {
            match stage {
                AggregateStage::Lookup(config) => {
                    self.ensure_collection(&config.from)?;
                    let foreign_id = Self::collection_id(&config.from);
                    let foreign_entries = self.btree.scan_all();
                    let foreign_docs: Vec<ObeDocument> = foreign_entries
                        .into_iter()
                        .filter(|e| Self::key_in_collection(&e.key, foreign_id) && !e.tombstone)
                        .filter_map(|e| ObeDocument::decode(&e.value).ok())
                        .collect();

                    docs = docs
                        .into_iter()
                        .map(|mut doc| {
                            let local_val = doc.get_path(&config.local_field).cloned();
                            let matched: Vec<ObeValue> = foreign_docs
                                .iter()
                                .filter(|fd| {
                                    let foreign_val = fd.get_path(&config.foreign_field);
                                    match (&local_val, foreign_val) {
                                        (Some(lv), Some(fv)) => lv.to_json() == fv.to_json(),
                                        _ => false,
                                    }
                                })
                                .map(|fd| ObeValue::Document(fd.fields.clone()))
                                .collect();

                            doc.set(config.as_field.clone(), ObeValue::Array(matched));
                            doc
                        })
                        .collect();
                }
                other_stage => {
                    docs = execute_stage_single(docs, other_stage)?;
                }
            }
        }

        Ok(docs.into_iter().map(|d| d.to_json()).collect())
    }

    /// Trigger a refresh on all materialized views that depend on a collection.
    /// Called after write operations.
    pub fn refresh_views_for_collection(&self, collection: &str) {
        let views = self.views.lock().unwrap();
        let views_to_refresh: Vec<String> = views
            .values()
            .filter(|v| {
                v.view_type == "materialized"
                    && v.source_collection == collection
                    && v.refresh_policy == "on_write"
            })
            .map(|v| v.name.clone())
            .collect();
        drop(views);

        for view_name in views_to_refresh {
            if let Err(e) = self.refresh_materialized_view(&view_name) {
                log::error!("Failed to refresh materialized view '{}': {}", view_name, e);
            }
        }
    }
}
