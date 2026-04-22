//! Database configuration (v2.0 "Nova").

use crate::compression::CompressionType;
use crate::{
    DEFAULT_BUFFER_POOL_SIZE, DEFAULT_GROUP_COMMIT_BYTES, DEFAULT_GROUP_COMMIT_US,
    DEFAULT_MAX_RETRIES, DEFAULT_MEMTABLE_THRESHOLD, DEFAULT_PAGE_SIZE,
};

// ── Durability Level ──────────────────────────────────────────────────────────

/// WAL durability guarantee level.
///
/// | Level       | Behavior                                          | Risk on crash  |
/// |-------------|---------------------------------------------------|----------------|
/// | `D0`        | No fsync. OS crash may lose committed data.       | Data loss       |
/// | `D1`        | Group commit: fsync batched (default, 200µs).     | Up to 200µs     |
/// | `D1Strict`  | fsync after every commit group.                   | Zero            |
/// | `D2`        | fdatasync+fsync on every single commit.           | Zero (slowest)  |
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurabilityLevel {
    /// No fsync — maximum throughput, risk of data loss on OS crash.
    D0,
    /// Group commit (default): batch multiple commits into one fsync call.
    D1,
    /// Group commit with strict per-group fsync.
    D1Strict,
    /// Per-commit fdatasync — maximum durability, minimum throughput.
    D2,
}

impl Default for DurabilityLevel {
    fn default() -> Self {
        Self::D1
    }
}

/// I/O backend preference. Actual selection is platform-dependent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoEngineHint {
    /// Use the platform default (io_uring on Linux, IOCP on Windows).
    Auto,
    /// Force synchronous I/O via std::fs. Portable.
    Sync,
}

impl Default for IoEngineHint {
    fn default() -> Self {
        Self::Auto
    }
}

// ── OvnConfig ─────────────────────────────────────────────────────────────────

/// Configuration for opening an Oblivinx3x v2 database.
#[derive(Debug, Clone)]
pub struct OvnConfig {
    // ── Core ─────────────────────────────────────────────────────
    /// Page size in bytes (512–65536, power of 2). Default: 4096.
    pub page_size: u32,
    /// Buffer pool size in bytes. Default: 256 MiB. Uses ARC algorithm.
    pub buffer_pool_size: usize,
    /// MemTable flush threshold. Default: 64 MiB.
    pub memtable_threshold: usize,
    /// Read-only mode. Auto-set to true for v1 (.ovn) files.
    pub read_only: bool,

    // ── WAL & Durability ─────────────────────────────────────────
    /// Enable WAL mode. Default: true.
    pub wal_mode: bool,
    /// WAL durability level. Default: D1.
    pub durability: DurabilityLevel,
    /// Max bytes per group commit batch. Default: 1 MiB.
    pub group_commit_bytes: usize,
    /// Max microseconds before flushing group commit. Default: 200µs.
    pub group_commit_us: u64,

    // ── Concurrency ───────────────────────────────────────────────
    /// Enable BEGIN CONCURRENT multi-writer MVCC. Default: false.
    pub concurrent_writes: bool,
    /// Max retry attempts on WRITE_CONFLICT. Default: 8.
    pub max_retries: u32,
    /// Enable Hybrid Logical Clock for TxIDs. Default: true.
    pub hlc_enabled: bool,

    // ── I/O ──────────────────────────────────────────────────────
    /// I/O engine preference. Default: Auto.
    pub io_engine: IoEngineHint,
    /// Enable O_DIRECT (bypass OS page cache). Default: false.
    pub direct_io: bool,

    // ── Compression ───────────────────────────────────────────────
    /// Page compression algorithm. Default: None.
    pub compression: CompressionType,

    // ── Legacy compat ────────────────────────────────────────────
    /// Deprecated: use `durability`. Kept for API compat.
    pub group_commit: bool,
    /// Deprecated: use `max_retries`. Kept for API compat.
    pub max_retry: u32,
}

impl Default for OvnConfig {
    fn default() -> Self {
        Self {
            page_size: DEFAULT_PAGE_SIZE,
            buffer_pool_size: DEFAULT_BUFFER_POOL_SIZE,
            memtable_threshold: DEFAULT_MEMTABLE_THRESHOLD,
            read_only: false,
            wal_mode: true,
            durability: DurabilityLevel::D1,
            group_commit_bytes: DEFAULT_GROUP_COMMIT_BYTES,
            group_commit_us: DEFAULT_GROUP_COMMIT_US,
            concurrent_writes: false,
            max_retries: DEFAULT_MAX_RETRIES,
            hlc_enabled: true,
            io_engine: IoEngineHint::Auto,
            direct_io: false,
            compression: CompressionType::None,
            group_commit: true,
            max_retry: DEFAULT_MAX_RETRIES,
        }
    }
}

impl OvnConfig {
    /// Minimal config for unit tests.
    pub fn test() -> Self {
        Self {
            page_size: 4096,
            buffer_pool_size: 1024 * 1024,
            memtable_threshold: 64 * 1024,
            durability: DurabilityLevel::D0,
            hlc_enabled: false,
            ..Default::default()
        }
    }

    /// Whether group commit is active.
    pub fn is_group_commit(&self) -> bool {
        matches!(self.durability, DurabilityLevel::D1 | DurabilityLevel::D1Strict)
    }

    /// Whether fsync is required on every commit (or commit group).
    pub fn needs_fsync_on_commit(&self) -> bool {
        matches!(self.durability, DurabilityLevel::D1Strict | DurabilityLevel::D2)
    }
}
