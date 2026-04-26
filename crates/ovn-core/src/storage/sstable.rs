//! SSTable — Sorted String Table for flushed MemTable data.
//!
//! SSTables are immutable, sorted key-value files with a Bloom filter
//! for O(1) miss detection. They form the L0 layer of the LSM tree.
//!
//! ## SSTable Format
//! ```text
//! [SSTable Header]
//!   magic: u32 = 0x53535442 ('SSTB')
//!   entry_count: u64
//!   min_key_len: u32
//!   min_key: [u8]
//!   max_key_len: u32
//!   max_key: [u8]
//!   bloom_filter_size: u32
//!   bloom_filter: [u8]
//! [Data Entries - sorted by key]
//!   key_len: u32
//!   key: [u8]
//!   value_len: u32
//!   value: [u8]
//!   txid: u64
//!   tombstone: u8
//! ```

use parking_lot::RwLock;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

use crate::error::{OvnError, OvnResult};
use crate::storage::memtable::MemTableEntry;

/// SSTable magic number: 'SSTB'
const SSTABLE_MAGIC: u32 = 0x5353_5442;

/// Number of hash functions for the Bloom filter.
const BLOOM_K: usize = 7;

/// Bloom filter for O(1) negative lookups.
#[derive(Debug, Clone)]
pub struct BloomFilter {
    /// Bit array
    bits: Vec<u8>,
    /// Number of bits
    num_bits: usize,
    /// Number of hash functions
    k: usize,
}

impl BloomFilter {
    /// Create a new Bloom filter sized for the expected number of elements
    /// with approximately 1% false positive rate.
    pub fn new(expected_elements: usize) -> Self {
        // Optimal bit count: m = -n * ln(p) / (ln(2)^2)
        // For p=0.01: m ≈ 9.585 * n
        let num_bits = ((expected_elements as f64 * 9.585).ceil() as usize).max(64);
        let byte_count = num_bits.div_ceil(8);
        Self {
            bits: vec![0u8; byte_count],
            num_bits,
            k: BLOOM_K,
        }
    }

    /// Create from raw bits.
    pub fn from_raw(bits: Vec<u8>, num_bits: usize) -> Self {
        Self {
            bits,
            num_bits,
            k: BLOOM_K,
        }
    }

    /// Insert a key into the Bloom filter.
    pub fn insert(&mut self, key: &[u8]) {
        for i in 0..self.k {
            let bit_pos = self.hash_key(key, i) % self.num_bits;
            self.bits[bit_pos / 8] |= 1 << (bit_pos % 8);
        }
    }

    /// Check if a key might be in the set.
    /// Returns false if the key is definitely NOT in the set.
    /// Returns true if the key MIGHT be in the set (possible false positive).
    pub fn may_contain(&self, key: &[u8]) -> bool {
        for i in 0..self.k {
            let bit_pos = self.hash_key(key, i) % self.num_bits;
            if self.bits[bit_pos / 8] & (1 << (bit_pos % 8)) == 0 {
                return false;
            }
        }
        true
    }

    fn hash_key(&self, key: &[u8], seed: usize) -> usize {
        let mut hasher = DefaultHasher::new();
        seed.hash(&mut hasher);
        key.hash(&mut hasher);
        hasher.finish() as usize
    }

    /// Get the raw bits.
    pub fn bits(&self) -> &[u8] {
        &self.bits
    }

    /// Get the number of bits.
    pub fn num_bits(&self) -> usize {
        self.num_bits
    }
}

/// An entry in the SSTable.
#[derive(Debug, Clone)]
pub struct SSTableEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
    pub txid: u64,
    pub tombstone: bool,
}

/// An in-memory SSTable (L0).
///
/// In production, this would be stored as pages in the .ovn file's Index Segment.
/// This implementation keeps entries in memory for the initial prototype.
#[derive(Debug)]
pub struct SSTable {
    /// Sorted entries
    entries: Vec<SSTableEntry>,
    /// Bloom filter for fast negative lookups
    bloom: BloomFilter,
    /// Minimum key in this SSTable
    min_key: Vec<u8>,
    /// Maximum key in this SSTable
    max_key: Vec<u8>,
    /// SSTable identifier
    pub id: u64,
    /// SSTable level (0 = freshly flushed)
    pub level: u32,
}

