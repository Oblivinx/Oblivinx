//! # Oblivinx3x Core Storage Engine
//!
//! `ovn-core` is the pure Rust implementation of the Oblivinx3x embedded document database.
//! It provides a hybrid B+/LSM storage engine with MVCC concurrency control,
//! ACID transactions, and a MongoDB-compatible query language subset.
//!
//! ## Architecture Layers (v2.0 "Nova")
//!
//! ```text
//! ┌─────────────────────────────────────┐
//! │         Engine (Public API)         │
//! ├─────────────────────────────────────┤
//! │         AI / ML Integration         │
//! ├─────────────────────────────────────┤
//! │         Query Engine                │
//! ├─────────────────────────────────────┤
//! │         Index Engine (AHIT v2)      │
//! ├─────────────────────────────────────┤
//! │         Document Layer (OBE2)       │
//! ├─────────────────────────────────────┤
//! │         MVCC Transaction Layer      │
//! ├─────────────────────────────────────┤
//! │         Relational Compat. Layer    │
//! ├─────────────────────────────────────┤
//! │         Security Layer              │
//! ├─────────────────────────────────────┤
//! │         Storage Engine              │
//! ├─────────────────────────────────────┤
//! │         I/O Abstraction             │
//! ├─────────────────────────────────────┤
//! │         Background Worker Layer     │
//! └─────────────────────────────────────┘
//! ```

pub mod background;
pub mod compression;
pub mod distributed;
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

// ── File Format Constants ─────────────────────────────────────────────────────

/// v2.0 magic number: 'OVN2' in ASCII = 0x4F564E32.
/// Used for all new .ovn2 files created by Oblivinx3x v2.x.
pub const OVN2_MAGIC: u32 = 0x4F56_4E32;

/// v1.x legacy magic: 'OVNX' in ASCII = 0x4F564E58.
/// Detected on open → read-only compatibility mode. Write requires explicit migration.
pub const OVN_MAGIC_V1: u32 = 0x4F56_4E58;

/// Default magic (always points to the current major version).
pub const OVN_MAGIC: u32 = OVN2_MAGIC;

/// File format version for v2.0.
pub const FORMAT_VERSION_MAJOR: u16 = 2;
pub const FORMAT_VERSION_MINOR: u16 = 0;

/// File format version for v1 (used during compatibility detection only).
pub const FORMAT_VERSION_MAJOR_V1: u16 = 1;

/// Default page size in bytes (4 KiB). Valid range: 512–65536.
pub const DEFAULT_PAGE_SIZE: u32 = 4096;

/// Maximum document size (16 MiB).
pub const MAX_DOCUMENT_SIZE: usize = 16 * 1024 * 1024;

/// Default MemTable threshold before flush (64 MiB).
pub const DEFAULT_MEMTABLE_THRESHOLD: usize = 64 * 1024 * 1024;

/// Default Buffer Pool size (256 MiB full profile; ARC algorithm).
pub const DEFAULT_BUFFER_POOL_SIZE: usize = 256 * 1024 * 1024;

/// Default ART (Tier-0) max size per collection (32 MiB).
pub const DEFAULT_ART_MAX_SIZE: usize = 32 * 1024 * 1024;

/// Default WAL group commit batch size (1 MiB).
pub const DEFAULT_GROUP_COMMIT_BYTES: usize = 1024 * 1024;

/// Default WAL group commit timeout (200 µs).
pub const DEFAULT_GROUP_COMMIT_US: u64 = 200;

/// Default max concurrent write retries on WRITE_CONFLICT.
pub const DEFAULT_MAX_RETRIES: u32 = 8;

// ── HLC Constants ─────────────────────────────────────────────────────────────

/// HLC physical timestamp occupies the top 48 bits of a u64 TxID.
pub const HLC_PHYSICAL_BITS: u32 = 48;

/// HLC logical counter occupies the bottom 16 bits of a u64 TxID.
pub const HLC_LOGICAL_BITS: u32 = 16;

/// Mask for the HLC logical counter portion.
pub const HLC_LOGICAL_MASK: u64 = (1u64 << HLC_LOGICAL_BITS) - 1;

// ── Segment Codes (v2) ────────────────────────────────────────────────────────

