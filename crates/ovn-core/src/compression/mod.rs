//! Compression utilities for page-level and document-level compression.
//!
//! - **Page-level**: LZ4 (fast decompression >4GB/s)
//! - **Document-level**: Zstandard (high ratio with shared dictionaries)

use crate::error::{OvnError, OvnResult};

/// Compression algorithm selection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompressionType {
    /// No compression
    None,
    /// LZ4 — optimized for decompression speed
    Lz4,
    /// Zstandard — optimized for compression ratio
    Zstd,
}

impl CompressionType {
    /// Parse from a string configuration value.
    pub fn from_str_config(s: &str) -> OvnResult<Self> {
        match s.to_lowercase().as_str() {
            "none" => Ok(Self::None),
            "lz4" => Ok(Self::Lz4),
            "zstd" | "zstandard" => Ok(Self::Zstd),
            _ => Err(OvnError::InvalidConfig(format!(
                "Unknown compression type: '{}'. Valid options: none, lz4, zstd",
                s
            ))),
        }
    }
}

/// Compress data using LZ4.
pub fn lz4_compress(data: &[u8]) -> OvnResult<Vec<u8>> {
    Ok(lz4_flex::compress_prepend_size(data))
}

/// Decompress LZ4-compressed data.
pub fn lz4_decompress(data: &[u8]) -> OvnResult<Vec<u8>> {
    lz4_flex::decompress_size_prepended(data)
        .map_err(|e| OvnError::CompressionError(format!("LZ4 decompression failed: {e}")))
}

/// Compress data using Zstandard at the given compression level.
pub fn zstd_compress(data: &[u8], level: i32) -> OvnResult<Vec<u8>> {
    zstd::encode_all(std::io::Cursor::new(data), level)
        .map_err(|e| OvnError::CompressionError(format!("Zstd compression failed: {e}")))
}

/// Decompress Zstandard-compressed data.
pub fn zstd_decompress(data: &[u8]) -> OvnResult<Vec<u8>> {
    zstd::decode_all(std::io::Cursor::new(data))
        .map_err(|e| OvnError::CompressionError(format!("Zstd decompression failed: {e}")))
}

/// Compress data using the specified algorithm.
pub fn compress(data: &[u8], compression: CompressionType) -> OvnResult<Vec<u8>> {
    match compression {
        CompressionType::None => Ok(data.to_vec()),
        CompressionType::Lz4 => lz4_compress(data),
        CompressionType::Zstd => zstd_compress(data, 3),
    }
}

/// Decompress data using the specified algorithm.
pub fn decompress(data: &[u8], compression: CompressionType) -> OvnResult<Vec<u8>> {
    match compression {
        CompressionType::None => Ok(data.to_vec()),
        CompressionType::Lz4 => lz4_decompress(data),
        CompressionType::Zstd => zstd_decompress(data),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lz4_roundtrip() {
        let data = b"Hello, Oblivinx3x! This is a test of LZ4 compression with repeated data. \
                      Hello, Oblivinx3x! This is a test of LZ4 compression with repeated data.";
        let compressed = lz4_compress(data).unwrap();
        let decompressed = lz4_decompress(&compressed).unwrap();
        assert_eq!(&decompressed, data);
        assert!(
            compressed.len() < data.len(),
            "LZ4 should compress repeated data"
        );
    }

    #[test]
    fn test_zstd_roundtrip() {
        let data = b"Oblivinx3x Zstandard test data with high entropy mixed in: \
                      abcdefghij1234567890abcdefghij1234567890";
        let compressed = zstd_compress(data, 3).unwrap();
        let decompressed = zstd_decompress(&compressed).unwrap();
        assert_eq!(&decompressed[..], &data[..]);
    }

    #[test]
    fn test_compression_dispatch() {
        let data = b"test data for compression dispatch";
        for &ctype in &[
            CompressionType::None,
            CompressionType::Lz4,
            CompressionType::Zstd,
        ] {
            let compressed = compress(data, ctype).unwrap();
            let decompressed = decompress(&compressed, ctype).unwrap();
            assert_eq!(decompressed, data);
        }
    }
}
