//! Adaptive Hybrid Index Tree (AHIT).
//!
//! AHIT divides the index into two zones:
//! - **Hot Zone**: In-memory B+ tree for frequently accessed index entries
//! - **Cold Zone**: Immutable SSTable files on disk for infrequent data
//!
//! A background Promoter monitors access patterns and moves cold nodes
//! to the Hot Zone when their frequency exceeds a threshold.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use parking_lot::RwLock;

use crate::error::OvnResult;
use crate::storage::btree::{BPlusTree, BTreeEntry};

/// Default promotion threshold: 1000 accesses in 60 seconds
const DEFAULT_PROMOTION_THRESHOLD: u64 = 1000;

/// Default eviction threshold: 100 accesses in 60 seconds
const DEFAULT_EVICTION_THRESHOLD: u64 = 100;

/// Access frequency counter for AHIT nodes.
#[derive(Debug)]
struct AccessCounter {
    count: AtomicU64,
    window_start: AtomicU64,
}

impl AccessCounter {
    fn new() -> Self {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            count: AtomicU64::new(0),
            window_start: AtomicU64::new(now),
        }
    }

    fn increment(&self) -> u64 {
        self.count.fetch_add(1, Ordering::Relaxed) + 1
    }

    fn reset_if_expired(&self, window_secs: u64) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let start = self.window_start.load(Ordering::Relaxed);
        if now - start > window_secs {
            self.count.store(0, Ordering::Relaxed);
            self.window_start.store(now, Ordering::Relaxed);
        }
    }

    fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }
}

/// The Adaptive Hybrid Index Tree.
pub struct AdaptiveHybridIndexTree {
    /// Hot Zone — in-memory B+ tree for frequently accessed entries
    hot_zone: BPlusTree,
    /// Cold Zone — overflow entries stored as sorted vectors (simulating SSTables)
    cold_zone: RwLock<BTreeMap<Vec<u8>, BTreeEntry>>,
    /// Access counters per key prefix (for promotion decisions)
    access_counters: RwLock<BTreeMap<Vec<u8>, AccessCounter>>,
    /// Promotion threshold (accesses per window)
    promotion_threshold: u64,
    /// Eviction threshold
    eviction_threshold: u64,
    /// Hot zone memory limit in bytes
    hot_zone_limit: usize,
    /// Index name
    pub name: String,
    /// Index field path (e.g., "age" or "address.city")
    pub field_path: String,
    /// Whether this index is unique
    pub unique: bool,
}

impl AdaptiveHybridIndexTree {
    /// Create a new AHIT index.
    pub fn new(name: String, field_path: String, unique: bool) -> Self {
        Self {
            hot_zone: BPlusTree::new(),
            cold_zone: RwLock::new(BTreeMap::new()),
            access_counters: RwLock::new(BTreeMap::new()),
            promotion_threshold: DEFAULT_PROMOTION_THRESHOLD,
            eviction_threshold: DEFAULT_EVICTION_THRESHOLD,
            hot_zone_limit: 64 * 1024 * 1024, // 64MB default
            name,
            field_path,
            unique,
        }
    }

    /// Insert an entry into the index.
    pub fn insert(&self, key: Vec<u8>, doc_id: Vec<u8>, txid: u64) -> OvnResult<()> {
        let entry = BTreeEntry {
            key: key.clone(),
            value: doc_id,
            txid,
            tombstone: false,
        };

        // Always insert into hot zone first (LSM-style write path)
        self.hot_zone.insert(entry)?;
        self.record_access(&key);
        Ok(())
    }

    /// Look up entries by index key.
    pub fn get(&self, key: &[u8]) -> Option<BTreeEntry> {
        self.record_access(key);

        // Check hot zone first
        if let Some(entry) = self.hot_zone.get(key) {
            if !entry.tombstone {
                return Some(entry);
            }
        }

        // Check cold zone
        let cold = self.cold_zone.read();
        cold.get(key).cloned()
    }

