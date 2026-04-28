//! Freelist — free page management for page allocation and reuse.
//!
//! Implements spec `[[FILE-01]]` §7:
//! - **Freelist**: linked list of free pages, head pointer in file header.
//! - **Allocate**: pop from head (O(1)). If empty, grow file.
//! - **Free**: push to head (O(1)).
//!
//! Each freelist trunk page holds up to `(PAGE_SIZE - 64) / 8 - 1` free page
//! ids and a `next_trunk` pointer. Leaf pages are simply individual freed pages.
//!
//! ## Two-level structure
//!
//! ```text
//! File header → free_pages_head
//!                  ↓
//!           ┌──────────────┐
//!           │ Trunk page 0 │ → [leaf_id_1, leaf_id_2, ..., leaf_id_N, next_trunk]
//!           └──────────────┘
//!                  ↓ (next_trunk)
//!           ┌──────────────┐
//!           │ Trunk page 1 │ → [leaf_id_N+1, ..., next_trunk=0]
//!           └──────────────┘
//! ```

use parking_lot::Mutex;
use std::collections::VecDeque;

use crate::error::OvnResult;
use crate::io::FileBackend;

/// In-memory freelist manager.
///
/// Tracks free page ids in a FIFO queue. Pages are allocated from the front
/// (oldest freed first, to maximize sequential I/O) and freed to the back.
pub struct FreelistManager {
    /// Queue of free page ids (FIFO: allocate from front, free to back).
    free_pages: Mutex<VecDeque<u64>>,
    /// Total number of pages currently in the database file.
    total_pages: Mutex<u64>,
    /// Page size in bytes (needed for file growth).
    page_size: u32,
    /// Number of pages to pre-allocate when the file grows (amortized).
    grow_batch_size: u64,
}

impl FreelistManager {
    /// Create a new freelist manager.
    ///
    /// `total_pages` is the current number of pages in the file.
    /// `page_size` is the page size in bytes.
    pub fn new(total_pages: u64, page_size: u32) -> Self {
        Self {
            free_pages: Mutex::new(VecDeque::new()),
            total_pages: Mutex::new(total_pages),
            page_size,
            grow_batch_size: 16, // Grow 16 pages at a time (128 KB for 8 KB pages)
        }
    }

    /// Allocate a page, returning its page id.
    ///
    /// If the freelist has pages, pops from the front (O(1)).
    /// Otherwise, grows the file by `grow_batch_size` pages and returns the first new page.
    pub fn allocate(&self, backend: &dyn FileBackend) -> OvnResult<u64> {
        let mut free = self.free_pages.lock();

        // Try to reuse a freed page
        if let Some(page_id) = free.pop_front() {
            return Ok(page_id);
        }

        // No free pages — grow the file
        drop(free);
        self.grow_file(backend)
    }

    /// Free a page, making it available for future allocation.
    pub fn free_page(&self, page_id: u64) {
        let mut free = self.free_pages.lock();
        // Avoid duplicates (defensive — shouldn't happen in correct code)
        if !free.contains(&page_id) {
            free.push_back(page_id);
        }
    }

    /// Get the number of free pages available.
    pub fn free_count(&self) -> usize {
        self.free_pages.lock().len()
    }

    /// Get the total number of pages in the file.
    pub fn total_pages(&self) -> u64 {
        *self.total_pages.lock()
    }

    /// Set the total number of pages (e.g., after loading from header).
    pub fn set_total_pages(&self, total: u64) {
        *self.total_pages.lock() = total;
    }

    /// Shrink the file by removing trailing free pages.
    ///
    /// Returns the number of pages reclaimed. Only removes pages from the
    /// end of the file — never moves live pages.
    pub fn shrink_to_fit(&self, backend: &dyn FileBackend) -> OvnResult<u64> {
        let mut free = self.free_pages.lock();
        let mut total = self.total_pages.lock();
        let mut reclaimed = 0u64;

        // Sort free pages to find trailing ones
        let mut sorted: Vec<u64> = free.iter().copied().collect();
        sorted.sort_unstable();

        // Remove pages from the end of the file
        while let Some(&last_free) = sorted.last() {
            if last_free == *total - 1 {
                sorted.pop();
                *total -= 1;
                reclaimed += 1;
            } else {
                break;
            }
        }

        if reclaimed > 0 {
            // Rebuild the free queue from remaining sorted pages
            free.clear();
            for page_id in sorted {
                free.push_back(page_id);
            }

            // Truncate the file
            let new_size = *total * self.page_size as u64;
            backend.truncate(new_size)?;
        }

        Ok(reclaimed)
    }

    /// Populate the freelist from a list of page ids (e.g., during recovery).
    pub fn load_from(&self, page_ids: impl IntoIterator<Item = u64>) {
        let mut free = self.free_pages.lock();
        for id in page_ids {
            if !free.contains(&id) {
                free.push_back(id);
            }
        }
    }

