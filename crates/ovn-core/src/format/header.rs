//! .OVN2 File Header (Page 0 — always equal to page_size bytes).
//!
//! ## Binary Layout v2.0 (4096-byte page)
//!
//! | Offset | Size | Field                            |
//! |--------|------|----------------------------------|
//! | 0x0000 | 4    | Magic: OVN2 (0x4F564E32)         |
//! | 0x0004 | 2    | Format Version Major (2)         |
//! | 0x0006 | 2    | Format Version Minor (0)         |
//! | 0x0008 | 4    | Page Size                        |
//! | 0x000C | 8    | Total file size                  |
//! | 0x0014 | 8    | Root Page of Primary B+ Tree     |
//! | 0x001C | 8    | Root Page of Metadata B+ Tree    |
//! | 0x0024 | 8    | WAL Segment Start Offset         |
//! | 0x002C | 8    | WAL Segment Size                 |
//! | 0x0034 | 4    | Number of collections            |
//! | 0x0038 | 4    | CRC32C checksum (fields 0–0x0037)|
//! | 0x003C | 8    | Flags (64-bit, replaces u32)     |
//! | 0x0044 | 8    | Creation timestamp (ms)          |
//! | 0x004C | 8    | Last checkpoint timestamp (ms)   |
//! | 0x0054 | 16   | Database UUID                    |
//! | 0x0064 | 64   | Application identifier (UTF-8)   |
//! | 0x00A4 | 8    | Columnar segment root page  [v2] |
//! | 0x00AC | 8    | Vector segment root page    [v2] |
//! | 0x00B4 | 8    | CDC log root page           [v2] |
//! | 0x00BC | 8    | Security metadata root page [v2] |
//! | 0x00C4 | 8    | Embedding cache root page   [v2] |
//! | 0x00CC | 8    | Zone map root page          [v2] |
//! | 0x00D4 | 8    | Learned index root page     [v2] |
//! | 0x00DC | 8    | Audit log root page         [v2] |
//! | 0x00E4 | 8    | Bloom filter root page      [v2] |
//! | 0x00EC | 8    | HLC persisted state         [v2] |
//! | 0x00F4 | 16   | KMS key ID                  [v2] |
//! | 0x0104 | 16   | Key derivation salt         [v2] |
//! | 0x0114 | 32   | Header HMAC-SHA256          [v2] |
//! | 0x0FF0 | 16   | Shadow copy (corruption det)    |

use crc32c::crc32c;
use std::io::{Cursor, Read, Write};
use uuid::Uuid;

use crate::error::{OvnError, OvnResult};
use crate::{
    DEFAULT_PAGE_SIZE, FORMAT_VERSION_MAJOR, FORMAT_VERSION_MAJOR_V1, FORMAT_VERSION_MINOR,
    OVN2_MAGIC, OVN_MAGIC_V1,
};

/// Size of the file header in bytes (always one full page).
pub const HEADER_SIZE: usize = 4096;

/// Offset of the shadow copy at the footer of Page 0.
const SHADOW_OFFSET: usize = 0x0FF0;

/// Whether a v1 file was opened in compatibility mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileVersion {
    /// v1.x file — opened in read-only compat mode.
    V1,
    /// v2.x file — full read-write.
    V2,
}

/// The .ovn2 file header occupying Page 0.
#[derive(Debug, Clone)]
pub struct FileHeader {
    /// Magic: OVN2 (0x4F564E32) for v2, OVNX (0x4F564E58) for v1 compat.
    pub magic: u32,
    /// Format version major.
    pub version_major: u16,
    /// Format version minor.
    pub version_minor: u16,
    /// Page size in bytes.
    pub page_size: u32,
    /// Total file size in bytes.
    pub total_file_size: u64,
    /// Primary B+ tree root page.
    pub primary_root_page: u64,
    /// Metadata B+ tree root page.
    pub metadata_root_page: u64,
    /// WAL segment start offset.
    pub wal_start_offset: u64,
    /// WAL segment size in bytes.
    pub wal_size: u64,
    /// Number of collections.
    pub collection_count: u32,
    /// CRC32C of header bytes 0x0000–0x0037.
    pub checksum: u32,
    /// Flags (64-bit in v2, 32-bit in v1 — see format::flags).
    pub flags: u64,
    /// Creation timestamp (Unix epoch ms).
    pub created_at: u64,
    /// Last checkpoint timestamp (Unix epoch ms).
    pub last_checkpoint: u64,
    /// Unique database identifier (128-bit UUID).
    pub db_uuid: [u8; 16],
    /// Application identifier (UTF-8, null-padded, 64 bytes).
    pub app_id: [u8; 64],

