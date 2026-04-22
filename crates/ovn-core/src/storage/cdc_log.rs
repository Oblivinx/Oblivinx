//! CDC (Change Data Capture) Log — Durable Debezium-compatible change stream. [v2]
//!
//! The CDC log records every INSERT/UPDATE/DELETE as a structured event
//! that can be replayed by downstream consumers (Kafka, webhooks, etc.).
//!
//! Events are appended to Segment 0x0B in the .ovn2 file and also buffered
//! in memory for in-process subscribers.

use parking_lot::RwLock;
use std::collections::VecDeque;

// ── CDC Operation ─────────────────────────────────────────────────────────────

/// The type of change that occurred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CdcOperation {
    Insert = 1,
    Update = 2,
    Delete = 3,
    /// Snapshot event (initial full-load marker).
    Snapshot = 4,
}

// ── CDC Record ────────────────────────────────────────────────────────────────

/// A single CDC record (Debezium-envelope compatible).
#[derive(Debug, Clone)]
pub struct CdcRecord {
    /// Monotonically increasing CDC sequence number.
    pub seq: u64,
    /// HLC TxID that produced this change.
    pub txid: u64,
    /// Collection ID.
    pub collection_id: u32,
    /// Collection name (UTF-8).
    pub collection_name: String,
    /// Document ID (primary key bytes).
    pub doc_id: Vec<u8>,
    /// Operation type.
    pub operation: CdcOperation,
    /// Pre-image (before value) — None for INSERT.
    pub before: Option<Vec<u8>>,
    /// Post-image (after value) — None for DELETE.
    pub after: Option<Vec<u8>>,
    /// Wall-clock timestamp (Unix ms) when the change was committed.
    pub committed_at_ms: u64,
}

impl CdcRecord {
    /// Serialize to a compact binary format.
    pub fn encode(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(64);
        buf.extend_from_slice(&self.seq.to_le_bytes());
        buf.extend_from_slice(&self.txid.to_le_bytes());
        buf.extend_from_slice(&self.collection_id.to_le_bytes());
        buf.push(self.operation as u8);
        buf.extend_from_slice(&self.committed_at_ms.to_le_bytes());

        // collection_name (length-prefixed)
        let name_bytes = self.collection_name.as_bytes();
        buf.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        buf.extend_from_slice(name_bytes);

        // doc_id
        buf.extend_from_slice(&(self.doc_id.len() as u32).to_le_bytes());
        buf.extend_from_slice(&self.doc_id);

        // before image
        match &self.before {
            Some(b) => {
                buf.extend_from_slice(&(b.len() as u32).to_le_bytes());
                buf.extend_from_slice(b);
            }
            None => buf.extend_from_slice(&0u32.to_le_bytes()),
        }

        // after image
        match &self.after {
            Some(a) => {
                buf.extend_from_slice(&(a.len() as u32).to_le_bytes());
                buf.extend_from_slice(a);
            }
            None => buf.extend_from_slice(&0u32.to_le_bytes()),
        }

        buf
    }

    /// Deserialize from binary format.
    pub fn decode(buf: &[u8]) -> Option<(Self, usize)> {
        if buf.len() < 32 {
            return None;
        }
        let mut pos = 0;

        let seq = u64::from_le_bytes(buf[pos..pos + 8].try_into().ok()?);
        pos += 8;
        let txid = u64::from_le_bytes(buf[pos..pos + 8].try_into().ok()?);
        pos += 8;
        let collection_id = u32::from_le_bytes(buf[pos..pos + 4].try_into().ok()?);
        pos += 4;
        let operation = match buf[pos] {
            1 => CdcOperation::Insert,
            2 => CdcOperation::Update,
            3 => CdcOperation::Delete,
            4 => CdcOperation::Snapshot,
            _ => return None,
        };
        pos += 1;
        let committed_at_ms = u64::from_le_bytes(buf[pos..pos + 8].try_into().ok()?);
        pos += 8;

        let name_len = u16::from_le_bytes(buf[pos..pos + 2].try_into().ok()?) as usize;
        pos += 2;
        if buf.len() < pos + name_len { return None; }
        let collection_name = String::from_utf8(buf[pos..pos + name_len].to_vec()).ok()?;
        pos += name_len;

        let doc_id_len = u32::from_le_bytes(buf[pos..pos + 4].try_into().ok()?) as usize;
        pos += 4;
        if buf.len() < pos + doc_id_len { return None; }
        let doc_id = buf[pos..pos + doc_id_len].to_vec();
        pos += doc_id_len;

        let read_optional = |buf: &[u8], pos: &mut usize| -> Option<Option<Vec<u8>>> {
            if buf.len() < *pos + 4 { return None; }
            let len = u32::from_le_bytes(buf[*pos..*pos + 4].try_into().ok()?) as usize;
            *pos += 4;
            if len == 0 { return Some(None); }
            if buf.len() < *pos + len { return None; }
            let v = buf[*pos..*pos + len].to_vec();
            *pos += len;
            Some(Some(v))
        };

        let before = read_optional(buf, &mut pos)?;
        let after = read_optional(buf, &mut pos)?;

        Some((
            CdcRecord {
                seq,
                txid,
                collection_id,
                collection_name,
                doc_id,
                operation,
                before,
                after,
                committed_at_ms,
            },
            pos,
        ))
    }
}

