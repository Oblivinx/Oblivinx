//! .OVN2 file format definitions.
//!
//! This module contains all structures and constants defining the binary
//! layout of .ovn2 database files, including the v2 file header, page headers,
//! segment types, OVN Binary Encoding v2 (OBE2) format, and the Segment Directory.

pub mod header;
pub mod obe;
pub mod page;
pub mod segment;

// ── Segment Type Codes ────────────────────────────────────────────────────────

/// Segment type codes used in the Segment Directory (Page 1).
///
/// v1 segments: 0x01–0x05 (carried forward unchanged).
/// v2 segments: 0x06–0x10 (new in v2.0 "Nova").
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SegmentType {
    // ── v1 segments (carried forward) ──────────────────────────────
    /// File header + DB metadata + collection registry.
    Header = 0x01,
    /// OBE2 document pages (row store).
    Data = 0x02,
    /// AHIT v2 index pages (ART + Learned + B+/SSTable + FTS + Geo + Vector).
    Index = 0x03,
    /// Write-ahead log records.
    Wal = 0x04,
    /// Collection schemas, statistics, pragmas, zstd dicts, relation defs.
    Metadata = 0x05,

    // ── v1 segments (extended in v2) ───────────────────────────────
    /// Blob storage (chunks > 16 MiB each at 255 KiB chunks).
    Blob = 0x06,
    /// Change Stream Log (circular buffer, in-process subscribers).
    ChangeStream = 0x07,
    /// Attached database index (alias → .ovn2 path map).
    AttachedDb = 0x08,

    // ── v2 NEW segments ─────────────────────────────────────────────
    /// Columnar mirror — ColumnChunks per (collection, field). [v2]
    Columnar = 0x09,
    /// Vector index — HNSW/DiskANN graph + RaBitQ codebook + SPFresh log. [v2]
    Vector = 0x0A,
    /// Durable CDC log (Debezium-compatible, replayable). [v2]
    CdcLog = 0x0B,
    /// Security metadata — QE schema, RLS, user/role, KMS key map. [v2]
    Security = 0x0C,
    /// AI embedding cache (content-hash → embedding). [v2]
    EmbeddingCache = 0x0D,
    /// Zone map sketches (per-page min/max/null-count). [v2]
    ZoneMap = 0x0E,
    /// Learned index model parameters (PGM++ segments). [v2]
    LearnedIndex = 0x0F,
    /// OCSF-schema audit log (append-only ring buffer). [v2]
    AuditLog = 0x10,
}

impl SegmentType {
    /// Convert a raw byte to a SegmentType, returning `None` for unknown codes.
    ///
    /// Unknown codes MUST be handled gracefully by v2 readers: skip the segment.
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x01 => Some(Self::Header),
            0x02 => Some(Self::Data),
            0x03 => Some(Self::Index),
            0x04 => Some(Self::Wal),
            0x05 => Some(Self::Metadata),
            0x06 => Some(Self::Blob),
            0x07 => Some(Self::ChangeStream),
            0x08 => Some(Self::AttachedDb),
            0x09 => Some(Self::Columnar),
            0x0A => Some(Self::Vector),
            0x0B => Some(Self::CdcLog),
            0x0C => Some(Self::Security),
            0x0D => Some(Self::EmbeddingCache),
            0x0E => Some(Self::ZoneMap),
            0x0F => Some(Self::LearnedIndex),
            0x10 => Some(Self::AuditLog),
            _ => None,
        }
    }

    /// Whether this segment type requires CRC32C page checksums.
    pub fn requires_checksum(&self) -> bool {
        !matches!(self, Self::Wal) // WAL records have their own CRC per record
    }

    /// Whether this segment is new in v2 (not present in v1 files).
    pub fn is_v2_only(&self) -> bool {
        matches!(
            self,
            Self::Columnar
                | Self::Vector
                | Self::CdcLog
                | Self::Security
                | Self::EmbeddingCache
                | Self::ZoneMap
                | Self::LearnedIndex
                | Self::AuditLog
        )
    }
}

