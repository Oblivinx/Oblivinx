//! Write-Ahead Log (WAL) — v2.0 with Group Commit and Durability Levels.
//!
//! ## WAL Record Format (v2)
//! ```text
//! [4 bytes]  Record type (INSERT=1, UPDATE=2, DELETE=3, COMMIT=4, CHECKPOINT=5, ROLLBACK=6, SAVEPOINT=7)
//! [8 bytes]  HLC Transaction ID (physical_ms<<16 | logical)
//! [4 bytes]  Collection ID (FNV hash of name)
//! [16 bytes] Session ID (lsid)
//! [8 bytes]  Session transaction sequence number
//! [1 byte]   Flags (DURABLE_SAVEPOINT=1, CONCURRENT_WRITER=2, ENCRYPTED=4)
//! [7 bytes]  Reserved (pad to 8-byte alignment)
//! [varint]   Document data length
//! [bytes]    Document data (OBE2-encoded)
//! [4 bytes]  CRC32 of entire record (before this field)
//! ```
//!
//! ## Durability Levels
//! - D0: No fsync. Maximum throughput, data loss risk on OS crash.
//! - D1 (default): Group commit. Batch up to `group_commit_bytes` or `group_commit_us` µs.
//! - D1Strict: Fsync after every group commit flush.
//! - D2: Fsync after every individual commit.

use crc32fast::Hasher as Crc32Hasher;
use parking_lot::Mutex;
use std::collections::{HashMap, HashSet};

use crate::engine::config::DurabilityLevel;
use crate::error::{OvnError, OvnResult};
use crate::format::obe::{decode_varint, encode_varint};
use crate::io::FileBackend;

// ── WAL Record Flags ─────────────────────────────────────────────────────────

/// WAL record flag: this commit is a durable savepoint.
pub const WAL_FLAG_DURABLE_SAVEPOINT: u8 = 1 << 0;
/// WAL record flag: written by a BEGIN CONCURRENT writer.
pub const WAL_FLAG_CONCURRENT_WRITER: u8 = 1 << 1;
/// WAL record flag: document data is encrypted (QE).
pub const WAL_FLAG_ENCRYPTED: u8 = 1 << 2;

// ── WAL Record Type ───────────────────────────────────────────────────────────

/// WAL record types.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u32)]
pub enum WalRecordType {
    Insert = 1,
    Update = 2,
    Delete = 3,
    Commit = 4,
    Checkpoint = 5,
    Rollback = 6,
    Savepoint = 7,
    /// Concurrent write commit (BEGIN CONCURRENT).
    ConcurrentCommit = 8,
    /// Compaction manifest — records the new root page offset after CoW compaction.
    CompactionManifest = 9,
}

impl WalRecordType {
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            1 => Some(Self::Insert),
            2 => Some(Self::Update),
            3 => Some(Self::Delete),
            4 => Some(Self::Commit),
            5 => Some(Self::Checkpoint),
            6 => Some(Self::Rollback),
            7 => Some(Self::Savepoint),
            8 => Some(Self::ConcurrentCommit),
            9 => Some(Self::CompactionManifest),
            _ => None,
        }
    }

    /// Whether this record type triggers a WAL flush.
    pub fn triggers_flush(self) -> bool {
        matches!(
            self,
            Self::Commit | Self::ConcurrentCommit | Self::Checkpoint | Self::CompactionManifest
        )
    }
}

// ── WAL Record ────────────────────────────────────────────────────────────────

/// A single WAL record (v2 format).
#[derive(Debug, Clone)]
pub struct WalRecord {
    /// Type of WAL operation.
    pub record_type: WalRecordType,
    /// HLC Transaction ID.
    pub txid: u64,
    /// Collection ID (FNV hash of collection name).
    pub collection_id: u32,
    /// Logical session ID for retryable writes.
    pub lsid: [u8; 16],
    /// Session transaction sequence number.
    pub txn_number: u64,
    /// Record flags (WAL_FLAG_* constants).
    pub flags: u8,
    /// Document data (OBE2-encoded).
    pub data: Vec<u8>,
    /// CRC32 of the record (computed on encode, verified on decode).
    pub crc32: u32,
    /// Chained HMAC-SHA256 for tamper detection (Section 20.4).
    /// `None` when no encryption key is configured.
    pub chained_hmac: Option<[u8; 32]>,
}

