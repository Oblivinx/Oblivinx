//! Storage engine layer.
//!
//! Implements the hybrid B+/LSM architecture:
//! - [`buffer_pool`] — Segmented LRU page cache
//! - [`wal`] — Write-ahead log for durability
//! - [`memtable`] — In-memory write buffer (skip list)
//! - [`sstable`] — Sorted String Table for flushed MemTable data
//! - [`disk_sstable`] — Real SSTable files on disk
//! - [`btree`] — Persistent B+ tree for primary document index
//! - [`disk_btree`] — Disk-based B+ tree with buffer pool integration

pub mod blob;
pub mod btree;
pub mod buffer_pool;
pub mod memtable;
pub mod sstable;
pub mod disk_sstable;
pub mod disk_btree;
pub mod timeseries;
pub mod wal;
