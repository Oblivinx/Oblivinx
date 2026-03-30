//! Page header and page type definitions.
//!
//! Every page in a .ovn file begins with a 32-byte page header that identifies
//! the page type, tracks its transaction lineage, and includes a CRC32
//! checksum for corruption detection.
//!
//! ## Page Header Layout (32 bytes)
//!
//! | Offset | Size | Field                            |
//! |--------|------|----------------------------------|
//! | 0x00   | 4    | Page Type                        |
//! | 0x04   | 8    | Page Number (0-indexed)          |
//! | 0x0C   | 8    | Transaction ID (last modifier)   |
//! | 0x14   | 2    | Number of document slots         |
//! | 0x16   | 2    | Free space offset                |
//! | 0x18   | 4    | Right sibling page number        |
//! | 0x1C   | 4    | CRC32 checksum of payload        |

use std::io::{Read, Write, Cursor};
use crc32fast::Hasher as Crc32Hasher;

use crate::error::{OvnError, OvnResult};

/// Size of the page header in bytes.
pub const PAGE_HEADER_SIZE: usize = 32;

/// Minimum usable payload size given header overhead.
pub const fn payload_size(page_size: u32) -> u32 {
    page_size - PAGE_HEADER_SIZE as u32
}

/// Page type identifiers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u32)]
pub enum PageType {
    /// B+ tree leaf page containing document slots
    Leaf = 0x01,
    /// B+ tree interior page containing key-pointer pairs
    Interior = 0x02,
    /// Overflow page for large documents spanning multiple pages
    Overflow = 0x03,
    /// WAL record page
    Wal = 0x04,
    /// Free page available for reuse
    Free = 0x05,
    /// Segment directory page
    SegmentDirectory = 0x06,
    /// Metadata page (collection schemas, statistics)
    Metadata = 0x07,
    /// Index page (SSTable index blocks)
    Index = 0x08,
}

impl PageType {
    /// Convert a raw u32 to a PageType.
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            0x01 => Some(Self::Leaf),
            0x02 => Some(Self::Interior),
            0x03 => Some(Self::Overflow),
            0x04 => Some(Self::Wal),
            0x05 => Some(Self::Free),
            0x06 => Some(Self::SegmentDirectory),
            0x07 => Some(Self::Metadata),
            0x08 => Some(Self::Index),
            _ => None,
        }
    }
}

/// The 32-byte header present at the start of every page.
#[derive(Debug, Clone, Copy)]
pub struct PageHeader {
    /// Type of this page
    pub page_type: PageType,
    /// Zero-indexed page number within the file
    pub page_number: u64,
    /// Transaction ID that last modified this page
    pub txid: u64,
    /// Number of document slots (leaf pages only)
    pub slot_count: u16,
    /// Offset of free space from the start of the payload area
    pub free_space_offset: u16,
    /// Page number of the right sibling (B+ tree leaf chain)
    pub right_sibling: u32,
    /// CRC32 checksum of all bytes after the header
    pub crc32: u32,
}

impl PageHeader {
    /// Create a new page header.
    pub fn new(page_type: PageType, page_number: u64) -> Self {
        Self {
            page_type,
            page_number,
            txid: 0,
            slot_count: 0,
            free_space_offset: 0,
            right_sibling: 0,
            crc32: 0,
        }
    }

    /// Serialize the page header to exactly 32 bytes.
    pub fn to_bytes(&self) -> [u8; PAGE_HEADER_SIZE] {
        let mut buf = [0u8; PAGE_HEADER_SIZE];
        let mut cursor = Cursor::new(&mut buf[..]);

        cursor.write_all(&(self.page_type as u32).to_le_bytes()).unwrap();
        cursor.write_all(&self.page_number.to_le_bytes()).unwrap();
        cursor.write_all(&self.txid.to_le_bytes()).unwrap();
        cursor.write_all(&self.slot_count.to_le_bytes()).unwrap();
        cursor.write_all(&self.free_space_offset.to_le_bytes()).unwrap();
        cursor.write_all(&self.right_sibling.to_le_bytes()).unwrap();
        cursor.write_all(&self.crc32.to_le_bytes()).unwrap();

        buf
    }

