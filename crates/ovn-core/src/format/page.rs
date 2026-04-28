//! Page header and page type definitions — v2.0 Nova.
//!
//! Every page in a .ovn2 file (except Page 0 and WAL records) begins with a
//! 64-byte **page header** that the buffer pool inspects without parsing the body.
//!
//! ## Page Header Layout (64 bytes) — spec `[[FILE-01]]` §4
//!
//! | Offset | Size | Field                                        |
//! |--------|------|----------------------------------------------|
//! | 0x00   |  1   | magic_byte (0x6F = ASCII 'o')                |
//! | 0x01   |  1   | page_type                                    |
//! | 0x02   |  2   | flags (compressed, encrypted, dirty-shadow…) |
//! | 0x04   |  4   | page_lsn_low (low 32 bits of WAL LSN)        |
//! | 0x08   |  8   | page_id (own page number)                    |
//! | 0x10   |  8   | next_page (overflow/freelist/sibling)         |
//! | 0x18   |  8   | prev_page (B+ leaf sibling, oplog prev)      |
//! | 0x20   |  8   | parent_page (B+ Tree parent; 0 if root)      |
//! | 0x28   |  4   | payload_len (used bytes in payload region)    |
//! | 0x2C   |  4   | free_offset (first free byte for slot layout) |
//! | 0x30   |  4   | record_count (keys / docs / overflow chunks)  |
//! | 0x34   |  4   | checksum (CRC-32C of bytes 64..PAGE_SIZE)     |
//! | 0x38   |  4   | encryption_tag_offset (or 0)                  |
//! | 0x3C   |  4   | full_lsn_high (top 32 bits of page_lsn)       |
//! | 0x40   |      | payload…                                      |
//!
//! Total header = **64 bytes**. Fixed; no future expansion.

use crc32c::crc32c;
use std::io::{Cursor, Read, Write};

use crate::error::{OvnError, OvnResult};

/// Size of the page header in bytes (v2: 64 bytes per spec §4).
pub const PAGE_HEADER_SIZE: usize = 64;

/// Magic byte at offset 0 of every data page.
pub const PAGE_MAGIC_BYTE: u8 = 0x6F; // ASCII 'o'

/// Page flag: payload is compressed.
pub const PAGE_FLAG_COMPRESSED: u16 = 1 << 0;
/// Page flag: payload is encrypted.
pub const PAGE_FLAG_ENCRYPTED: u16 = 1 << 1;
/// Page flag: dirty-on-disk shadow.
pub const PAGE_FLAG_DIRTY_SHADOW: u16 = 1 << 2;
/// Page flag: is root of a B+ tree.
pub const PAGE_FLAG_IS_ROOT: u16 = 1 << 3;

/// Minimum usable payload size given header overhead.
pub const fn payload_size(page_size: u32) -> u32 {
    page_size - PAGE_HEADER_SIZE as u32
}

/// Page type identifiers — spec `[[FILE-01]]` §4.1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum PageType {
    /// B+ tree leaf page containing document slots.
    Leaf = 0x02,
    /// B+ tree interior page containing key-pointer pairs.
    Interior = 0x01,
    /// Overflow page for large documents spanning multiple pages.
    Overflow = 0x03,
    /// Freelist leaf (chain of free page ids).
    FreelistLeaf = 0x04,
    /// Freelist trunk (intermediate freelist page).
    FreelistTrunk = 0x05,
    /// Document heap (slotted page for variable-length docs).
    DocumentHeap = 0x06,
    /// Oplog page (append-only log of operations).
    Oplog = 0x07,
    /// FTS posting list page.
    FtsPosting = 0x08,
    /// HNSW vector graph node page.
    VectorGraph = 0x09,
    /// Arrow-style column chunk for HTAP mirror.
    ColumnChunk = 0x0A,
    /// R*-tree geo node.
    GeoRtreeNode = 0x0B,
    /// Hash bucket index.
    HashBucket = 0x0C,
    /// Bloom filter page.
    BloomFilter = 0x0D,
    /// Bitmap free-space tracker.
    BitmapFreespace = 0x0E,
    /// Audit log page.
    AuditLog = 0x0F,
    /// Schema dictionary page.
    SchemaDict = 0x10,
    /// Learned index model parameters.
    LearnedIndex = 0x11,
    /// Profile log page.
    ProfileLog = 0x12,
    /// WAL record page.
    Wal = 0x14,
    /// Blob chunk page.
    BlobChunk = 0x16,
    /// Change stream record page.
    ChangeStreamRecord = 0x17,
    /// Segment directory page (always Page 1).
    SegmentDirectory = 0x20,
    /// Metadata page (collection schemas, statistics).
    Metadata = 0x30,
    /// SSTable index block.
    SstableIndex = 0x31,
    /// Freed but not yet on freelist (transient).
    Free = 0xFE,
    /// Zeroed / unused page.
    Unused = 0xFF,
}

