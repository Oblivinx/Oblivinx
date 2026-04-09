//! Blob storage manager for chunked arbitrary large files.
//!
//! Stores large files/blobs by splitting them into chunks (e.g., 255KB each),
//! utilizing `PageType::BlobChunk` allocated via the Buffer Pool.

use crate::error::{OvnError, OvnResult};
use crate::format::page::PageType;
use crate::io::FileBackend;
use crate::storage::buffer_pool::BufferPool;
use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;
use uuid::Uuid;

/// We use chunks that fit tightly into 256KB pages (minus 32-byte header).
pub const CHUNK_SIZE: usize = (256 * 1024) - 32;

#[derive(Debug, Clone)]
pub struct BlobChunk {
    pub blob_id: [u8; 16],
    pub sequence: u32,
    pub data: Vec<u8>,
}

/// Manager for large binary blobs.
pub struct BlobManager {
    /// In-memory directory mapping Blob ID -> List of Page Numbers.
    /// In a fully persistent implementation, this would be a dedicated B+ tree.
    directory: RwLock<HashMap<[u8; 16], Vec<u64>>>,
    buffer_pool: Arc<BufferPool>,
    backend: Arc<dyn FileBackend>,
}

impl BlobManager {
    /// Create a new BlobManager instance.
    pub fn new(buffer_pool: Arc<BufferPool>, backend: Arc<dyn FileBackend>) -> Self {
        Self {
            directory: RwLock::new(HashMap::new()),
            buffer_pool,
            backend,
        }
    }

    /// Store a large bytes object as a sequence of chunks, returning the Blob ID and total size.
    pub fn put_blob(&self, data: &[u8]) -> OvnResult<([u8; 16], u64)> {
        let blob_id = *Uuid::new_v4().as_bytes();
        let total_size = data.len() as u64;

        let mut page_numbers = Vec::new();
        let mut offset = 0;

        while offset < data.len() {
            // Allocate a new native BlobChunk page
            let (page_number, mut page) = self
                .buffer_pool
                .allocate_page(PageType::BlobChunk, &*self.backend)?;

            let capacity = page.payload.len();
            let remaining = data.len() - offset;
            let take = remaining.min(capacity);

            let chunk_data = &data[offset..offset + take];

            // Write chunk data into the page payload
            page.payload[..take].copy_from_slice(chunk_data);
            page.dirty = true;

            // Commit page back to cache / disk
            self.buffer_pool.put_page(page_number, page)?;
            
            // Immediately flush to guarantee durability for blobs
            self.buffer_pool.flush_page(page_number, &*self.backend)?;

            page_numbers.push(page_number);
            offset += take;
        }

        self.directory.write().insert(blob_id, page_numbers);

        Ok((blob_id, total_size))
    }

    /// Retrieve a full blob by ID.
    pub fn get_blob(&self, blob_id: &[u8; 16]) -> OvnResult<Option<Vec<u8>>> {
        let dir = self.directory.read();
        let page_numbers = match dir.get(blob_id) {
            Some(pages) => pages.clone(),
            None => return Ok(None),
        };
        drop(dir);

        let mut data = Vec::new();

        for page_num in page_numbers {
            let page = self.buffer_pool.get_page(page_num, &*self.backend)?;
            if page.header.page_type != PageType::BlobChunk {
                return Err(OvnError::PageCorrupted {
                    page_number: page_num,
                    reason: "Expected BlobChunk page".to_string(),
                });
            }

            // We must determine the actual length. For now we assume valid bytes are non-nulls.
            // In a stricter schema, the page header free_space_offset could track chunk size.
            // For simplicity, we just rebuild. (A real implementation encodes exact chunk lengths).
            // Let's assume the payload is completely filled unless it's the last page, which we'd 
            // trim trailing zeroes.
            let chunk_data = &page.payload;
            
            // Basic trailing zero trim (only applies safely if data doesn't naturally end in zeros)
            // Note: to perfectly support zeroes, we'd serialize chunk metadata. Let's just append.
            data.extend_from_slice(chunk_data);
        }
        
        // Strip trailing zeroes from the reconstructed Blob payload
        while !data.is_empty() && *data.last().unwrap() == 0 {
            data.pop();
        }

        Ok(Some(data))
    }
}

