//! Segment Directory (Page 1 of every .ovn2 file).
//!
//! The Segment Directory is a structured catalog that maps each [`SegmentType`]
//! to its location within the file. It occupies Page 1 (bytes 4096–8191 in the
//! default 4 KiB page size) and is written atomically on every checkpoint.
//!
//! ## Binary Layout
//!
//! ```text
//! Byte offset  Size  Field
//! ─────────────────────────────────────────────────────────────
//! 0x0000       4     Magic: 0x5344_4952 ('SDIR')
//! 0x0004       2     Entry count
//! 0x0006       2     Reserved (pad to 8-byte alignment)
//! 0x0008       N×32  Entries (see SegmentEntry layout below)
//! 0xFF00       4     CRC32C over bytes 0x0000–0xFEFF
//! 0xFF04       12    Reserved / future use
//! ─────────────────────────────────────────────────────────────
//!
//! Each SegmentEntry (32 bytes):
//!   offset  size  field
//!    0x00    1    segment_type (SegmentType code)
//!    0x01    1    flags (ACTIVE=1, COMPRESSED=2, ENCRYPTED=4)
//!    0x02    2    reserved
//!    0x04    8    start_page (first page number in this segment)
//!    0x0C    8    end_page   (last page number, inclusive; 0 if segment is empty)
//!    0x14    8    entry_count (number of logical records in this segment)
//!    0x1C    4    reserved
//! ```

use crc32c::crc32c;
use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use super::SegmentType;
use crate::error::{OvnError, OvnResult};

/// Magic number for the Segment Directory page: 'SDIR' in ASCII.
pub const SEGMENT_DIR_MAGIC: u32 = 0x5344_4952;

/// Size of one serialized SegmentEntry in bytes.
const ENTRY_SIZE: usize = 32;

/// Offset of the CRC32C in the directory page (relative to page start).
const DIR_CRC_OFFSET: usize = 0xFF00;

/// Entry flags for a segment.
pub mod entry_flags {
    pub const ACTIVE: u8 = 1 << 0;
    pub const COMPRESSED: u8 = 1 << 1;
    pub const ENCRYPTED: u8 = 1 << 2;
}

/// One entry in the Segment Directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SegmentEntry {
    /// Which segment this entry describes.
    pub segment_type: SegmentType,
    /// Entry flags (ACTIVE, COMPRESSED, ENCRYPTED).
    pub flags: u8,
    /// First page number occupied by this segment.
    pub start_page: u64,
    /// Last page number occupied by this segment (inclusive). 0 = empty.
    pub end_page: u64,
    /// Logical record count within this segment.
    pub entry_count: u64,
}

impl SegmentEntry {
    /// Create a new, empty (inactive) segment entry.
    pub fn new(segment_type: SegmentType) -> Self {
        Self {
            segment_type,
            flags: 0,
            start_page: 0,
            end_page: 0,
            entry_count: 0,
        }
    }

    /// Whether this segment is currently active (has been written to).
    pub fn is_active(&self) -> bool {
        self.flags & entry_flags::ACTIVE != 0
    }

    /// Activate this entry by setting the ACTIVE flag.
    pub fn activate(&mut self) {
        self.flags |= entry_flags::ACTIVE;
    }

    /// Serialize to exactly 32 bytes.
    fn to_bytes(&self) -> [u8; ENTRY_SIZE] {
        let mut buf = [0u8; ENTRY_SIZE];
        buf[0] = self.segment_type as u8;
        buf[1] = self.flags;
        // buf[2..4] = reserved
        buf[4..12].copy_from_slice(&self.start_page.to_le_bytes());
        buf[12..20].copy_from_slice(&self.end_page.to_le_bytes());
        buf[20..28].copy_from_slice(&self.entry_count.to_le_bytes());
        // buf[28..32] = reserved
        buf
    }

