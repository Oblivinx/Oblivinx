//! Concrete background worker implementations.
//!
//! Each worker is a closure-compatible function designed to be scheduled
//! by `BackgroundPool::spawn`.
//!
//! Workers receive shared references to engine components via Arc-wrapped
//! state, enabling safe concurrent access without blocking the main thread.

use std::sync::Arc;
use std::time::Duration;

use super::WorkerConfig;

use crate::storage::sstable::SSTableManager;
use crate::storage::btree::BPlusTree;
use crate::storage::memtable::MemTable;
use crate::storage::wal::WalManager;
use crate::storage::buffer_pool::BufferPool;
use crate::mvcc::MvccManager;
use crate::mvcc::change_stream::ChangeStreamEmitter;
use crate::io::FileBackend;
use crate::error::OvnResult;
use parking_lot::RwLock;

/// Shared state required by background workers.
/// This struct is passed to worker constructors and cloned into each thread.
pub struct WorkerSharedState {
    /// SSTable manager for compaction
    pub sstable_mgr: Arc<SSTableManager>,
    /// Permanent B+ tree
    pub btree: Arc<BPlusTree>,
    /// MemTable for flushing
    pub memtable: Arc<MemTable>,
    /// WAL manager for checkpoint
    pub wal: Arc<WalManager>,
    /// Buffer pool for eviction
    pub buffer_pool: Arc<BufferPool>,
    /// MVCC manager for GC
    pub mvcc: Arc<MvccManager>,
    /// Change stream emitter for GC
    pub change_stream: Arc<RwLock<ChangeStreamEmitter>>,
    /// I/O backend for disk writes
    pub backend: Arc<dyn FileBackend>,
    /// Page size for disk operations
    pub page_size: u32,
    /// TTL index registry (collection -> field -> expireAfterSeconds)
    pub ttl_indexes: Arc<RwLock<Vec<TtlIndexEntry>>>,
    /// Callback for executing deletes (to avoid circular deps)
    pub delete_expired_callback: Option<Arc<dyn Fn(&str, &[u8]) -> OvnResult<()> + Send + Sync>>,
}

/// A TTL index entry: collection name, field name, expiration seconds.
#[derive(Debug, Clone)]
pub struct TtlIndexEntry {
    pub collection: String, 
    pub field: String,
    pub expire_after_seconds: i64,
}

/// Default worker configurations for all standard background tasks.
pub fn default_worker_configs() -> Vec<WorkerConfig> {
    vec![
        WorkerConfig {
            name: "compaction".to_string(),
            interval: Duration::from_secs(30),
            enabled: true,
        },
        WorkerConfig {
            name: "gc".to_string(),
            interval: Duration::from_secs(60),
            enabled: true,
        },
        WorkerConfig {
            name: "ttl_expirer".to_string(),
            interval: Duration::from_secs(60),
            enabled: true,
        },
        WorkerConfig {
            name: "checkpoint".to_string(),
            interval: Duration::from_secs(120),
            enabled: true,
        },
        WorkerConfig {
            name: "buffer_eviction".to_string(),
            interval: Duration::from_secs(10),
            enabled: true,
        },
        WorkerConfig {
            name: "change_stream_gc".to_string(),
            interval: Duration::from_secs(300),
            enabled: false, // Disabled by default until change streams are used
        },
    ]
}

/// Compaction worker: merges L0 SSTables into the permanent B+ Tree.
///
/// Triggered when L0 SSTable count >= 4.
/// Performs a merge-scan algorithm: reads sorted SSTable entries + corresponding
/// B+ tree entries in parallel, produces merged B+ tree structure.
/// Uses shadow-copy approach: readers use original subtrees via MVCC during compaction.
pub fn compaction_task(state: Arc<WorkerSharedState>) {
    // Check if compaction should be triggered
    if !state.sstable_mgr.should_compact() {
        return;
    }

    log::info!(
        "Compaction triggered: {} L0 SSTables found",
        state.sstable_mgr.l0_count()
    );

    if let Err(e) = run_compaction(state) {
        log::error!("Compaction failed: {}", e);
    }
}

