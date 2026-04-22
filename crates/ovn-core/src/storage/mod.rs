//! Storage engine layer (v2.0 "Nova").
//!
//! Hybrid B+/LSM architecture with HTAP columnar mirror:
//! - [`arc_buffer`]   — ARC adaptive replacement cache (replaces segmented-LRU) [v2]
//! - [`buffer_pool`]  — Page cache, now backed by ARC
//! - [`wal`]          — Write-ahead log with group commit + durability levels [v2]
//! - [`memtable`]     — In-memory write buffer (skip list)
//! - [`sstable`]      — Sorted String Table for flushed MemTable data
//! - [`disk_sstable`] — Real SSTable files on disk
//! - [`btree`]        — Persistent B+ tree for primary document index
//! - [`disk_btree`]   — Disk-based B+ tree with buffer pool integration
//! - [`columnar`]     — HTAP ColumnChunk mirror (ColumnarFlusher) [v2]
//! - [`zone_map`]     — Zone map sketches (per-page min/max/null-count) [v2]
//! - [`cdc_log`]      — Durable CDC log (Debezium-compatible) [v2]

pub mod arc_buffer;
pub mod blob;
pub mod btree;
pub mod buffer_pool;
pub mod cdc_log;
pub mod columnar;
pub mod disk_btree;
pub mod disk_sstable;
pub mod memtable;
pub mod sstable;
pub mod timeseries;
pub mod wal;
pub mod zone_map;
