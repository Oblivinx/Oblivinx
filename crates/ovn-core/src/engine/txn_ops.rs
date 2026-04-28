//! Transaction operations for the OvnEngine.
//!
//! Implements full savepoint support with in-memory state capture and rollback.
//! Savepoints are stored in-memory only - if the process crashes, savepoint state
//! is lost with the parent transaction.

use std::collections::HashMap;

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};
use crate::storage::btree::BTreeEntry;

/// What was the original value before this transaction wrote it?
#[derive(Debug, Clone)]
pub enum SavepointOriginalValue {
    /// Key existed with this value before the transaction
    Existing(Vec<u8>),
    /// Key did not exist (newly inserted)
    New,
}

/// A savepoint captures the current state of written keys.
#[derive(Debug, Clone)]
pub struct Savepoint {
    pub name: String,
    /// key → (original_value, collection_id)
    pub state_snapshot: HashMap<Vec<u8>, (SavepointOriginalValue, u32)>,
}

/// Per-transaction savepoint state.
#[derive(Debug)]
pub struct SavepointState {
    pub savepoints: Vec<Savepoint>,
    /// Keys written: key → (original_value, collection_id)
    pub write_log: HashMap<Vec<u8>, (SavepointOriginalValue, u32)>,
}

impl SavepointState {
    pub fn new() -> Self {
        Self {
            savepoints: Vec::new(),
            write_log: HashMap::new(),
        }
    }

    pub fn record_write(
        &mut self,
        key: Vec<u8>,
        original: SavepointOriginalValue,
        collection_id: u32,
    ) {
        self.write_log
            .entry(key)
            .or_insert((original, collection_id));
    }

    pub fn create_savepoint(&mut self, name: &str) -> OvnResult<()> {
        const MAX_DEPTH: usize = 16;
        if self.savepoints.len() >= MAX_DEPTH {
            return Err(OvnError::SavepointDepthError {
                max_depth: MAX_DEPTH,
            });
        }
        if self.savepoints.iter().any(|sp| sp.name == name) {
            return Err(OvnError::SavepointError {
                name: name.to_string(),
                reason: "Savepoint name already exists".to_string(),
            });
        }
        self.savepoints.push(Savepoint {
            name: name.to_string(),
            state_snapshot: self.write_log.clone(),
        });
        Ok(())
    }

    pub fn rollback_to_savepoint(
        &mut self,
        name: &str,
    ) -> OvnResult<Vec<(Vec<u8>, SavepointOriginalValue, u32)>> {
        let idx = self
            .savepoints
            .iter()
            .rposition(|sp| sp.name == name)
            .ok_or_else(|| OvnError::SavepointError {
                name: name.to_string(),
                reason: "Savepoint not found".to_string(),
            })?;

        let snapshot = &self.savepoints[idx].state_snapshot;

        let undo: Vec<(Vec<u8>, SavepointOriginalValue, u32)> = self
            .write_log
            .iter()
            .filter_map(|(k, (v, c))| {
                if !snapshot.contains_key(k) {
                    Some((k.clone(), v.clone(), *c))
                } else {
                    None
                }
            })
            .collect();

        self.write_log = snapshot.clone();
        self.savepoints.truncate(idx);

        Ok(undo)
    }

    pub fn release_savepoint(&mut self, name: &str) -> OvnResult<()> {
        let idx = self
            .savepoints
            .iter()
            .rposition(|sp| sp.name == name)
            .ok_or_else(|| OvnError::SavepointError {
                name: name.to_string(),
                reason: "Savepoint not found".to_string(),
            })?;
        self.savepoints.remove(idx);
        Ok(())
    }
}

impl OvnEngine {
    /// Begin a new transaction.
    pub fn begin_transaction(&self) -> OvnResult<u64> {
        self.check_closed()?;
        let txn = self.mvcc.begin_transaction();
        let txid = txn.txid;

        // Initialize savepoint state for this transaction
        self.savepoint_states
            .lock()
            .unwrap()
            .insert(txid, SavepointState::new());

        Ok(txid)
    }

