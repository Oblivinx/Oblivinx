//! MVCC (Multi-Version Concurrency Control) transaction layer.
//!
//! Each document write creates a new version stamped with a TxID.
//! Readers see consistent snapshots. A GC thread purges old versions.

use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod change_stream;
pub mod session;

use crate::error::{OvnError, OvnResult};

/// Transaction ID generator using monotonic counter.
pub struct TxIdGenerator {
    counter: AtomicU64,
}

impl TxIdGenerator {
    pub fn new() -> Self {
        // Seed with current timestamp for uniqueness across restarts
        let seed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_micros() as u64;
        Self {
            counter: AtomicU64::new(seed),
        }
    }

    /// Generate the next transaction ID (monotonically increasing).
    pub fn next(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::SeqCst)
    }

    /// Get the current counter value without incrementing.
    pub fn current(&self) -> u64 {
        self.counter.load(Ordering::SeqCst)
    }
}

impl Default for TxIdGenerator {
    fn default() -> Self {
        Self::new()
    }
}

/// An MVCC snapshot representing a consistent point-in-time view.
#[derive(Debug, Clone)]
pub struct Snapshot {
    /// The TxID at which this snapshot was taken
    pub txid: u64,
    /// Active transaction IDs at snapshot time (invisible to this snapshot)
    pub active_txids: HashSet<u64>,
}

impl Snapshot {
    /// Check if a document version is visible to this snapshot.
    ///
    /// A version is visible if:
    /// 1. Its TxID ≤ snapshot TxID
    /// 2. Its TxID is NOT in the active (uncommitted) set
    /// 3. It is not a tombstone (unless checking for deletion)
    pub fn is_visible(&self, version_txid: u64) -> bool {
        version_txid <= self.txid && !self.active_txids.contains(&version_txid)
    }
}

/// Active transaction tracking.
#[derive(Debug, Clone)]
pub struct Transaction {
    /// Transaction ID
    pub txid: u64,
    /// Snapshot for this transaction
    pub snapshot: Snapshot,
    /// Set of document keys read during this transaction (for conflict detection)
    pub read_set: HashSet<Vec<u8>>,
    /// Set of document keys written during this transaction
    pub write_set: HashMap<Vec<u8>, Vec<u8>>,
    /// Whether this transaction has been committed
    pub committed: bool,
    /// Whether this transaction has been aborted
    pub aborted: bool,
}

impl Transaction {
    pub fn new(txid: u64, snapshot: Snapshot) -> Self {
        Self {
            txid,
            snapshot,
            read_set: HashSet::new(),
            write_set: HashMap::new(),
            committed: false,
            aborted: false,
        }
    }

    /// Record a key read.
    pub fn record_read(&mut self, key: Vec<u8>) {
        self.read_set.insert(key);
    }

    /// Record a key write.
    pub fn record_write(&mut self, key: Vec<u8>, value: Vec<u8>) {
        self.write_set.insert(key, value);
    }
}

/// Version chain entry for a single document.
#[derive(Debug, Clone)]
pub struct VersionEntry {
    /// Transaction ID that created this version
    pub txid: u64,
    /// OBE-encoded document bytes
    pub data: Vec<u8>,
    /// Whether this version is a deletion tombstone
    pub tombstone: bool,
}

/// MVCC Manager — coordinates snapshots, transactions, and garbage collection.
pub struct MvccManager {
    /// Transaction ID generator
    txid_gen: TxIdGenerator,
    /// Active (uncommitted) transactions
    active_transactions: RwLock<HashMap<u64, Transaction>>,
    /// Version chains: document_key → list of versions (newest first)
    version_chains: RwLock<HashMap<Vec<u8>, Vec<VersionEntry>>>,
    /// Horizon TxID — minimum TxID of all active snapshots
    horizon_txid: AtomicU64,
}

impl MvccManager {
    pub fn new() -> Self {
        Self {
            txid_gen: TxIdGenerator::new(),
            active_transactions: RwLock::new(HashMap::new()),
            version_chains: RwLock::new(HashMap::new()),
            horizon_txid: AtomicU64::new(0),
        }
    }

    /// Begin a new transaction with a consistent snapshot.
    pub fn begin_transaction(&self) -> Transaction {
        let txid = self.txid_gen.next();

        // Snapshot: collect all currently active TxIDs
        let active_txids: HashSet<u64> = self.active_transactions.read().keys().copied().collect();

        let snapshot = Snapshot { txid, active_txids };
        let txn = Transaction::new(txid, snapshot);

        self.active_transactions.write().insert(txid, txn.clone());
        self.update_horizon();

        txn
    }

    /// Commit a transaction after validating no write conflicts.
    pub fn commit(&self, txid: u64) -> OvnResult<()> {
        let mut active = self.active_transactions.write();

        let txn = active
            .get(&txid)
            .ok_or_else(|| OvnError::TransactionAborted {
                txid,
                reason: "Transaction not found".to_string(),
            })?;

        // Optimistic conflict detection: check if any key in the read set
        // was modified by another committed transaction since our snapshot
        let version_chains = self.version_chains.read();
        for read_key in &txn.read_set {
            if let Some(versions) = version_chains.get(read_key) {
                for version in versions {
                    if version.txid > txn.snapshot.txid
                        && !txn.snapshot.active_txids.contains(&version.txid)
                    {
                        let winner_txid = version.txid;
                        let doc_id = String::from_utf8_lossy(read_key).to_string();
                        drop(version_chains);
                        active.remove(&txid);
                        self.update_horizon();
                        return Err(OvnError::WriteConflict {
                            doc_id,
                            winner_txid,
                            loser_txid: txid,
                        });
                    }
                }
            }
        }

        active.remove(&txid);
        drop(active);
        self.update_horizon();

        Ok(())
    }

