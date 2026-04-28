//! Document Heap — manages document storage across slotted pages.
//!
//! Implements spec `[[FILE-01]]` §13: documents share pages (small docs,
//! ~10-30 per page) using the slotted-page layout from §4.2. Records are
//! stored in insert order; key order is managed by the primary key index
//! (a separate B+ Tree referencing heap pages).
//!
//! For large documents exceeding the inline threshold, the document is stored
//! in an overflow chain and the heap slot contains a pointer to the first
//! overflow page (see `overflow.rs`).

use std::sync::Arc;

use crate::error::{OvnError, OvnResult};
use crate::format::page::{Page, PageType};
use crate::io::FileBackend;
use crate::storage::buffer_pool::BufferPool;
use crate::storage::freelist::FreelistManager;
use crate::storage::overflow::{
    free_overflow_chain, inline_threshold, read_overflow_chain, write_overflow_chain,
};
use crate::storage::slotted_page::SlottedPage;

/// Pointer to a document stored in the heap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct DocPointer {
    /// Page ID containing the document (or inline pointer to overflow chain).
    pub page_id: u64,
    /// Slot index within the page.
    pub slot_idx: u16,
    /// Whether this points to an overflow chain (doc too large for inline).
    pub is_overflow: bool,
}

impl DocPointer {
    /// Encode to 11 bytes: page_id(8) + slot_idx(2) + flags(1).
    pub fn to_bytes(&self) -> [u8; 11] {
        let mut buf = [0u8; 11];
        buf[0..8].copy_from_slice(&self.page_id.to_le_bytes());
        buf[8..10].copy_from_slice(&self.slot_idx.to_le_bytes());
        buf[10] = if self.is_overflow { 0x01 } else { 0x00 };
        buf
    }

    /// Decode from 11 bytes.
    pub fn from_bytes(buf: &[u8; 11]) -> Self {
        Self {
            page_id: u64::from_le_bytes([
                buf[0], buf[1], buf[2], buf[3], buf[4], buf[5], buf[6], buf[7],
            ]),
            slot_idx: u16::from_le_bytes([buf[8], buf[9]]),
            is_overflow: buf[10] == 0x01,
        }
    }
}

/// Document heap manager.
///
/// Coordinates page allocation, slotted pages, and overflow chains for
/// storing variable-length documents.
pub struct DocumentHeap {
    /// Freelist for page allocation.
    freelist: Arc<FreelistManager>,
    /// Buffer pool for page caching.
    buffer_pool: Arc<BufferPool>,
    /// I/O backend.
    backend: Arc<dyn FileBackend>,
    /// Page size in bytes.
    page_size: u32,
    /// The current page being filled (insertion target).
    current_page_id: parking_lot::Mutex<Option<u64>>,
}

impl DocumentHeap {
    /// Create a new document heap.
    pub fn new(
        freelist: Arc<FreelistManager>,
        buffer_pool: Arc<BufferPool>,
        backend: Arc<dyn FileBackend>,
        page_size: u32,
    ) -> Self {
        Self {
            freelist,
            buffer_pool,
            backend,
            page_size,
            current_page_id: parking_lot::Mutex::new(None),
        }
    }

    /// Store a document, returning a pointer to it.
    ///
    /// If the document is small enough, it's stored inline in a slotted page.
    /// Otherwise, it goes into an overflow chain.
    pub fn store(&self, doc_bytes: &[u8]) -> OvnResult<DocPointer> {
        let threshold = inline_threshold(self.page_size);

        if doc_bytes.len() > threshold {
            // Large document → overflow chain
            let first_page = write_overflow_chain(
                doc_bytes,
                self.page_size,
                &self.freelist,
                &self.buffer_pool,
                self.backend.as_ref(),
            )?;

            Ok(DocPointer {
                page_id: first_page,
                slot_idx: 0,
                is_overflow: true,
            })
        } else {
            // Inline: find a page with space or allocate a new one
            self.store_inline(doc_bytes)
        }
    }

    /// Read a document given its pointer.
    pub fn read(&self, ptr: &DocPointer) -> OvnResult<Vec<u8>> {
        if ptr.is_overflow {
            read_overflow_chain(
                ptr.page_id,
                self.page_size,
                &self.buffer_pool,
                self.backend.as_ref(),
            )
        } else {
            let page = self
                .buffer_pool
                .get_page(ptr.page_id, self.backend.as_ref())?;
            let mut page_mut = page.clone();
            let sp = SlottedPage::new(&mut page_mut);

            sp.get(ptr.slot_idx as usize)
                .map(|data| data.to_vec())
                .ok_or_else(|| {
                    OvnError::EncodingError(format!(
                        "Document at page {} slot {} not found or tombstoned",
                        ptr.page_id, ptr.slot_idx
                    ))
                })
        }
    }

    /// Delete a document (tombstone for inline, free chain for overflow).
    pub fn delete(&self, ptr: &DocPointer) -> OvnResult<()> {
        if ptr.is_overflow {
            free_overflow_chain(
                ptr.page_id,
                self.page_size,
                &self.freelist,
                &self.buffer_pool,
                self.backend.as_ref(),
            )?;
            Ok(())
        } else {
            let page = self
                .buffer_pool
                .get_page(ptr.page_id, self.backend.as_ref())?;
            let mut page_mut = page.clone();
            let mut sp = SlottedPage::new(&mut page_mut);

            if sp.delete(ptr.slot_idx as usize) {
                // Write back the modified page
                let bytes = page_mut.to_bytes();
                self.backend
                    .write_page(ptr.page_id, self.page_size, &bytes)?;
                self.buffer_pool.put_page(ptr.page_id, page_mut)?;
                Ok(())
            } else {
                Err(OvnError::EncodingError(format!(
                    "Cannot delete document at page {} slot {}",
                    ptr.page_id, ptr.slot_idx
                )))
            }
        }
    }

