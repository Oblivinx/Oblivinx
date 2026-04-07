//! Database configuration.

use crate::compression::CompressionType;
use crate::{DEFAULT_BUFFER_POOL_SIZE, DEFAULT_MEMTABLE_THRESHOLD, DEFAULT_PAGE_SIZE};

/// Configuration for opening an Oblivinx3x database.
#[derive(Debug, Clone)]
pub struct OvnConfig {
    /// Page size in bytes (512–65536, default 4096)
    pub page_size: u32,
    /// Buffer pool size in bytes (default 256MB)
    pub buffer_pool_size: usize,
    /// Enable WAL for concurrent reads (default true)
    pub wal_mode: bool,
    /// Page compression type (default LZ4)
    pub compression: CompressionType,
    /// Open in read-only mode (default false)
    pub read_only: bool,
    /// MemTable flush threshold in bytes (default 64MB)
    pub memtable_threshold: usize,
    /// Maximum number of retry attempts for write conflicts (default 3)
    pub max_retry: u32,
    /// Enable group commit for WAL
    pub group_commit: bool,
}

impl Default for OvnConfig {
    fn default() -> Self {
        Self {
            page_size: DEFAULT_PAGE_SIZE,
            buffer_pool_size: DEFAULT_BUFFER_POOL_SIZE,
            wal_mode: true,
            compression: CompressionType::None, // Start with none for testing
            read_only: false,
            memtable_threshold: DEFAULT_MEMTABLE_THRESHOLD,
            max_retry: 3,
            group_commit: true,
        }
    }
}

impl OvnConfig {
    /// Create a minimal config for testing.
    pub fn test() -> Self {
        Self {
            page_size: 4096,
            buffer_pool_size: 1024 * 1024, // 1MB
            memtable_threshold: 64 * 1024, // 64KB
            ..Default::default()
        }
    }
}
