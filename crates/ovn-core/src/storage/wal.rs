//! Write-Ahead Log (WAL) — durability and crash recovery.
//!
//! The WAL guarantees that no committed write is lost after a crash.
//! All writes are appended to the WAL and fsync'd before acknowledgment.
//!
//! ## WAL Record Format
//! ```text
//! [4 bytes]  Record type (INSERT=1, UPDATE=2, DELETE=3, COMMIT=4, CHECKPOINT=5)
//! [8 bytes]  Transaction ID
//! [4 bytes]  Collection ID
//! [varint]   Document length
//! [bytes]    Document data (OBE-encoded)
//! [4 bytes]  CRC32 of record
//! ```

use crc32fast::Hasher as Crc32Hasher;
use parking_lot::Mutex;

use crate::error::{OvnError, OvnResult};
use crate::format::obe::{decode_varint, encode_varint};
use crate::io::FileBackend;

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
            _ => None,
        }
    }
}

/// A single WAL record.
#[derive(Debug, Clone)]
pub struct WalRecord {
    /// Type of WAL operation
    pub record_type: WalRecordType,
    /// Transaction ID
    pub txid: u64,
    /// Collection ID (hash of collection name)
    pub collection_id: u32,
    /// Logical session ID for retryable writes
    pub lsid: [u8; 16],
    /// Session transaction sequence number
    pub txn_number: u64,
    /// Document data (OBE-encoded)
    pub data: Vec<u8>,
    /// CRC32 of the record
    pub crc32: u32,
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
            data,
            crc32: 0,
        }
    }

    /// Serialize the WAL record to bytes.
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(44 + self.data.len());

        buf.extend_from_slice(&(self.record_type as u32).to_le_bytes());
        buf.extend_from_slice(&self.txid.to_le_bytes());
        buf.extend_from_slice(&self.collection_id.to_le_bytes());
        buf.extend_from_slice(&self.lsid);
        buf.extend_from_slice(&self.txn_number.to_le_bytes());
        encode_varint(self.data.len() as u64, &mut buf);
        buf.extend_from_slice(&self.data);

        // Compute CRC32 over everything so far
        let mut hasher = Crc32Hasher::new();
        hasher.update(&buf);
        let crc = hasher.finalize();
        buf.extend_from_slice(&crc.to_le_bytes());

        buf
    }

    /// Deserialize a WAL record from bytes, returning (record, bytes_consumed).
    pub fn decode(buf: &[u8]) -> OvnResult<(Self, usize)> {
        if buf.len() < 40 {
            return Err(OvnError::WalCorrupted {
                offset: 0,
                reason: "Record too short".to_string(),
            });
        }

        let mut pos = 0;

        // Record type
        let rt = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
        let record_type = WalRecordType::from_u32(rt).ok_or_else(|| OvnError::WalCorrupted {
            offset: pos as u64,
            reason: format!("Unknown record type: {rt}"),
        })?;
        pos += 4;

        // TxID
        let txid = u64::from_le_bytes([
            buf[pos],
            buf[pos + 1],
            buf[pos + 2],
            buf[pos + 3],
            buf[pos + 4],
            buf[pos + 5],
            buf[pos + 6],
            buf[pos + 7],
        ]);
        pos += 8;

        // Collection ID
        let collection_id =
            u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
        pos += 4;

        // lsid
        if buf.len() < pos + 24 {
            return Err(OvnError::WalCorrupted {
                offset: pos as u64,
                reason: "Record too short for lsid/txnNumber".to_string(),
            });
        }
        let mut lsid = [0u8; 16];
        lsid.copy_from_slice(&buf[pos..pos + 16]);
        pos += 16;

        // txnNumber
        let txn_number = u64::from_le_bytes([
            buf[pos],
            buf[pos + 1],
            buf[pos + 2],
            buf[pos + 3],
            buf[pos + 4],
            buf[pos + 5],
            buf[pos + 6],
            buf[pos + 7],
        ]);
        pos += 8;

        // Data length
        let (data_len, vl) = decode_varint(&buf[pos..])?;
        pos += vl;
        let data_len = data_len as usize;

        // Data
        if buf.len() < pos + data_len + 4 {
            return Err(OvnError::WalCorrupted {
                offset: pos as u64,
                reason: "Record data truncated".to_string(),
            });
        }
        let data = buf[pos..pos + data_len].to_vec();
        pos += data_len;

        // CRC32
        let stored_crc = u32::from_le_bytes([buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]]);
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
                data,
                crc32: stored_crc,
            },
            pos,
        ))
    }
}