impl PageType {
    /// Convert a raw u8 to a PageType.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0x01 => Some(Self::Interior),
            0x02 => Some(Self::Leaf),
            0x03 => Some(Self::Overflow),
            0x04 => Some(Self::FreelistLeaf),
            0x05 => Some(Self::FreelistTrunk),
            0x06 => Some(Self::DocumentHeap),
            0x07 => Some(Self::Oplog),
            0x08 => Some(Self::FtsPosting),
            0x09 => Some(Self::VectorGraph),
            0x0A => Some(Self::ColumnChunk),
            0x0B => Some(Self::GeoRtreeNode),
            0x0C => Some(Self::HashBucket),
            0x0D => Some(Self::BloomFilter),
            0x0E => Some(Self::BitmapFreespace),
            0x0F => Some(Self::AuditLog),
            0x10 => Some(Self::SchemaDict),
            0x11 => Some(Self::LearnedIndex),
            0x12 => Some(Self::ProfileLog),
            0x14 => Some(Self::Wal),
            0x16 => Some(Self::BlobChunk),
            0x17 => Some(Self::ChangeStreamRecord),
            0x20 => Some(Self::SegmentDirectory),
            0x30 => Some(Self::Metadata),
            0x31 => Some(Self::SstableIndex),
            0xFE => Some(Self::Free),
            0xFF => Some(Self::Unused),
            _ => None,
        }
    }

    /// Convert a raw u32 to a PageType (legacy compat with old code).
    pub fn from_u32(v: u32) -> Option<Self> {
        if v <= 0xFF {
            Self::from_u8(v as u8)
        } else {
            None
        }
    }
}

/// The 64-byte header present at the start of every page — spec `[[FILE-01]]` §4.
#[derive(Debug, Clone, Copy)]
pub struct PageHeader {
    /// Magic byte: 0x6F (ASCII 'o') for all data pages.
    pub magic_byte: u8,
    /// Type of this page (u8 discriminant).
    pub page_type: PageType,
    /// Page flags (compressed, encrypted, dirty-shadow, is-root).
    pub flags: u16,
    /// Low 32 bits of the WAL LSN at last write.
    pub page_lsn_low: u32,
    /// Own page id (= page_number; page_id × PAGE_SIZE = file offset).
    pub page_id: u64,
    /// Next page: overflow chain, freelist next, B+ leaf right sibling.
    pub next_page: u64,
    /// Previous page: B+ leaf left sibling, oplog prev.
    pub prev_page: u64,
    /// Parent page in B+ tree (0 if root).
    pub parent_page: u64,
    /// Bytes used in the payload region.
    pub payload_len: u32,
    /// Offset of first free byte (slot-and-data layout).
    pub free_offset: u32,
    /// Number of records (B+ keys / leaf docs / overflow chunks).
    pub record_count: u32,
    /// CRC-32C of bytes 64..PAGE_SIZE (0 = uncomputed).
    pub checksum: u32,
    /// Offset of encryption tag within page (0 = not encrypted).
    pub encryption_tag_offset: u32,
    /// High 32 bits of page_lsn (combined with page_lsn_low for full 64-bit LSN).
    pub full_lsn_high: u32,

