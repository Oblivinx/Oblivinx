//! MemTable — in-memory write buffer using a concurrent skip list.
//!
//! Writes are buffered in the MemTable for O(log N) insert and lookup.
//! When the MemTable exceeds the configured threshold (default 64MB),
//! it is frozen and flushed to an L0 SSTable by a background thread.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, AtomicBool, Ordering};
use parking_lot::RwLock;

use crate::error::{OvnError, OvnResult};

/// A single entry in the MemTable.
#[derive(Debug, Clone)]
pub struct MemTableEntry {
    /// Document key (document ID bytes)
    pub key: Vec<u8>,
    /// Document value (OBE-encoded bytes)
    pub value: Vec<u8>,
    /// Transaction ID
    pub txid: u64,
    /// Whether this is a tombstone (deletion marker)
    pub tombstone: bool,
    /// Collection ID this entry belongs to
    pub collection_id: u32,
}

impl MemTableEntry {
    /// Approximate memory size of this entry.
    pub fn memory_size(&self) -> usize {
        self.key.len() + self.value.len() + 8 + 1 + 4 + 64 // overhead estimate
    }
}

/// Thread-safe MemTable using a BTreeMap (sorted by key).
///
/// In a production system this would use `crossbeam-skiplist` for lock-free
/// concurrent access. We use a `RwLock<BTreeMap>` here for correctness
/// with the option to swap in a lock-free skip list later.
pub struct MemTable {
    /// Sorted entries: key → entry
    entries: RwLock<BTreeMap<Vec<u8>, MemTableEntry>>,
    /// Current memory usage in bytes
    memory_usage: AtomicU64,
    /// Maximum memory threshold before flush
    threshold: u64,
    /// Whether this MemTable is frozen (immutable)
    frozen: AtomicBool,
    /// Number of entries
    count: AtomicU64,
}

impl MemTable {
    /// Create a new MemTable with the given threshold in bytes.
    pub fn new(threshold: usize) -> Self {
        Self {
            entries: RwLock::new(BTreeMap::new()),
            memory_usage: AtomicU64::new(0),
            threshold: threshold as u64,
            frozen: AtomicBool::new(false),
            count: AtomicU64::new(0),
        }
    }

    /// Insert an entry into the MemTable.
    ///
    /// Returns `Err(MemTableFull)` if the MemTable is frozen.
    pub fn insert(&self, entry: MemTableEntry) -> OvnResult<()> {
        if self.frozen.load(Ordering::Acquire) {
            return Err(OvnError::MemTableFull {
                size: self.memory_usage.load(Ordering::Relaxed) as usize,
            });
        }

        let size = entry.memory_size() as u64;
        let key = entry.key.clone();

        let mut entries = self.entries.write();
        entries.insert(key, entry);
        self.memory_usage.fetch_add(size, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);

        Ok(())
    }

    /// Look up an entry by key.
    pub fn get(&self, key: &[u8]) -> Option<MemTableEntry> {
        let entries = self.entries.read();
        entries.get(key).cloned()
    }

    /// Scan entries in a key range [from, to).
    pub fn scan_range(&self, from: &[u8], to: &[u8]) -> Vec<MemTableEntry> {
        let entries = self.entries.read();
        entries
            .range(from.to_vec()..to.to_vec())
            .map(|(_, e)| e.clone())
            .collect()
    }

    /// Get all entries sorted by key (for flushing to SSTable).
    pub fn drain_sorted(&self) -> Vec<MemTableEntry> {
        let entries = self.entries.read();
        entries.values().cloned().collect()
    }

    /// Get all entries for a specific collection.
    pub fn entries_for_collection(&self, collection_id: u32) -> Vec<MemTableEntry> {
        let entries = self.entries.read();
        entries
            .values()
            .filter(|e| e.collection_id == collection_id)
            .cloned()
            .collect()
    }

    /// Check if the MemTable should be flushed.
    pub fn should_flush(&self) -> bool {
        self.memory_usage.load(Ordering::Relaxed) >= self.threshold
    }

    /// Freeze the MemTable (make it immutable).
    pub fn freeze(&self) {
        self.frozen.store(true, Ordering::Release);
    }

    /// Check if this MemTable is frozen.
    pub fn is_frozen(&self) -> bool {
        self.frozen.load(Ordering::Acquire)
    }

    /// Get current memory usage in bytes.
    pub fn memory_usage(&self) -> u64 {
        self.memory_usage.load(Ordering::Relaxed)
    }

    /// Get the number of entries.
    pub fn len(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Clear all entries (after successful flush).
    pub fn clear(&self) {
        let mut entries = self.entries.write();
        entries.clear();
        self.memory_usage.store(0, Ordering::Relaxed);
        self.count.store(0, Ordering::Relaxed);
        self.frozen.store(false, Ordering::Release);
    }

    /// Check if a key exists.
    pub fn contains_key(&self, key: &[u8]) -> bool {
        self.entries.read().contains_key(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_entry(key: &str, value: &str, txid: u64) -> MemTableEntry {
        MemTableEntry {
            key: key.as_bytes().to_vec(),
            value: value.as_bytes().to_vec(),
            txid,
            tombstone: false,
            collection_id: 1,
        }
    }

    #[test]
    fn test_insert_and_get() {
        let mt = MemTable::new(1024 * 1024);
        mt.insert(make_entry("key1", "value1", 1)).unwrap();
        mt.insert(make_entry("key2", "value2", 2)).unwrap();

        let entry = mt.get(b"key1").unwrap();
        assert_eq!(entry.value, b"value1");
        assert_eq!(entry.txid, 1);

        assert!(mt.get(b"key3").is_none());
    }

    #[test]
    fn test_sorted_drain() {
        let mt = MemTable::new(1024 * 1024);
        mt.insert(make_entry("c", "3", 3)).unwrap();
        mt.insert(make_entry("a", "1", 1)).unwrap();
        mt.insert(make_entry("b", "2", 2)).unwrap();

        let sorted = mt.drain_sorted();
        assert_eq!(sorted[0].key, b"a");
        assert_eq!(sorted[1].key, b"b");
        assert_eq!(sorted[2].key, b"c");
    }

    #[test]
    fn test_frozen_rejects_insert() {
        let mt = MemTable::new(1024 * 1024);
        mt.insert(make_entry("a", "1", 1)).unwrap();
        mt.freeze();
        assert!(mt.insert(make_entry("b", "2", 2)).is_err());
    }

    #[test]
    fn test_memory_threshold() {
        let mt = MemTable::new(100); // Very low threshold
        mt.insert(make_entry("key1", "a very long value that exceeds threshold", 1)).unwrap();
        assert!(mt.should_flush());
    }
}
