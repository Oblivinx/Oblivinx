//! Storage engine layer.
//!
//! Implements the hybrid B+/LSM architecture:
//! - [`buffer_pool`] — Segmented LRU page cache
//! - [`wal`] — Write-ahead log for durability
//! - [`memtable`] — In-memory write buffer (skip list)
//! - [`sstable`] — Sorted String Table for flushed MemTable data
//! - [`btree`] — Persistent B+ tree for primary document index

pub mod buffer_pool;
pub mod wal;
pub mod memtable;
pub mod sstable;
pub mod btree;