    // ── Derived / runtime fields (not serialized into the 64-byte header) ──
    // Kept for backwards compatibility with existing engine code.
    /// Legacy: zero-indexed page number alias (= page_id).
    #[doc(hidden)]
    pub page_number: u64,
    /// Legacy: transaction ID that last modified this page.
    pub txid: u64,
    /// Legacy: slot count alias (= record_count as u16, truncated).
    pub slot_count: u16,
    /// Legacy: free space offset alias (= free_offset as u16, truncated).
    pub free_space_offset: u16,
    /// Legacy: right sibling alias (= next_page as u32, truncated).
    pub right_sibling: u32,
    /// Legacy: CRC32 alias (= checksum).
    pub crc32: u32,
}

impl PageHeader {
    /// Create a new page header with the spec-compliant 64-byte layout.
    pub fn new(page_type: PageType, page_number: u64) -> Self {
        Self {
            magic_byte: PAGE_MAGIC_BYTE,
            page_type,
            flags: 0,
            page_lsn_low: 0,
            page_id: page_number,
            next_page: 0,
            prev_page: 0,
            parent_page: 0,
            payload_len: 0,
            free_offset: 0,
            record_count: 0,
            checksum: 0,
            encryption_tag_offset: 0,
            full_lsn_high: 0,
            // Legacy aliases
            page_number,
            txid: 0,
            slot_count: 0,
            free_space_offset: 0,
            right_sibling: 0,
            crc32: 0,
        }
    }

    /// Full 64-bit LSN combining low and high parts.
    pub fn full_lsn(&self) -> u64 {
        ((self.full_lsn_high as u64) << 32) | (self.page_lsn_low as u64)
    }

    /// Set the full 64-bit LSN, splitting into low and high parts.
    pub fn set_full_lsn(&mut self, lsn: u64) {
        self.page_lsn_low = lsn as u32;
        self.full_lsn_high = (lsn >> 32) as u32;
    }

    /// Serialize the page header to exactly 64 bytes (spec §4 format).
    pub fn to_bytes(&self) -> [u8; PAGE_HEADER_SIZE] {
        let mut buf = [0u8; PAGE_HEADER_SIZE];
        let mut cursor = Cursor::new(&mut buf[..]);

        cursor.write_all(&[self.magic_byte]).unwrap(); //  0: 1
        cursor.write_all(&[self.page_type as u8]).unwrap(); //  1: 1
        cursor.write_all(&self.flags.to_le_bytes()).unwrap(); //  2: 2
        cursor.write_all(&self.page_lsn_low.to_le_bytes()).unwrap(); //  4: 4
        cursor.write_all(&self.page_id.to_le_bytes()).unwrap(); //  8: 8
        cursor.write_all(&self.next_page.to_le_bytes()).unwrap(); // 16: 8
        cursor.write_all(&self.prev_page.to_le_bytes()).unwrap(); // 24: 8
        cursor.write_all(&self.parent_page.to_le_bytes()).unwrap(); // 32: 8
        cursor.write_all(&self.payload_len.to_le_bytes()).unwrap(); // 40: 4
        cursor.write_all(&self.free_offset.to_le_bytes()).unwrap(); // 44: 4
        cursor.write_all(&self.record_count.to_le_bytes()).unwrap(); // 48: 4
        cursor.write_all(&self.checksum.to_le_bytes()).unwrap(); // 52: 4
        cursor
            .write_all(&self.encryption_tag_offset.to_le_bytes())
            .unwrap(); // 56: 4
        cursor.write_all(&self.full_lsn_high.to_le_bytes()).unwrap(); // 60: 4
                                                                      // Total: 64 bytes

        buf
    }