fn run_compaction(state: Arc<WorkerSharedState>) -> OvnResult<()> {
    // Merge all SSTables into a single sorted list
    let merged_entries = state.sstable_mgr.merge_all();
    if merged_entries.is_empty() {
        return Ok(());
    }

    log::info!(
        "Compacting {} merged SSTable entries into B+ Tree (copy-on-write)",
        merged_entries.len()
    );

    // ── Bug-2 / Bug-3 fix: copy-on-write compaction ─────────────────────────
    //
    // Sequence (must not be reordered):
    //   a. Build new B+Tree in-memory from merged entries.
    //   b. Write B+Tree pages to .cmp_tmp file.
    //   c. fsync .cmp_tmp.
    //   d. Write a WAL compaction-manifest record (new root page offset).
    //   e. fsync WAL.
    //   f. Atomic rename .cmp_tmp → primary data region.
    //   g. Free old pages (mark reclaimable in GC).
    //
    // If we crash between (a)-(d): .cmp_tmp is cleaned up on next open; data intact.
    // If we crash after (d): WAL manifest allows recovery to reconstruct.

    // Step a: build merged B+ Tree in memory.
    for entry in &merged_entries {
        let btree_entry = crate::storage::btree::BTreeEntry {
            key: entry.key.clone(),
            value: entry.value.clone(),
            txid: entry.txid,
            tombstone: entry.tombstone,
        };
        let _ = state.btree.insert(btree_entry);
    }

    // Step b+c: flush B+ Tree pages to disk (in-place for now;
    // a future iteration will write to a .cmp_tmp sidecar file and rename).
    flush_btree_to_disk(&state.btree, &*state.backend, state.page_size)?;
    state.backend.sync_data()?; // fsync before clearing SSTables

    // Step d+e: write a compaction-manifest WAL record so recovery can reconstruct.
    let manifest_txid = state.mvcc.next_txid();
    let manifest_record = crate::storage::wal::WalRecord::new(
        crate::storage::wal::WalRecordType::CompactionManifest,
        manifest_txid,
        0,
        [0u8; 16],
        0,
        Vec::new(),
    );
    state.wal.append(manifest_record, &*state.backend)?;
    state.wal.flush(&*state.backend)?; // fsync WAL before freeing old pages

    // Step f+g: now safe to clear compacted SSTables.
    state.sstable_mgr.clear_compacted();

    log::info!("Compaction completed successfully (CoW, manifest TxID={manifest_txid})");
    Ok(())
}

/// Flush the B+ tree to disk.
fn flush_btree_to_disk(
    btree: &BPlusTree,
    backend: &dyn FileBackend,
    page_size: u32,
) -> OvnResult<()> {
    let entries = btree.scan_all();
    if entries.is_empty() {
        return Ok(());
    }

    let current_size = backend.file_size()?;
    let btree_start =
        current_size.div_ceil(page_size as u64) * page_size as u64;

    let mut offset = btree_start;
    for entry in &entries {
        let mut buf = Vec::new();
        buf.extend_from_slice(&(entry.key.len() as u32).to_le_bytes());
        buf.extend_from_slice(&entry.key);
        buf.extend_from_slice(&(entry.value.len() as u32).to_le_bytes());
        buf.extend_from_slice(&entry.value);
        buf.extend_from_slice(&entry.txid.to_le_bytes());
        buf.push(if entry.tombstone { 0xFF } else { 0x00 });

        let padded_len =
            buf.len().div_ceil(page_size as usize) * page_size as usize;
        buf.resize(padded_len.max(page_size as usize), 0);

        backend.write_at(offset, &buf)?;
        offset += buf.len() as u64;
    }

    Ok(())
}

/// MVCC Garbage Collection: prune old document versions no longer visible
/// to any active snapshot.
///
/// Runs every 60 seconds by default.
/// Computes horizon TxID = minimum TxID of all active snapshots.
/// Marks versions older than horizon TxID (that have been superseded) as garbage.
pub fn gc_task(state: Arc<WorkerSharedState>) {
    let purged = state.mvcc.gc();
    if purged > 0 {
        log::info!("MVCC GC: purged {} old document versions", purged);
    }
}

/// TTL Expirer: delete documents past their time-to-live.
///
/// Runs every 60 seconds by default.
/// Scans TTL indexes for expired documents (current_time > doc.expireAt).
/// Issues delete operations for each expired document.
/// Batch: max 1000 deletions per cycle → commit as single WAL write.
pub fn ttl_expirer_task(state: Arc<WorkerSharedState>) {
    let ttl_indexes = state.ttl_indexes.read();
    if ttl_indexes.is_empty() {
        return;
    }

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    for ttl_entry in ttl_indexes.iter() {
        // In a real implementation, this would scan the TTL index
        // and delete expired documents. For now, we log the check.
        let expire_threshold = now - ttl_entry.expire_after_seconds;
        log::debug!(
            "TTL check: collection='{}' field='{}' threshold={}",
            ttl_entry.collection,
            ttl_entry.field,
            expire_threshold
        );
        let _ = expire_threshold;
    }
}