// ── Header Flags (64-bit in v2) ───────────────────────────────────────────────

/// Flags stored in the file header at offset 0x003C (now 64-bit in v2).
///
/// v1 used 32-bit flags (bits 0–2). v2 extends to 64-bit.
/// Bits 0–7 are backward-compatible with v1 flag positions.
pub mod flags {
    // ── Bits 0–7: carried from v1 ─────────────────────────────────
    /// Bit 0: WAL is currently active (crash marker — set on open, cleared on clean close).
    pub const WAL_ACTIVE: u64 = 1 << 0;
    /// Bit 1: Per-collection AES-256-GCM encryption active.
    pub const ENCRYPTED: u64 = 1 << 1;
    /// Bit 2: Page-level compression (LZ4 or Zstd) active.
    pub const COMPRESSED: u64 = 1 << 2;
    /// Bit 3: Blob segment present.
    pub const HAS_BLOB: u64 = 1 << 3;
    /// Bit 4: Change Stream Log segment present.
    pub const HAS_CHANGE_STREAM: u64 = 1 << 4;
    /// Bit 5: Relational metadata present.
    pub const HAS_RELATIONS: u64 = 1 << 5;
    /// Bit 6: View definitions present.
    pub const HAS_VIEWS: u64 = 1 << 6;
    /// Bit 7: Trigger definitions present.
    pub const HAS_TRIGGERS: u64 = 1 << 7;

    // ── Bits 8–23: v2 NEW ──────────────────────────────────────────
    /// Bit 8: Columnar mirror segments present. [v2]
    pub const HAS_COLUMNAR: u64 = 1 << 8;
    /// Bit 9: Vector index segments present. [v2]
    pub const HAS_VECTOR: u64 = 1 << 9;
    /// Bit 10: Durable CDC log present. [v2]
    pub const HAS_CDC: u64 = 1 << 10;
    /// Bit 11: Queryable-Encryption metadata present. [v2]
    pub const HAS_QE: u64 = 1 << 11;
    /// Bit 12: Row-Level-Security policies present. [v2]
    pub const HAS_RLS: u64 = 1 << 12;
    /// Bit 13: AI Embedding Cache present. [v2]
    pub const HAS_EMBEDDING_CACHE: u64 = 1 << 13;
    /// Bit 14: AHIT Tier-1 learned-index segments present. [v2]
    pub const HAS_LEARNED_INDEX: u64 = 1 << 14;
    /// Bit 15: HLC was used for TxIDs. [v2]
    pub const HAS_HLC: u64 = 1 << 15;
    /// Bit 16: File was written with BEGIN CONCURRENT multi-writer mode. [v2]
    pub const CONCURRENT_WRITES: u64 = 1 << 16;
    /// Bit 17: Header HMAC-SHA256 present and valid. [v2]
    pub const SIGNED_RELEASE: u64 = 1 << 17;
    /// Bit 18: Zstd shared dictionary in Metadata segment.
    pub const ZSTD_DICT: u64 = 1 << 18;
    /// Bit 19: File opened with O_DIRECT (bypass OS page cache hint).
    pub const DIRECT_IO: u64 = 1 << 19;
    /// Bit 20: File lives in browser OPFS (affects fsync semantics). [v2]
    pub const WASM_OPFS: u64 = 1 << 20;
    /// Bit 21: File is cold-tiered to R2/S3 object storage. [v2]
    pub const REMOTE_BACKED: u64 = 1 << 21;
    /// Bit 22: Last checkpoint on persistent memory (PMEM/CXL). [v2]
    pub const PMEM_CHECKPOINT: u64 = 1 << 22;

    // ── Backward-compat helper ─────────────────────────────────────
    /// Read v1 flags (u32) and upgrade to v1-compatible u64 representation.
    pub fn upgrade_v1_flags(v1_flags: u32) -> u64 {
        // Bits 0–2 (WAL_ACTIVE, ENCRYPTED, COMPRESSED) are in the same positions.
        (v1_flags & 0b111) as u64
    }
}
