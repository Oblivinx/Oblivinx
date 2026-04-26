//! Versioned Document System for the OvnEngine.
//!
//! Every document can optionally have a full version history.
//! Version metadata is stored in-memory and can be persisted to the Metadata Segment.
//! Supports diff mode (store only changes) and snapshot mode (full document copy).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::engine::OvnEngine;
use crate::error::{OvnError, OvnResult};
use crate::format::obe::ObeDocument;

/// Versioning configuration for a collection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersioningConfig {
    /// Enable versioning
    pub enabled: bool,
    /// Mode: 'diff' (store only changes) or 'snapshot' (full copy)
    pub mode: String,
    /// Maximum versions per document (-1 = unlimited)
    pub max_versions: i64,
    /// How long to retain versions (e.g. "30d", "6m", -1 = forever)
    pub retain_for: String,
    /// Track author (requires author field in write options)
    pub track_author: bool,
    /// Auto-create tags for each version
    pub auto_tag: bool,
}

impl Default for VersioningConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: "diff".to_string(),
            max_versions: 50,
            retain_for: "-1".to_string(),
            track_author: false,
            auto_tag: false,
        }
    }
}

/// A single version of a document.
#[derive(Debug, Clone)]
pub struct DocumentVersion {
    /// Version number (1-based, sequential)
    pub version: u64,
    /// Transaction ID that created this version
    #[allow(dead_code)]
    pub txid: u64,
    /// Timestamp (Unix epoch milliseconds)
    pub created_at: u64,
    /// Optional author ID
    pub author: Option<String>,
    /// Optional tag (like git tag)
    pub tag: Option<String>,
    /// The document data (full copy or diff depending on mode)
    pub document: ObeDocument,
    /// Changeset: for diff mode, stores {added, modified, removed}
    pub changeset: Option<serde_json::Value>,
}

/// Version information returned to the user.
#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub version: u64,
    pub created_at: u64,
    pub author: Option<String>,
    pub tag: Option<String>,
    pub change_count: usize,
}

/// Diff result between two versions.
#[derive(Debug, Clone, Serialize)]
pub struct VersionDiff {
    pub from_version: u64,
    pub to_version: u64,
    pub added: HashMap<String, serde_json::Value>,
    pub modified: HashMap<String, (serde_json::Value, serde_json::Value)>,
    pub removed: HashMap<String, serde_json::Value>,
}