    /// Update a document in-place if it fits, or rewrite to new location.
    ///
    /// Returns the new pointer (may differ from the old one if the doc grew).
    pub fn update(&self, old_ptr: &DocPointer, new_bytes: &[u8]) -> OvnResult<DocPointer> {
        // Delete old, store new
        self.delete(old_ptr)?;
        self.store(new_bytes)
    }

    // ── Internal ───────────────────────────────────────────────

    /// Store a small document inline in a slotted page.
    fn store_inline(&self, doc_bytes: &[u8]) -> OvnResult<DocPointer> {
        // Try the current page first
        let mut current = self.current_page_id.lock();

        if let Some(page_id) = *current {
            let page = self.buffer_pool.get_page(page_id, self.backend.as_ref())?;
            let mut page_mut = page.clone();
            let mut sp = SlottedPage::new(&mut page_mut);

            if sp.can_fit(doc_bytes.len()) {
                let slot_idx = sp.insert(doc_bytes)?;

                // Write back
                let bytes = page_mut.to_bytes();
                self.backend.write_page(page_id, self.page_size, &bytes)?;
                self.buffer_pool.put_page(page_id, page_mut)?;

                return Ok(DocPointer {
                    page_id,
                    slot_idx: slot_idx as u16,
                    is_overflow: false,
                });
            }
        }

        // Current page is full or doesn't exist — allocate new page
        let new_page_id = self.freelist.allocate(self.backend.as_ref())?;
        let mut page = Page::new(PageType::DocumentHeap, new_page_id, self.page_size);

        {
            let mut sp = SlottedPage::new(&mut page);
            let slot_idx = sp.insert(doc_bytes)?;

            let bytes = page.to_bytes();
            self.backend
                .write_page(new_page_id, self.page_size, &bytes)?;
            self.buffer_pool
                .put_page(new_page_id, Page::from_bytes(&bytes, self.page_size)?)?;

            *current = Some(new_page_id);

            Ok(DocPointer {
                page_id: new_page_id,
                slot_idx: slot_idx as u16,
                is_overflow: false,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::backend::MemoryBackend;

    fn setup_heap() -> DocumentHeap {
        let backend = Arc::new(MemoryBackend::new());
        let pool = Arc::new(BufferPool::new(4096 * 64, 4096));
        let freelist = Arc::new(FreelistManager::new(2, 4096));

        // Pre-extend backend
        let empty = vec![0u8; 4096 * 100];
        backend.write_at(0, &empty).unwrap();
        freelist.set_total_pages(100);
        for i in 2..100 {
            freelist.free_page(i);
        }

        DocumentHeap::new(freelist, pool, backend, 4096)
    }

    #[test]
    fn test_heap_store_and_read_inline() {
        let heap = setup_heap();

        let ptr = heap.store(b"Hello, Nova Engine!").unwrap();
        assert!(!ptr.is_overflow);

        let data = heap.read(&ptr).unwrap();
        assert_eq!(data, b"Hello, Nova Engine!");
    }

    #[test]
    fn test_heap_store_multiple_in_same_page() {
        let heap = setup_heap();

        let ptr1 = heap.store(b"doc_1").unwrap();
        let ptr2 = heap.store(b"doc_2").unwrap();
        let ptr3 = heap.store(b"doc_3").unwrap();

        // All should be in the same page (small docs)
        assert_eq!(ptr1.page_id, ptr2.page_id);
        assert_eq!(ptr2.page_id, ptr3.page_id);
        assert_eq!(ptr1.slot_idx, 0);
        assert_eq!(ptr2.slot_idx, 1);
        assert_eq!(ptr3.slot_idx, 2);

        assert_eq!(heap.read(&ptr1).unwrap(), b"doc_1");
        assert_eq!(heap.read(&ptr2).unwrap(), b"doc_2");
        assert_eq!(heap.read(&ptr3).unwrap(), b"doc_3");
    }

    #[test]
    fn test_heap_store_overflow() {
        let heap = setup_heap();

        // Create a document larger than inline threshold
        let threshold = inline_threshold(4096);
        let big_doc = vec![0xAB; threshold + 100];

        let ptr = heap.store(&big_doc).unwrap();
        assert!(ptr.is_overflow);

        let data = heap.read(&ptr).unwrap();
        assert_eq!(data.len(), big_doc.len());
        assert_eq!(data, big_doc);
    }

    #[test]
    fn test_heap_delete_inline() {
        let heap = setup_heap();

        let ptr = heap.store(b"temporary").unwrap();
        assert!(heap.read(&ptr).is_ok());

        heap.delete(&ptr).unwrap();
        assert!(heap.read(&ptr).is_err()); // tombstoned
    }

    #[test]
    fn test_heap_update() {
        let heap = setup_heap();

        let ptr1 = heap.store(b"original").unwrap();
        let ptr2 = heap.update(&ptr1, b"updated value").unwrap();

        // Old pointer should be invalid
        assert!(heap.read(&ptr1).is_err());
        // New pointer should work
        assert_eq!(heap.read(&ptr2).unwrap(), b"updated value");
    }

    #[test]
    fn test_doc_pointer_roundtrip() {
        let ptr = DocPointer {
            page_id: 42,
            slot_idx: 7,
            is_overflow: true,
        };
        let bytes = ptr.to_bytes();
        let decoded = DocPointer::from_bytes(&bytes);
        assert_eq!(decoded, ptr);
    }
}
