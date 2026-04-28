//! Overflow page chains — spec `[[FILE-01]]` §8.
//!
//! When a record (document, leaf entry, posting list) exceeds the inline
//! threshold, the value is split across an **overflow chain** of linked pages.
//!
//! ```text
//! inline pointer  →  Overflow page 1  →  Overflow page 2  →  ...
//!                    (next_page link)     (next_page link)
//! ```
//!
//! ## Overflow page body layout
//!
//! ```text
//! Offset  Size  Field
//! ──────  ────  ───────────────────────────
//!   0     64    PageHeader (page_type=Overflow)
//!  64     4     chunk_length (bytes in this page's chunk)
//!  68     var   chunk_data
//! last 4  4     chunk_crc32c (CRC-32C of chunk_data only)
//! ```
//!
//! The `next_page` field in the PageHeader links to the next overflow page
//! (0 = end of chain). The inline pointer in the parent record holds the
//! first overflow page id.

use crc32c::crc32c;

use crate::error::{OvnError, OvnResult};
use crate::format::page::{Page, PageType, PAGE_HEADER_SIZE};
use crate::io::FileBackend;
use crate::storage::buffer_pool::BufferPool;
use crate::storage::freelist::FreelistManager;

/// Inline threshold: values smaller than this are stored inline in the B+ leaf.
/// For a 4096-byte page: (4096 - 64) / 4 = 1008 bytes.
/// For a 8192-byte page: (8192 - 64) / 4 = 2032 bytes.
pub fn inline_threshold(page_size: u32) -> usize {
    ((page_size as usize) - PAGE_HEADER_SIZE) / 4
}

/// Maximum payload per overflow page (page_size - 64 header - 4 chunk_length - 4 crc).
pub fn overflow_chunk_capacity(page_size: u32) -> usize {
    (page_size as usize) - PAGE_HEADER_SIZE - 4 - 4
}

/// Write a value to an overflow chain, returning the first overflow page id.
///
/// Allocates as many overflow pages as needed and links them via `next_page`.
pub fn write_overflow_chain(
    data: &[u8],
    page_size: u32,
    freelist: &FreelistManager,
    buffer_pool: &BufferPool,
    backend: &dyn FileBackend,
) -> OvnResult<u64> {
    let chunk_cap = overflow_chunk_capacity(page_size);
    let chunks: Vec<&[u8]> = data.chunks(chunk_cap).collect();

    if chunks.is_empty() {
        return Err(OvnError::EncodingError(
            "Cannot create overflow chain for empty data".to_string(),
        ));
    }

    // Allocate all pages up-front
    let mut page_ids = Vec::with_capacity(chunks.len());
    for _ in 0..chunks.len() {
        let page_id = freelist.allocate(backend)?;
        page_ids.push(page_id);
    }

    // Write each chunk page, linking them together
    for (i, chunk) in chunks.iter().enumerate() {
        let page_id = page_ids[i];
        let next_page = if i + 1 < page_ids.len() {
            page_ids[i + 1]
        } else {
            0 // End of chain
        };

        let mut page = Page::new(PageType::Overflow, page_id, page_size);
        page.header.next_page = next_page;
        page.header.record_count = 1;

        // Write chunk_length (4 bytes)
        let chunk_len = chunk.len() as u32;
        page.payload[0..4].copy_from_slice(&chunk_len.to_le_bytes());

        // Write chunk_data
        page.payload[4..4 + chunk.len()].copy_from_slice(chunk);

        // Write chunk CRC-32C at the end of the used area
        let crc = crc32c(chunk);
        let crc_offset = 4 + chunk.len();
        page.payload[crc_offset..crc_offset + 4].copy_from_slice(&crc.to_le_bytes());

        page.header.payload_len = (crc_offset + 4) as u32;
        page.dirty = true;

        // Write page to backend
        let bytes = page.to_bytes();
        backend.write_page(page_id, page_size, &bytes)?;

        // Cache in buffer pool
        buffer_pool.put_page(page_id, page)?;
    }

    Ok(page_ids[0])
}

