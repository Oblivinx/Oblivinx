//! Error types for the Oblivinx3x storage engine.
//!
//! All errors are centralized here using `thiserror` for ergonomic error handling.
//! The [`OvnError`] enum covers all failure modes across storage, encoding,
//! transaction, and query layers.

use thiserror::Error;

/// Central result type for all Oblivinx3x operations.
pub type OvnResult<T> = Result<T, OvnError>;

/// Comprehensive error type covering all failure modes in the database engine.
#[derive(Error, Debug)]
pub enum OvnError {
    // ── I/O Errors ─────────────────────────────────────────────
    /// File system I/O failure
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    // ── Format / Corruption Errors ─────────────────────────────
    /// The .ovn file has an invalid magic number
    #[error("Invalid magic number: expected 0x4F564E58, got 0x{0:08X}")]
    InvalidMagic(u32),

    /// CRC32 checksum mismatch indicating data corruption
    #[error("Checksum mismatch on {location}: expected 0x{expected:08X}, got 0x{actual:08X}")]
    ChecksumMismatch {
        location: String,
        expected: u32,
        actual: u32,
    },

    /// Page corruption detected
    #[error("Page {page_number} is corrupted: {reason}")]
    PageCorrupted { page_number: u64, reason: String },

    /// Unsupported format version
    #[error("Unsupported format version {major}.{minor}")]
    UnsupportedVersion { major: u16, minor: u16 },

    // ── Encoding Errors ────────────────────────────────────────
    /// OBE encoding/decoding failure
    #[error("OBE encoding error: {0}")]
    EncodingError(String),

    /// Unknown type tag encountered during OBE decoding
    #[error("Unknown OBE type tag: 0x{0:02X}")]
    UnknownTypeTag(u8),

    /// Document exceeds maximum allowed size
    #[error("Document size {size} exceeds maximum {max}")]
    DocumentTooLarge { size: usize, max: usize },

    /// Varint encoding overflow
    #[error("Varint overflow: value too large for LEB128 encoding")]
    VarintOverflow,

    // ── Storage Engine Errors ──────────────────────────────────
    /// Buffer pool is full and cannot evict any pages
    #[error("Buffer pool exhausted: all {capacity} pages are pinned")]
    BufferPoolExhausted { capacity: usize },

    /// WAL record is invalid or truncated
    #[error("WAL record corrupted at offset {offset}: {reason}")]
    WalCorrupted { offset: u64, reason: String },

    /// B+ tree structural error
    #[error("B+ tree error: {0}")]
    BTreeError(String),

    /// SSTable format error
    #[error("SSTable error: {0}")]
    SSTableError(String),

    /// MemTable is full and waiting for flush
    #[error("MemTable threshold reached ({size} bytes), write throttled")]
    MemTableFull { size: usize },

    // ── Transaction / MVCC Errors ──────────────────────────────
    /// Write-write conflict detected during optimistic validation
    #[error("Write conflict on document {doc_id} between tx {winner_txid} and tx {loser_txid}")]
    WriteConflict {
        doc_id: String,
        winner_txid: u64,
        loser_txid: u64,
    },

    /// Transaction was aborted due to serialization failure
    #[error("Transaction {txid} aborted: {reason}")]
    TransactionAborted { txid: u64, reason: String },

    /// Snapshot is no longer valid (GC purged referenced versions)
    #[error("Snapshot {snapshot_txid} expired: versions have been garbage collected")]
    SnapshotExpired { snapshot_txid: u64 },

    // ── Collection Errors ──────────────────────────────────────
    /// Collection not found
    #[error("Collection '{name}' not found")]
    CollectionNotFound { name: String },

    /// Collection already exists
    #[error("Collection '{name}' already exists")]
    CollectionAlreadyExists { name: String },

    // ── Query Errors ───────────────────────────────────────────
    /// MQL query syntax error
    #[error("Query syntax error at position {position}: {message}")]
    QuerySyntaxError { position: usize, message: String },

    /// Unknown query operator
    #[error("Unknown operator: {0}")]
    UnknownOperator(String),

    /// Invalid query plan
    #[error("Query plan error: {0}")]
    QueryPlanError(String),

    // ── Index Errors ───────────────────────────────────────────
    /// Index not found
    #[error("Index '{name}' not found on collection '{collection}'")]
    IndexNotFound { name: String, collection: String },

    /// Index already exists
    #[error("Index '{name}' already exists on collection '{collection}'")]
    IndexAlreadyExists { name: String, collection: String },

    // ── Schema Validation Errors ───────────────────────────────
    /// Document does not match collection's JSON schema
    #[error("Document validation failed: {0}")]
    ValidationError(String),

    // ── Configuration Errors ───────────────────────────────────
    /// Invalid configuration parameter
    #[error("Invalid configuration: {0}")]
    InvalidConfig(String),

    /// Database is opened in read-only mode
    #[error("Database is read-only")]
    ReadOnly,

    /// Database is already closed
    #[error("Database is closed")]
    DatabaseClosed,

    // ── Compression Errors ─────────────────────────────────────
    /// Compression/decompression failure
    #[error("Compression error: {0}")]
    CompressionError(String),

    // ── Serialization Errors ───────────────────────────────────
    /// JSON serialization/deserialization error
    #[error("JSON error: {0}")]
    JsonError(#[from] serde_json::Error),
}