    /// Range scan on the index.
    pub fn range_scan(&self, from: &[u8], to: &[u8]) -> Vec<BTreeEntry> {
        let mut results = self.hot_zone.range_scan(from, to);

        // Also scan cold zone
        let cold = self.cold_zone.read();
        for (key, entry) in cold.range(from.to_vec()..to.to_vec()) {
            if !results.iter().any(|e| e.key == *key) {
                results.push(entry.clone());
            }
        }

        results.sort_by(|a, b| a.key.cmp(&b.key));
        results
    }

    /// Delete an entry from the index.
    pub fn delete(&self, key: &[u8]) -> Option<BTreeEntry> {
        // Try hot zone first
        if let Some(entry) = self.hot_zone.delete(key) {
            return Some(entry);
        }

        // Try cold zone
        self.cold_zone.write().remove(key)
    }

    /// Run the promotion check — move cold entries to hot zone if access threshold met.
    pub fn promote(&self) {
        let counters = self.access_counters.read();
        let mut cold = self.cold_zone.write();

        let to_promote: Vec<Vec<u8>> = counters
            .iter()
            .filter(|(_, c)| c.count() >= self.promotion_threshold)
            .filter_map(|(key, _)| {
                if cold.contains_key(key) {
                    Some(key.clone())
                } else {
                    None
                }
            })
            .collect();

        for key in to_promote {
            if let Some(entry) = cold.remove(&key) {
                let _ = self.hot_zone.insert(entry);
            }
        }
    }

    /// Run the demotion check — move infrequently accessed hot entries to cold zone.
    pub fn demote(&self) {
        let counters = self.access_counters.read();
        let entries = self.hot_zone.scan_all();

        for entry in entries {
            let count = counters
                .get(&entry.key)
                .map(|c| c.count())
                .unwrap_or(0);

            if count < self.eviction_threshold {
                self.hot_zone.delete(&entry.key);
                self.cold_zone.write().insert(entry.key.clone(), entry);
            }
        }
    }

    /// Get the total number of indexed entries.
    pub fn len(&self) -> u64 {
        self.hot_zone.len() + self.cold_zone.read().len() as u64
    }

    /// Check if the index is empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn record_access(&self, key: &[u8]) {
        let mut counters = self.access_counters.write();
        let counter = counters
            .entry(key.to_vec())
            .or_insert_with(AccessCounter::new);
        counter.reset_if_expired(60);
        counter.increment();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ahit_insert_and_get() {
        let ahit = AdaptiveHybridIndexTree::new(
            "age_idx".to_string(),
            "age".to_string(),
            false,
        );

        ahit.insert(b"28".to_vec(), b"doc1".to_vec(), 1).unwrap();
        ahit.insert(b"30".to_vec(), b"doc2".to_vec(), 2).unwrap();

        let result = ahit.get(b"28").unwrap();
        assert_eq!(result.value, b"doc1");

        assert!(ahit.get(b"99").is_none());
    }

    #[test]
    fn test_ahit_range_scan() {
        let ahit = AdaptiveHybridIndexTree::new(
            "idx".to_string(), "field".to_string(), false,
        );

        for i in 0..10u32 {
            let key = format!("{:03}", i);
            ahit.insert(key.as_bytes().to_vec(), format!("doc{i}").into_bytes(), i as u64).unwrap();
        }

        let results = ahit.range_scan(b"003", b"007");
        assert_eq!(results.len(), 4); // 003, 004, 005, 006
    }

    #[test]
    fn test_ahit_delete() {
        let ahit = AdaptiveHybridIndexTree::new(
            "idx".to_string(), "field".to_string(), false,
        );

        ahit.insert(b"key1".to_vec(), b"doc1".to_vec(), 1).unwrap();
        ahit.delete(b"key1");
        assert!(ahit.get(b"key1").is_none());
    }
}