/// Segment 0x01: File header + DB metadata + collection registry.
pub const SEGMENT_HEADER: u8 = 0x01;
/// Segment 0x02: OBE2 documents (row store).
pub const SEGMENT_DATA: u8 = 0x02;
/// Segment 0x03: AHIT v2 index (ART + Learned + B+/SSTable + FTS + Geo + Vector).
pub const SEGMENT_INDEX: u8 = 0x03;
/// Segment 0x04: Write-ahead log records.
pub const SEGMENT_WAL: u8 = 0x04;
/// Segment 0x05: Metadata (schemas, stats, pragmas, zstd dicts, etc.).
pub const SEGMENT_METADATA: u8 = 0x05;
/// Segment 0x06: Blob storage chunks.
pub const SEGMENT_BLOB: u8 = 0x06;
/// Segment 0x07: Change Stream Log (circular buffer, in-process).
pub const SEGMENT_CHANGE_STREAM: u8 = 0x07;
/// Segment 0x08: Attached database index.
pub const SEGMENT_ATTACHED_DB: u8 = 0x08;
/// Segment 0x09: Columnar mirror — HTAP ColumnChunks per (collection, field). [v2]
pub const SEGMENT_COLUMNAR: u8 = 0x09;
/// Segment 0x0A: Vector index — HNSW/DiskANN graph + RaBitQ codebook + SPFresh log. [v2]
pub const SEGMENT_VECTOR: u8 = 0x0A;
/// Segment 0x0B: Durable CDC log (Debezium-compatible, replayable). [v2]
pub const SEGMENT_CDC_LOG: u8 = 0x0B;
/// Segment 0x0C: Security metadata — QE schema, RLS, user/role, KMS key map. [v2]
pub const SEGMENT_SECURITY: u8 = 0x0C;
/// Segment 0x0D: AI embedding cache (content-hash → embedding). [v2]
pub const SEGMENT_EMBEDDING_CACHE: u8 = 0x0D;
/// Segment 0x0E: Zone map sketches (per-page min/max/null-count). [v2]
pub const SEGMENT_ZONE_MAP: u8 = 0x0E;
/// Segment 0x0F: Learned index model parameters (PGM++ segments). [v2]
pub const SEGMENT_LEARNED_INDEX: u8 = 0x0F;
/// Segment 0x10: OCSF-schema audit log (append-only ring buffer). [v2]
pub const SEGMENT_AUDIT_LOG: u8 = 0x10;

// ── Page Type Codes (v2) ──────────────────────────────────────────────────────

/// Page 0x01: B+ tree leaf page.
pub const PAGE_BTREE_LEAF: u8 = 0x01;
/// Page 0x02: B+ tree interior page.
pub const PAGE_BTREE_INTERIOR: u8 = 0x02;
/// Page 0x03: Overflow page (large field values).
pub const PAGE_OVERFLOW: u8 = 0x03;
/// Page 0x04: WAL record page.
pub const PAGE_WAL: u8 = 0x04;
/// Page 0x05: Free page.
pub const PAGE_FREE: u8 = 0x05;
/// Page 0x06: Blob chunk page.
pub const PAGE_BLOB_CHUNK: u8 = 0x06;
/// Page 0x07: Change stream record page.
pub const PAGE_CHANGE_STREAM: u8 = 0x07;
/// Page 0x08: Materialized view snapshot page.
pub const PAGE_VIEW_SNAPSHOT: u8 = 0x08;
/// Page 0x09: Column chunk page (HTAP columnar mirror). [v2]
pub const PAGE_COLUMN_CHUNK: u8 = 0x09;
/// Page 0x0A: Vector graph page (HNSW/DiskANN neighbor lists). [v2]
pub const PAGE_VECTOR_GRAPH: u8 = 0x0A;
/// Page 0x0B: Vector codebook page (RaBitQ quantization). [v2]
pub const PAGE_VECTOR_CODEBOOK: u8 = 0x0B;
/// Page 0x0C: CDC record page. [v2]
pub const PAGE_CDC_RECORD: u8 = 0x0C;
/// Page 0x0D: Audit log record page (OCSF JSON). [v2]
pub const PAGE_AUDIT_LOG: u8 = 0x0D;
/// Page 0x0E: Embedding cache page. [v2]
pub const PAGE_EMBEDDING_CACHE: u8 = 0x0E;
/// Page 0x0F: Zone map page (min/max sketches). [v2]
pub const PAGE_ZONE_MAP: u8 = 0x0F;
/// Page 0x10: Learned index page (PGM++ model params). [v2]
pub const PAGE_LEARNED_INDEX: u8 = 0x10;
/// Page 0x11: SSTable index block.
pub const PAGE_SSTABLE_INDEX: u8 = 0x11;
/// Page 0x12: Bloom filter page.
pub const PAGE_BLOOM_FILTER: u8 = 0x12;
/// Page 0x13: Security metadata page. [v2]
pub const PAGE_SECURITY_META: u8 = 0x13;
/// Page 0x14: Relation index page.
pub const PAGE_RELATION_INDEX: u8 = 0x14;
/// Page 0x20: Segment Directory (always Page 1).
pub const PAGE_SEGMENT_DIRECTORY: u8 = 0x20;
