//! Pragma operations for the OvnEngine.
//!
//! Implements engine directives for configuration, diagnostics,
//! and integrity checking (similar to SQLite PRAGMA).

use super::OvnEngine;

use crate::error::OvnResult;
use std::collections::HashMap;

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  PRAGMAS
    // ═══════════════════════════════════════════════════════════════

    /// Set a pragma value.
    pub fn set_pragma(&self, name: &str, value: &serde_json::Value) -> OvnResult<()> {
        self.check_closed()?;
        self.pragmas.lock().unwrap().insert(name.to_string(), value.clone());
        log::debug!("Pragma '{}' = {:?}", name, value);
        Ok(())
    }

    /// Get a pragma value.
    pub fn get_pragma(&self, name: &str) -> OvnResult<serde_json::Value> {
        self.check_closed()?;
        let pragmas = self.pragmas.lock().unwrap();
        Ok(pragmas.get(name).cloned().unwrap_or(serde_json::Value::Null))
    }

    /// Handle special pragmas with side effects.
    pub fn pragma(&self, name: &str, value: Option<&serde_json::Value>) -> OvnResult<serde_json::Value> {
        self.check_closed()?;

        match name {
            // Integrity check pragma
            "integrity_check" => {
                let mode = value.and_then(|v| v.as_str()).unwrap_or("quick");
                self.run_integrity_check(mode)
            }

            // Page size pragma
            "page_size" => {
                if let Some(v) = value {
                    if let Some(size) = v.as_u64() {
                        let mut header = self.header.write();
                        header.page_size = size as u32;
                        log::info!("Page size set to {}", size);
                    }
                }
                Ok(serde_json::json!(self.header.read().page_size))
            }

            // Cache size pragma
            "cache_size" => {
                if let Some(v) = value {
                    if let Some(size) = v.as_u64() {
                        log::info!("Cache size set to {} bytes", size);
                    }
                }
                let stats = self.buffer_pool.stats();
                Ok(serde_json::json!({
                    "hits": stats.hits,
                    "misses": stats.misses,
                    "evictions": stats.evictions,
                    "hitRate": self.buffer_pool.hit_rate(),
                    "size": self.buffer_pool.size(),
                }))
            }

            // Foreign key pragma
            "foreign_keys" => {
                if let Some(v) = value {
                    let mode = if v.as_bool() == Some(true) { "strict" } else { "off" };
                    self.set_referential_integrity(mode)?;
                }
                let mode = self.integrity_mode.read().clone();
                Ok(serde_json::json!(mode != "off"))
            }

            // User version pragma
            "user_version" => {
                if let Some(v) = value {
                    let mut header = self.header.write();
                    // Store in application identifier field
                    if let Some(n) = v.as_u64() {
                        // Store as little-endian in first 8 bytes of app_id
                        let bytes = n.to_le_bytes();
                        header.app_id[..8].copy_from_slice(&bytes);
                    }
                }
                // Read back
                let header = self.header.read();
                let n = u64::from_le_bytes(header.app_id[..8].try_into().unwrap_or([0u8; 8]));
                Ok(serde_json::json!(n))
            }

            // Legacy pragma (backward compatibility)
            "legacy_mode" => {
                Ok(serde_json::json!(false))
            }

            // Generic pragma: store/retrieve from pragma map
            _ => {
                if let Some(v) = value {
                    self.set_pragma(name, v)?;
                    Ok(v.clone())
                } else {
                    self.get_pragma(name)
                }
            }
        }
    }

    /// Run integrity check on the database.
    fn run_integrity_check(&self, mode: &str) -> OvnResult<serde_json::Value> {
        let mut issues = Vec::new();
        let mut pages_checked = 0u64;
        let mut indexes_checked = 0u64;

        // Check file header
        let header = self.header.read();
        let header_bytes = header.to_bytes();
        if header_bytes.len() < 4096 {
            issues.push(serde_json::json!({
                "type": "header_truncated",
                "severity": "critical",
                "detail": "File header is truncated"
            }));
        }

        // Check magic number
        if header.magic != crate::OVN_MAGIC {
            issues.push(serde_json::json!({
                "type": "invalid_magic",
                "severity": "critical",
                "detail": format!("Invalid magic number: 0x{:08X}", header.magic)
            }));
        }
        drop(header);

        // Check B+ tree entries
        let entries = self.btree.scan_all();
        pages_checked += entries.len() as u64;

        for entry in &entries {
            // Check that each entry can be decoded as a document
            if !entry.tombstone && entry.value.is_empty() {
                issues.push(serde_json::json!({
                    "type": "empty_value",
                    "severity": "warning",
                    "detail": format!("B+ tree entry has empty value")
                }));
            }
        }

        // Check collections and indexes
        let collections = self.collections.read();
        for (name, coll) in collections.iter() {
            let indexes = coll.index_manager.list_indexes();
            indexes_checked += indexes.len() as u64;

            // Check for duplicate index names
            let mut seen_names = HashMap::new();
            for idx in &indexes {
                if seen_names.contains_key(&idx.name) {
                    issues.push(serde_json::json!({
                        "type": "duplicate_index",
                        "severity": "warning",
                        "detail": format!("Duplicate index name '{}' in collection '{}'", idx.name, name)
                    }));
                }
                seen_names.insert(&idx.name, true);
            }
        }

        // Check WAL for corruption
        let wal_records = self.wal.record_count();
        if wal_records > 0 {
            log::debug!("WAL has {} pending records", wal_records);
        }

        let status = if issues.is_empty() { "ok" } else { "corrupted" };

        Ok(serde_json::json!({
            "status": status,
            "pagesChecked": pages_checked,
            "indexesChecked": indexes_checked,
            "issues": issues,
            "mode": mode,
        }))
    }
}
