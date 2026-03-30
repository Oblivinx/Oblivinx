//! .OVN file format definitions.
//!
//! This module contains all structures and constants defining the binary
//! layout of .ovn database files, including the file header, page headers,
//! segment types, and the OVN Binary Encoding (OBE) format.

pub mod header;
pub mod page;
pub mod obe;

/// Segment type codes used in the Segment Directory (Page 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum SegmentType {
    /// File header, database metadata, collection registry
    Header = 0x01,
    /// Document pages, overflow pages
    Data = 0x02,
    /// B+ tree index pages, SSTable index blocks
    Index = 0x03,
    /// Write-ahead log records, transaction journal
    Wal = 0x04,
    /// Collection schemas, statistics, version history
    Metadata = 0x05,
}

impl SegmentType {
    /// Convert a raw byte to a SegmentType, returning None for unknown values.
    pub fn from_byte(b: u8) -> Option<Self> {
        match b {
            0x01 => Some(Self::Header),
            0x02 => Some(Self::Data),
            0x03 => Some(Self::Index),
            0x04 => Some(Self::Wal),
            0x05 => Some(Self::Metadata),
            _ => None,
        }
    }
}

/// Flags stored in the file header (Offset 0x003C).
pub mod flags {
    /// WAL is currently active (unclean shutdown if set on open)
    pub const WAL_ACTIVE: u32 = 1 << 0;
    /// Database file is encrypted
    pub const ENCRYPTED: u32 = 1 << 1;
    /// Page-level compression is enabled
    pub const COMPRESSED: u32 = 1 << 2;
}