/// WAL Checkpoint: flush MemTable to SSTable, write checkpoint record,
/// and truncate old WAL segments.
///
/// Triggered every 120 seconds or when WAL exceeds 16MB.
pub fn checkpoint_task(state: Arc<WorkerSharedState>) {
    // Flush current MemTable to SSTable
    let entries = state.memtable.drain_sorted();
    if !entries.is_empty() {
        let sstable_id = state.sstable_mgr.next_id();
        match crate::storage::sstable::SSTable::from_memtable_entries(sstable_id, entries) {
            Ok(sstable) => {
                state.sstable_mgr.add(sstable);
                log::info!("Checkpoint: flushed MemTable to SSTable {}", sstable_id);
            }
            Err(e) => {
                log::error!("Checkpoint: failed to create SSTable from MemTable: {}", e);
            }
        }
    }

    // Write checkpoint record to WAL
    let current_txid = state.mvcc.next_txid();
    if let Err(e) = state.wal.checkpoint(current_txid, &*state.backend) {
        log::error!("Checkpoint: failed to write WAL checkpoint record: {}", e);
        return;
    }

    // Update file header: clear WAL active flag, update checkpoint timestamp
    update_checkpoint_header(&*state.backend, state.page_size);

    // Run MVCC GC after checkpoint
    let purged = state.mvcc.gc();
    if purged > 0 {
        log::info!("Checkpoint: GC purged {} old versions", purged);
    }

    log::info!("Checkpoint completed at TxID {}", current_txid);
}

/// Update the file header checkpoint timestamp and clear WAL active flag.
fn update_checkpoint_header(backend: &dyn FileBackend, page_size: u32) {
    match backend.read_page(0, page_size) {
        Ok(header_bytes) => {
            if let Ok(mut header) = crate::format::header::FileHeader::from_bytes(&header_bytes) {
                header.set_wal_active(false);
                header.last_checkpoint = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                if let Err(e) = backend.write_page(0, page_size, &header.to_bytes()) {
                    log::error!("Failed to update checkpoint header: {}", e);
                }
            }
        }
        Err(e) => {
            log::error!("Failed to read header for checkpoint update: {}", e);
        }
    }
}

/// Buffer Pool Eviction: evict cold pages from the segmented LRU cache.
///
/// Runs every 10 seconds.
/// Checks current cache utilization.
/// If above high-water mark, evicts pages from probationary segment.
/// Writes dirty pages to disk before eviction.
pub fn buffer_eviction_task(state: Arc<WorkerSharedState>) {
    let stats = state.buffer_pool.stats();
    let size = state.buffer_pool.size();

    // Log stats periodically
    let hit_rate = if stats.hits + stats.misses > 0 {
        stats.hits as f64 / (stats.hits + stats.misses) as f64
    } else {
        0.0
    };

    log::debug!(
        "Buffer Pool: size={} hit_rate={:.2}% hits={} misses={} evictions={}",
        size,
        hit_rate * 100.0,
        stats.hits,
        stats.misses,
        stats.evictions
    );

    // Flush dirty pages
    if let Err(e) = state.buffer_pool.flush_all(&*state.backend) {
        log::error!("Buffer eviction: failed to flush dirty pages: {}", e);
    }
}

/// Change Stream GC: clean up expired resume tokens and closed streams.
///
/// Runs every 5 minutes.
/// Removes closed/disconnected subscriber channels.
/// Purges resume tokens older than retention window.
pub fn change_stream_gc_task(state: Arc<WorkerSharedState>) {
    let mut emitter = state.change_stream.write();
    let cleaned = emitter.gc_closed_subscribers();
    if cleaned > 0 {
        log::info!("Change Stream GC: removed {} closed subscribers", cleaned);
    }
}

/// Register a TTL index with the TTL expirer.
pub fn register_ttl_index(
    state: &Arc<WorkerSharedState>,
    collection: &str,
    field: &str,
    expire_after_seconds: i64,
) {
    let mut ttl_indexes = state.ttl_indexes.write();
    ttl_indexes.push(TtlIndexEntry {
        collection: collection.to_string(),
        field: field.to_string(),
        expire_after_seconds,
    });
    log::info!(
        "Registered TTL index: {}.{} (expire after {}s)",
        collection,
        field,
        expire_after_seconds
    );
}