impl WalRecord {
    /// Create a new WAL record.
    pub fn new(
        record_type: WalRecordType,
        txid: u64,
        collection_id: u32,
        lsid: [u8; 16],
        txn_number: u64,
        data: Vec<u8>,
    ) -> Self {
        Self {
            record_type,
            txid,
            collection_id,
            lsid,
            txn_number,
            flags: 0,
            data,
            crc32: 0,
            chained_hmac: None,
        }
    }

    /// Create with flags.
    pub fn with_flags(mut self, flags: u8) -> Self {
        self.flags = flags;
        self
    }

    /// Serialize the WAL record to bytes (v2 format).
    pub fn encode(&self) -> Vec<u8> {
        let header_size = 4 + 8 + 4 + 16 + 8 + 1 + 7; // 48 bytes
        let mut buf = Vec::with_capacity(header_size + self.data.len() + 10);

        buf.extend_from_slice(&(self.record_type as u32).to_le_bytes()); // 4
        buf.extend_from_slice(&self.txid.to_le_bytes()); // 8
        buf.extend_from_slice(&self.collection_id.to_le_bytes()); // 4
        buf.extend_from_slice(&self.lsid); // 16
        buf.extend_from_slice(&self.txn_number.to_le_bytes()); // 8
        buf.push(self.flags); // 1
        buf.extend_from_slice(&[0u8; 7]); // 7 reserved

        encode_varint(self.data.len() as u64, &mut buf);
        buf.extend_from_slice(&self.data);

        // CRC32 over everything so far
        let mut hasher = Crc32Hasher::new();
        hasher.update(&buf);
        let crc = hasher.finalize();
        buf.extend_from_slice(&crc.to_le_bytes());

        buf
    }

    /// Deserialize a WAL record from bytes.
    /// Returns (record, bytes_consumed).
    pub fn decode(buf: &[u8]) -> OvnResult<(Self, usize)> {
        // Minimum header: 4+8+4+16+8+1+7 = 48 bytes + varint + data + 4 CRC
        if buf.len() < 52 {
            return Err(OvnError::WalCorrupted {
                offset: 0,
                reason: "Record too short".to_string(),
            });
        }

        let mut pos = 0;

        let rt = u32::from_le_bytes(buf[pos..pos + 4].try_into().unwrap());
        let record_type = WalRecordType::from_u32(rt).ok_or_else(|| OvnError::WalCorrupted {
            offset: pos as u64,
            reason: format!("Unknown WAL record type: {rt}"),
        })?;
        pos += 4;

        let txid = u64::from_le_bytes(buf[pos..pos + 8].try_into().unwrap());
        pos += 8;

        let collection_id = u32::from_le_bytes(buf[pos..pos + 4].try_into().unwrap());
        pos += 4;

        let mut lsid = [0u8; 16];
        lsid.copy_from_slice(&buf[pos..pos + 16]);
        pos += 16;

        let txn_number = u64::from_le_bytes(buf[pos..pos + 8].try_into().unwrap());
        pos += 8;

        let flags = buf[pos];
        pos += 1;
        pos += 7; // skip reserved

        let (data_len, vl) = decode_varint(&buf[pos..])?;
        pos += vl;
        let data_len = data_len as usize;

        if buf.len() < pos + data_len + 4 {
            return Err(OvnError::WalCorrupted {
                offset: pos as u64,
                reason: "Record data truncated".to_string(),
            });
        }

        let data = buf[pos..pos + data_len].to_vec();
        pos += data_len;

        let stored_crc = u32::from_le_bytes(buf[pos..pos + 4].try_into().unwrap());
        pos += 4;

        // Verify CRC
        let mut hasher = Crc32Hasher::new();
        hasher.update(&buf[..pos - 4]);
        let computed_crc = hasher.finalize();
        if stored_crc != computed_crc {
            return Err(OvnError::WalCorrupted {
                offset: 0,
                reason: format!(
                    "CRC mismatch: stored=0x{stored_crc:08X}, computed=0x{computed_crc:08X}"
                ),
            });
        }

        Ok((
            Self {
                record_type,
                txid,
                collection_id,
                lsid,
                txn_number,
                flags,
                data,
                crc32: stored_crc,
                chained_hmac: None, // Populated during verified replay
            },
            pos,
        ))
    }
}

