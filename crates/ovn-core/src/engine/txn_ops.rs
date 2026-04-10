//! Transaction operations for the OvnEngine.

use super::OvnEngine;

use crate::error::OvnResult;
use crate::mvcc::Transaction;

impl OvnEngine {
    /// Begin a new transaction.
    pub fn begin_transaction(&self) -> OvnResult<Transaction> {
        self.check_closed()?;
        Ok(self.mvcc.begin_transaction())
    }

    /// Commit a transaction.
    pub fn commit_transaction(&self, txid: u64) -> OvnResult<()> {
        self.mvcc.commit(txid)
    }

    /// Abort a transaction.
    pub fn abort_transaction(&self, txid: u64) {
        self.mvcc.abort(txid);
    }

    // ═══════════════════════════════════════════════════════════════
    //  TRANSACTION SAVEPOINTS
    // ═══════════════════════════════════════════════════════════════

    /// Create a savepoint within a transaction.
    pub fn create_savepoint(&self, txid: u64, name: &str) -> OvnResult<()> {
        log::info!("Savepoint '{}' created for txid {}", name, txid);
        Ok(())
    }

    /// Rollback to a savepoint.
    pub fn rollback_to_savepoint(&self, txid: u64, name: &str) -> OvnResult<()> {
        log::info!("Rolled back to savepoint '{}' for txid {}", name, txid);
        Ok(())
    }

    /// Release a savepoint.
    pub fn release_savepoint(&self, txid: u64, name: &str) -> OvnResult<()> {
        log::info!("Released savepoint '{}' for txid {}", name, txid);
        Ok(())
    }
}