/// Read the full value from an overflow chain, given the first page id.
///
/// Follows the `next_page` links until 0, coalescing all chunks into one buffer.
pub fn read_overflow_chain(
    first_page_id: u64,
    page_size: u32,
    buffer_pool: &BufferPool,
    backend: &dyn FileBackend,
) -> OvnResult<Vec<u8>> {
    let mut result = Vec::new();
    let mut current_page_id = first_page_id;
    let mut visited = 0u32;
    let max_chain_len = 1024 * 1024 / page_size; // Safety: max 1M pages

    while current_page_id != 0 {
        visited += 1;
        if visited > max_chain_len {
            return Err(OvnError::PageCorrupted {
                page_number: current_page_id,
                reason: format!(
                    "Overflow chain exceeds maximum length ({} pages)",
                    max_chain_len
                ),
            });
        }

        let page = buffer_pool.get_page(current_page_id, backend)?;

        if page.header.page_type != PageType::Overflow {
            return Err(OvnError::PageCorrupted {
                page_number: current_page_id,
                reason: format!("Expected overflow page, got {:?}", page.header.page_type),
            });
        }

        // Read chunk_length
        if page.payload.len() < 4 {
            return Err(OvnError::PageCorrupted {
                page_number: current_page_id,
                reason: "Overflow page payload too small".to_string(),
            });
        }
        let chunk_len = u32::from_le_bytes([
            page.payload[0],
            page.payload[1],
            page.payload[2],
            page.payload[3],
        ]) as usize;

        if chunk_len + 4 + 4 > page.payload.len() {
            return Err(OvnError::PageCorrupted {
                page_number: current_page_id,
                reason: format!("Overflow chunk_length {} exceeds page payload", chunk_len),
            });
        }

        let chunk_data = &page.payload[4..4 + chunk_len];

        // Verify chunk CRC-32C
        let crc_offset = 4 + chunk_len;
        let stored_crc = u32::from_le_bytes([
            page.payload[crc_offset],
            page.payload[crc_offset + 1],
            page.payload[crc_offset + 2],
            page.payload[crc_offset + 3],
        ]);
        let computed_crc = crc32c(chunk_data);
        if stored_crc != computed_crc {
            return Err(OvnError::ChecksumMismatch {
                location: format!("overflow page {} chunk", current_page_id),
                expected: stored_crc,
                actual: computed_crc,
            });
        }

        result.extend_from_slice(chunk_data);
        current_page_id = page.header.next_page;
    }

    Ok(result)
}

/// Free all pages in an overflow chain, returning them to the freelist.
pub fn free_overflow_chain(
    first_page_id: u64,
    _page_size: u32,
    freelist: &FreelistManager,
    buffer_pool: &BufferPool,
    backend: &dyn FileBackend,
) -> OvnResult<u32> {
    let mut current = first_page_id;
    let mut freed = 0u32;

    while current != 0 {
        let page = buffer_pool.get_page(current, backend)?;
        let next = page.header.next_page;

        freelist.free_page(current);
        freed += 1;

        current = next;
    }

    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::backend::MemoryBackend;

    fn setup() -> (MemoryBackend, BufferPool, FreelistManager) {
        let backend = MemoryBackend::new();
        let pool = BufferPool::new(4096 * 64, 4096); // 64 page cache
        let freelist = FreelistManager::new(2, 4096); // 2 reserved pages (header + segdir)

        // Pre-extend the backend so page reads don't fail
        let empty = vec![0u8; 4096 * 100];
        backend.write_at(0, &empty).unwrap();
        freelist.set_total_pages(100);

        // Add free pages
        for i in 2..100 {
            freelist.free_page(i);
        }

        (backend, pool, freelist)
    }

    #[test]
    fn test_overflow_small_value() {
        let (backend, pool, freelist) = setup();
        let data = b"hello overflow world!";

        let first_page = write_overflow_chain(data, 4096, &freelist, &pool, &backend).unwrap();
        let read_back = read_overflow_chain(first_page, 4096, &pool, &backend).unwrap();

        assert_eq!(read_back, data.as_slice());
    }

    #[test]
    fn test_overflow_large_value_multi_page() {
        let (backend, pool, freelist) = setup();
        let chunk_cap = overflow_chunk_capacity(4096);

        // Create data that spans 3 pages
        let data = vec![0xABu8; chunk_cap * 3 - 100];

        let first_page = write_overflow_chain(&data, 4096, &freelist, &pool, &backend).unwrap();
        let read_back = read_overflow_chain(first_page, 4096, &pool, &backend).unwrap();

        assert_eq!(read_back.len(), data.len());
        assert_eq!(read_back, data);
    }

    #[test]
    fn test_overflow_free_chain() {
        let (backend, pool, freelist) = setup();
        let data = vec![0xCDu8; overflow_chunk_capacity(4096) * 2];

        let before_free = freelist.free_count();
        let first_page = write_overflow_chain(&data, 4096, &freelist, &pool, &backend).unwrap();
        let after_write = freelist.free_count();
        assert_eq!(after_write, before_free - 2); // 2 pages used

        let freed = free_overflow_chain(first_page, 4096, &freelist, &pool, &backend).unwrap();
        assert_eq!(freed, 2);
        assert_eq!(freelist.free_count(), before_free); // pages returned
    }

    #[test]
    fn test_inline_threshold() {
        assert_eq!(inline_threshold(4096), (4096 - 64) / 4);
        assert_eq!(inline_threshold(8192), (8192 - 64) / 4);
    }
}
