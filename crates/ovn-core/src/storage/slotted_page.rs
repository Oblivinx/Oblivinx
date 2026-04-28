//! Slotted page layout — spec `[[FILE-01]]` §4.2.
//!
//! Variable-length records within a page use a **slot array growing from the
//! end** and **data growing from the start** (after the 64-byte header).
//!
//! ```text
//! Offset 0       64                 free_offset       PAGE_SIZE
//!        │       │                  │                 │
//!        ▼       ▼                  ▼                 ▼
//!        ┌──────────┬──────────────┬────────────────┬───────────────┐
//!        │  Header  │ Records ───► │     FREE       │ ◄─── Slots    │
//!        └──────────┴──────────────┴────────────────┴───────────────┘
//!         (64 B)                                      (4 B per slot)
//!
//! Slot[N]  at offset PAGE_SIZE - 4*(N+1)   (from the END of the payload)
//! Slot[0]  at offset PAGE_SIZE - 4         (last 4 bytes of the page)
//! ```
//!
//! Each slot is a packed u32:
//! - bits 0..15  = record offset (within payload, from payload start)
//! - bits 16..30 = record length
//! - bit 31      = tombstone flag

use crate::error::{OvnError, OvnResult};
use crate::format::page::{Page, SlotEntry};

/// Manager for a slotted page layout.
///
/// Operates on a mutable `Page` reference, providing insert/delete/get
/// operations on variable-length records.
pub struct SlottedPage<'a> {
    page: &'a mut Page,
}

impl<'a> SlottedPage<'a> {
    /// Wrap an existing page for slotted operations.
    pub fn new(page: &'a mut Page) -> Self {
        Self { page }
    }

    /// Get the payload size (excluding header).
    fn payload_size(&self) -> usize {
        self.page.payload.len()
    }

    /// Number of slots (including tombstoned ones).
    pub fn slot_count(&self) -> usize {
        self.page.header.record_count as usize
    }

    /// Current free offset (next available byte for data, from payload start).
    pub fn free_offset(&self) -> usize {
        self.page.header.free_offset as usize
    }

    /// Available free space in the page.
    pub fn free_space(&self) -> usize {
        let slot_area = self.slot_count() * 4;
        let data_end = self.free_offset();
        self.payload_size().saturating_sub(data_end + slot_area)
    }

    /// Can we fit a record of `record_len` bytes?
    pub fn can_fit(&self, record_len: usize) -> bool {
        // Need space for: record data + 1 new slot entry (4 bytes)
        self.free_space() >= record_len + 4
    }

    /// Insert a record, returning the slot index.
    ///
    /// Returns `Err(PageFull)` if there's not enough space.
    pub fn insert(&mut self, record: &[u8]) -> OvnResult<usize> {
        let record_len = record.len();

        if !self.can_fit(record_len) {
            return Err(OvnError::EncodingError(
                "Page full: cannot insert record".to_string(),
            ));
        }

        let data_offset = self.free_offset();
        let slot_idx = self.slot_count();

        // Write record data at free_offset
        self.page.payload[data_offset..data_offset + record_len].copy_from_slice(record);

        // Write slot entry at the end of the payload
        let slot = SlotEntry {
            doc_offset: data_offset as u16,
            doc_length: record_len as u16,
            tombstone: false,
        };
        self.write_slot(slot_idx, &slot);

        // Update header
        self.page.header.free_offset = (data_offset + record_len) as u32;
        self.page.header.record_count += 1;
        self.page.header.payload_len = self.page.header.free_offset;
        self.page.dirty = true;

        Ok(slot_idx)
    }

    /// Get a record by slot index.
    pub fn get(&self, slot_idx: usize) -> Option<&[u8]> {
        if slot_idx >= self.slot_count() {
            return None;
        }

        let slot = self.read_slot(slot_idx);
        if slot.tombstone {
            return None;
        }

        let start = slot.doc_offset as usize;
        let end = start + slot.doc_length as usize;
        if end <= self.payload_size() {
            Some(&self.page.payload[start..end])
        } else {
            None
        }
    }

    /// Delete a record by slot index (sets tombstone flag).
    pub fn delete(&mut self, slot_idx: usize) -> bool {
        if slot_idx >= self.slot_count() {
            return false;
        }

        let mut slot = self.read_slot(slot_idx);
        if slot.tombstone {
            return false; // Already deleted
        }

        slot.tombstone = true;
        self.write_slot(slot_idx, &slot);
        self.page.dirty = true;
        true
    }

    /// Get the live (non-tombstoned) record count.
    pub fn live_count(&self) -> usize {
        (0..self.slot_count())
            .filter(|&i| !self.read_slot(i).tombstone)
            .count()
    }

    /// Live ratio: fraction of slots that are not tombstoned.
    pub fn live_ratio(&self) -> f64 {
        let total = self.slot_count();
        if total == 0 {
            return 1.0;
        }
        self.live_count() as f64 / total as f64
    }

    /// Should this page be compacted? (live ratio < 70% per spec)
    pub fn needs_compaction(&self) -> bool {
        self.slot_count() > 0 && self.live_ratio() < 0.70
    }

    /// Compact the page: remove tombstoned records and reclaim space.
    ///
    /// Returns the number of records reclaimed.
    pub fn compact(&mut self) -> usize {
        let mut live_records: Vec<Vec<u8>> = Vec::new();

        for i in 0..self.slot_count() {
            if let Some(data) = self.get(i) {
                live_records.push(data.to_vec());
            }
        }

        let reclaimed = self.slot_count() - live_records.len();

        // Reset page
        self.page.header.free_offset = 0;
        self.page.header.record_count = 0;
        self.page.payload.fill(0);
        self.page.dirty = true;

        // Re-insert live records
        for record in &live_records {
            let _ = self.insert(record);
        }

        reclaimed
    }