    /// Deserialize a page header from a byte slice.
    pub fn from_bytes(buf: &[u8]) -> OvnResult<Self> {
        if buf.len() < PAGE_HEADER_SIZE {
            return Err(OvnError::EncodingError(format!(
                "Page header buffer too small: {} bytes",
                buf.len()
            )));
        }

        let mut cursor = Cursor::new(buf);
        let mut tmp4 = [0u8; 4];
        let mut tmp8 = [0u8; 8];
        let mut tmp2 = [0u8; 2];

        cursor.read_exact(&mut tmp4)?;
        let page_type_raw = u32::from_le_bytes(tmp4);
        let page_type = PageType::from_u32(page_type_raw).ok_or_else(|| {
            OvnError::PageCorrupted {
                page_number: 0,
                reason: format!("Unknown page type: 0x{page_type_raw:08X}"),
            }
        })?;

        cursor.read_exact(&mut tmp8)?;
        let page_number = u64::from_le_bytes(tmp8);

        cursor.read_exact(&mut tmp8)?;
        let txid = u64::from_le_bytes(tmp8);

        cursor.read_exact(&mut tmp2)?;
        let slot_count = u16::from_le_bytes(tmp2);

        cursor.read_exact(&mut tmp2)?;
        let free_space_offset = u16::from_le_bytes(tmp2);

        cursor.read_exact(&mut tmp4)?;
        let right_sibling = u32::from_le_bytes(tmp4);

        cursor.read_exact(&mut tmp4)?;
        let crc32 = u32::from_le_bytes(tmp4);

        Ok(Self {
            page_type,
            page_number,
            txid,
            slot_count,
            free_space_offset,
            right_sibling,
            crc32,
        })
    }

    /// Compute the CRC32 of a payload and update `self.crc32`.
    pub fn compute_crc(&mut self, payload: &[u8]) {
        let mut hasher = Crc32Hasher::new();
        hasher.update(payload);
        self.crc32 = hasher.finalize();
    }

    /// Verify the CRC32 of a payload against the stored checksum.
    pub fn verify_crc(&self, payload: &[u8]) -> OvnResult<()> {
        let mut hasher = Crc32Hasher::new();
        hasher.update(payload);
        let computed = hasher.finalize();
        if computed != self.crc32 {
            return Err(OvnError::ChecksumMismatch {
                location: format!("page {}", self.page_number),
                expected: self.crc32,
                actual: computed,
            });
        }
        Ok(())
    }
}

/// A complete page: header + payload bytes.
#[derive(Debug, Clone)]
pub struct Page {
    /// The page header
    pub header: PageHeader,
    /// The raw payload bytes (page_size - PAGE_HEADER_SIZE)
    pub payload: Vec<u8>,
    /// Whether this page has been modified (dirty)
    pub dirty: bool,
    /// Pin count — number of active references
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
        if header.crc32 != 0 {
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

/// Slot entry within a leaf page's slot array.
/// Each slot is 4 bytes: 2 bytes doc_offset + 2 bytes doc_length.
#[derive(Debug, Clone, Copy)]
pub struct SlotEntry {
    /// Offset of the document within the payload (from payload start)
    pub doc_offset: u16,
    /// Length of the document in bytes
    pub doc_length: u16,
}

impl SlotEntry {
    /// Serialize a slot entry to 4 bytes.
    pub fn to_bytes(&self) -> [u8; 4] {
        let mut buf = [0u8; 4];
        buf[0..2].copy_from_slice(&self.doc_offset.to_le_bytes());
        buf[2..4].copy_from_slice(&self.doc_length.to_le_bytes());
        buf
    }

    /// Deserialize a slot entry from 4 bytes.
    pub fn from_bytes(buf: &[u8; 4]) -> Self {
        Self {
            doc_offset: u16::from_le_bytes([buf[0], buf[1]]),
            doc_length: u16::from_le_bytes([buf[2], buf[3]]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_page_header_roundtrip() {
        let mut header = PageHeader::new(PageType::Leaf, 42);
        header.txid = 1000;
        header.slot_count = 5;
        header.right_sibling = 43;

        let bytes = header.to_bytes();
        let decoded = PageHeader::from_bytes(&bytes).unwrap();

        assert_eq!(decoded.page_type, PageType::Leaf);
        assert_eq!(decoded.page_number, 42);
        assert_eq!(decoded.txid, 1000);
        assert_eq!(decoded.slot_count, 5);
        assert_eq!(decoded.right_sibling, 43);
    }

    #[test]
    fn test_page_crc_verification() {
        let mut page = Page::new(PageType::Leaf, 0, 4096);
        page.payload[0..5].copy_from_slice(b"hello");
        page.dirty = true;

        let bytes = page.to_bytes();
        let decoded = Page::from_bytes(&bytes, 4096).unwrap();
        assert_eq!(&decoded.payload[0..5], b"hello");
    }

    #[test]
    fn test_slot_entry_roundtrip() {
        let slot = SlotEntry {
            doc_offset: 1024,
            doc_length: 256,
        };
        let bytes = slot.to_bytes();
        let decoded = SlotEntry::from_bytes(&bytes);
        assert_eq!(decoded.doc_offset, 1024);
        assert_eq!(decoded.doc_length, 256);
    }
}