// ── CDC Log ───────────────────────────────────────────────────────────────────

/// In-memory CDC log buffer (ring buffer of recent events).
pub struct CdcLog {
    /// Ring buffer of recent events (max `capacity` entries).
    buffer: RwLock<VecDeque<CdcRecord>>,
    /// Max entries before oldest is dropped.
    capacity: usize,
    /// Monotonic sequence counter.
    next_seq: parking_lot::Mutex<u64>,
    /// Which collections have CDC enabled.
    enabled_collections: RwLock<std::collections::HashSet<u32>>,
}

impl CdcLog {
    /// Create a CDC log with given in-memory ring buffer capacity.
    pub fn new(capacity: usize) -> Self {
        Self {
            buffer: RwLock::new(VecDeque::with_capacity(capacity)),
            capacity,
            next_seq: parking_lot::Mutex::new(1),
            enabled_collections: RwLock::new(std::collections::HashSet::new()),
        }
    }

    /// Enable CDC for a collection.
    pub fn enable(&self, collection_id: u32) {
        self.enabled_collections.write().insert(collection_id);
    }

    /// Disable CDC for a collection.
    pub fn disable(&self, collection_id: u32) {
        self.enabled_collections.write().remove(&collection_id);
    }

    /// Whether CDC is enabled for this collection.
    pub fn is_enabled(&self, collection_id: u32) -> bool {
        self.enabled_collections.read().contains(&collection_id)
    }

    /// Append a CDC record. If `collection_id` is not CDC-enabled, does nothing.
    pub fn append(
        &self,
        txid: u64,
        collection_id: u32,
        collection_name: &str,
        doc_id: Vec<u8>,
        operation: CdcOperation,
        before: Option<Vec<u8>>,
        after: Option<Vec<u8>>,
    ) -> Option<u64> {
        if !self.is_enabled(collection_id) {
            return None;
        }
        let seq = {
            let mut s = self.next_seq.lock();
            let v = *s;
            *s += 1;
            v
        };
        let committed_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let record = CdcRecord {
            seq,
            txid,
            collection_id,
            collection_name: collection_name.to_string(),
            doc_id,
            operation,
            before,
            after,
            committed_at_ms,
        };

        let mut buf = self.buffer.write();
        if buf.len() >= self.capacity {
            buf.pop_front(); // drop oldest
        }
        buf.push_back(record);
        Some(seq)
    }

    /// Read all records since the given sequence number (inclusive).
    pub fn read_since(&self, since_seq: u64) -> Vec<CdcRecord> {
        self.buffer
            .read()
            .iter()
            .filter(|r| r.seq >= since_seq)
            .cloned()
            .collect()
    }

    /// Get the latest sequence number (0 if empty).
    pub fn latest_seq(&self) -> u64 {
        self.buffer.read().back().map(|r| r.seq).unwrap_or(0)
    }

    /// Current number of buffered records.
    pub fn len(&self) -> usize {
        self.buffer.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Default for CdcLog {
    fn default() -> Self {
        Self::new(10_000)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cdc_record_roundtrip() {
        let record = CdcRecord {
            seq: 1,
            txid: 100,
            collection_id: 42,
            collection_name: "users".to_string(),
            doc_id: b"user_1".to_vec(),
            operation: CdcOperation::Insert,
            before: None,
            after: Some(b"{ name: 'Alice' }".to_vec()),
            committed_at_ms: 1_700_000_000_000,
        };

        let encoded = record.encode();
        let (decoded, consumed) = CdcRecord::decode(&encoded).unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(decoded.seq, 1);
        assert_eq!(decoded.collection_name, "users");
        assert_eq!(decoded.operation, CdcOperation::Insert);
        assert!(decoded.before.is_none());
        assert!(decoded.after.is_some());
    }

    #[test]
    fn test_cdc_log_enable_disable() {
        let log = CdcLog::new(100);
        log.enable(1);
        assert!(log.is_enabled(1));
        assert!(!log.is_enabled(2));

        let seq = log.append(1, 1, "users", b"doc1".to_vec(), CdcOperation::Insert, None, Some(b"data".to_vec()));
        assert!(seq.is_some());

        // Not enabled — should return None
        let seq2 = log.append(1, 2, "orders", b"doc1".to_vec(), CdcOperation::Insert, None, None);
        assert!(seq2.is_none());

        log.disable(1);
        assert!(!log.is_enabled(1));
    }

    #[test]
    fn test_cdc_log_read_since() {
        let log = CdcLog::new(100);
        log.enable(1);
        for i in 0..5 {
            log.append(i, 1, "items", b"doc".to_vec(), CdcOperation::Update, None, Some(b"v".to_vec()));
        }
        let recent = log.read_since(3);
        assert_eq!(recent.len(), 3); // seq 3, 4, 5
    }
}