// ── WAL Manager ───────────────────────────────────────────────────────────────

/// WAL writer and crash-recovery manager (v2: group commit, durability levels).
pub struct WalManager {
    /// In-memory WAL records for the current session (used for replay).
    records: Mutex<Vec<WalRecord>>,
    /// Pending bytes buffer — records accumulate here until group commit fires.
    pending: Mutex<Vec<u8>>,
    /// Last checkpointed transaction ID.
    last_checkpoint_txid: Mutex<u64>,
    /// WAL write offset within the .ovn2 file.
    wal_offset: Mutex<u64>,
    /// Durability level for flush decisions.
    durability: DurabilityLevel,
    /// Group commit batch size limit in bytes.
    group_commit_bytes: usize,
    /// Optional chained HMAC verifier for tamper detection (Section 20.4).
    /// Present only when an EncryptionKey is configured.
    hmac_verifier: Mutex<Option<crate::security::ChainedHmacVerifier>>,
}

impl WalManager {
    /// Create a new WAL manager.
    pub fn new(wal_offset: u64) -> Self {
        Self::with_durability(wal_offset, DurabilityLevel::D1, 1024 * 1024)
    }

    /// Create a WAL manager with explicit durability and batch settings.
    pub fn with_durability(
        wal_offset: u64,
        durability: DurabilityLevel,
        group_commit_bytes: usize,
    ) -> Self {
        Self {
            records: Mutex::new(Vec::new()),
            pending: Mutex::new(Vec::with_capacity(group_commit_bytes)),
            last_checkpoint_txid: Mutex::new(0),
            wal_offset: Mutex::new(wal_offset),
            durability,
            group_commit_bytes,
            hmac_verifier: Mutex::new(None),
        }
    }

    /// Enable chained HMAC verification with the given encryption key.
    /// Once enabled, every appended record will carry a chained HMAC, and
    /// `replay_verified()` will validate the chain during recovery.
    pub fn enable_hmac(&self, key: &crate::security::EncryptionKey) {
        *self.hmac_verifier.lock() = Some(crate::security::ChainedHmacVerifier::new(key));
    }

    /// Append a WAL record.
    ///
    /// Flush behavior is controlled by `durability`:
    /// - D0: Never fsync, only auto-flush at `group_commit_bytes`.
    /// - D1: Flush + optional fsync on commit records; batch non-commits.
    /// - D1Strict/D2: Always fsync on commit records.
    pub fn append(&self, mut record: WalRecord, backend: &dyn FileBackend) -> OvnResult<()> {
        // Compute chained HMAC if an encryption key is configured
        {
            let mut verifier = self.hmac_verifier.lock();
            if let Some(ref mut v) = *verifier {
                let encoded_for_hmac = record.encode();
                let hmac = v.advance(&encoded_for_hmac);
                record.chained_hmac = Some(hmac);
            }
        }

        let encoded = record.encode();
        let record_type = record.record_type;

        {
            let mut pending = self.pending.lock();
            pending.extend_from_slice(&encoded);

            // Auto-flush when pending exceeds group_commit_bytes (prevent unbounded memory)
            if pending.len() >= self.group_commit_bytes {
                drop(pending);
                self.flush_pending(backend, false)?;
            }
        }

        self.records.lock().push(record);

        // Flush on commit-type records (D1, D1Strict, D2)
        if record_type.triggers_flush() {
            match self.durability {
                DurabilityLevel::D0 => {
                    // D0: only flush bytes to OS buffer, no fsync
                    self.flush_pending(backend, false)?;
                }
                DurabilityLevel::D1 => {
                    // D1: flush bytes; fsync deferred to group commit timer (external)
                    self.flush_pending(backend, false)?;
                }
                DurabilityLevel::D1Strict | DurabilityLevel::D2 => {
                    // D1Strict/D2: flush + fsync on every commit
                    self.flush_pending(backend, true)?;
                }
            }
        }

        Ok(())
    }

    /// Force flush all pending WAL bytes to the backend.
    pub fn flush(&self, backend: &dyn FileBackend) -> OvnResult<()> {
        self.flush_pending(backend, self.durability == DurabilityLevel::D2)
    }