    // ── v2-only fields ────────────────────────────────────────────
    /// Root page of the Columnar segment. [v2]
    pub columnar_root_page: u64,
    /// Root page of the Vector index segment. [v2]
    pub vector_root_page: u64,
    /// Root page of the CDC log segment. [v2]
    pub cdc_log_root_page: u64,
    /// Root page of the Security metadata segment. [v2]
    pub security_root_page: u64,
    /// Root page of the Embedding cache segment. [v2]
    pub embedding_cache_root_page: u64,
    /// Root page of the Zone map segment. [v2]
    pub zone_map_root_page: u64,
    /// Root page of the Learned index segment. [v2]
    pub learned_index_root_page: u64,
    /// Root page of the Audit log segment. [v2]
    pub audit_log_root_page: u64,
    /// Root page of the Bloom filter store. [v2]
    pub bloom_root_page: u64,
    /// Persisted HLC state (last physical ms + logical counter). [v2]
    pub hlc_state: u64,
    /// KMS key ID (16 bytes; zeros = no external KMS). [v2]
    pub kms_key_id: [u8; 16],
    /// Key derivation salt (Argon2id). [v2]
    pub key_derivation_salt: [u8; 16],
    /// HMAC-SHA256 over entire header (zeros = not signed). [v2]
    pub header_hmac: [u8; 32],

    /// Which file format version this was deserialized from.
    #[doc(hidden)]
    pub file_version: FileVersion,
}

impl FileHeader {
    /// Create a new v2 file header for a fresh database.
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
        let wal_start = page_size as u64 * 2;