/// WAL writer and recovery manager.
pub struct WalManager {
    /// All WAL records in memory (for the current session)
    records: Mutex<Vec<WalRecord>>,
    /// The raw WAL bytes buffer
    buffer: Mutex<Vec<u8>>,
    /// Last checkpointed transaction ID
    last_checkpoint_txid: Mutex<u64>,
    /// WAL file offset in the .ovn file
    wal_offset: u64,
    /// Whether group commit is enabled
    group_commit: bool,
}

impl WalManager {
    /// Create a new WAL manager.
    pub fn new(wal_offset: u64) -> Self {
        Self {
            records: Mutex::new(Vec::new()),
            buffer: Mutex::new(Vec::new()),
            last_checkpoint_txid: Mutex::new(0),
            wal_offset,
            group_commit: true,
        }
    }

    /// Append a WAL record and flush to backend.
    pub fn append(&self, record: WalRecord, backend: &dyn FileBackend) -> OvnResult<()> {
        let encoded = record.encode();

        {
            let mut buffer = self.buffer.lock();
            buffer.extend_from_slice(&encoded);
        }

        // Persist to backend
        if !self.group_commit || record.record_type == WalRecordType::Commit {
            self.flush(backend)?;
        }

        self.records.lock().push(record);

        Ok(())
    }

    /// Flush pending WAL writes to disk.
    pub fn flush(&self, backend: &dyn FileBackend) -> OvnResult<()> {
        let mut buffer = self.buffer.lock();
        if buffer.is_empty() {
            return Ok(());
        }

        // Write WAL data
        backend.write_at(self.wal_offset + self.current_size_locked(&buffer), &buffer)?;
        backend.sync()?;

        buffer.clear();
        Ok(())
    }

    /// Write a checkpoint record and update the last checkpoint TxID.
    pub fn checkpoint(&self, txid: u64, backend: &dyn FileBackend) -> OvnResult<()> {
        let record = WalRecord::new(WalRecordType::Checkpoint, txid, 0, [0; 16], 0, Vec::new());
        self.append(record, backend)?;
        *self.last_checkpoint_txid.lock() = txid;
        Ok(())
    }

    /// Replay WAL records from the given raw bytes, returning records since the last checkpoint.
    pub fn replay(data: &[u8]) -> OvnResult<Vec<WalRecord>> {
        let mut records = Vec::new();
        let mut pos = 0;

        while pos < data.len() {
            // Try to decode next record
            match WalRecord::decode(&data[pos..]) {
                Ok((record, consumed)) => {
                    records.push(record);
                    pos += consumed;
                }
                Err(_) => {
                    // End of valid WAL — truncated records from crash
                    break;
                }
            }
        }

        // Find last checkpoint and return only records after it
        let checkpoint_pos = records
            .iter()
            .rposition(|r| r.record_type == WalRecordType::Checkpoint);

        if let Some(cp_pos) = checkpoint_pos {
            Ok(records[cp_pos + 1..].to_vec())
        } else {
            Ok(records)
        }
    }

    /// Get the last checkpoint TxID.
    pub fn last_checkpoint_txid(&self) -> u64 {
        *self.last_checkpoint_txid.lock()
    }

    /// Get total number of records in this session.
    pub fn record_count(&self) -> usize {
        self.records.lock().len()
    }

    /// Clear all WAL records (after successful compaction).
    pub fn clear(&self) {
        self.records.lock().clear();
        self.buffer.lock().clear();
    }

    fn current_size_locked(&self, _buffer: &Vec<u8>) -> u64 {
        // In a real implementation this would track the written offset.
        // For now, we compute from recorded records.
        let records = self.records.lock();
        records.iter().map(|r| r.encode().len() as u64).sum()
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
    }

    #[test]
    fn test_wal_replay_multiple() {
        let mut all_bytes = Vec::new();

        let r1 = WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 0, b"doc1".to_vec());
        all_bytes.extend_from_slice(&r1.encode());

        let r2 = WalRecord::new(WalRecordType::Commit, 1, 0, [0; 16], 0, Vec::new());
        all_bytes.extend_from_slice(&r2.encode());

        let r3 = WalRecord::new(WalRecordType::Checkpoint, 1, 0, [0; 16], 0, Vec::new());
        all_bytes.extend_from_slice(&r3.encode());

        let r4 = WalRecord::new(WalRecordType::Insert, 2, 1, [0; 16], 0, b"doc2".to_vec());
        all_bytes.extend_from_slice(&r4.encode());

        let records = WalManager::replay(&all_bytes).unwrap();
        // Should only return records after the checkpoint
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].txid, 2);
    }

    #[test]
    fn test_wal_corrupted_record() {
        let record = WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 0, b"data".to_vec());
        let mut encoded = record.encode();
        // Corrupt CRC
        let len = encoded.len();
        encoded[len - 1] ^= 0xFF;
        let result = WalRecord::decode(&encoded);
        assert!(result.is_err());
    }
}
