//! Buffer Pool — segmented LRU page cache.
//!
//! The buffer pool is the central page cache. It maintains fixed-size page slots
//! and implements a **segmented LRU** eviction policy:
//!
//! 1. Pages enter the **probationary** segment on first access.
//! 2. If accessed again, they are promoted to the **protected** segment.
//! 3. Eviction targets the probationary segment first, protecting hot pages
//!    from scan-induced cache pollution.
//!
//! Default size: `min(256MB, 25% of available RAM)`.

use parking_lot::RwLock;
use std::collections::HashMap;

use crate::error::OvnResult;
use crate::format::page::{Page, PageType};
use crate::io::FileBackend;

/// A cached page entry with LRU metadata.
#[derive(Debug)]
struct CacheEntry {
    /// The cached page
    page: Page,
    /// Whether this entry is in the protected segment
    protected: bool,
    /// Access counter for promotion decisions
    access_count: u64,
    /// Sequence number for LRU ordering
    seq: u64,
}

/// Segmented-LRU buffer pool for page caching.
pub struct BufferPool {
    /// Page cache: page_number → cached entry
    cache: RwLock<HashMap<u64, CacheEntry>>,
    /// Maximum number of pages to cache
    capacity: usize,
    /// Page size in bytes
    page_size: u32,
    /// Monotonic sequence counter for LRU ordering
    seq_counter: RwLock<u64>,
    /// Ratio of protected vs probationary (0.0 - 1.0)
    /// Reserved for future adaptive resizing — segmented-LRU uses this threshold.
    #[allow(dead_code)]
    protected_ratio: f64,
    /// Statistics
    stats: RwLock<BufferPoolStats>,
}

/// Buffer pool performance statistics.
#[derive(Debug, Default, Clone)]
pub struct BufferPoolStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub dirty_writes: u64,
    pub pages_read: u64,
    pub pages_written: u64,
}

impl BufferPool {
    /// Create a new buffer pool with the given capacity in bytes.
    pub fn new(capacity_bytes: usize, page_size: u32) -> Self {
        let capacity = capacity_bytes / page_size as usize;
        Self {
            cache: RwLock::new(HashMap::with_capacity(capacity)),
            capacity, // use exact capacity for testing
            page_size,
            seq_counter: RwLock::new(0),
            protected_ratio: 0.6, // 60% protected, 40% probationary
            stats: RwLock::new(BufferPoolStats::default()),
        }
    }

    /// Get a page from the cache or load it from the backend.
    pub fn get_page(&self, page_number: u64, backend: &dyn FileBackend) -> OvnResult<Page> {
        // Try cache first
        {
            let mut cache = self.cache.write();
            if let Some(entry) = cache.get_mut(&page_number) {
                entry.access_count += 1;
                entry.seq = self.next_seq();
                // Promote to protected on second access
                if !entry.protected && entry.access_count >= 2 {
                    entry.protected = true;
                }
                self.stats.write().hits += 1;
                return Ok(entry.page.clone());
            }
        }

        // Cache miss — read from disk
        self.stats.write().misses += 1;
        self.stats.write().pages_read += 1;

        let data = backend.read_page(page_number, self.page_size)?;
        let page = Page::from_bytes(&data, self.page_size)?;

        // Insert into cache
        self.insert(page_number, page.clone())?;

        Ok(page)
    }

    /// Insert or update a page in the cache.
    pub fn put_page(&self, page_number: u64, page: Page) -> OvnResult<()> {
        self.insert(page_number, page)
    }

    /// Mark a page as dirty (modified).
    pub fn mark_dirty(&self, page_number: u64) {
        let mut cache = self.cache.write();
        if let Some(entry) = cache.get_mut(&page_number) {
            entry.page.dirty = true;
        }
    }

    /// Flush all dirty pages to the backend.
    pub fn flush_all(&self, backend: &dyn FileBackend) -> OvnResult<()> {
        let cache = self.cache.read();
        for (page_number, entry) in cache.iter() {
            if entry.page.dirty {
                let bytes = entry.page.to_bytes();
                backend.write_page(*page_number, self.page_size, &bytes)?;
                self.stats.write().dirty_writes += 1;
                self.stats.write().pages_written += 1;
            }
        }
        // Clear dirty flags
        drop(cache);
        let mut cache = self.cache.write();
        for entry in cache.values_mut() {
            entry.page.dirty = false;
        }
        Ok(())
    }