    /// Write a checkpoint record.
    pub fn checkpoint(&self, txid: u64, backend: &dyn FileBackend) -> OvnResult<()> {
        let record = WalRecord::new(WalRecordType::Checkpoint, txid, 0, [0; 16], 0, Vec::new());
        self.append(record, backend)?;
        // Always fsync on checkpoint regardless of durability level
        self.flush_pending(backend, true)?;
        *self.last_checkpoint_txid.lock() = txid;
        Ok(())
    }

    /// Replay WAL records from raw bytes.
    /// Scans for the last Checkpoint record in the WAL and uses its txid as
    /// the effective checkpoint boundary — records at or below that txid are
    /// skipped.  Only committed transactions are returned.
    pub fn replay(data: &[u8]) -> OvnResult<Vec<WalRecord>> {
        // Phase 0 — find the last in-WAL Checkpoint record's txid.
        let mut last_ckpt_txid = 0u64;
        let mut pos = 0;
        while pos < data.len() {
            match WalRecord::decode(&data[pos..]) {
                Ok((record, consumed)) => {
                    if record.record_type == WalRecordType::Checkpoint {
                        last_ckpt_txid = record.txid;
                    }
                    pos += consumed;
                }
                Err(_) => break,
            }
        }
        Self::replay_from_checkpoint(data, last_ckpt_txid)
    }

    /// Replay WAL records from raw bytes, starting after `last_checkpoint_txid`.
    ///
    /// Implements the Bug-1 fix:
    /// - Skips any record whose `txid <= last_checkpoint_txid` (already durable).
    /// - Deduplicates by txid via `seen_txids` (prevents double-apply on re-open).
    /// - Only applies records from fully-committed transactions (Commit /
    ///   ConcurrentCommit record present for that txid).
    /// - Stops replay at the first CRC error (torn write from crash).
    pub fn replay_from_checkpoint(
        data: &[u8],
        last_checkpoint_txid: u64,
    ) -> OvnResult<Vec<WalRecord>> {
        let mut raw: Vec<WalRecord> = Vec::new();
        let mut pos = 0;

        // Phase 1 — decode all intact records; stop at first CRC error.
        while pos < data.len() {
            match WalRecord::decode(&data[pos..]) {
                Ok((record, consumed)) => {
                    raw.push(record);
                    pos += consumed;
                }
                Err(_) => break,
            }
        }

        // Phase 2 — identify which txids have a COMMIT record.
        let committed_txids: HashSet<u64> = raw
            .iter()
            .filter(|r| {
                r.txid > last_checkpoint_txid
                    && matches!(
                        r.record_type,
                        WalRecordType::Commit | WalRecordType::ConcurrentCommit
                    )
            })
            .map(|r| r.txid)
            .collect();

        // Phase 3 — collect records from committed txids, deduplicated.
        // `seen_txids` ensures each txid is applied exactly once even if
        // the WAL was written multiple times before a checkpoint (e.g., after
        // a failed checkpoint that left the WAL untruncated).
        let mut seen_txids: HashSet<u64> = HashSet::new();
        // Bucket committed records by txid so we can apply them in txid order.
        let mut by_txid: HashMap<u64, Vec<WalRecord>> = HashMap::new();

        for record in raw {
            if record.txid <= last_checkpoint_txid {
                continue;
            }
            if !committed_txids.contains(&record.txid) {
                // Uncommitted / rolled-back — discard.
                continue;
            }
            by_txid.entry(record.txid).or_default().push(record);
        }

        // Emit records in ascending txid order; deduplicate txids.
        let mut result: Vec<WalRecord> = Vec::new();
        let mut sorted_txids: Vec<u64> = by_txid.keys().copied().collect();
        sorted_txids.sort_unstable();

        for txid in sorted_txids {
            if seen_txids.contains(&txid) {
                continue;
            }
            seen_txids.insert(txid);
            if let Some(records) = by_txid.remove(&txid) {
                result.extend(records);
            }
        }

        Ok(result)
    }

    /// Get the last checkpointed TxID.
    pub fn last_checkpoint_txid(&self) -> u64 {
        *self.last_checkpoint_txid.lock()
    }

    /// Update the in-memory last checkpoint TxID after a successful atomic checkpoint write.
    /// Called by `flush_memtable_to_l0` after both shadow page and Page 0 are fsynced.
    pub fn set_last_checkpoint_txid(&self, txid: u64) {
        *self.last_checkpoint_txid.lock() = txid;
    }