    /// Deserialize a page header from a byte slice (must be ≥ 64 bytes).
    pub fn from_bytes(buf: &[u8]) -> OvnResult<Self> {
        if buf.len() < PAGE_HEADER_SIZE {
            return Err(OvnError::EncodingError(format!(
                "Page header buffer too small: {} bytes (need {})",
                buf.len(),
                PAGE_HEADER_SIZE
            )));
        }

        let magic_byte = buf[0];
        // Accept both the v2 magic byte (0x6F) and 0x00 (zeroed page)
        // For non-zero pages, validate the magic byte
        if magic_byte != PAGE_MAGIC_BYTE && magic_byte != 0x00 {
            // Also accept legacy page type bytes for backward compatibility
            // (old format stored page_type at offset 0 as u32)
        }

        let page_type_raw = buf[1];
        let page_type = PageType::from_u8(page_type_raw).unwrap_or_else(|| {
            // Fallback: try interpreting the first 4 bytes as a legacy u32 page type
            let legacy_type = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]);
            PageType::from_u32(legacy_type).unwrap_or(PageType::Unused)
        });

        let mut cursor = Cursor::new(&buf[2..]);
        let mut tmp2 = [0u8; 2];
        let mut tmp4 = [0u8; 4];
        let mut tmp8 = [0u8; 8];

        cursor.read_exact(&mut tmp2)?;
        let flags = u16::from_le_bytes(tmp2);

        cursor.read_exact(&mut tmp4)?;
        let page_lsn_low = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp8)?;
        let page_id = u64::from_le_bytes(tmp8);

        cursor.read_exact(&mut tmp8)?;
        let next_page = u64::from_le_bytes(tmp8);

        cursor.read_exact(&mut tmp8)?;
        let prev_page = u64::from_le_bytes(tmp8);

        cursor.read_exact(&mut tmp8)?;
        let parent_page = u64::from_le_bytes(tmp8);

        cursor.read_exact(&mut tmp4)?;
        let payload_len = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp4)?;
        let free_offset = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp4)?;
        let record_count = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp4)?;
        let checksum = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp4)?;
        let encryption_tag_offset = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp4)?;
        let full_lsn_high = u32::from_le_bytes(tmp4);

        Ok(Self {
            magic_byte,
            page_type,
            flags,
            page_lsn_low,
            page_id,
            next_page,
            prev_page,
            parent_page,
            payload_len,
            free_offset,
            record_count,
            checksum,
            encryption_tag_offset,
            full_lsn_high,
            // Legacy aliases
            page_number: page_id,
            txid: ((full_lsn_high as u64) << 32) | (page_lsn_low as u64),
            slot_count: record_count as u16,
            free_space_offset: free_offset as u16,
            right_sibling: next_page as u32,
            crc32: checksum,
        })
    }

    /// Compute the CRC-32C of a payload and update `self.checksum`.
    pub fn compute_crc(&mut self, payload: &[u8]) {
        self.checksum = crc32c(payload);
        self.crc32 = self.checksum;
    }

    /// Verify the CRC-32C of a payload against the stored checksum.
    pub fn verify_crc(&self, payload: &[u8]) -> OvnResult<()> {
        let computed = crc32c(payload);
        if computed != self.checksum {
            return Err(OvnError::ChecksumMismatch {
                location: format!("page {}", self.page_id),
                expected: self.checksum,
                actual: computed,
            });
        }
        Ok(())
    }
}

/// A complete page: header + payload bytes.
#[derive(Debug, Clone)]
pub struct Page {
    /// The page header (64 bytes).
    pub header: PageHeader,
    /// The raw payload bytes (page_size - PAGE_HEADER_SIZE).
    pub payload: Vec<u8>,
    /// Whether this page has been modified (dirty).
    pub dirty: bool,
    /// Pin count — number of active references.
    pub pin_count: u32,
}

