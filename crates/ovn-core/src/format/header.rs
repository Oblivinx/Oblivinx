//! .OVN File Header (Page 0 — always 4096 bytes).
//!
//! The file header occupies the first page of every .ovn file and contains
//! critical metadata: magic number, format version, root page pointers,
//! WAL segment location, flags, timestamps, and a corruption-detection
//! shadow copy at the page footer.
//!
//! ## Binary Layout (Section 5.1 of spec)
//!
//! | Offset | Size | Field                        |
//! |--------|------|------------------------------|
//! | 0x0000 | 4    | Magic Number (0x4F564E58)    |
//! | 0x0004 | 2    | Format Version Major         |
//! | 0x0006 | 2    | Format Version Minor         |
//! | 0x0008 | 4    | Page Size                    |
//! | 0x000C | 8    | Total file size              |
//! | 0x0014 | 8    | Root Page of Primary B+ Tree |
//! | 0x001C | 8    | Root Page of Metadata B+ Tree|
//! | 0x0024 | 8    | WAL Segment Start Offset     |
//! | 0x002C | 8    | WAL Segment Size             |
//! | 0x0034 | 4    | Number of collections        |
//! | 0x0038 | 4    | CRC32 checksum               |
//! | 0x003C | 4    | Flags                        |
//! | 0x0040 | 8    | Creation timestamp           |
//! | 0x0048 | 8    | Last checkpoint timestamp    |
//! | 0x0050 | 16   | Database UUID                |
//! | 0x0060 | 64   | Application identifier       |
//! | 0x0FF0 | 16   | Shadow copy (corruption det) |

use crc32fast::Hasher as Crc32Hasher;
use std::io::{Cursor, Read, Write};
use uuid::Uuid;

use crate::error::{OvnError, OvnResult};
use crate::{DEFAULT_PAGE_SIZE, FORMAT_VERSION_MAJOR, FORMAT_VERSION_MINOR, OVN_MAGIC};

/// Size of the file header in bytes (always one full page).
pub const HEADER_SIZE: usize = 4096;

/// Offset of the shadow copy at the footer of Page 0.
const SHADOW_OFFSET: usize = 0x0FF0;

/// The .ovn file header occupying Page 0.
#[derive(Debug, Clone)]
pub struct FileHeader {
    /// Magic number — must equal 0x4F564E58 ('OVNX')
    pub magic: u32,
    /// Format version major
    pub version_major: u16,
    /// Format version minor
    pub version_minor: u16,
    /// Page size in bytes (default 4096, range 512–65536)
    pub page_size: u32,
    /// Total file size in bytes
    pub total_file_size: u64,
    /// Page number of the primary B+ tree root
    pub primary_root_page: u64,
    /// Page number of the metadata B+ tree root
    pub metadata_root_page: u64,
    /// Byte offset where the WAL segment begins
    pub wal_start_offset: u64,
    /// Size of the WAL segment in bytes
    pub wal_size: u64,
    /// Number of collections in the database
    pub collection_count: u32,
    /// CRC32 checksum of header bytes 0x0000–0x0034
    pub checksum: u32,
    /// Flags (WAL_ACTIVE, ENCRYPTED, COMPRESSED)
    pub flags: u32,
    /// Database creation timestamp (Unix epoch milliseconds)
    pub created_at: u64,
    /// Last successful checkpoint timestamp
    pub last_checkpoint: u64,
    /// Unique database identifier (128-bit UUID)
    pub db_uuid: [u8; 16],
    /// Application identifier string (UTF-8, null-padded, max 64 bytes)
    pub app_id: [u8; 64],
}

impl FileHeader {
    /// Create a new file header with default values for a fresh database.
    pub fn new(page_size: u32) -> Self {
        let uuid_bytes = *Uuid::new_v4().as_bytes();
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        let mut app_id = [0u8; 64];
        let name = b"Oblivinx3x";
        app_id[..name.len()].copy_from_slice(name);

        // WAL must start AFTER page 0 (header) and page 1 (segment directory).
        // wal_start_offset = 0 causes WAL records to overwrite the file header,
        // corrupting the magic number (0x4F564E58 → 0x00000001 = Insert record type).
        let wal_start = page_size as u64 * 2;

        Self {
            magic: OVN_MAGIC,
            version_major: FORMAT_VERSION_MAJOR,
            version_minor: FORMAT_VERSION_MINOR,
            page_size,
            total_file_size: page_size as u64 * 2, // header + segment directory
            primary_root_page: 0,
            metadata_root_page: 0,
            wal_start_offset: wal_start,
            wal_size: 0,
            collection_count: 0,
            checksum: 0, // computed on write
            flags: 0,
            created_at: now_ms,
            last_checkpoint: 0,
            db_uuid: uuid_bytes,
            app_id,
        }
    }

