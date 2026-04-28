//! Page Allocator — unified page allocation and management.
//!
//! Integrates the freelist, buffer pool, and file backend into a single
//! interface for page allocation, reading, writing, and freeing. This is
//! the component that the B+ tree and document heap layers call to manage
//! pages on disk.
//!
//! Implements spec `[[FILE-01]]` §7.3: allocation policy.

use std::sync::Arc;

use crate::error::OvnResult;
use crate::format::page::{Page, PageType, PAGE_HEADER_SIZE};
use crate::io::FileBackend;
use crate::storage::buffer_pool::BufferPool;
use crate::storage::freelist::FreelistManager;

/// Central page allocator coordinating freelist + buffer pool + backend.
pub struct PageAllocator {
    /// Freelist for free page tracking.
    pub freelist: Arc<FreelistManager>,
    /// Buffer pool for page caching.
    pub buffer_pool: Arc<BufferPool>,
    /// I/O backend for disk access.
    pub backend: Arc<dyn FileBackend>,
    /// Page size in bytes.
    pub page_size: u32,
}

impl PageAllocator {
    /// Create a new page allocator.
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
        }
    }

    /// Allocate a new page of the given type.
    ///
    /// Tries the freelist first; if empty, grows the file.
    /// The page is initialized with the given type and cached in the buffer pool.
    pub fn allocate(&self, page_type: PageType) -> OvnResult<(u64, Page)> {
        let page_id = self.freelist.allocate(self.backend.as_ref())?;
        let page = Page::new(page_type, page_id, self.page_size);

        // Write to disk immediately (to reserve the space)
        let bytes = page.to_bytes();
        self.backend.write_page(page_id, self.page_size, &bytes)?;

        // Cache in buffer pool
        self.buffer_pool.put_page(page_id, page.clone())?;

        Ok((page_id, page))
    }

    /// Read a page from the cache or disk.
    pub fn read_page(&self, page_id: u64) -> OvnResult<Page> {
        self.buffer_pool.get_page(page_id, self.backend.as_ref())
    }

    /// Write a page to disk and update the cache.
    pub fn write_page(&self, page_id: u64, page: &Page) -> OvnResult<()> {
        let bytes = page.to_bytes();
        self.backend.write_page(page_id, self.page_size, &bytes)?;
        self.buffer_pool.put_page(page_id, page.clone())?;
        Ok(())
    }

    /// Free a page (mark it as available for reuse).
    pub fn free_page(&self, page_id: u64) -> OvnResult<()> {
        // Write a zeroed page to mark it as free
        let free_page = Page::new(PageType::Free, page_id, self.page_size);
        let bytes = free_page.to_bytes();
        self.backend.write_page(page_id, self.page_size, &bytes)?;
        self.buffer_pool.put_page(page_id, free_page)?;

        self.freelist.free_page(page_id);
        Ok(())
    }

    /// Get the inline payload size per page (page_size - header).
    pub fn payload_size(&self) -> usize {
        self.page_size as usize - PAGE_HEADER_SIZE
    }

    /// Get freelist statistics.
    pub fn free_page_count(&self) -> usize {
        self.freelist.free_count()
    }

    /// Get total pages in the database.
    pub fn total_pages(&self) -> u64 {
        self.freelist.total_pages()
    }

    /// Sync all dirty pages to disk.
    pub fn flush(&self) -> OvnResult<()> {
        self.buffer_pool.flush_all(self.backend.as_ref())?;
        self.backend.sync()?;
        Ok(())
    }

    /// Shrink the file to reclaim trailing free pages.
    pub fn shrink_to_fit(&self) -> OvnResult<u64> {
        self.freelist.shrink_to_fit(self.backend.as_ref())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::backend::MemoryBackend;

    fn setup_allocator() -> PageAllocator {
        let backend = Arc::new(MemoryBackend::new());
        let pool = Arc::new(BufferPool::new(4096 * 32, 4096));
        let freelist = Arc::new(FreelistManager::new(2, 4096));

        // Pre-extend the backend
        let empty = vec![0u8; 4096 * 2]; // 2 reserved pages
        backend.write_at(0, &empty).unwrap();

        PageAllocator::new(freelist, pool, backend, 4096)
    }

    #[test]
    fn test_allocate_and_read() {
        let alloc = setup_allocator();

        let (id, mut page) = alloc.allocate(PageType::Leaf).unwrap();
        assert!(id >= 2); // Pages 0,1 are reserved

        // Modify and write back
        page.payload[0..5].copy_from_slice(b"hello");
        page.dirty = true;
        alloc.write_page(id, &page).unwrap();

        // Read back
        let read = alloc.read_page(id).unwrap();
        assert_eq!(&read.payload[0..5], b"hello");
        assert_eq!(read.header.page_type, PageType::Leaf);
    }

    #[test]
    fn test_allocate_and_free() {
        let alloc = setup_allocator();

        let (id1, _) = alloc.allocate(PageType::Leaf).unwrap();
        let (id2, _) = alloc.allocate(PageType::Interior).unwrap();

        let free_before = alloc.free_page_count();
        alloc.free_page(id1).unwrap();
        assert_eq!(alloc.free_page_count(), free_before + 1);

        // Drain remaining batch-allocated pages first
        let remaining = alloc.free_page_count();
        let mut drained = Vec::new();
        for _ in 0..remaining {
            let (id, _) = alloc.allocate(PageType::Leaf).unwrap();
            drained.push(id);
        }

        // The last drained should be id1 (it was pushed to the back of FIFO)
        assert_eq!(
            *drained.last().unwrap(),
            id1,
            "Freed page should be reused via FIFO"
        );
        let _ = id2; // suppress warning
    }

    #[test]
    fn test_multiple_allocations() {
        let alloc = setup_allocator();

        let mut ids = Vec::new();
        for _ in 0..20 {
            let (id, _) = alloc.allocate(PageType::Leaf).unwrap();
            ids.push(id);
        }

        // All ids should be unique
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), 20);
    }
}
