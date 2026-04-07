//! Blob storage manager for chunked arbitrary large files.
//!
//! Stores large files/blobs by splitting them into chunks (e.g., 255KB each),
//! utilizing `PageType::BlobChunk`.

use crate::error::OvnResult;
use uuid::Uuid;

pub const CHUNK_SIZE: usize = 255 * 1024; // 255 KB

#[derive(Debug, Clone)]
pub struct BlobChunk {
    pub blob_id: [u8; 16],
    pub sequence: u32,
    pub data: Vec<u8>,
}

pub struct BlobManager {
    // Placeholder: interacts with BufferPool and FileBackend to allocate pages.
}

impl Default for BlobManager {
    fn default() -> Self {
        Self::new()
    }
}

impl BlobManager {
    pub fn new() -> Self {
        Self {}
    }

    /// Store a large bytes object as a sequence of chunks, returning the Blob ID and total size.
    pub fn put_blob(&self, data: &[u8]) -> OvnResult<([u8; 16], u64)> {
        let blob_id = *Uuid::new_v4().as_bytes();
        let total_size = data.len() as u64;

        for (seq, chunk_data) in data.chunks(CHUNK_SIZE).enumerate() {
            let _chunk = BlobChunk {
                blob_id,
                sequence: seq as u32,
                data: chunk_data.to_vec(),
            };
            // TODO: allocate PageType::BlobChunk via BufferPool and sync
        }

        Ok((blob_id, total_size))
    }

    /// Retrieve a full blob by ID.
    pub fn get_blob(&self, _blob_id: &[u8; 16]) -> OvnResult<Option<Vec<u8>>> {
        // TODO: reconstruct data by fetching chunks sequentially
        Ok(None)
    }
}
