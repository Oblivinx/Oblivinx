//! # Oblivinx3x Core Storage Engine
//!
//! `ovn-core` is the pure Rust implementation of the Oblivinx3x embedded document database.
//! It provides a hybrid B+/LSM storage engine with MVCC concurrency control,
//! ACID transactions, and a MongoDB-compatible query language subset.
//!
//! ## Architecture Layers
//!
//! ```text
//! ┌─────────────────────────────────────┐
//! │         Engine (Public API)         │
//! ├─────────────────────────────────────┤
//! │         Query Engine                │
//! ├─────────────────────────────────────┤
//! │         Index Engine (AHIT)         │
//! ├─────────────────────────────────────┤
//! │         Document Layer (OBE)        │
//! ├─────────────────────────────────────┤
//! │         MVCC Transaction Layer      │
//! ├─────────────────────────────────────┤
//! │         Storage Engine              │
//! ├─────────────────────────────────────┤
//! │         I/O Abstraction             │
//! └─────────────────────────────────────┘
//! ```

pub mod compression;
pub mod engine;
pub mod error;
pub mod format;
pub mod index;
pub mod io;
pub mod mvcc;
pub mod query;
pub mod storage;

// Re-export primary public types
pub use engine::config::OvnConfig;
pub use engine::OvnEngine;
pub use error::{OvnError, OvnResult};
pub use format::obe::{ObeDocument, ObeField, ObeValue};

/// The magic number for .ovn files: 'OVNX' in ASCII = 0x4F564E58
pub const OVN_MAGIC: u32 = 0x4F56_4E58;

/// Default page size in bytes
pub const DEFAULT_PAGE_SIZE: u32 = 4096;

/// Maximum document size (16MB)
pub const MAX_DOCUMENT_SIZE: usize = 16 * 1024 * 1024;

/// Default MemTable threshold before flush (64MB)
pub const DEFAULT_MEMTABLE_THRESHOLD: usize = 64 * 1024 * 1024;

/// Default buffer pool size (256MB)
pub const DEFAULT_BUFFER_POOL_SIZE: usize = 256 * 1024 * 1024;

/// File format version
pub const FORMAT_VERSION_MAJOR: u16 = 1;
pub const FORMAT_VERSION_MINOR: u16 = 0;