    /// Serialize the header to a page-sized byte buffer.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = vec![0u8; HEADER_SIZE];
        let mut cursor = Cursor::new(&mut buf[..]);

        // Write all fields in little-endian order
        cursor.write_all(&self.magic.to_le_bytes()).unwrap(); // 0x0000
        cursor.write_all(&self.version_major.to_le_bytes()).unwrap(); // 0x0004
        cursor.write_all(&self.version_minor.to_le_bytes()).unwrap(); // 0x0006
        cursor.write_all(&self.page_size.to_le_bytes()).unwrap(); // 0x0008
        cursor
            .write_all(&self.total_file_size.to_le_bytes())
            .unwrap(); // 0x000C
        cursor
            .write_all(&self.primary_root_page.to_le_bytes())
            .unwrap(); // 0x0014
        cursor
            .write_all(&self.metadata_root_page.to_le_bytes())
            .unwrap(); // 0x001C
        cursor
            .write_all(&self.wal_start_offset.to_le_bytes())
            .unwrap(); // 0x0024
        cursor.write_all(&self.wal_size.to_le_bytes()).unwrap(); // 0x002C
        cursor
            .write_all(&self.collection_count.to_le_bytes())
            .unwrap(); // 0x0034

        // Compute CRC32 over bytes 0x0000–0x0037 (inclusive)
        let mut crc = Crc32Hasher::new();
        crc.update(&cursor.get_ref()[0x0000..0x0038]);
        let checksum = crc.finalize();
        cursor.write_all(&checksum.to_le_bytes()).unwrap(); // 0x0038

        cursor.write_all(&self.flags.to_le_bytes()).unwrap(); // 0x003C
        cursor.write_all(&self.created_at.to_le_bytes()).unwrap(); // 0x0040
        cursor
            .write_all(&self.last_checkpoint.to_le_bytes())
            .unwrap(); // 0x0048
        cursor.write_all(&self.db_uuid).unwrap(); // 0x0050
        cursor.write_all(&self.app_id).unwrap(); // 0x0060

        // Shadow copy at 0x0FF0: magic(4) + version(4) + page_size(4) + pad(4)
        let shadow_start = SHADOW_OFFSET;
        buf[shadow_start..shadow_start + 4].copy_from_slice(&self.magic.to_le_bytes());
        buf[shadow_start + 4..shadow_start + 6].copy_from_slice(&self.version_major.to_le_bytes());
        buf[shadow_start + 6..shadow_start + 8].copy_from_slice(&self.version_minor.to_le_bytes());
        buf[shadow_start + 8..shadow_start + 12].copy_from_slice(&self.page_size.to_le_bytes());

