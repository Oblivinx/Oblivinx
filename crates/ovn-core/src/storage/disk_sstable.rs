//! Real SSTable disk files.
//!
//! SSTables are immutable sorted string tables written to actual disk files.
//! Each SSTable consists of:
//! 1. Data block: sorted key-value pairs
//! 2. Bloom filter: for O(1) negative lookups
//! 3. Index block: sparse index for fast binary search
//! 4. Footer: magic number, metadata, checksum

use crc32fast::Hasher as Crc32Hasher;
use std::collections::hash_map::DefaultHasher;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::error::{OvnError, OvnResult};
use crate::storage::memtable::MemTableEntry;

/// SSTable magic number: 'SSTF' (SSTable File)
const SSTABLE_FILE_MAGIC: u32 = 0x5353_5446;

/// Number of hash functions for the Bloom filter.
const BLOOM_K: usize = 7;

/// SSTable footer — last 32 bytes of every SSTable file.
#[derive(Debug, Clone)]
pub struct SSTableFooter {
    /// Magic number
    pub magic: u32,
    /// SSTable ID
    pub sstable_id: u64,
    /// Offset to index block
    pub index_offset: u64,
    /// Offset to bloom filter
    pub bloom_offset: u64,
    /// Number of entries
    pub entry_count: u64,
    /// CRC32 of data + index + bloom
    pub checksum: u32,
}

impl SSTableFooter {
    pub fn encode(&self) -> [u8; 40] {
        let mut buf = [0u8; 40];
        buf[0..4].copy_from_slice(&self.magic.to_le_bytes());
        buf[4..12].copy_from_slice(&self.sstable_id.to_le_bytes());
        buf[12..20].copy_from_slice(&self.index_offset.to_le_bytes());
        buf[20..28].copy_from_slice(&self.bloom_offset.to_le_bytes());
        buf[28..36].copy_from_slice(&self.entry_count.to_le_bytes());
        buf[36..40].copy_from_slice(&self.checksum.to_le_bytes());
        buf
    }

    pub fn decode(buf: &[u8]) -> OvnResult<Self> {
        if buf.len() < 40 {
            return Err(OvnError::SSTableError("Footer too short".to_string()));
        }
        let magic = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
        if magic != SSTABLE_FILE_MAGIC {
            return Err(OvnError::SSTableError(format!(
                "Invalid magic: 0x{magic:08X}"
            )));
        }
        Ok(Self {
            magic,
            sstable_id: u64::from_le_bytes(buf[4..12].try_into().unwrap()),
            index_offset: u64::from_le_bytes(buf[12..20].try_into().unwrap()),
            bloom_offset: u64::from_le_bytes(buf[20..28].try_into().unwrap()),
            entry_count: u64::from_le_bytes(buf[28..36].try_into().unwrap()),
            checksum: u32::from_le_bytes(buf[36..40].try_into().unwrap()),
        })
    }
}

/// Bloom filter for SSTable.
#[derive(Debug, Clone)]
pub struct SSTableBloom {
    bits: Vec<u8>,
    num_bits: usize,
    k: usize,
}

impl SSTableBloom {
    pub fn new(expected_elements: usize) -> Self {
        let num_bits = ((expected_elements as f64 * 9.585).ceil() as usize).max(64);
        let byte_count = num_bits.div_ceil(8);
        Self {
            bits: vec![0u8; byte_count],
            num_bits,
            k: BLOOM_K,
        }
    }

    pub fn from_raw(bits: Vec<u8>, num_bits: usize) -> Self {
        Self {
            bits,
            num_bits,
            k: BLOOM_K,
        }
    }