    /// Iterate over all live records.
    pub fn iter(&self) -> impl Iterator<Item = (usize, &[u8])> {
        (0..self.slot_count()).filter_map(move |i| self.get(i).map(|data| (i, data)))
    }

    // ── Internal ───────────────────────────────────────────────

    /// Read a slot entry from the end of the payload.
    fn read_slot(&self, slot_idx: usize) -> SlotEntry {
        let offset = self.slot_offset(slot_idx);
        if offset + 4 <= self.payload_size() {
            let packed = u32::from_le_bytes([
                self.page.payload[offset],
                self.page.payload[offset + 1],
                self.page.payload[offset + 2],
                self.page.payload[offset + 3],
            ]);
            SlotEntry::from_packed(packed)
        } else {
            SlotEntry {
                doc_offset: 0,
                doc_length: 0,
                tombstone: true,
            }
        }
    }

    /// Write a slot entry at the end of the payload.
    fn write_slot(&mut self, slot_idx: usize, slot: &SlotEntry) {
        let offset = self.slot_offset(slot_idx);
        let packed = slot.to_packed().to_le_bytes();
        self.page.payload[offset..offset + 4].copy_from_slice(&packed);
    }

    /// Get the byte offset within payload for a given slot index.
    /// Slots grow backwards from the end of the payload.
    fn slot_offset(&self, slot_idx: usize) -> usize {
        self.payload_size() - 4 * (slot_idx + 1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::page::PageType;

    #[test]
    fn test_slotted_page_insert_and_get() {
        let mut page = Page::new(PageType::DocumentHeap, 5, 4096);
        let mut sp = SlottedPage::new(&mut page);

        let idx = sp.insert(b"Hello, World!").unwrap();
        assert_eq!(idx, 0);
        assert_eq!(sp.slot_count(), 1);
        assert_eq!(sp.get(0).unwrap(), b"Hello, World!");
    }

    #[test]
    fn test_slotted_page_multiple_inserts() {
        let mut page = Page::new(PageType::DocumentHeap, 10, 4096);
        let mut sp = SlottedPage::new(&mut page);

        sp.insert(b"record_0").unwrap();
        sp.insert(b"record_1").unwrap();
        sp.insert(b"record_2").unwrap();

        assert_eq!(sp.slot_count(), 3);
        assert_eq!(sp.get(0).unwrap(), b"record_0");
        assert_eq!(sp.get(1).unwrap(), b"record_1");
        assert_eq!(sp.get(2).unwrap(), b"record_2");
    }

    #[test]
    fn test_slotted_page_delete_tombstone() {
        let mut page = Page::new(PageType::Leaf, 1, 4096);
        let mut sp = SlottedPage::new(&mut page);

        sp.insert(b"keep_me").unwrap();
        sp.insert(b"delete_me").unwrap();
        sp.insert(b"also_keep").unwrap();

        assert_eq!(sp.live_count(), 3);

        assert!(sp.delete(1));
        assert_eq!(sp.live_count(), 2);
        assert!(sp.get(1).is_none()); // tombstoned
        assert_eq!(sp.get(0).unwrap(), b"keep_me");
        assert_eq!(sp.get(2).unwrap(), b"also_keep");
    }

    #[test]
    fn test_slotted_page_compact() {
        let mut page = Page::new(PageType::DocumentHeap, 2, 4096);
        let mut sp = SlottedPage::new(&mut page);

        sp.insert(b"aaaa").unwrap();
        sp.insert(b"bbbb").unwrap();
        sp.insert(b"cccc").unwrap();
        sp.insert(b"dddd").unwrap();

        // Delete 2 records → 50% live ratio → needs compaction
        sp.delete(1);
        sp.delete(3);
        assert!(sp.needs_compaction());

        let reclaimed = sp.compact();
        assert_eq!(reclaimed, 2);
        assert_eq!(sp.slot_count(), 2);
        assert_eq!(sp.live_count(), 2);
        assert!(!sp.needs_compaction());
    }

    #[test]
    fn test_slotted_page_full() {
        let mut page = Page::new(PageType::Leaf, 0, 256); // tiny page
        let mut sp = SlottedPage::new(&mut page);

        // Payload = 256 - 64 = 192 bytes
        // Each insert takes record_len + 4 bytes (slot)
        // So we can fit at most 192 / (big_record + 4) records
        let big_record = vec![0xABu8; 80];
        let r1 = sp.insert(&big_record);
        assert!(r1.is_ok());

        let r2 = sp.insert(&big_record);
        assert!(r2.is_ok());

        // Third should fail (80+4 + 80+4 = 168, only 192-168=24 left, need 80+4=84)
        let r3 = sp.insert(&big_record);
        assert!(r3.is_err());
    }

    #[test]
    fn test_slotted_page_iter() {
        let mut page = Page::new(PageType::DocumentHeap, 0, 4096);
        let mut sp = SlottedPage::new(&mut page);

        sp.insert(b"aaa").unwrap();
        sp.insert(b"bbb").unwrap();
        sp.insert(b"ccc").unwrap();
        sp.delete(1); // tombstone

        let live: Vec<(usize, &[u8])> = sp.iter().collect();
        assert_eq!(live.len(), 2);
        assert_eq!(live[0], (0, &b"aaa"[..]));
        assert_eq!(live[1], (2, &b"ccc"[..]));
    }
}