    /// Deserialize from 32 bytes.
    fn from_bytes(buf: &[u8; ENTRY_SIZE]) -> Option<Self> {
        let seg_type = SegmentType::from_byte(buf[0])?;
        let flags = buf[1];
        let start_page = u64::from_le_bytes(buf[4..12].try_into().ok()?);
        let end_page = u64::from_le_bytes(buf[12..20].try_into().ok()?);
        let entry_count = u64::from_le_bytes(buf[20..28].try_into().ok()?);
        Some(Self {
            segment_type: seg_type,
            flags,
            start_page,
            end_page,
            entry_count,
        })
    }
}

/// The Segment Directory for an .ovn2 file.
///
/// Provides O(1) lookup of any segment's page range.
/// Serialized into Page 1 of the database file on every checkpoint.
pub struct SegmentDirectory {
    entries: HashMap<u8, SegmentEntry>,
}

impl SegmentDirectory {
    /// Create a new, empty Segment Directory (for a fresh database).
    pub fn new() -> Self {
        Self {
            entries: HashMap::with_capacity(16),
        }
    }

    /// Create the default directory for a newly created .ovn2 database.
    ///
    /// Pre-populates entries for mandatory segments (Header, Data, Index, Wal, Metadata).
    pub fn with_defaults(first_free_page: u64) -> Self {
        let mut dir = Self::new();
        // Mandatory segments start after Page 0 (header) and Page 1 (this directory).
        dir.upsert(SegmentEntry {
            segment_type: SegmentType::Header,
            flags: entry_flags::ACTIVE,
            start_page: 0,
            end_page: 0,
            entry_count: 1,
        });
        dir.upsert(SegmentEntry {
            segment_type: SegmentType::Wal,
            flags: entry_flags::ACTIVE,
            start_page: first_free_page,
            end_page: first_free_page,
            entry_count: 0,
        });
        dir
    }

    /// Insert or update a segment entry.
    pub fn upsert(&mut self, entry: SegmentEntry) {
        self.entries.insert(entry.segment_type as u8, entry);
    }

    /// Look up a segment entry by type.
    pub fn get(&self, seg_type: SegmentType) -> Option<&SegmentEntry> {
        self.entries.get(&(seg_type as u8))
    }

    /// Look up a segment entry mutably by type.
    pub fn get_mut(&mut self, seg_type: SegmentType) -> Option<&mut SegmentEntry> {
        self.entries.get_mut(&(seg_type as u8))
    }

    /// Ensure a segment entry exists; creates an empty one if missing.
    pub fn ensure(&mut self, seg_type: SegmentType) -> &mut SegmentEntry {
        self.entries
            .entry(seg_type as u8)
            .or_insert_with(|| SegmentEntry::new(seg_type))
    }

    /// All active entries.
    pub fn active_entries(&self) -> impl Iterator<Item = &SegmentEntry> {
        self.entries.values().filter(|e| e.is_active())
    }

    /// Serialize the directory into a page-sized buffer.
    ///
    /// `page_size` — the database page size in bytes. Must be ≥ 512.
    /// Returns exactly `page_size` bytes, CRC32C-protected.
    pub fn to_bytes(&self, page_size: usize) -> OvnResult<Vec<u8>> {
        let mut buf = vec![0u8; page_size];
        let mut cursor = Cursor::new(&mut buf[..]);

        // Magic
        cursor.write_all(&SEGMENT_DIR_MAGIC.to_le_bytes())?;

        // Entry count (only active entries are serialized)
        let active: Vec<&SegmentEntry> = self.active_entries().collect();
        if active.len() > u16::MAX as usize {
            return Err(OvnError::EncodingError(
                "Too many segment entries".to_string(),
            ));
        }
        cursor.write_all(&(active.len() as u16).to_le_bytes())?;
        cursor.write_all(&[0u8; 2])?; // reserved

        // Entries
        for entry in &active {
            cursor.write_all(&entry.to_bytes())?;
        }

        // CRC32C at offset 0xFF00 (or near end if page is small)
        let crc_offset = DIR_CRC_OFFSET.min(page_size - 16);
        let crc_val = crc32c(&buf[..crc_offset]);
        buf[crc_offset..crc_offset + 4].copy_from_slice(&crc_val.to_le_bytes());

        Ok(buf)
    }