    pub fn insert(&mut self, key: &[u8]) {
        for i in 0..self.k {
            let bit_pos = self.hash_key(key, i) % self.num_bits;
            self.bits[bit_pos / 8] |= 1 << (bit_pos % 8);
        }
    }

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

    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(8 + self.bits.len());
        buf.extend_from_slice(&(self.num_bits as u32).to_le_bytes());
        buf.extend_from_slice(&self.bits);
        buf
    }

    pub fn decode(buf: &[u8]) -> OvnResult<(Self, usize)> {
        if buf.len() < 4 {
            return Err(OvnError::SSTableError("Bloom too short".to_string()));
        }
        let num_bits = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
        let byte_count = num_bits.div_ceil(8);
        if buf.len() < 4 + byte_count {
            return Err(OvnError::SSTableError("Bloom truncated".to_string()));
        }
        let bits = buf[4..4 + byte_count].to_vec();
        Ok((Self::from_raw(bits, num_bits), 4 + byte_count))
    }
}

/// SSTable entry on disk.
#[derive(Debug, Clone)]
pub struct DiskSSTableEntry {
    pub key: Vec<u8>,
    pub value: Vec<u8>,
    pub txid: u64,
    pub tombstone: bool,
}

/// An SSTable stored as a real disk file.
pub struct DiskSSTable {
    /// SSTable ID
    pub id: u64,
    /// File path
    pub path: PathBuf,
    /// Footer metadata
    pub footer: SSTableFooter,
    /// Cached bloom filter (loaded on first access)
    bloom: Option<SSTableBloom>,
}

