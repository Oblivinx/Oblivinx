use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::error::OvnResult;
use crate::format::page::{Page, PageType, SlotEntry, PAGE_HEADER_SIZE};
use crate::io::FileBackend;
use crate::storage::btree::{BPlusTree, BTreeEntry};
use crate::storage::buffer_pool::BufferPool;

/// Disk-based B+ Tree that persists nodes through the buffer pool.
pub struct DiskBPlusTree {
    /// In-memory B+ tree structure (logical view)
    tree: Arc<BPlusTree>,
    /// Buffer pool for page caching
    buffer_pool: Arc<BufferPool>,
    /// I/O backend for disk access
    backend: Arc<dyn FileBackend>,
    /// Page size
    page_size: u32,
    /// Page number of the root node
    root_page: parking_lot::Mutex<u64>,
    /// Whether the tree has been modified (dirty flag)
    dirty: AtomicBool,
}

impl DiskBPlusTree {
    /// Create a new disk-based B+ tree.
    pub fn new(
        tree: Arc<BPlusTree>,
        buffer_pool: Arc<BufferPool>,
        backend: Arc<dyn FileBackend>,
        page_size: u32,
        root_page: u64,
    ) -> Self {
        Self {
            tree,
            buffer_pool,
            backend,
            page_size,
            root_page: parking_lot::Mutex::new(root_page),
            dirty: AtomicBool::new(false),
        }
    }

    /// Insert a key-value pair and mark dirty for eventual flush.
    pub fn insert(&self, entry: BTreeEntry) -> OvnResult<()> {
        self.tree.insert(entry)?;
        self.dirty.store(true, Ordering::SeqCst);
        Ok(())
    }

    /// Point lookup (uses in-memory tree which is backed by buffer pool).
    pub fn get(&self, key: &[u8]) -> Option<BTreeEntry> {
        self.tree.get(key)
    }

    /// Range scan.
    pub fn range_scan(&self, from: &[u8], to: &[u8]) -> Vec<BTreeEntry> {
        self.tree.range_scan(from, to)
    }

    /// Delete a key.
    pub fn delete(&self, key: &[u8]) -> Option<BTreeEntry> {
        let result = self.tree.delete(key);
        if result.is_some() {
            self.dirty.store(true, Ordering::SeqCst);
        }
        result
    }

    /// Full scan.
    pub fn scan_all(&self) -> Vec<BTreeEntry> {
        self.tree.scan_all()
    }

    /// Flush dirty tree to disk as leaf pages.
    pub fn flush_to_disk(&self) -> OvnResult<()> {
        if !self.dirty.load(Ordering::SeqCst) {
            return Ok(());
        }

        let entries = self.tree.scan_all();
        if entries.is_empty() {
            return Ok(());
        }

        let usable = (self.page_size as usize).saturating_sub(PAGE_HEADER_SIZE + 8);
        let avg_entry_size = 32usize;
        let entries_per_page = (usable / (4 + avg_entry_size)).max(1);

        let current_size = self.backend.file_size()?;
        let start_page = current_size.div_ceil(self.page_size as u64);

        let mut page_num = start_page;
        let mut prev_page_num: Option<u64> = None;

        for chunk in entries.chunks(entries_per_page) {
            let mut page = Page::new(PageType::Leaf, page_num, self.page_size);
            page.header.txid = chunk.last().map(|e| e.txid).unwrap_or(0);

            let payload_len = page.payload.len();
            let mut data_offset = payload_len;

            for (i, entry) in chunk.iter().enumerate() {
                let data = if entry.tombstone {
                    vec![0xFF]
                } else {
                    entry.value.clone()
                };
                let len = data.len();
                if data_offset < len { break; }
                data_offset -= len;
                page.payload[data_offset..data_offset + len].copy_from_slice(&data);

                let slot = SlotEntry {
                    doc_offset: data_offset as u16,
                    doc_length: len as u16,
                };
                let slot_offset = i * 4;
                if slot_offset + 4 <= page.payload.len() {
                    page.payload[slot_offset..slot_offset + 2]
                        .copy_from_slice(&slot.doc_offset.to_le_bytes());
                    page.payload[slot_offset + 2..slot_offset + 4]
                        .copy_from_slice(&slot.doc_length.to_le_bytes());
                }
            }

            page.header.slot_count = chunk.len() as u16;
            page.header.free_space_offset = data_offset as u16;

            if let Some(prev) = prev_page_num {
                page.header.right_sibling = prev as u32;
            }

            self.backend.write_page(page_num, self.page_size, &page.to_bytes())?;
            self.buffer_pool.put_page(page_num, page)?;

            prev_page_num = Some(page_num);
            page_num += 1;
        }

        *self.root_page.lock() = start_page;

        self.backend.sync()?;
        self.dirty.store(false, Ordering::SeqCst);

        Ok(())
    }

    /// Get total entries.
    pub fn len(&self) -> u64 {
        self.tree.len()
    }

    /// Check if empty.
    pub fn is_empty(&self) -> bool {
        self.tree.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::backend::MemoryBackend;
    use crate::storage::btree::BPlusTree;
    use crate::storage::buffer_pool::BufferPool;
    use std::sync::Arc;

    fn make_entry(key: &str, value: &str, txid: u64) -> BTreeEntry {
        BTreeEntry {
            key: key.as_bytes().to_vec(),
            value: value.as_bytes().to_vec(),
            txid,
            tombstone: false,
        }
    }

    #[test]
    fn test_disk_btree_insert_and_flush() {
        let tree = Arc::new(BPlusTree::new());
        let backend = Arc::new(MemoryBackend::new());
        let buffer_pool = Arc::new(BufferPool::new(4096 * 10, 4096));

        let disk_tree = DiskBPlusTree::new(tree, buffer_pool, backend.clone(), 4096, 2);

        for i in 0..10 {
            let key = format!("key_{:03}", i);
            disk_tree.insert(make_entry(&key, "value", i as u64)).unwrap();
        }

        assert_eq!(disk_tree.len(), 10);
        assert!(disk_tree.get(b"key_005").is_some());

        disk_tree.flush_to_disk().unwrap();

        // Verify data was written (MemoryBackend tracks writes)
        let file_size = backend.file_size().unwrap();
        assert!(file_size > 0); // At least some data was written
    }

    #[test]
    fn test_disk_btree_range_scan() {
        let tree = Arc::new(BPlusTree::new());
        let backend = Arc::new(MemoryBackend::new());
        let buffer_pool = Arc::new(BufferPool::new(4096 * 10, 4096));

        let disk_tree = DiskBPlusTree::new(tree, buffer_pool, backend, 4096, 2);

        for i in 0..20 {
            let key = format!("key_{:03}", i);
            disk_tree.insert(make_entry(&key, &format!("val_{}", i), i as u64)).unwrap();
        }

        let results = disk_tree.range_scan(b"key_005", b"key_010");
        assert_eq!(results.len(), 5);
    }
}