impl SSTable {
    /// Build an SSTable from a sorted list of MemTable entries.
    pub fn from_memtable_entries(id: u64, entries: Vec<MemTableEntry>) -> OvnResult<Self> {
        if entries.is_empty() {
            return Err(OvnError::SSTableError(
                "Cannot create SSTable from empty entries".to_string(),
            ));
        }

        let mut bloom = BloomFilter::new(entries.len());
        let mut sstable_entries = Vec::with_capacity(entries.len());

        for entry in &entries {
            bloom.insert(&entry.key);
            sstable_entries.push(SSTableEntry {
                key: entry.key.clone(),
                value: entry.value.clone(),
                txid: entry.txid,
                tombstone: entry.tombstone,
            });
        }

        // Ensure sorted
        sstable_entries.sort_by(|a, b| a.key.cmp(&b.key));

        let min_key = sstable_entries.first().unwrap().key.clone();
        let max_key = sstable_entries.last().unwrap().key.clone();

        Ok(Self {
            entries: sstable_entries,
            bloom,
            min_key,
            max_key,
            id,
            level: 0,
        })
    }

    /// Point lookup by key.
    pub fn get(&self, key: &[u8]) -> Option<&SSTableEntry> {
        // Bloom filter check first
        if !self.bloom.may_contain(key) {
            return None;
        }

        // Binary search
        self.entries
            .binary_search_by(|e| e.key.as_slice().cmp(key))
            .ok()
            .map(|idx| &self.entries[idx])
    }

    /// Range scan [from, to).
    pub fn scan_range(&self, from: &[u8], to: &[u8]) -> Vec<&SSTableEntry> {
        let start = match self
            .entries
            .binary_search_by(|e| e.key.as_slice().cmp(from))
        {
            Ok(idx) => idx,
            Err(idx) => idx,
        };

        self.entries[start..]
            .iter()
            .take_while(|e| e.key.as_slice() < to)
            .collect()
    }

    /// Check if a key might be in this SSTable (using Bloom filter + range check).
    pub fn may_contain(&self, key: &[u8]) -> bool {
        if key < self.min_key.as_slice() || key > self.max_key.as_slice() {
            return false;
        }
        self.bloom.may_contain(key)
    }

    /// Get the number of entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Get all entries (for compaction).
    pub fn entries(&self) -> &[SSTableEntry] {
        &self.entries
    }

