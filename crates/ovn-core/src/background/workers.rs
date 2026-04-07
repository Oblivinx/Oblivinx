//! Concrete background worker implementations.
//!
//! Each worker is a closure-compatible function designed to be scheduled
//! by `BackgroundPool::spawn`.

use std::time::Duration;

use super::WorkerConfig;

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

/// Compaction worker: merges L0 SSTables into higher level files.
pub fn compaction_task() {
    // TODO: Acquire engine reference and run SSTable tiered compaction
    // 1. Check L0 SSTable count against threshold
    // 2. Pick candidate SSTables based on overlap and size
    // 3. Merge-sort entries, removing tombstones older than GC horizon
    // 4. Write new SSTable to L1+
    // 5. Update manifest and delete old SSTables
}

/// MVCC Garbage Collection: prune old document versions no longer visible
/// to any active snapshot.
pub fn gc_task() {
    // TODO: Acquire MVCC manager reference
    // 1. Determine oldest active snapshot TxID
    // 2. Scan version chains for documents with all versions < oldest TxID
    // 3. Retain only the latest committed version, purge older ones
    // 4. Update storage accounting
}

/// TTL Expirer: delete documents past their time-to-live.
pub fn ttl_expirer_task() {
    // TODO: Acquire engine + index reference
    // 1. Scan TTL indexes for expired documents (current_time > doc.expireAt)
    // 2. Issue delete operations for each expired document
    // 3. Update collection doc_count
}

/// WAL Checkpoint: flush WAL records to stable storage and truncate old segments.
pub fn checkpoint_task() {
    // TODO: Acquire WAL + MemTable references
    // 1. Flush current MemTable to SSTable
    // 2. Write checkpoint record to WAL
    // 3. Truncate WAL segments before checkpoint LSN
}

/// Buffer Pool Eviction: evict cold pages from the segmented LRU cache.
pub fn buffer_eviction_task() {
    // TODO: Acquire BufferPool reference
    // 1. Check current cache utilization
    // 2. If above high-water mark, evict pages from probationary segment
    // 3. Write dirty pages to disk before eviction
}

/// Change Stream GC: clean up expired resume tokens and closed streams.
pub fn change_stream_gc_task() {
    // TODO: Acquire ChangeStreamEmitter reference
    // 1. Remove closed/disconnected subscriber channels
    // 2. Purge resume tokens older than retention window
}