    /// Abort a transaction, discarding all its writes.
    pub fn abort(&self, txid: u64) {
        self.active_transactions.write().remove(&txid);
        self.update_horizon();
    }

    /// Add a new document version to the version chain.
    pub fn add_version(&self, key: Vec<u8>, entry: VersionEntry) {
        let mut chains = self.version_chains.write();
        let chain = chains.entry(key).or_default();
        // Insert at front (newest first)
        chain.insert(0, entry);
    }

    /// Read the visible version of a document for a given snapshot.
    pub fn read_version(&self, key: &[u8], snapshot: &Snapshot) -> Option<VersionEntry> {
        let chains = self.version_chains.read();
        let chain = chains.get(key)?;

        // Walk the version chain to find the first visible version
        for version in chain {
            if snapshot.is_visible(version.txid) {
                if version.tombstone {
                    return None; // Document was deleted in visible history
                }
                return Some(version.clone());
            }
        }

        None
    }

    /// Garbage collect old versions beyond the horizon.
    pub fn gc(&self) -> usize {
        let horizon = self.horizon_txid.load(Ordering::SeqCst);
        let mut chains = self.version_chains.write();
        let mut purged = 0;

        for chain in chains.values_mut() {
            // Keep at least the newest version, purge old ones beyond horizon
            let mut keep_count = 0;
            for version in chain.iter() {
                keep_count += 1;
                if version.txid < horizon && keep_count > 1 {
                    break;
                }
            }
            if chain.len() > keep_count {
                let removed = chain.len() - keep_count;
                chain.truncate(keep_count);
                purged += removed;
            }
        }

        purged
    }

    /// Get the current horizon TxID.
    pub fn horizon(&self) -> u64 {
        self.horizon_txid.load(Ordering::SeqCst)
    }

    /// Generate a new TxID (for non-transactional writes).
    pub fn next_txid(&self) -> u64 {
        self.txid_gen.next()
    }

    /// Get the number of active transactions.
    pub fn active_count(&self) -> usize {
        self.active_transactions.read().len()
    }

    fn update_horizon(&self) {
        let active = self.active_transactions.read();
        let min_txid = active
            .keys()
            .copied()
            .min()
            .unwrap_or(self.txid_gen.current());
        self.horizon_txid.store(min_txid, Ordering::SeqCst);
    }
}

impl Default for MvccManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_txid_monotonic() {
        let gen = TxIdGenerator::new();
        let id1 = gen.next();
        let id2 = gen.next();
        let id3 = gen.next();
        assert!(id1 < id2);
        assert!(id2 < id3);
    }

    #[test]
    fn test_snapshot_visibility() {
        let snapshot = Snapshot {
            txid: 100,
            active_txids: HashSet::from([95, 98]),
        };

        assert!(snapshot.is_visible(50)); // Before snapshot
        assert!(snapshot.is_visible(100)); // At snapshot
        assert!(!snapshot.is_visible(101)); // After snapshot
        assert!(!snapshot.is_visible(95)); // Active at snapshot time
        assert!(!snapshot.is_visible(98)); // Active at snapshot time
        assert!(snapshot.is_visible(96)); // Committed before snapshot
    }

    #[test]
    fn test_mvcc_basic_read_write() {
        let mvcc = MvccManager::new();

        // Write a document
        let txid = mvcc.next_txid();
        mvcc.add_version(
            b"doc1".to_vec(),
            VersionEntry {
                txid,
                data: b"version1".to_vec(),
                tombstone: false,
            },
        );

        // Read it with a new snapshot
        let txn = mvcc.begin_transaction();
        let version = mvcc.read_version(b"doc1", &txn.snapshot);
        assert!(version.is_some());
        assert_eq!(version.unwrap().data, b"version1");

        mvcc.commit(txn.txid).unwrap();
    }

    #[test]
    fn test_mvcc_transaction_isolation() {
        let mvcc = MvccManager::new();

        // Write initial version
        let txid1 = mvcc.next_txid();
        mvcc.add_version(
            b"doc1".to_vec(),
            VersionEntry {
                txid: txid1,
                data: b"v1".to_vec(),
                tombstone: false,
            },
        );

        // Start a read transaction
        let reader = mvcc.begin_transaction();

        // Write a new version after the reader's snapshot
        let txid2 = mvcc.next_txid();
        mvcc.add_version(
            b"doc1".to_vec(),
            VersionEntry {
                txid: txid2,
                data: b"v2".to_vec(),
                tombstone: false,
            },
        );

        // Reader should still see v1
        let version = mvcc.read_version(b"doc1", &reader.snapshot);
        assert_eq!(version.unwrap().data, b"v1");

        mvcc.commit(reader.txid).unwrap();
    }
}