/// Version history for a collection: doc_id → Vec<DocumentVersion>
pub type CollectionVersionHistory = HashMap<String, Vec<DocumentVersion>>;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  VERSIONED DOCUMENT SYSTEM
    // ═══════════════════════════════════════════════════════════════

    /// Enable versioning for a collection.
    pub fn enable_versioning(
        &self,
        collection: &str,
        config: Option<&serde_json::Value>,
    ) -> OvnResult<()> {
        self.check_closed()?;

        let mut version_config = VersioningConfig::default();
        if let Some(json) = config {
            if let Some(obj) = json.as_object() {
                if let Some(enabled) = obj.get("enabled").and_then(|v| v.as_bool()) {
                    version_config.enabled = enabled;
                }
                if let Some(mode) = obj.get("mode").and_then(|v| v.as_str()) {
                    version_config.mode = mode.to_string();
                }
                if let Some(max) = obj.get("maxVersions").and_then(|v| v.as_i64()) {
                    version_config.max_versions = max;
                }
                if let Some(retain) = obj.get("retainFor").and_then(|v| v.as_str()) {
                    version_config.retain_for = retain.to_string();
                }
                if let Some(track) = obj.get("trackAuthor").and_then(|v| v.as_bool()) {
                    version_config.track_author = track;
                }
                if let Some(auto_tag) = obj.get("autoTag").and_then(|v| v.as_bool()) {
                    version_config.auto_tag = auto_tag;
                }
            }
        }

        version_config.enabled = true;

        self.versioning_configs
            .lock()
            .unwrap()
            .insert(collection.to_string(), version_config);

        // Initialize version history for this collection
        self.version_history
            .lock()
            .unwrap()
            .entry(collection.to_string())
            .or_default();

        log::info!("Versioning enabled for collection '{}'", collection);
        Ok(())
    }

    /// Disable versioning for a collection.
    pub fn disable_versioning(&self, collection: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.versioning_configs.lock().unwrap().remove(collection);
        self.version_history.lock().unwrap().remove(collection);
        log::info!("Versioning disabled for collection '{}'", collection);
        Ok(())
    }

    /// Check if versioning is enabled for a collection.
    pub fn is_versioning_enabled(&self, collection: &str) -> bool {
        self.versioning_configs
            .lock()
            .unwrap()
            .get(collection)
            .map(|c| c.enabled)
            .unwrap_or(false)
    }

    /// Get the versioning config for a collection.
    fn get_versioning_config(&self, collection: &str) -> Option<VersioningConfig> {
        self.versioning_configs
            .lock()
            .unwrap()
            .get(collection)
            .cloned()
    }

    /// Record a new version of a document. Called internally after each write.
    pub fn record_document_version(
        &self,
        collection: &str,
        doc_id: &str,
        doc: ObeDocument,
        author: Option<String>,
    ) -> OvnResult<u64> {
        // Check if versioning is enabled
        let config = match self.get_versioning_config(collection) {
            Some(c) if c.enabled => c,
            _ => return Ok(0), // Versioning not enabled, silently skip
        };

        let mut history = self.version_history.lock().unwrap();
        let coll_history = history.entry(collection.to_string()).or_default();
        let versions = coll_history.entry(doc_id.to_string()).or_default();

        // Determine version number
        let version_number = versions.len() as u64 + 1;

        // Compute changeset for diff mode
        let changeset = if config.mode == "diff" && !versions.is_empty() {
            let previous = &versions.last().unwrap().document;
            Some(self.compute_diff(previous, &doc))
        } else {
            None
        };

        let new_version = DocumentVersion {
            version: version_number,
            txid: doc.txid,
            created_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            author: if config.track_author { author } else { None },
            tag: if config.auto_tag {
                Some(format!("v{}", version_number))
            } else {
                None
            },
            document: doc,
            changeset,
        };

        versions.push(new_version);

        // Prune old versions if max_versions is set
        if config.max_versions > 0 {
            let max = config.max_versions as usize;
            if versions.len() > max {
                let to_remove = versions.len() - max;
                versions.drain(..to_remove);
                log::debug!(
                    "Pruned {} old versions from {}.{} (max={})",
                    to_remove, collection, doc_id, max
                );
            }
        }

        Ok(version_number)
    }

    /// Get a specific version of a document.
    pub fn get_document_version(
        &self,
        collection: &str,
        doc_id: &str,
        version: u64,
    ) -> OvnResult<Option<serde_json::Value>> {
        self.check_closed()?;

        let history = self.version_history.lock().unwrap();
        let coll_history = history.get(collection);
        let versions = coll_history.and_then(|h| h.get(doc_id));

        if let Some(vers) = versions {
            if let Some(v) = vers.iter().find(|v| v.version == version) {
                let mut json = v.document.to_json();
                if let Some(obj) = json.as_object_mut() {
                    obj.insert("__version".to_string(), serde_json::json!(v.version));
                    obj.insert(
                        "__versionedAt".to_string(),
                        serde_json::json!(v.created_at),
                    );
                    if let Some(ref author) = v.author {
                        obj.insert("__author".to_string(), serde_json::json!(author));
                    }
                    if let Some(ref tag) = v.tag {
                        obj.insert("__tag".to_string(), serde_json::json!(tag));
                    }
                }
                return Ok(Some(json));
            }
        }

        Ok(None)
    }

    /// List all versions of a document.
    pub fn list_document_versions(
        &self,
        collection: &str,
        doc_id: &str,
    ) -> OvnResult<Vec<VersionInfo>> {
        self.check_closed()?;

        let history = self.version_history.lock().unwrap();
        let coll_history = history.get(collection);
        let versions = coll_history.and_then(|h| h.get(doc_id));

        if let Some(vers) = versions {
            Ok(vers
                .iter()
                .map(|v| VersionInfo {
                    version: v.version,
                    created_at: v.created_at,
                    author: v.author.clone(),
                    tag: v.tag.clone(),
                    change_count: v
                        .changeset
                        .as_ref()
                        .map(|c| {
                            let mut count = 0;
                            if let Some(obj) = c.as_object() {
                                if let Some(modified) = obj.get("modified").and_then(|v| v.as_object()) {
                                    count += modified.len();
                                }
                                if let Some(added) = obj.get("added").and_then(|v| v.as_object()) {
                                    count += added.len();
                                }
                                if let Some(removed) = obj.get("removed").and_then(|v| v.as_object()) {
                                    count += removed.len();
                                }
                            }
                            count
                        })
                        .unwrap_or(0),
                })
                .collect())
        } else {
            Ok(vec![])
        }
    }

    /// Compute diff between two versions.
    pub fn diff_document_versions(
        &self,
        collection: &str,
        doc_id: &str,
        v1: u64,
        v2: u64,
    ) -> OvnResult<VersionDiff> {
        self.check_closed()?;

        let history = self.version_history.lock().unwrap();
        let coll_history = history.get(collection);
        let versions = coll_history.and_then(|h| h.get(doc_id));

        if let Some(vers) = versions {
            let ver1 = vers.iter().find(|v| v.version == v1).ok_or_else(|| {
                OvnError::ValidationError(format!("Version {} not found for {}", v1, doc_id))
            })?;
            let ver2 = vers.iter().find(|v| v.version == v2).ok_or_else(|| {
                OvnError::ValidationError(format!("Version {} not found for {}", v2, doc_id))
            })?;

            let diff = self.compute_diff(&ver1.document, &ver2.document);

            // Convert to structured diff
            let mut added = HashMap::new();
            let mut modified = HashMap::new();
            let mut removed = HashMap::new();

            if let Some(obj) = diff.as_object() {
                if let Some(a) = obj.get("added").and_then(|v| v.as_object()) {
                    for (k, v) in a {
                        added.insert(k.clone(), v.clone());
                    }
                }
                if let Some(m) = obj.get("modified").and_then(|v| v.as_object()) {
                    for (k, v) in m {
                        if let Some(arr) = v.as_array() {
                            if arr.len() == 2 {
                                modified.insert(
                                    k.clone(),
                                    (arr[0].clone(), arr[1].clone()),
                                );
                            }
                        }
                    }
                }
                if let Some(r) = obj.get("removed").and_then(|v| v.as_object()) {
                    for (k, v) in r {
                        removed.insert(k.clone(), v.clone());
                    }
                }
            }

            Ok(VersionDiff {
                from_version: v1,
                to_version: v2,
                added,
                modified,
                removed,
            })
        } else {
            Err(OvnError::ValidationError(
                "No version history found for document".to_string(),
            ))
        }
    }

    /// Rollback to a specific version. Creates a new version with the old content.
    pub fn rollback_to_version(
        &self,
        collection: &str,
        doc_id: &str,
        version: u64,
        author: Option<String>,
    ) -> OvnResult<serde_json::Value> {
        self.check_closed()?;

        // Get the target version
        let target_doc = self
            .get_document_version(collection, doc_id, version)?
            .ok_or_else(|| {
                OvnError::ValidationError(format!(
                    "Version {} not found for {}",
                    version, doc_id
                ))
            })?;

        // Strip version metadata fields
        let mut clean_doc = target_doc.clone();
        if let Some(obj) = clean_doc.as_object_mut() {
            obj.remove("__version");
            obj.remove("__versionedAt");
            obj.remove("__author");
            obj.remove("__tag");
        }

        // Update the document with the old content (this creates a new version)
        let doc = ObeDocument::from_json(&clean_doc)?;
        let new_version = self.record_document_version(collection, doc_id, doc, author)?;

        log::info!(
            "Rolled back {}.{} to version {} (new version: {})",
            collection, doc_id, version, new_version
        );

        Ok(clean_doc)
    }

    /// Tag a specific version.
    pub fn tag_document_version(
        &self,
        collection: &str,
        doc_id: &str,
        version: u64,
        tag: &str,
    ) -> OvnResult<()> {
        let mut history = self.version_history.lock().unwrap();
        let coll_history = history.get_mut(collection).ok_or_else(|| {
            OvnError::ValidationError("No version history for collection".to_string())
        })?;
        let versions = coll_history.get_mut(doc_id).ok_or_else(|| {
            OvnError::ValidationError("No version history for document".to_string())
        })?;

        if let Some(v) = versions.iter_mut().find(|v| v.version == version) {
            v.tag = Some(tag.to_string());
            Ok(())
        } else {
            Err(OvnError::ValidationError(format!(
                "Version {} not found", version
            )))
        }
    }

    /// Restore from a tag.
    pub fn restore_from_tag(
        &self,
        collection: &str,
        doc_id: &str,
        tag: &str,
        author: Option<String>,
    ) -> OvnResult<serde_json::Value> {
        // Find the version with this tag
        let history = self.version_history.lock().unwrap();
        let coll_history = history.get(collection).ok_or_else(|| {
            OvnError::ValidationError("No version history for collection".to_string())
        })?;
        let versions = coll_history.get(doc_id).ok_or_else(|| {
            OvnError::ValidationError("No version history for document".to_string())
        })?;

        let version = versions
            .iter()
            .find(|v| v.tag.as_deref() == Some(tag))
            .map(|v| v.version)
            .ok_or_else(|| {
                OvnError::ValidationError(format!("Tag '{}' not found", tag))
            })?;
        drop(history);

        // Rollback to that version
        self.rollback_to_version(collection, doc_id, version, author)
    }

    /// Compute a structured diff between two documents.
    fn compute_diff(&self, old: &ObeDocument, new: &ObeDocument) -> serde_json::Value {
        let old_json = old.to_json();
        let new_json = new.to_json();

        let mut added = serde_json::Map::new();
        let mut modified = serde_json::Map::new();
        let mut removed = serde_json::Map::new();

        // Check for added and modified fields
        if let Some(new_obj) = new_json.as_object() {
            for (key, new_val) in new_obj {
                if key == "_id" || key.starts_with("__") {
                    continue; // Skip internal fields
                }
                match old_json.get(key) {
                    None => {
                        added.insert(key.clone(), new_val.clone());
                    }
                    Some(old_val) if old_val != new_val => {
                        modified.insert(
                            key.clone(),
                            serde_json::json!([old_val, new_val]),
                        );
                    }
                    _ => {}
                }
            }
        }

        // Check for removed fields
        if let Some(old_obj) = old_json.as_object() {
            for key in old_obj.keys() {
                if key == "_id" || key.starts_with("__") {
                    continue;
                }
                if let Some(new_obj) = new_json.as_object() {
                    if !new_obj.contains_key(key) {
                        if let Some(val) = old_obj.get(key) {
                            removed.insert(key.clone(), val.clone());
                        }
                    }
                }
            }
        }

        serde_json::json!({
            "added": serde_json::Value::Object(added),
            "modified": serde_json::Value::Object(modified),
            "removed": serde_json::Value::Object(removed),
        })
    }
}