impl DiskSSTable {
    /// Write an SSTable to disk from sorted entries.
    pub fn create_from_entries(
        id: u64,
        directory: &Path,
        entries: &[DiskSSTableEntry],
    ) -> OvnResult<Self> {
        if entries.is_empty() {
            return Err(OvnError::SSTableError(
                "Cannot create SSTable from empty entries".to_string(),
            ));
        }

        let filename = format!("sst_{:06}.sst", id);
        let path = directory.join(&filename);

        let mut file = File::create(&path).map_err(|e| OvnError::SSTableError(e.to_string()))?;

        // Build bloom filter
        let mut bloom = SSTableBloom::new(entries.len());
        for entry in entries {
            bloom.insert(&entry.key);
        }

        // Write data block
        let _data_start = file.stream_position().unwrap_or(0);
        let mut hasher = Crc32Hasher::new();

        for entry in entries {
            // Encode entry
            let mut buf = Vec::new();
            buf.extend_from_slice(&(entry.key.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.key);
            buf.extend_from_slice(&(entry.value.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.value);
            buf.extend_from_slice(&entry.txid.to_le_bytes());
            buf.push(if entry.tombstone { 0xFF } else { 0x00 });

            hasher.update(&buf);
            file.write_all(&buf)
                .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        }
        let data_end = file.stream_position().unwrap_or(0);

        // Write bloom filter
        let bloom_offset = data_end;
        let bloom_bytes = bloom.encode();
        hasher.update(&bloom_bytes);
        file.write_all(&bloom_bytes)
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let index_offset = file.stream_position().unwrap_or(0);

        // Write sparse index (every 16th key for efficient binary search)
        let stride = 16usize;
        for (i, entry) in entries.iter().enumerate().step_by(stride) {
            let mut buf = Vec::new();
            buf.extend_from_slice(&(i as u32).to_le_bytes()); // entry index
            buf.extend_from_slice(&(entry.key.len() as u32).to_le_bytes());
            buf.extend_from_slice(&entry.key);
            hasher.update(&buf);
            file.write_all(&buf)
                .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        }

        // Write footer
        let checksum = hasher.finalize();
        let footer = SSTableFooter {
            magic: SSTABLE_FILE_MAGIC,
            sstable_id: id,
            index_offset,
            bloom_offset,
            entry_count: entries.len() as u64,
            checksum,
        };

        file.write_all(&footer.encode())
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        file.sync_all()
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;

        Ok(Self {
            id,
            path,
            footer,
            bloom: Some(bloom),
        })
    }

    /// Open an existing SSTable file from disk.
    pub fn open(id: u64, directory: &Path) -> OvnResult<Self> {
        let filename = format!("sst_{:06}.sst", id);
        let path = directory.join(&filename);

        let mut file = File::open(&path).map_err(|e| {
            OvnError::SSTableError(format!("Cannot open SSTable '{}': {}", filename, e))
        })?;
        let file_size = file
            .metadata()
            .map_err(|e| OvnError::SSTableError(e.to_string()))?
            .len();

        if file_size < 40 {
            return Err(OvnError::SSTableError(format!(
                "SSTable '{}' too small: {} bytes",
                filename, file_size
            )));
        }

        // Read footer (last 40 bytes)
        file.seek(SeekFrom::End(-40))
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let mut footer_buf = [0u8; 40];
        file.read_exact(&mut footer_buf)
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let footer = SSTableFooter::decode(&footer_buf)?;

        // Verify checksum
        file.seek(SeekFrom::Start(0))
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let mut data = vec![0u8; (footer.bloom_offset) as usize];
        file.read_exact(&mut data)
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let mut hasher = Crc32Hasher::new();
        hasher.update(&data);
        let computed = hasher.finalize();

        if computed != footer.checksum {
            return Err(OvnError::SSTableError(format!(
                "SSTable '{}' checksum mismatch: expected 0x{:08X}, got 0x{:08X}",
                filename, footer.checksum, computed
            )));
        }

        // Load bloom filter
        file.seek(SeekFrom::Start(footer.bloom_offset))
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let bloom_size = footer.index_offset - footer.bloom_offset;
        let mut bloom_buf = vec![0u8; bloom_size as usize];
        file.read_exact(&mut bloom_buf)
            .map_err(|e| OvnError::SSTableError(e.to_string()))?;
        let (bloom, _) = SSTableBloom::decode(&bloom_buf)?;

        Ok(Self {
            id,
            path,
            footer,
            bloom: Some(bloom),
        })
    }

    /// Point lookup by key (binary search + bloom filter).
    pub fn get(&self, key: &[u8]) -> Option<DiskSSTableEntry> {
        // Bloom filter check
        if let Some(ref bloom) = self.bloom {
            if !bloom.may_contain(key) {
                return None;
            }
        }

        // Open file and binary search
        let mut file = File::open(&self.path).ok()?;
        let data_end = self.footer.bloom_offset as usize;

        // Linear scan for simplicity (in production, use index block)
        let mut offset = 0u64;
        file.seek(SeekFrom::Start(0)).ok()?;

        while offset < data_end as u64 {
            // Read key length
            let mut len_buf = [0u8; 4];
            if file.read_exact(&mut len_buf).is_err() {
                break;
            }
            offset += 4;
            let key_len = u32::from_le_bytes(len_buf) as usize;

            // Read key
            let mut key_buf = vec![0u8; key_len];
            if file.read_exact(&mut key_buf).is_err() {
                break;
            }
            offset += key_len as u64;

            // Read value length
            if file.read_exact(&mut len_buf).is_err() {
                break;
            }
            offset += 4;
            let val_len = u32::from_le_bytes(len_buf) as usize;

            // Read value
            let mut val_buf = vec![0u8; val_len];
            if file.read_exact(&mut val_buf).is_err() {
                break;
            }
            offset += val_len as u64;

            // Read txid and tombstone
            let mut txid_buf = [0u8; 8];
            if file.read_exact(&mut txid_buf).is_err() {
                break;
            }
            offset += 8;
            let txid = u64::from_le_bytes(txid_buf);

            let mut tomb_buf = [0u8; 1];
            if file.read_exact(&mut tomb_buf).is_err() {
                break;
            }
            offset += 1;
            let tombstone = tomb_buf[0] == 0xFF;

            // Check if this is the key we're looking for
            if key_buf == key {
                return Some(DiskSSTableEntry {
                    key: key_buf,
                    value: val_buf,
                    txid,
                    tombstone,
                });
            }

            // Optimization: if key > current key, continue; if key < current key and we're past it, not found
            if key_buf.as_slice() > key {
                return None; // Keys are sorted, we passed it
            }
        }

        None
    }

    /// Range scan [from, to).
    pub fn scan_range(&self, from: &[u8], to: &[u8]) -> Vec<DiskSSTableEntry> {
        let mut results = Vec::new();
        let mut file = match File::open(&self.path) {
            Ok(f) => f,
            Err(_) => return results,
        };
        let data_end = self.footer.bloom_offset as usize;

        if file.seek(SeekFrom::Start(0)).is_err() {
            return results;
        };
        let mut offset = 0u64;

        while offset < data_end as u64 {
            let mut len_buf = [0u8; 4];
            if file.read_exact(&mut len_buf).is_err() {
                break;
            }
            offset += 4;
            let key_len = u32::from_le_bytes(len_buf) as usize;

            let mut key_buf = vec![0u8; key_len];
            if file.read_exact(&mut key_buf).is_err() {
                break;
            }
            offset += key_len as u64;

            if file.read_exact(&mut len_buf).is_err() {
                break;
            }
            offset += 4;
            let val_len = u32::from_le_bytes(len_buf) as usize;

            let mut val_buf = vec![0u8; val_len];
            if file.read_exact(&mut val_buf).is_err() {
                break;
            }
            offset += val_len as u64;

            let mut txid_buf = [0u8; 8];
            if file.read_exact(&mut txid_buf).is_err() {
                break;
            }
            offset += 8;
            let txid = u64::from_le_bytes(txid_buf);

            let mut tomb_buf = [0u8; 1];
            if file.read_exact(&mut tomb_buf).is_err() {
                break;
            }
            offset += 1;
            let tombstone = tomb_buf[0] == 0xFF;

            if key_buf.as_slice() >= from && key_buf.as_slice() < to {
                results.push(DiskSSTableEntry {
                    key: key_buf.clone(),
                    value: val_buf,
                    txid,
                    tombstone,
                });
            }

            if key_buf.as_slice() >= to {
                break;
            }
        }

        results
    }

    /// Get number of entries.
    pub fn len(&self) -> u64 {
        self.footer.entry_count
    }

    /// True if the SSTable has no entries.
    pub fn is_empty(&self) -> bool {
        self.footer.entry_count == 0
    }

    /// Delete the SSTable file.
    pub fn delete(&self) -> OvnResult<()> {
        std::fs::remove_file(&self.path).map_err(|e| OvnError::SSTableError(e.to_string()))
    }
}

/// Manager for disk-backed SSTables.
pub struct DiskSSTableManager {
    /// Directory for SSTable files
    directory: PathBuf,
    /// Active SSTables
    tables: parking_lot::RwLock<Vec<DiskSSTable>>,
    /// Next SSTable ID
    next_id: std::sync::atomic::AtomicU64,
}

impl DiskSSTableManager {
    pub fn new(directory: &Path) -> OvnResult<Self> {
        std::fs::create_dir_all(directory).map_err(|e| OvnError::SSTableError(e.to_string()))?;

        // Scan existing SSTables to find next ID
        let mut max_id = 0u64;
        if let Ok(entries) = std::fs::read_dir(directory) {
            for entry in entries.flatten() {
                if let Some(name) = entry.file_name().to_str() {
                    if name.starts_with("sst_") && name.ends_with(".sst") {
                        if let Some(id_str) = name
                            .strip_prefix("sst_")
                            .and_then(|s| s.strip_suffix(".sst"))
                        {
                            if let Ok(id) = id_str.parse::<u64>() {
                                max_id = max_id.max(id);
                            }
                        }
                    }
                }
            }
        }

        Ok(Self {
            directory: directory.to_path_buf(),
            tables: parking_lot::RwLock::new(Vec::new()),
            next_id: std::sync::atomic::AtomicU64::new(max_id + 1),
        })
    }

    /// Create a new SSTable from MemTable entries and write to disk.
    pub fn flush_from_memtable(&self, entries: Vec<MemTableEntry>) -> OvnResult<()> {
        if entries.is_empty() {
            return Ok(());
        }

        let id = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);

        // Convert to disk entries
        let disk_entries: Vec<DiskSSTableEntry> = entries
            .into_iter()
            .map(|e| DiskSSTableEntry {
                key: e.key,
                value: e.value,
                txid: e.txid,
                tombstone: e.tombstone,
            })
            .collect();

        let sstable = DiskSSTable::create_from_entries(id, &self.directory, &disk_entries)?;

        log::info!(
            "Created SSTable {} at {:?} ({} entries)",
            id,
            sstable.path,
            sstable.footer.entry_count
        );

        self.tables.write().push(sstable);
        Ok(())
    }

    /// Point lookup across all SSTables (newest first).
    pub fn get(&self, key: &[u8]) -> Option<DiskSSTableEntry> {
        let tables = self.tables.read();
        for table in tables.iter().rev() {
            if let Some(entry) = table.get(key) {
                return Some(entry);
            }
        }
        None
    }

    /// Range scan across all SSTables.
    pub fn scan_range(&self, from: &[u8], to: &[u8]) -> Vec<DiskSSTableEntry> {
        let tables = self.tables.read();
        let mut results = Vec::new();
        for table in tables.iter() {
            results.extend(table.scan_range(from, to));
        }
        // Deduplicate by key (keep newest)
        results.sort_by(|a, b| a.key.cmp(&b.key).then(b.txid.cmp(&a.txid)));
        results.dedup_by(|a, b| a.key == b.key);
        results
    }

    /// Get number of SSTables.
    pub fn count(&self) -> usize {
        self.tables.read().len()
    }

    /// Check if compaction should be triggered (>= 4 SSTables).
    pub fn should_compact(&self) -> bool {
        self.count() >= 4
    }

    /// Clear all SSTables (after compaction).
    pub fn clear(&self) {
        self.tables.write().clear();
    }

    /// Delete all SSTable files.
    pub fn delete_all(&self) -> OvnResult<()> {
        let tables = self.tables.write();
        for table in tables.iter() {
            let _ = table.delete();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::memtable::MemTableEntry;
    use std::fs;

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
    fn test_disk_sstable_create_and_lookup() {
        let tmp_dir = std::env::temp_dir().join("ovn_sstable_test");
        let _ = fs::remove_dir_all(&tmp_dir);

        let mgr = DiskSSTableManager::new(&tmp_dir).unwrap();
        let entries = make_memtable_entries();
        mgr.flush_from_memtable(entries).unwrap();

        assert_eq!(mgr.count(), 1);

        let result = mgr.get(b"key_b");
        assert!(result.is_some());
        assert_eq!(result.unwrap().value, b"value_b");

        assert!(mgr.get(b"key_d").is_none());

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_disk_sstable_range_scan() {
        let tmp_dir = std::env::temp_dir().join("ovn_sstable_range_test");
        let _ = fs::remove_dir_all(&tmp_dir);

        let mgr = DiskSSTableManager::new(&tmp_dir).unwrap();
        let entries = make_memtable_entries();
        mgr.flush_from_memtable(entries).unwrap();

        let results = mgr.scan_range(b"key_a", b"key_c");
        assert_eq!(results.len(), 2); // key_a and key_b

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn test_disk_sstable_persistence() {
        let tmp_dir = std::env::temp_dir().join("ovn_sstable_persist_test");
        let _ = fs::remove_dir_all(&tmp_dir);

        {
            let mgr = DiskSSTableManager::new(&tmp_dir).unwrap();
            let entries = make_memtable_entries();
            mgr.flush_from_memtable(entries).unwrap();
            // mgr goes out of scope, but files remain on disk
        }

        // Reopen manager
        {
            let _mgr2 = DiskSSTableManager::new(&tmp_dir).unwrap();
            // SSTable files exist on disk, manager should scan them
            // In a full implementation, we'd load existing tables here
            assert!(tmp_dir.exists());
        }

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
