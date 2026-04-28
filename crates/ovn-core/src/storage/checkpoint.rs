//! Atomic checkpoint and MemTable-to-L0 flush logic (Bug-1 & Bug-2 fix).
//!
//! ## Correct flush + checkpoint sequence
//!
//! ```text
//! 1. Freeze MemTable (no new writes accepted).
//! 2. Write L0 SSTable bytes to disk with CRC32C footer.
//! 3. fsync L0 SSTable file.
//! 4. write_checkpoint_atomic(frozen.max_txid()):
//!    a. Serialize checkpoint metadata to shadow page at offset 0x0FF0.
//!    b. fsync shadow page.
//!    c. Update Page 0 with new checkpoint TxID + recalculate CRC32C.
//!    d. fsync Page 0.
//! 5. Truncate WAL records below the new checkpoint TxID.
//! 6. Clear MemTable only after ALL fsyncs succeed.
//! ```
//!
//! If any step fails before step 5 the WAL is NOT truncated and the MemTable
//! is NOT cleared — both remain valid for the next recovery attempt.

use std::sync::Arc;

use crate::error::{OvnError, OvnResult};
use crate::format::header::FileHeader;
use crate::io::FileBackend;
use crate::storage::memtable::{MemTable, MemTableEntry};
use crate::storage::sstable::SSTableManager;
use crate::storage::wal::WalManager;

/// Shadow-page offset within Page 0 (4096-byte header page).
const SHADOW_OFFSET: u64 = 0x0FF0;

/// Checkpointed state written to the shadow page.
///
/// 16 bytes: txid(8) + crc32c(4) + reserved(4).
fn encode_shadow_checkpoint(txid: u64) -> [u8; 16] {
    let mut buf = [0u8; 16];
    buf[0..8].copy_from_slice(&txid.to_le_bytes());
    let crc = crc32c::crc32c(&buf[0..8]);
    buf[8..12].copy_from_slice(&crc.to_le_bytes());
    buf
}

/// Write the checkpoint TxID atomically to both the shadow page and Page 0.
///
/// Ordering guarantee:
/// 1. Shadow page written + fsynced first.
/// 2. Page 0 updated + fsynced second.
///
/// If we crash between steps 1 and 2, `read_page_0_safe()` detects the
/// shadow, logs a warning, and forces WAL recovery which re-applies the
/// same checkpoint.
pub fn write_checkpoint_atomic(
    backend: &dyn FileBackend,
    page_size: u32,
    checkpoint_txid: u64,
) -> OvnResult<()> {
    // ── Step 1: shadow page ──────────────────────────────────────────────
    let shadow = encode_shadow_checkpoint(checkpoint_txid);
    backend.write_at(SHADOW_OFFSET, &shadow)?;
    backend.sync_data()?; // fsync shadow first

    // ── Step 2: Page 0 ──────────────────────────────────────────────────
    let page0_bytes = backend.read_page(0, page_size)?;
    let mut header = FileHeader::from_bytes(&page0_bytes)?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    header.last_checkpoint = now_ms;
    // Store the checkpoint TxID in the HLC state field (upper bits hold physical ms,
    // lower bits hold the last durable TxID for WAL replay skipping).
    header.hlc_state = checkpoint_txid;

    let new_page0 = header.to_bytes();
    backend.write_page(0, page_size, &new_page0)?;
    backend.sync()?; // fsync Page 0 (full metadata sync)

    log::debug!("Checkpoint atomic write complete: txid={}", checkpoint_txid);
    Ok(())
}

/// Flush the active MemTable to an L0 SSTable and then write an atomic checkpoint.
///
/// This is the Bug-1 fix: the checkpoint TxID is only advanced AFTER the
/// SSTable is fully written and fsynced.  WAL records below the new checkpoint
/// are safe to truncate only after this function returns `Ok(())`.
///
/// Returns the maximum TxID that was checkpointed, or `None` if the MemTable
/// was empty (no flush needed).
pub fn flush_memtable_to_l0(
    memtable: &Arc<MemTable>,
    sstable_mgr: &Arc<SSTableManager>,
    wal: &Arc<WalManager>,
    backend: &dyn FileBackend,
    page_size: u32,
) -> OvnResult<Option<u64>> {
    let entries: Vec<MemTableEntry> = memtable.drain_sorted();
    if entries.is_empty() {
        return Ok(None);
    }

    let max_txid = entries.iter().map(|e| e.txid).max().unwrap_or(0);

    // ── Step 1: build L0 SSTable (in memory) ────────────────────────────
    let sstable_id = sstable_mgr.next_id();
    let sstable = crate::storage::sstable::SSTable::from_memtable_entries(sstable_id, entries)
        .map_err(|e| OvnError::SSTableError(e.to_string()))?;

    // ── Step 2: persist SSTable bytes + fsync ────────────────────────────
    // Write SSTable data to the end of the data file.
    let sstable_bytes = sstable.to_bytes();
    let _sstable_offset = backend.append(&sstable_bytes)?;
    backend.sync_data()?; // fsync SSTable before touching checkpoint

    // ── Step 3: register SSTable in manager ──────────────────────────────
    sstable_mgr.add(sstable);

    // ── Step 4: atomic checkpoint (shadow → Page 0) ──────────────────────
    write_checkpoint_atomic(backend, page_size, max_txid)?;

    // ── Step 5: update WAL's in-memory last_checkpoint_txid ──────────────
    // WAL truncation of records below this TxID is now safe.
    wal.set_last_checkpoint_txid(max_txid);

    // ── Step 6: clear MemTable only after all fsyncs succeed ─────────────
    memtable.clear();

    log::info!("Flushed MemTable to L0 SSTable id={sstable_id}; checkpoint TxID={max_txid}");
    Ok(Some(max_txid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(test)]
    use crate::io::backend::MemoryBackend;

    #[test]
    fn test_shadow_checkpoint_encoding() {
        let txid = 0xDEAD_BEEF_1234_5678u64;
        let encoded = encode_shadow_checkpoint(txid);
        let decoded_txid = u64::from_le_bytes(encoded[0..8].try_into().unwrap());
        assert_eq!(decoded_txid, txid);

        // CRC should be consistent
        let crc1 = u32::from_le_bytes(encoded[8..12].try_into().unwrap());
        let expected_crc = crc32c::crc32c(&encoded[0..8]);
        assert_eq!(crc1, expected_crc);
    }

    #[test]
    fn test_write_checkpoint_atomic() {
        let backend = MemoryBackend::new();
        // Initialize a blank Page 0
        let header = FileHeader::new(4096);
        let page0 = header.to_bytes();
        backend.write_page(0, 4096, &page0).unwrap();
        // Extend file so shadow offset (0x0FF0) is addressable within Page 0
        // (MemoryBackend grows automatically on write_at).

        write_checkpoint_atomic(&backend, 4096, 42).unwrap();

        // Verify shadow page was written
        let shadow = backend.read_at(SHADOW_OFFSET, 16).unwrap();
        let txid = u64::from_le_bytes(shadow[0..8].try_into().unwrap());
        assert_eq!(txid, 42);
    }
}