    /// Get all free page ids (for persistence to disk).
    pub fn all_free_pages(&self) -> Vec<u64> {
        self.free_pages.lock().iter().copied().collect()
    }

    // ── Internal ───────────────────────────────────────────────

    /// Grow the file by `grow_batch_size` pages. Returns the first new page id.
    fn grow_file(&self, backend: &dyn FileBackend) -> OvnResult<u64> {
        let mut total = self.total_pages.lock();
        let first_new = *total;

        // Pre-allocate in batch
        let end = first_new + self.grow_batch_size;
        let new_file_size = end * self.page_size as u64;

        // Extend the file by writing zeros to the last byte
        let current_size = backend.file_size()?;
        if new_file_size > current_size {
            // Write a single zero byte at the end to extend the file
            let zero = [0u8; 1];
            backend.write_at(new_file_size - 1, &zero)?;
        }

        *total = end;

        // Add the extra pages (beyond the first) to the freelist
        if self.grow_batch_size > 1 {
            let mut free = self.free_pages.lock();
            for page_id in (first_new + 1)..end {
                free.push_back(page_id);
            }
        }

        Ok(first_new)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal in-memory backend for freelist tests.
    struct TestBackend {
        size: Mutex<u64>,
    }

    impl TestBackend {
        fn new(size: u64) -> Self {
            Self {
                size: Mutex::new(size),
            }
        }
    }

    impl FileBackend for TestBackend {
        fn read_page(&self, _page_number: u64, _page_size: u32) -> OvnResult<Vec<u8>> {
            Ok(vec![0u8; 4096])
        }
        fn write_page(&self, _page_number: u64, _page_size: u32, _data: &[u8]) -> OvnResult<()> {
            Ok(())
        }
        fn append(&self, data: &[u8]) -> OvnResult<u64> {
            let mut s = self.size.lock();
            let offset = *s;
            *s += data.len() as u64;
            Ok(offset)
        }
        fn sync(&self) -> OvnResult<()> {
            Ok(())
        }
        fn file_size(&self) -> OvnResult<u64> {
            Ok(*self.size.lock())
        }
        fn truncate(&self, size: u64) -> OvnResult<()> {
            *self.size.lock() = size;
            Ok(())
        }
        fn read_at(&self, _offset: u64, length: usize) -> OvnResult<Vec<u8>> {
            Ok(vec![0u8; length])
        }
        fn write_at(&self, offset: u64, data: &[u8]) -> OvnResult<()> {
            let mut s = self.size.lock();
            let end = offset + data.len() as u64;
            if end > *s {
                *s = end;
            }
            Ok(())
        }
    }

    #[test]
    fn test_freelist_allocate_reuse() {
        let backend = TestBackend::new(4096 * 10); // 10 pages
        let fl = FreelistManager::new(10, 4096);

        // Free pages 5 and 7
        fl.free_page(5);
        fl.free_page(7);
        assert_eq!(fl.free_count(), 2);

        // Allocate should return 5 first (FIFO)
        let p1 = fl.allocate(&backend).unwrap();
        assert_eq!(p1, 5);

        let p2 = fl.allocate(&backend).unwrap();
        assert_eq!(p2, 7);

        // No more free pages — should grow
        let p3 = fl.allocate(&backend).unwrap();
        assert_eq!(p3, 10); // first page after the original 10
    }

    #[test]
    fn test_freelist_grow_batch() {
        let backend = TestBackend::new(4096 * 2); // 2 pages
        let fl = FreelistManager::new(2, 4096);

        // First allocate grows the file
        let p1 = fl.allocate(&backend).unwrap();
        assert_eq!(p1, 2);

        // Batch growth adds 15 more pages to freelist
        assert_eq!(fl.free_count(), 15); // grow_batch_size=16, first returned, 15 remain

        // Next 15 allocates come from freelist
        for i in 3..18u64 {
            let p = fl.allocate(&backend).unwrap();
            assert_eq!(p, i);
        }
        assert_eq!(fl.free_count(), 0);
    }

    #[test]
    fn test_freelist_no_duplicates() {
        let fl = FreelistManager::new(10, 4096);
        fl.free_page(5);
        fl.free_page(5); // duplicate
        assert_eq!(fl.free_count(), 1);
    }

    #[test]
    fn test_freelist_shrink_to_fit() {
        let backend = TestBackend::new(4096 * 10);
        let fl = FreelistManager::new(10, 4096);

        // Free the last 3 pages
        fl.free_page(7);
        fl.free_page(8);
        fl.free_page(9);

        let reclaimed = fl.shrink_to_fit(&backend).unwrap();
        assert_eq!(reclaimed, 3);
        assert_eq!(fl.total_pages(), 7);
        assert_eq!(fl.free_count(), 0);
    }
}