    /// Flush a specific dirty page to the backend.
    pub fn flush_page(&self, page_number: u64, backend: &dyn FileBackend) -> OvnResult<()> {
        let cache = self.cache.read();
        if let Some(entry) = cache.get(&page_number) {
            if entry.page.dirty {
                let bytes = entry.page.to_bytes();
                backend.write_page(page_number, self.page_size, &bytes)?;
                self.stats.write().dirty_writes += 1;
                self.stats.write().pages_written += 1;
            }
        }
        drop(cache);
        let mut cache = self.cache.write();
        if let Some(entry) = cache.get_mut(&page_number) {
            entry.page.dirty = false;
        }
        Ok(())
    }

    /// Get buffer pool statistics.
    pub fn stats(&self) -> BufferPoolStats {
        self.stats.read().clone()
    }

    /// Get current number of cached pages.
    pub fn size(&self) -> usize {
        self.cache.read().len()
    }

    /// Get the cache hit rate.
    pub fn hit_rate(&self) -> f64 {
        let stats = self.stats.read();
        let total = stats.hits + stats.misses;
        if total == 0 {
            0.0
        } else {
            stats.hits as f64 / total as f64
        }
    }

    /// Allocate a new page with the given type, returning the page number.
    pub fn allocate_page(
        &self,
        page_type: PageType,
        backend: &dyn FileBackend,
    ) -> OvnResult<(u64, Page)> {
        let file_size = backend.file_size()?;
        let page_number = file_size / self.page_size as u64;

        // Extend the file by one page
        let empty_page = vec![0u8; self.page_size as usize];
        backend.write_page(page_number, self.page_size, &empty_page)?;

        let page = Page::new(page_type, page_number, self.page_size);
        self.insert(page_number, page.clone())?;

        Ok((page_number, page))
    }

    // ── Internal ───────────────────────────────────────────────

    fn insert(&self, page_number: u64, page: Page) -> OvnResult<()> {
        let mut cache = self.cache.write();

        // Evict if at capacity
        if cache.len() >= self.capacity && !cache.contains_key(&page_number) {
            self.evict_one(&mut cache);
        }

        let seq = self.next_seq();
        cache.insert(
            page_number,
            CacheEntry {
                page,
                protected: false,
                access_count: 1,
                seq,
            },
        );

        Ok(())
    }

    fn evict_one(&self, cache: &mut HashMap<u64, CacheEntry>) {
        // First try evicting from probationary segment (not protected)
        let victim = cache
            .iter()
            .filter(|(_, e)| !e.protected && e.page.pin_count == 0)
            .min_by_key(|(_, e)| e.seq)
            .map(|(k, _)| *k);

        if let Some(page_number) = victim {
            cache.remove(&page_number);
            self.stats.write().evictions += 1;
            return;
        }

        // If no probationary victims, evict from protected segment
        let victim = cache
            .iter()
            .filter(|(_, e)| e.page.pin_count == 0)
            .min_by_key(|(_, e)| e.seq)
            .map(|(k, _)| *k);

        if let Some(page_number) = victim {
            cache.remove(&page_number);
            self.stats.write().evictions += 1;
        }
    }

    fn next_seq(&self) -> u64 {
        let mut counter = self.seq_counter.write();
        *counter += 1;
        *counter
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::page::PageType;
    use crate::io::backend::MemoryBackend;

    #[test]
    fn test_buffer_pool_basic() {
        let backend = MemoryBackend::new();
        let pool = BufferPool::new(4096 * 4, 4096); // 4 pages

        // Write pages directly to backend
        for i in 0..3u64 {
            let page = Page::new(PageType::Leaf, i, 4096);
            let bytes = page.to_bytes();
            backend.write_page(i, 4096, &bytes).unwrap();
        }

        // Read through buffer pool
        let page = pool.get_page(0, &backend).unwrap();
        assert_eq!(page.header.page_type, PageType::Leaf);
        assert_eq!(page.header.page_number, 0);

        // Second access should be a cache hit
        let _page2 = pool.get_page(0, &backend).unwrap();
        let stats = pool.stats();
        assert_eq!(stats.hits, 1);
        assert_eq!(stats.misses, 1);
    }

    #[test]
    fn test_buffer_pool_eviction() {
        let backend = MemoryBackend::new();
        let pool = BufferPool::new(4096 * 2, 4096); // Only 2 pages

        // Write 4 pages to backend
        for i in 0..4u64 {
            let page = Page::new(PageType::Leaf, i, 4096);
            backend.write_page(i, 4096, &page.to_bytes()).unwrap();
        }

        // Load all 4 — should trigger evictions
        for i in 0..4u64 {
            pool.get_page(i, &backend).unwrap();
        }

        assert!(pool.stats().evictions > 0);
    }
}