    /// Serialize the SSTable to bytes with an 8-byte CRC32C footer.
    ///
    /// Format: `encode()` payload + 4-byte CRC32C + 4-byte reserved (0x00).
    /// `from_bytes_verified()` checks this footer before decoding.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = self.encode();
        let crc = crc32c::crc32c(&buf);
        buf.extend_from_slice(&crc.to_le_bytes()); // 4 bytes CRC32C
        buf.extend_from_slice(&[0u8; 4]);          // 4 bytes reserved
        buf
    }

    /// Decode an SSTable from bytes that were written by `to_bytes()`.
    ///
    /// Verifies the 8-byte CRC32C footer before decoding.  Returns
    /// `Err(SstableIncomplete)` on any mismatch (truncated write or
    /// on-disk corruption), so the caller can delete the file and
    /// regenerate from WAL.
    pub fn from_bytes_verified(id: u64, data: &[u8], path: &str) -> OvnResult<Self> {
        const FOOTER: usize = 8;
        if data.len() < FOOTER {
            return Err(OvnError::SstableIncomplete { path: path.to_string() });
        }
        let payload = &data[..data.len() - FOOTER];
        let stored_crc = u32::from_le_bytes(
            data[data.len() - FOOTER..data.len() - FOOTER + 4]
                .try_into()
                .unwrap(),
        );
        let computed_crc = crc32c::crc32c(payload);
        if stored_crc != computed_crc {
            log::warn!(
                "SSTable incomplete: {path} CRC32C mismatch (stored=0x{stored_crc:08X}, computed=0x{computed_crc:08X})"
            );
            return Err(OvnError::SstableIncomplete { path: path.to_string() });
        }
        Self::decode(id, payload)
    }

    /// Serialize the SSTable to bytes (no footer).
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::new();

        // Header
        buf.extend_from_slice(&SSTABLE_MAGIC.to_le_bytes());
        buf.extend_from_slice(&(self.entries.len() as u64).to_le_bytes());

        // Min key
        buf.extend_from_slice(&(self.min_key.len() as u32).to_le_bytes());
        buf.extend_from_slice(&self.min_key);

        // Max key
        buf.extend_from_slice(&(self.max_key.len() as u32).to_le_bytes());
        buf.extend_from_slice(&self.max_key);

        // Bloom filter
        let bloom_bits = self.bloom.bits();
        buf.extend_from_slice(&(bloom_bits.len() as u32).to_le_bytes());
        buf.extend_from_slice(bloom_bits);

        // Entries
        for entry in &self.entries {
            buf.extend_from_slice(&(entry.key.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.key);
            buf.extend_from_slice(&(entry.value.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.value);
            buf.extend_from_slice(&entry.txid.to_le_bytes());
            buf.push(if entry.tombstone { 0xFF } else { 0x00 });
        }

        buf
    }

    /// Deserialize an SSTable from bytes.
    pub fn decode(id: u64, data: &[u8]) -> OvnResult<Self> {
        let mut pos = 0;

        // Magic
        if data.len() < 4 {
            return Err(OvnError::SSTableError("Data too short".to_string()));
        }
        let magic = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
        if magic != SSTABLE_MAGIC {
            return Err(OvnError::SSTableError(format!(
                "Invalid magic: 0x{magic:08X}"
            )));
        }
        pos += 4;

        // Entry count
        let entry_count = u64::from_le_bytes([
            data[pos],
            data[pos + 1],
            data[pos + 2],
            data[pos + 3],
            data[pos + 4],
            data[pos + 5],
            data[pos + 6],
            data[pos + 7],
        ]) as usize;
        pos += 8;

        // Min key
        let min_key_len =
            u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        pos += 4;
        let min_key = data[pos..pos + min_key_len].to_vec();
        pos += min_key_len;

        // Max key
        let max_key_len =
            u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        pos += 4;
        let max_key = data[pos..pos + max_key_len].to_vec();
        pos += max_key_len;

        // Bloom filter
        let bloom_size =
            u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]]) as usize;
        pos += 4;
        let bloom_bits = data[pos..pos + bloom_size].to_vec();
        pos += bloom_size;
        let bloom = BloomFilter::from_raw(bloom_bits, bloom_size * 8);

        // Entries
        let mut entries = Vec::with_capacity(entry_count);
        for _ in 0..entry_count {
            let key_len =
                u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                    as usize;
            pos += 4;
            let key = data[pos..pos + key_len].to_vec();
            pos += key_len;

            let val_len =
                u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                    as usize;
            pos += 4;
            let value = data[pos..pos + val_len].to_vec();
            pos += val_len;

            let txid = u64::from_le_bytes([
                data[pos],
                data[pos + 1],
                data[pos + 2],
                data[pos + 3],
                data[pos + 4],
                data[pos + 5],
                data[pos + 6],
                data[pos + 7],
            ]);
            pos += 8;

            let tombstone = data[pos] == 0xFF;
            pos += 1;

            entries.push(SSTableEntry {
                key,
                value,
                txid,
                tombstone,
            });
        }

        Ok(Self {
            entries,
            bloom,
            min_key,
            max_key,
            id,
            level: 0,
        })
    }
}

/// Manager for multiple SSTables (the L0 layer).
pub struct SSTableManager {
    /// Active SSTables sorted by ID (newest first)
    tables: RwLock<Vec<SSTable>>,
    /// Next SSTable ID
    next_id: std::sync::atomic::AtomicU64,
}