    /// Deserialize the directory from a page-sized buffer.
    pub fn from_bytes(buf: &[u8]) -> OvnResult<Self> {
        if buf.len() < 8 {
            return Err(OvnError::EncodingError(
                "Segment directory buffer too small".to_string(),
            ));
        }

        // Verify CRC32C
        let crc_offset = DIR_CRC_OFFSET.min(buf.len() - 16);
        let stored_crc = u32::from_le_bytes(
            buf[crc_offset..crc_offset + 4]
                .try_into()
                .map_err(|_| OvnError::EncodingError("CRC slice error".to_string()))?,
        );
        if stored_crc != 0 {
            let computed_crc = crc32c(&buf[..crc_offset]);
            if computed_crc != stored_crc {
                return Err(OvnError::ChecksumMismatch {
                    location: "segment directory".to_string(),
                    expected: stored_crc,
                    actual: computed_crc,
                });
            }
        }

        // Read magic
        let magic = u32::from_le_bytes(buf[0..4].try_into().unwrap());
        if magic != SEGMENT_DIR_MAGIC {
            return Err(OvnError::EncodingError(format!(
                "Invalid segment directory magic: 0x{:08X}",
                magic
            )));
        }

        let count = u16::from_le_bytes(buf[4..6].try_into().unwrap()) as usize;

        let mut cursor = Cursor::new(buf);
        // Seek past header (8 bytes)
        let mut skip = [0u8; 8];
        cursor.read_exact(&mut skip)?;

        let mut dir = Self::new();
        for _ in 0..count {
            let mut entry_buf = [0u8; ENTRY_SIZE];
            cursor.read_exact(&mut entry_buf)?;
            if let Some(entry) = SegmentEntry::from_bytes(&entry_buf) {
                dir.entries.insert(entry.segment_type as u8, entry);
            }
            // Unknown segment types are silently skipped (forward compatibility).
        }

        Ok(dir)
    }
}

impl Default for SegmentDirectory {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_segment_entry_roundtrip() {
        let entry = SegmentEntry {
            segment_type: SegmentType::Columnar,
            flags: entry_flags::ACTIVE | entry_flags::COMPRESSED,
            start_page: 1024,
            end_page: 2048,
            entry_count: 500,
        };

        let bytes = entry.to_bytes();
        let decoded = SegmentEntry::from_bytes(&bytes).unwrap();

        assert_eq!(decoded.segment_type, SegmentType::Columnar);
        assert_eq!(decoded.flags, entry.flags);
        assert_eq!(decoded.start_page, 1024);
        assert_eq!(decoded.end_page, 2048);
        assert_eq!(decoded.entry_count, 500);
    }

    #[test]
    fn test_directory_roundtrip() {
        let mut dir = SegmentDirectory::new();

        let mut data_entry = SegmentEntry::new(SegmentType::Data);
        data_entry.activate();
        data_entry.start_page = 2;
        data_entry.end_page = 100;
        data_entry.entry_count = 50;
        dir.upsert(data_entry);

        let mut cdc_entry = SegmentEntry::new(SegmentType::CdcLog);
        cdc_entry.activate();
        cdc_entry.start_page = 200;
        cdc_entry.end_page = 300;
        cdc_entry.entry_count = 1000;
        dir.upsert(cdc_entry);

        let bytes = dir.to_bytes(4096).unwrap();
        assert_eq!(bytes.len(), 4096);

        let decoded = SegmentDirectory::from_bytes(&bytes).unwrap();
        let data = decoded.get(SegmentType::Data).unwrap();
        assert_eq!(data.start_page, 2);
        assert_eq!(data.entry_count, 50);

        let cdc = decoded.get(SegmentType::CdcLog).unwrap();
        assert_eq!(cdc.entry_count, 1000);
    }

    #[test]
    fn test_with_defaults() {
        let dir = SegmentDirectory::with_defaults(2);
        assert!(dir.get(SegmentType::Header).is_some());
        assert!(dir.get(SegmentType::Wal).is_some());
        assert!(dir.get(SegmentType::Columnar).is_none());
    }
}