impl Page {
    /// Create a new empty page.
    pub fn new(page_type: PageType, page_number: u64, page_size: u32) -> Self {
        let payload_len = page_size as usize - PAGE_HEADER_SIZE;
        Self {
            header: PageHeader::new(page_type, page_number),
            payload: vec![0u8; payload_len],
            dirty: false,
            pin_count: 0,
        }
    }

    /// Serialize the entire page (header + payload) to a byte vector.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = Vec::with_capacity(PAGE_HEADER_SIZE + self.payload.len());
        let mut header = self.header;
        header.compute_crc(&self.payload);
        buf.extend_from_slice(&header.to_bytes());
        buf.extend_from_slice(&self.payload);
        buf
    }

    /// Deserialize a page from raw bytes.
    pub fn from_bytes(buf: &[u8], page_size: u32) -> OvnResult<Self> {
        if buf.len() < page_size as usize {
            return Err(OvnError::EncodingError(format!(
                "Page buffer too small: {} bytes (need {})",
                buf.len(),
                page_size
            )));
        }

        let header = PageHeader::from_bytes(&buf[..PAGE_HEADER_SIZE])?;
        let payload = buf[PAGE_HEADER_SIZE..page_size as usize].to_vec();

        // Verify CRC if nonzero
        if header.checksum != 0 {
            header.verify_crc(&payload)?;
        }

        Ok(Self {
            header,
            payload,
            dirty: false,
            pin_count: 0,
        })
    }

    /// Get total page size including header.
    pub fn total_size(&self) -> usize {
        PAGE_HEADER_SIZE + self.payload.len()
    }
}

/// Slot entry within a leaf page's slot array — spec `[[FILE-01]]` §4.2.
///
/// Each slot is 4 bytes packed as:
/// - bits 0..15  = record offset within payload
/// - bits 16..30 = record length
/// - bit 31      = tombstone flag
#[derive(Debug, Clone, Copy)]
pub struct SlotEntry {
    /// Offset of the document within the payload (from payload start).
    pub doc_offset: u16,
    /// Length of the document in bytes.
    pub doc_length: u16,
    /// Whether this slot is tombstoned (deleted but retained).
    pub tombstone: bool,
}

impl SlotEntry {
    /// Pack a slot entry into 4 bytes (spec format: offset | length<<16 | tombstone<<31).
    pub fn to_packed(&self) -> u32 {
        let mut packed = (self.doc_offset as u32) | ((self.doc_length as u32) << 16);
        if self.tombstone {
            packed |= 0x8000_0000;
        }
        packed
    }

    /// Unpack a slot entry from 4 bytes.
    pub fn from_packed(packed: u32) -> Self {
        Self {
            doc_offset: (packed & 0xFFFF) as u16,
            doc_length: ((packed >> 16) & 0x7FFF) as u16,
            tombstone: packed & 0x8000_0000 != 0,
        }
    }

    /// Serialize a slot entry to 4 bytes (little-endian packed).
    pub fn to_bytes(&self) -> [u8; 4] {
        self.to_packed().to_le_bytes()
    }

    /// Deserialize a slot entry from 4 bytes.
    pub fn from_bytes(buf: &[u8; 4]) -> Self {
        let packed = u32::from_le_bytes(*buf);
        Self::from_packed(packed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_page_header_size_is_64() {
        let header = PageHeader::new(PageType::Leaf, 0);
        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), 64, "Page header must be exactly 64 bytes");
    }

