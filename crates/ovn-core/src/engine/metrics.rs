//! Metrics and version operations for the OvnEngine.

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};

impl OvnEngine {
    // ── Metrics ────────────────────────────────────────────────

    /// Get database metrics.
    pub fn get_metrics(&self) -> serde_json::Value {
        let bp_stats = self.buffer_pool.stats();

        serde_json::json!({
            "io": {
                "pagesRead": bp_stats.pages_read,
                "pagesWritten": bp_stats.pages_written,
            },
            "cache": {
                "hitRate": self.buffer_pool.hit_rate(),
                "size": self.buffer_pool.size(),
            },
            "txn": {
                "activeCount": self.mvcc.active_count(),
            },
            "storage": {
                "btreeEntries": self.btree.len(),
                "memtableSize": self.memtable.memory_usage(),
                "sstableCount": self.sstable_mgr.l0_count(),
            },
            "collections": self.collections.read().len(),
        })
    }

    /// Get the database version.
    pub fn get_version(&self) -> OvnResult<serde_json::Value> {
        self.check_closed()?;
        let header = self.header.read();
        Ok(serde_json::json!({
            "formatVersion": format!("{}.{}", header.version_major, header.version_minor),
            "pageSize": header.page_size,
        }))
    }

    /// Export database to JSON format.
    ///
    /// Returns a JSON object with collections as keys and arrays of documents as values.
    pub fn export(&self) -> OvnResult<serde_json::Value> {
        self.check_closed()?;

        let collection_names = self.list_collections();
        let mut export_map = serde_json::Map::new();

        for coll_name in &collection_names {
            let docs = self.find(coll_name, &serde_json::Value::Null, None)?;
            export_map.insert(coll_name.clone(), serde_json::Value::Array(docs));
        }

        Ok(serde_json::Value::Object(export_map))
    }

    /// Backup database to a file path.
    ///
    /// In a full implementation this would create a consistent hot-backup
    /// using WAL checkpointing and file copy.
    pub fn backup(&self, dest_path: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.checkpoint()?;

        let data = self.export()?;
        let json_str = serde_json::to_string_pretty(&data)
            .map_err(|e| OvnError::EncodingError(e.to_string()))?;

        std::fs::write(dest_path, json_str)?;
        Ok(())
    }
}