        Self {
            magic: OVN2_MAGIC,
            version_major: FORMAT_VERSION_MAJOR,
            version_minor: FORMAT_VERSION_MINOR,
            page_size,
            total_file_size: page_size as u64 * 2,
            primary_root_page: 0,
            metadata_root_page: 0,
            wal_start_offset: wal_start,
            wal_size: 0,
            collection_count: 0,
            checksum: 0,
            flags: crate::format::flags::WAL_ACTIVE | crate::format::flags::HAS_HLC,
            created_at: now_ms,
            last_checkpoint: 0,
            db_uuid: uuid_bytes,
            app_id,
            columnar_root_page: 0,
            vector_root_page: 0,
            cdc_log_root_page: 0,
            security_root_page: 0,
            embedding_cache_root_page: 0,
            zone_map_root_page: 0,
            learned_index_root_page: 0,
            audit_log_root_page: 0,
            bloom_root_page: 0,
            hlc_state: now_ms << 16, // physical_ms in top 48 bits, logical=0
            kms_key_id: [0u8; 16],
            key_derivation_salt: [0u8; 16],
            header_hmac: [0u8; 32],
            file_version: FileVersion::V2,
        }
    }

    /// Whether this header was from a v1 file (read-only compat).
    pub fn is_v1_compat(&self) -> bool {
        self.file_version == FileVersion::V1
    }

    /// Serialize the header to a page-sized byte buffer.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut buf = vec![0u8; HEADER_SIZE];

        // ── Core fields (shared with v1 layout) ──────────────────
        buf[0x0000..0x0004].copy_from_slice(&self.magic.to_le_bytes());
        buf[0x0004..0x0006].copy_from_slice(&self.version_major.to_le_bytes());
        buf[0x0006..0x0008].copy_from_slice(&self.version_minor.to_le_bytes());
        buf[0x0008..0x000C].copy_from_slice(&self.page_size.to_le_bytes());
        buf[0x000C..0x0014].copy_from_slice(&self.total_file_size.to_le_bytes());
        buf[0x0014..0x001C].copy_from_slice(&self.primary_root_page.to_le_bytes());
        buf[0x001C..0x0024].copy_from_slice(&self.metadata_root_page.to_le_bytes());
        buf[0x0024..0x002C].copy_from_slice(&self.wal_start_offset.to_le_bytes());
        buf[0x002C..0x0034].copy_from_slice(&self.wal_size.to_le_bytes());
        buf[0x0034..0x0038].copy_from_slice(&self.collection_count.to_le_bytes());

        // CRC32C over bytes 0x0000–0x0037 (compute before any mutable cursor)
        let crc_val = crc32c(&buf[0x0000..0x0038]);
        buf[0x0038..0x003C].copy_from_slice(&crc_val.to_le_bytes());

        // ── Flags (64-bit in v2) ──────────────────────────────────
        buf[0x003C..0x0044].copy_from_slice(&self.flags.to_le_bytes());

        // ── Timestamps ───────────────────────────────────────────
        buf[0x0044..0x004C].copy_from_slice(&self.created_at.to_le_bytes());
        buf[0x004C..0x0054].copy_from_slice(&self.last_checkpoint.to_le_bytes());

        // ── UUIDs and App ID ─────────────────────────────────────
        buf[0x0054..0x0064].copy_from_slice(&self.db_uuid);
        buf[0x0064..0x00A4].copy_from_slice(&self.app_id);

        // ── v2-only fields ────────────────────────────────────────
        buf[0x00A4..0x00AC].copy_from_slice(&self.columnar_root_page.to_le_bytes());
        buf[0x00AC..0x00B4].copy_from_slice(&self.vector_root_page.to_le_bytes());
        buf[0x00B4..0x00BC].copy_from_slice(&self.cdc_log_root_page.to_le_bytes());
        buf[0x00BC..0x00C4].copy_from_slice(&self.security_root_page.to_le_bytes());
        buf[0x00C4..0x00CC].copy_from_slice(&self.embedding_cache_root_page.to_le_bytes());
        buf[0x00CC..0x00D4].copy_from_slice(&self.zone_map_root_page.to_le_bytes());
        buf[0x00D4..0x00DC].copy_from_slice(&self.learned_index_root_page.to_le_bytes());
        buf[0x00DC..0x00E4].copy_from_slice(&self.audit_log_root_page.to_le_bytes());
        buf[0x00E4..0x00EC].copy_from_slice(&self.bloom_root_page.to_le_bytes());
        buf[0x00EC..0x00F4].copy_from_slice(&self.hlc_state.to_le_bytes());
        buf[0x00F4..0x0104].copy_from_slice(&self.kms_key_id);
        buf[0x0104..0x0114].copy_from_slice(&self.key_derivation_salt);
        buf[0x0114..0x0134].copy_from_slice(&self.header_hmac);

        // ── Shadow copy at 0x0FF0 (magic + version + page_size + flags_lo) ──
        buf[SHADOW_OFFSET..SHADOW_OFFSET + 4].copy_from_slice(&self.magic.to_le_bytes());
        buf[SHADOW_OFFSET + 4..SHADOW_OFFSET + 6].copy_from_slice(&self.version_major.to_le_bytes());
        buf[SHADOW_OFFSET + 6..SHADOW_OFFSET + 8].copy_from_slice(&self.version_minor.to_le_bytes());
        buf[SHADOW_OFFSET + 8..SHADOW_OFFSET + 12].copy_from_slice(&self.page_size.to_le_bytes());
        buf[SHADOW_OFFSET + 12..SHADOW_OFFSET + 16].copy_from_slice(&self.flags.to_le_bytes()[..4]);

        buf
    }

    /// Deserialize a header from a page-sized byte buffer.
    ///
    /// Supports both v1 (OVNX magic) and v2 (OVN2 magic) files.
    /// Returns `Err` if the buffer is too small, the magic is unknown,
    /// or the CRC32C fails.
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
        let file_version = match magic {
            m if m == OVN2_MAGIC => FileVersion::V2,
            m if m == OVN_MAGIC_V1 => {
                log::info!("Opening v1 file (magic OVNX) in read-only compatibility mode.");
                FileVersion::V1
            }
            m => return Err(OvnError::InvalidMagic(m)),
        };

        // Version
        cursor.read_exact(&mut tmp2)?;
        let version_major = u16::from_le_bytes(tmp2);
        cursor.read_exact(&mut tmp2)?;
        let version_minor = u16::from_le_bytes(tmp2);

        // Validate v1 version number if v1 magic
        if file_version == FileVersion::V1 && version_major != FORMAT_VERSION_MAJOR_V1 {
            return Err(OvnError::EncodingError(format!(
                "Unexpected v1 format version: {}.{}",
                version_major, version_minor
            )));
        }

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

        // CRC32C (bytes 0x0000–0x0037)
        let stored_crc = {
            cursor.read_exact(&mut tmp4)?;
            u32::from_le_bytes(tmp4)
        };
        if stored_crc != 0 {
            let computed_crc = crc32c(&buf[0x0000..0x0038]);
            if computed_crc != stored_crc {
                return Err(OvnError::ChecksumMismatch {
                    location: "file header".to_string(),
                    expected: stored_crc,
                    actual: computed_crc,
                });
            }
        }

        // Flags: v1 stored as u32, v2 as u64
        let flags = if file_version == FileVersion::V1 {
            cursor.read_exact(&mut tmp4)?;
            let v1_flags = u32::from_le_bytes(tmp4);
            // Skip 4 padding bytes that don't exist in v1 layout
            crate::format::flags::upgrade_v1_flags(v1_flags)
        } else {
            cursor.read_exact(&mut tmp8)?;
            u64::from_le_bytes(tmp8)
        };

        // Timestamps (v1: 8+8 at same relative offsets after flags u32+pad)
        // v2: flags is 8 bytes, so timestamps shift by +4 relative to v1.
        // We position by cursor which already handled the difference above.
        cursor.read_exact(&mut tmp8)?;
        let created_at = u64::from_le_bytes(tmp8);
        cursor.read_exact(&mut tmp8)?;
        let last_checkpoint = u64::from_le_bytes(tmp8);

        // UUID
        let mut db_uuid = [0u8; 16];
        cursor.read_exact(&mut db_uuid)?;

        // App ID (64 bytes)
        let mut app_id = [0u8; 64];
        cursor.read_exact(&mut app_id)?;

        // ── v2-only fields (safe to default on v1) ───────────────
        let (
            columnar_root_page,
            vector_root_page,
            cdc_log_root_page,
            security_root_page,
            embedding_cache_root_page,
            zone_map_root_page,
            learned_index_root_page,
            audit_log_root_page,
            bloom_root_page,
            hlc_state,
            kms_key_id,
            key_derivation_salt,
            header_hmac,
        ) = if file_version == FileVersion::V2 {
            let mut r8 = || {
                cursor.read_exact(&mut tmp8)?;
                Ok::<u64, std::io::Error>(u64::from_le_bytes(tmp8))
            };
            let col = r8()?;
            let vec = r8()?;
            let cdc = r8()?;
            let sec = r8()?;
            let emb = r8()?;
            let zon = r8()?;
            let lrn = r8()?;
            let aud = r8()?;
            let blm = r8()?;
            let hlc = r8()?;

            let mut kms = [0u8; 16];
            cursor.read_exact(&mut kms)?;
            let mut salt = [0u8; 16];
            cursor.read_exact(&mut salt)?;
            let mut hmac = [0u8; 32];
            cursor.read_exact(&mut hmac)?;

            (col, vec, cdc, sec, emb, zon, lrn, aud, blm, hlc, kms, salt, hmac)
        } else {
            (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, [0u8; 16], [0u8; 16], [0u8; 32])
        };

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
            columnar_root_page,
            vector_root_page,
            cdc_log_root_page,
            security_root_page,
            embedding_cache_root_page,
            zone_map_root_page,
            learned_index_root_page,
            audit_log_root_page,
            bloom_root_page,
            hlc_state,
            kms_key_id,
            key_derivation_salt,
            header_hmac,
            file_version,
        })
    }

    // ── Flag helpers ─────────────────────────────────────────────

    pub fn is_wal_active(&self) -> bool {
        self.flags & crate::format::flags::WAL_ACTIVE != 0
    }

    pub fn set_wal_active(&mut self, active: bool) {
        if active {
            self.flags |= crate::format::flags::WAL_ACTIVE;
        } else {
            self.flags &= !crate::format::flags::WAL_ACTIVE;
        }
    }

    pub fn is_compressed(&self) -> bool {
        self.flags & crate::format::flags::COMPRESSED != 0
    }

    pub fn has_columnar(&self) -> bool {
        self.flags & crate::format::flags::HAS_COLUMNAR != 0
    }

    pub fn has_vector(&self) -> bool {
        self.flags & crate::format::flags::HAS_VECTOR != 0
    }

    pub fn has_cdc(&self) -> bool {
        self.flags & crate::format::flags::HAS_CDC != 0
    }

    pub fn has_hlc(&self) -> bool {
        self.flags & crate::format::flags::HAS_HLC != 0
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
    fn test_v2_header_roundtrip() {
        let header = FileHeader::new(4096);
        assert_eq!(header.magic, OVN2_MAGIC);
        assert_eq!(header.version_major, 2);
        assert_eq!(header.file_version, FileVersion::V2);

        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), HEADER_SIZE);

        let decoded = FileHeader::from_bytes(&bytes).unwrap();
        assert_eq!(decoded.magic, OVN2_MAGIC);
        assert_eq!(decoded.page_size, 4096);
        assert_eq!(decoded.version_major, 2);
        assert_eq!(decoded.version_minor, 0);
        assert_eq!(decoded.db_uuid, header.db_uuid);
        assert_eq!(decoded.file_version, FileVersion::V2);
        assert_eq!(decoded.hlc_state, header.hlc_state);
    }

    #[test]
    fn test_v1_compat_detection() {
        // Simulate a v1 header: magic OVNX, version 1.1
        let mut buf = vec![0u8; HEADER_SIZE];
        buf[0..4].copy_from_slice(&OVN_MAGIC_V1.to_le_bytes());
        buf[4..6].copy_from_slice(&1u16.to_le_bytes()); // major = 1
        buf[6..8].copy_from_slice(&1u16.to_le_bytes()); // minor = 1
        buf[8..12].copy_from_slice(&4096u32.to_le_bytes()); // page_size

        let decoded = FileHeader::from_bytes(&buf).unwrap();
        assert_eq!(decoded.file_version, FileVersion::V1);
        assert_eq!(decoded.magic, OVN_MAGIC_V1);
        // v2 fields should be zeroed
        assert_eq!(decoded.columnar_root_page, 0);
        assert_eq!(decoded.hlc_state, 0);
    }

    #[test]
    fn test_invalid_magic() {
        let mut bytes = FileHeader::new(4096).to_bytes();
        bytes[0] = 0xFF; // corrupt magic
        let result = FileHeader::from_bytes(&bytes);
        assert!(result.is_err());
    }

    #[test]
    fn test_shadow_copy_present() {
        let header = FileHeader::new(4096);
        let bytes = header.to_bytes();
        let shadow_magic = u32::from_le_bytes([
            bytes[SHADOW_OFFSET],
            bytes[SHADOW_OFFSET + 1],
            bytes[SHADOW_OFFSET + 2],
            bytes[SHADOW_OFFSET + 3],
        ]);
        assert_eq!(shadow_magic, OVN2_MAGIC);
    }

    #[test]
    fn test_flag_helpers() {
        let mut h = FileHeader::new(4096);
        assert!(h.is_wal_active());
        assert!(h.has_hlc());
        assert!(!h.has_columnar());

        h.flags |= crate::format::flags::HAS_COLUMNAR;
        assert!(h.has_columnar());

        h.set_wal_active(false);
        assert!(!h.is_wal_active());
    }
}