        buf
    }

    /// Deserialize a header from a page-sized byte buffer.
    pub fn from_bytes(buf: &[u8]) -> OvnResult<Self> {
        if buf.len() < HEADER_SIZE {
            return Err(OvnError::EncodingError(format!(
                "Header buffer too small: {} bytes (need {})",
                buf.len(),
                HEADER_SIZE
            )));
        }

        let mut cursor = Cursor::new(buf);
        let mut tmp4 = [0u8; 4];
        let mut tmp2 = [0u8; 2];
        let mut tmp8 = [0u8; 8];

        // Magic
        cursor.read_exact(&mut tmp4)?;
        let magic = u32::from_le_bytes(tmp4);
        if magic != OVN_MAGIC {
            return Err(OvnError::InvalidMagic(magic));
        }

        // Version
        cursor.read_exact(&mut tmp2)?;
        let version_major = u16::from_le_bytes(tmp2);
        cursor.read_exact(&mut tmp2)?;
        let version_minor = u16::from_le_bytes(tmp2);

        // Page size
        cursor.read_exact(&mut tmp4)?;
        let page_size = u32::from_le_bytes(tmp4);

        // Total file size
        cursor.read_exact(&mut tmp8)?;
        let total_file_size = u64::from_le_bytes(tmp8);

        // Root pages
        cursor.read_exact(&mut tmp8)?;
        let primary_root_page = u64::from_le_bytes(tmp8);
        cursor.read_exact(&mut tmp8)?;
        let metadata_root_page = u64::from_le_bytes(tmp8);

        // WAL
        cursor.read_exact(&mut tmp8)?;
        let wal_start_offset = u64::from_le_bytes(tmp8);
        cursor.read_exact(&mut tmp8)?;
        let wal_size = u64::from_le_bytes(tmp8);

        // Collection count
        cursor.read_exact(&mut tmp4)?;
        let collection_count = u32::from_le_bytes(tmp4);

        // Verify CRC32
        let mut crc = Crc32Hasher::new();
        crc.update(&buf[0x0000..0x0038]);
        let computed_crc = crc.finalize();

        cursor.read_exact(&mut tmp4)?;
        let stored_crc = u32::from_le_bytes(tmp4);

        if stored_crc != 0 && computed_crc != stored_crc {
            return Err(OvnError::ChecksumMismatch {
                location: "file header".to_string(),
                expected: stored_crc,
                actual: computed_crc,
            });
        }

        // Flags
        cursor.read_exact(&mut tmp4)?;
        let flags = u32::from_le_bytes(tmp4);

        // Timestamps
        cursor.read_exact(&mut tmp8)?;
        let created_at = u64::from_le_bytes(tmp8);
        cursor.read_exact(&mut tmp8)?;
        let last_checkpoint = u64::from_le_bytes(tmp8);

        // UUID
        let mut db_uuid = [0u8; 16];
        cursor.read_exact(&mut db_uuid)?;

        // App ID
        let mut app_id = [0u8; 64];
        cursor.read_exact(&mut app_id)?;

        Ok(Self {
            magic,
            version_major,
            version_minor,
            page_size,
            total_file_size,
            primary_root_page,
            metadata_root_page,
            wal_start_offset,
            wal_size,
            collection_count,
            checksum: stored_crc,
            flags,
            created_at,
            last_checkpoint,
            db_uuid,
            app_id,
        })
    }

    /// Check whether the WAL_ACTIVE flag is set.
    pub fn is_wal_active(&self) -> bool {
        self.flags & super::flags::WAL_ACTIVE != 0
    }

    /// Check whether compression is enabled.
    pub fn is_compressed(&self) -> bool {
        self.flags & super::flags::COMPRESSED != 0
    }

    /// Set or clear the WAL_ACTIVE flag.
    pub fn set_wal_active(&mut self, active: bool) {
        if active {
            self.flags |= super::flags::WAL_ACTIVE;
        } else {
            self.flags &= !super::flags::WAL_ACTIVE;
        }
    }
}

impl Default for FileHeader {
    fn default() -> Self {
        Self::new(DEFAULT_PAGE_SIZE)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_header_roundtrip() {
        let header = FileHeader::new(4096);
        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), HEADER_SIZE);

        let decoded = FileHeader::from_bytes(&bytes).unwrap();
        assert_eq!(decoded.magic, OVN_MAGIC);
        assert_eq!(decoded.page_size, 4096);
        assert_eq!(decoded.version_major, FORMAT_VERSION_MAJOR);
        assert_eq!(decoded.version_minor, FORMAT_VERSION_MINOR);
        assert_eq!(decoded.db_uuid, header.db_uuid);
    }

    #[test]
    fn test_invalid_magic() {
        let mut bytes = FileHeader::new(4096).to_bytes();
        bytes[0] = 0xFF; // corrupt magic
        let result = FileHeader::from_bytes(&bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_shadow_copy() {
        let header = FileHeader::new(4096);
        let bytes = header.to_bytes();
        // Verify shadow copy at 0x0FF0 matches header fields
        let shadow_magic = u32::from_le_bytes([
            bytes[SHADOW_OFFSET],
            bytes[SHADOW_OFFSET + 1],
            bytes[SHADOW_OFFSET + 2],
            bytes[SHADOW_OFFSET + 3],
        ]);
        assert_eq!(shadow_magic, OVN_MAGIC);
    }
}