    #[test]
    fn test_page_header_roundtrip() {
        let mut header = PageHeader::new(PageType::Leaf, 42);
        header.page_lsn_low = 0xDEADBEEF;
        header.next_page = 43;
        header.prev_page = 41;
        header.parent_page = 10;
        header.payload_len = 1024;
        header.free_offset = 512;
        header.record_count = 5;
        header.flags = PAGE_FLAG_COMPRESSED | PAGE_FLAG_IS_ROOT;
        header.full_lsn_high = 0x0000_0001;

        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), PAGE_HEADER_SIZE);

        let decoded = PageHeader::from_bytes(&bytes).unwrap();
        assert_eq!(decoded.magic_byte, PAGE_MAGIC_BYTE);
        assert_eq!(decoded.page_type, PageType::Leaf);
        assert_eq!(decoded.page_id, 42);
        assert_eq!(decoded.next_page, 43);
        assert_eq!(decoded.prev_page, 41);
        assert_eq!(decoded.parent_page, 10);
        assert_eq!(decoded.payload_len, 1024);
        assert_eq!(decoded.free_offset, 512);
        assert_eq!(decoded.record_count, 5);
        assert_eq!(decoded.flags, PAGE_FLAG_COMPRESSED | PAGE_FLAG_IS_ROOT);
        assert_eq!(decoded.page_lsn_low, 0xDEADBEEF);
        assert_eq!(decoded.full_lsn_high, 1);
        assert_eq!(decoded.full_lsn(), 0x0000_0001_DEAD_BEEF);
    }

    #[test]
    fn test_page_crc32c_verification() {
        let mut page = Page::new(PageType::Leaf, 0, 4096);
        page.payload[0..5].copy_from_slice(b"hello");
        page.dirty = true;

        let bytes = page.to_bytes();
        let decoded = Page::from_bytes(&bytes, 4096).unwrap();
        assert_eq!(&decoded.payload[0..5], b"hello");
    }

    #[test]
    fn test_page_crc32c_corruption_detected() {
        let mut page = Page::new(PageType::Leaf, 1, 4096);
        page.payload[0..5].copy_from_slice(b"world");
        let mut bytes = page.to_bytes();
        // Corrupt a payload byte
        bytes[PAGE_HEADER_SIZE + 3] ^= 0xFF;
        assert!(Page::from_bytes(&bytes, 4096).is_err());
    }

    #[test]
    fn test_slot_entry_packed_roundtrip() {
        let slot = SlotEntry {
            doc_offset: 1024,
            doc_length: 256,
            tombstone: false,
        };
        let packed = slot.to_packed();
        let decoded = SlotEntry::from_packed(packed);
        assert_eq!(decoded.doc_offset, 1024);
        assert_eq!(decoded.doc_length, 256);
        assert!(!decoded.tombstone);

        // With tombstone
        let slot_tomb = SlotEntry {
            doc_offset: 512,
            doc_length: 128,
            tombstone: true,
        };
        let packed_t = slot_tomb.to_packed();
        let decoded_t = SlotEntry::from_packed(packed_t);
        assert_eq!(decoded_t.doc_offset, 512);
        assert_eq!(decoded_t.doc_length, 128);
        assert!(decoded_t.tombstone);
    }

    #[test]
    fn test_slot_entry_bytes_roundtrip() {
        let slot = SlotEntry {
            doc_offset: 1024,
            doc_length: 256,
            tombstone: false,
        };
        let bytes = slot.to_bytes();
        let decoded = SlotEntry::from_bytes(&bytes);
        assert_eq!(decoded.doc_offset, 1024);
        assert_eq!(decoded.doc_length, 256);
    }

    #[test]
    fn test_page_type_roundtrip() {
        let types = vec![
            PageType::Leaf,
            PageType::Interior,
            PageType::Overflow,
            PageType::FreelistLeaf,
            PageType::FreelistTrunk,
            PageType::DocumentHeap,
            PageType::Free,
            PageType::Unused,
            PageType::SegmentDirectory,
        ];
        for pt in types {
            let v = pt as u8;
            assert_eq!(PageType::from_u8(v), Some(pt));
        }
    }

    #[test]
    fn test_full_lsn() {
        let mut header = PageHeader::new(PageType::Leaf, 0);
        header.set_full_lsn(0x0000_0003_DEAD_BEEF);
        assert_eq!(header.page_lsn_low, 0xDEAD_BEEF);
        assert_eq!(header.full_lsn_high, 3);
        assert_eq!(header.full_lsn(), 0x0000_0003_DEAD_BEEF);
    }
}