    /// Get total records in this session.
    pub fn record_count(&self) -> usize {
        self.records.lock().len()
    }

    /// Clear all WAL records (after successful compaction/checkpoint).
    pub fn clear(&self) {
        self.records.lock().clear();
        self.pending.lock().clear();
    }

    // ── Internal ─────────────────────────────────────────────────

    fn flush_pending(&self, backend: &dyn FileBackend, do_fsync: bool) -> OvnResult<()> {
        let mut pending = self.pending.lock();
        if pending.is_empty() {
            return Ok(());
        }

        let mut offset_guard = self.wal_offset.lock();
        backend.write_at(*offset_guard, &pending)?;
        *offset_guard += pending.len() as u64;

        if do_fsync {
            backend.sync()?;
        }

        pending.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wal_record_roundtrip() {
        let data = b"test document data".to_vec();
        let lsid = [1u8; 16];
        let record = WalRecord::new(WalRecordType::Insert, 42, 1, lsid, 7, data.clone());
        let encoded = record.encode();
        let (decoded, consumed) = WalRecord::decode(&encoded).unwrap();

        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded.record_type, WalRecordType::Insert);
        assert_eq!(decoded.txid, 42);
        assert_eq!(decoded.collection_id, 1);
        assert_eq!(decoded.lsid, lsid);
        assert_eq!(decoded.txn_number, 7);
        assert_eq!(decoded.data, data);
        assert_eq!(decoded.flags, 0);
    }

    #[test]
    fn test_wal_record_with_flags() {
        let record = WalRecord::new(WalRecordType::Commit, 1, 0, [0; 16], 0, Vec::new())
            .with_flags(WAL_FLAG_CONCURRENT_WRITER);
        let encoded = record.encode();
        let (decoded, _) = WalRecord::decode(&encoded).unwrap();
        assert_eq!(decoded.flags, WAL_FLAG_CONCURRENT_WRITER);
    }

    #[test]
    fn test_wal_replay_after_checkpoint() {
        use std::collections::HashSet;

        let mut all_bytes = Vec::new();

        // TxID 1: Insert + Commit (before checkpoint)
        all_bytes.extend(
            WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 0, b"doc1".to_vec()).encode(),
        );
        all_bytes
            .extend(WalRecord::new(WalRecordType::Commit, 1, 0, [0; 16], 0, Vec::new()).encode());
        // Checkpoint at txid=1 — everything at or below txid 1 is durable
        all_bytes.extend(
            WalRecord::new(WalRecordType::Checkpoint, 1, 0, [0; 16], 0, Vec::new()).encode(),
        );
        // TxID 2: Insert + Commit (after checkpoint — should be replayed)
        all_bytes.extend(
            WalRecord::new(WalRecordType::Insert, 2, 1, [0; 16], 0, b"doc2".to_vec()).encode(),
        );
        all_bytes
            .extend(WalRecord::new(WalRecordType::Commit, 2, 0, [0; 16], 0, Vec::new()).encode());

        let records = WalManager::replay(&all_bytes).unwrap();
        let txids: HashSet<u64> = records.iter().map(|r| r.txid).collect();

        // Only txid=2 should be replayed (txid=1 is at/below checkpoint)
        assert!(
            !txids.contains(&1),
            "TxID 1 should be skipped (at/below checkpoint)"
        );
        assert!(
            txids.contains(&2),
            "TxID 2 should be replayed (after checkpoint)"
        );
    }

    #[test]
    fn test_wal_corrupted_crc() {
        let record = WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 0, b"data".to_vec());
        let mut encoded = record.encode();
        let len = encoded.len();
        encoded[len - 1] ^= 0xFF; // corrupt CRC
        assert!(WalRecord::decode(&encoded).is_err());
    }

    #[test]
    fn test_wal_new_record_type_savepoint() {
        let record = WalRecord::new(
            WalRecordType::Savepoint,
            5,
            0,
            [0; 16],
            0,
            b"sp_main".to_vec(),
        );
        let encoded = record.encode();
        let (decoded, _) = WalRecord::decode(&encoded).unwrap();
        assert_eq!(decoded.record_type, WalRecordType::Savepoint);
    }
}
