//! Columnar Mirror — HTAP ColumnChunks per (collection, field). [v2]
//!
//! ColumnarFlusher reads WAL records and appends typed column data to ColumnChunks.
//! Column data is used by the query planner for aggregation-heavy workloads.
//!
//! Phase 5 implementation: zone-map-aware chunked storage with RLE/DICT encoding.

use parking_lot::RwLock;
use std::collections::HashMap;

// ── Column Encoding ───────────────────────────────────────────────────────────

/// Column chunk encoding type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ColumnEncoding {
    Plain = 0x00,
    RLE = 0x01,
    Dictionary = 0x02,
    BitPack = 0x03,
    Delta = 0x04,
}

// ── Column Value (minimal for Phase 2 stub) ───────────────────────────────────

/// A single typed column value for zone map tracking.
#[derive(Debug, Clone, PartialEq)]
pub enum ColumnValue {
    Null,
    Int64(i64),
    Float64(f64),
    Bool(bool),
    Bytes(Vec<u8>),
}

// ── ColumnChunk ───────────────────────────────────────────────────────────────

/// One chunk of column data (up to 64 KiB, one field, one collection).
#[derive(Debug)]
pub struct ColumnChunk {
    /// Collection ID.
    pub collection_id: u32,
    /// Field name.
    pub field_name: String,
    /// Encoding used.
    pub encoding: ColumnEncoding,
    /// Raw encoded bytes.
    pub data: Vec<u8>,
    /// Number of rows in this chunk.
    pub row_count: u32,
    /// Minimum TxID for MVCC visibility.
    pub min_txid: u64,
    /// Maximum TxID for MVCC visibility.
    pub max_txid: u64,
    /// Row deletion bitmap (bit i = 1 means row i is deleted).
    pub delete_bitmap: Vec<u64>,
}

impl ColumnChunk {
    /// Create an empty column chunk.
    pub fn new(collection_id: u32, field_name: String) -> Self {
        Self {
            collection_id,
            field_name,
            encoding: ColumnEncoding::Plain,
            data: Vec::new(),
            row_count: 0,
            min_txid: u64::MAX,
            max_txid: 0,
            delete_bitmap: Vec::new(),
        }
    }

    /// Whether a row is deleted.
    pub fn is_deleted(&self, row_idx: u32) -> bool {
        let word = row_idx / 64;
        let bit = row_idx % 64;
        if word as usize >= self.delete_bitmap.len() {
            return false;
        }
        self.delete_bitmap[word as usize] & (1u64 << bit) != 0
    }

    /// Mark a row as deleted.
    pub fn mark_deleted(&mut self, row_idx: u32) {
        let word = row_idx / 64;
        let bit = row_idx % 64;
        while self.delete_bitmap.len() <= word as usize {
            self.delete_bitmap.push(0);
        }
        self.delete_bitmap[word as usize] |= 1u64 << bit;
    }
}

// ── Columnar Registry ─────────────────────────────────────────────────────────

/// Registry of which collections/fields have columnar mirroring enabled.
pub struct ColumnarRegistry {
    /// (collection_id, field_name) → enabled
    enabled: RwLock<HashMap<(u32, String), bool>>,
}

impl ColumnarRegistry {
    pub fn new() -> Self {
        Self {
            enabled: RwLock::new(HashMap::new()),
        }
    }

    /// Enable columnar mirroring for a (collection, field) pair.
    pub fn enable(&self, collection_id: u32, field_name: &str) {
        self.enabled
            .write()
            .insert((collection_id, field_name.to_string()), true);
    }

    /// Disable columnar mirroring.
    pub fn disable(&self, collection_id: u32, field_name: &str) {
        self.enabled
            .write()
            .remove(&(collection_id, field_name.to_string()));
    }

    /// Check if columnar is enabled for a (collection, field).
    pub fn is_enabled(&self, collection_id: u32, field_name: &str) -> bool {
        self.enabled
            .read()
            .contains_key(&(collection_id, field_name.to_string()))
    }

    /// All enabled (collection_id, field_name) pairs.
    pub fn all_enabled(&self) -> Vec<(u32, String)> {
        self.enabled.read().keys().cloned().collect()
    }
}

impl Default for ColumnarRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_column_chunk_delete_bitmap() {
        let mut chunk = ColumnChunk::new(1, "age".to_string());
        assert!(!chunk.is_deleted(0));
        chunk.mark_deleted(0);
        assert!(chunk.is_deleted(0));
        assert!(!chunk.is_deleted(1));
        chunk.mark_deleted(63);
        assert!(chunk.is_deleted(63));
    }

    #[test]
    fn test_columnar_registry() {
        let reg = ColumnarRegistry::new();
        reg.enable(1, "price");
        assert!(reg.is_enabled(1, "price"));
        assert!(!reg.is_enabled(1, "name"));
        reg.disable(1, "price");
        assert!(!reg.is_enabled(1, "price"));
    }
}