    /// Commit a transaction.
    pub fn commit_transaction(&self, txid: u64) -> OvnResult<()> {
        self.check_closed()?;
        // Clean up savepoint state on commit
        self.savepoint_states.lock().unwrap().remove(&txid);
        self.mvcc.commit(txid)
    }

    /// Abort a transaction.
    pub fn abort_transaction(&self, txid: u64) {
        // Clean up savepoint state on abort
        self.savepoint_states.lock().unwrap().remove(&txid);
        self.mvcc.abort(txid);
    }

    /// Record a write for savepoint tracking.
    pub fn record_savepoint_write(
        &self,
        txid: u64,
        key: Vec<u8>,
        original: SavepointOriginalValue,
        collection_id: u32,
    ) {
        if let Ok(mut map) = self.savepoint_states.try_lock() {
            if let Some(state) = map.get_mut(&txid) {
                state.record_write(key, original, collection_id);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════
    //  TRANSACTION SAVEPOINTS
    // ═══════════════════════════════════════════════════════════════

    /// Create a savepoint within a transaction.
    pub fn create_savepoint(&self, txid: u64, name: &str) -> OvnResult<()> {
        self.check_closed()?;
        let mut map = self.savepoint_states.lock().unwrap();
        let state = map.entry(txid).or_insert_with(SavepointState::new);
        state.create_savepoint(name)?;
        log::info!("Savepoint '{}' created for txid {}", name, txid);
        Ok(())
    }

    /// Rollback to a savepoint, undoing all writes since it was created.
    pub fn rollback_to_savepoint(&self, txid: u64, name: &str) -> OvnResult<()> {
        self.check_closed()?;

        let mut map = self.savepoint_states.lock().unwrap();
        let state = map
            .get_mut(&txid)
            .ok_or_else(|| OvnError::TransactionAborted {
                txid,
                reason: "Transaction not found".to_string(),
            })?;

        let undo = state.rollback_to_savepoint(name)?;

        // Undo writes by restoring original values
        for (key, original, coll_id) in undo {
            let new_txid = self.mvcc.next_txid();
            match original {
                SavepointOriginalValue::Existing(value) => {
                    let _ = self.btree.insert(BTreeEntry {
                        key: key.clone(),
                        value: value.clone(),
                        txid: new_txid,
                        tombstone: false,
                    });
                    let _ = self
                        .memtable
                        .insert(crate::storage::memtable::MemTableEntry {
                            key,
                            value,
                            txid: new_txid,
                            tombstone: false,
                            collection_id: coll_id,
                        });
                }
                SavepointOriginalValue::New => {
                    // Tombstone the newly inserted key
                    let _ = self.btree.insert(BTreeEntry {
                        key: key.clone(),
                        value: Vec::new(),
                        txid: new_txid,
                        tombstone: true,
                    });
                    let _ = self
                        .memtable
                        .insert(crate::storage::memtable::MemTableEntry {
                            key,
                            value: Vec::new(),
                            txid: new_txid,
                            tombstone: true,
                            collection_id: coll_id,
                        });
                }
            }
        }

        log::info!("Rolled back to savepoint '{}' for txid {}", name, txid);
        Ok(())
    }

    /// Release a savepoint.
    pub fn release_savepoint(&self, txid: u64, name: &str) -> OvnResult<()> {
        self.check_closed()?;
        let mut map = self.savepoint_states.lock().unwrap();
        let state = map
            .get_mut(&txid)
            .ok_or_else(|| OvnError::TransactionAborted {
                txid,
                reason: "Transaction not found".to_string(),
            })?;
        state.release_savepoint(name)?;
        log::info!("Released savepoint '{}' for txid {}", name, txid);
        Ok(())
    }
}