impl SSTableManager {
    pub fn new() -> Self {
        Self {
            tables: RwLock::new(Vec::new()),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }
}

impl Default for SSTableManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SSTableManager {
    pub fn add(&self, sstable: SSTable) {
        self.tables.write().push(sstable);
    }

    /// Look up a key across all SSTables (newest first).
    pub fn get(&self, key: &[u8]) -> Option<SSTableEntry> {
        let tables = self.tables.read();
        // Search newest first
        for table in tables.iter().rev() {
            if let Some(entry) = table.get(key) {
                return Some(entry.clone());
            }
        }
        None
    }

    /// Get the number of L0 SSTables (triggers compaction when > 4).
    pub fn l0_count(&self) -> usize {
        self.tables.read().iter().filter(|t| t.level == 0).count()
    }

    /// Check if compaction should be triggered.
    pub fn should_compact(&self) -> bool {
        self.l0_count() >= 4
    }

    /// Get next SSTable ID.
    pub fn next_id(&self) -> u64 {
        self.next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    }

    /// Remove all SSTables (after compaction into B+ tree).
    pub fn clear_compacted(&self) {
        self.tables.write().clear();
    }

    /// Get all entries from all SSTables merged and sorted (for compaction).
    pub fn merge_all(&self) -> Vec<SSTableEntry> {
        let tables = self.tables.read();
        let mut all_entries: Vec<SSTableEntry> = Vec::new();

        for table in tables.iter() {
            all_entries.extend(table.entries().iter().cloned());
        }

        // Sort by key, then by txid descending (newest version first)
        all_entries.sort_by(|a, b| a.key.cmp(&b.key).then(b.txid.cmp(&a.txid)));

        // Deduplicate: keep only the newest version per key
        all_entries.dedup_by(|a, b| a.key == b.key);

        all_entries
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memtable::MemTableEntry;

    fn make_memtable_entries() -> Vec<MemTableEntry> {
        vec![
            MemTableEntry {
                key: b"key_a".to_vec(),
                value: b"value_a".to_vec(),
                txid: 1,
                tombstone: false,
                collection_id: 1,
            },
            MemTableEntry {
                key: b"key_b".to_vec(),
                value: b"value_b".to_vec(),
                txid: 2,
                tombstone: false,
                collection_id: 1,
            },
            MemTableEntry {
                key: b"key_c".to_vec(),
                value: b"value_c".to_vec(),
                txid: 3,
                tombstone: false,
                collection_id: 1,
            },
        ]
    }

    #[test]
    fn test_bloom_filter() {
        let mut bloom = BloomFilter::new(100);
        bloom.insert(b"hello");
        bloom.insert(b"world");

        assert!(bloom.may_contain(b"hello"));
        assert!(bloom.may_contain(b"world"));
        // Not inserted — should return false (no false positive for this simple case)
        // Note: false positives are possible but unlikely with few elements
    }

    #[test]
    fn test_sstable_build_and_lookup() {
        let entries = make_memtable_entries();
        let sst = SSTable::from_memtable_entries(1, entries).unwrap();

        assert_eq!(sst.len(), 3);
        assert!(sst.get(b"key_a").is_some());
        assert!(sst.get(b"key_b").is_some());
        assert!(sst.get(b"key_c").is_some());
        assert!(sst.get(b"key_d").is_none());
    }

    #[test]
    fn test_sstable_range_scan() {
        let entries = make_memtable_entries();
        let sst = SSTable::from_memtable_entries(1, entries).unwrap();

        let results = sst.scan_range(b"key_a", b"key_c");
        assert_eq!(results.len(), 2); // key_a and key_b
    }

    #[test]
    fn test_sstable_encode_decode() {
        let entries = make_memtable_entries();
        let sst = SSTable::from_memtable_entries(1, entries).unwrap();

        let encoded = sst.encode();
        let decoded = SSTable::decode(1, &encoded).unwrap();

        assert_eq!(decoded.len(), 3);
        assert!(decoded.get(b"key_a").is_some());
        assert!(decoded.get(b"key_b").is_some());
        assert!(decoded.get(b"key_c").is_some());
    }
}
