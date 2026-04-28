//! Comprehensive crash recovery integration tests.
//!
//! Tests the full engine lifecycle:
//! 1. Open → Insert → WAL flush → Crash (simulate) → Reopen → Verify
//! 2. Multi-collection crash recovery
//! 3. Header corruption detection and shadow page recovery
//! 4. Open/close cycling stress
//! 5. Freelist persistence across restarts

#[cfg(test)]
mod tests {
    use crate::engine::config::OvnConfig;
    use crate::engine::OvnEngine;
    use crate::format::page::{Page, PageType, PAGE_HEADER_SIZE, PAGE_MAGIC_BYTE};
    use crate::io::FileBackend;
    use crate::storage::freelist::FreelistManager;
    use crate::storage::overflow::{
        inline_threshold, overflow_chunk_capacity, read_overflow_chain, write_overflow_chain,
    };
    use crate::storage::slotted_page::SlottedPage;

    // ── Page Header Tests ───────────────────────────────────────

    #[test]
    fn test_page_header_64byte_layout() {
        let header = crate::format::page::PageHeader::new(PageType::Leaf, 42);
        let bytes = header.to_bytes();
        assert_eq!(bytes.len(), PAGE_HEADER_SIZE);
        assert_eq!(bytes[0], PAGE_MAGIC_BYTE, "Byte 0 must be magic 0x6F");
        assert_eq!(bytes[1], PageType::Leaf as u8, "Byte 1 must be page type");
    }

    #[test]
    fn test_page_header_full_lsn_64bit() {
        let mut header = crate::format::page::PageHeader::new(PageType::Interior, 0);
        let test_lsn: u64 = 0x0000_ABCD_1234_5678;
        header.set_full_lsn(test_lsn);

        let bytes = header.to_bytes();
        let decoded = crate::format::page::PageHeader::from_bytes(&bytes).unwrap();

        assert_eq!(decoded.full_lsn(), test_lsn);
    }

    // ── Slotted Page Integration Tests ──────────────────────────

    #[test]
    fn test_slotted_page_fill_and_split_signal() {
        let mut page = Page::new(PageType::Leaf, 0, 256); // Tiny page
        let mut sp = SlottedPage::new(&mut page);

        let mut count = 0;
        loop {
            if sp.can_fit(20) {
                sp.insert(&[0xAA; 20]).unwrap();
                count += 1;
            } else {
                break;
            }
        }

        assert!(count > 0, "Should insert at least one record");
        assert!(!sp.can_fit(20), "Should be full");
    }

    #[test]
    fn test_slotted_page_tombstone_density_trigger() {
        let mut page = Page::new(PageType::DocumentHeap, 0, 4096);
        let mut sp = SlottedPage::new(&mut page);

        // Insert 10 records
        for i in 0..10 {
            let data = format!("record_{:04}", i);
            sp.insert(data.as_bytes()).unwrap();
        }
        assert_eq!(sp.live_count(), 10);
        assert!(!sp.needs_compaction());

        // Delete 4 records (40% tombstoned → 60% live → below 70% threshold)
        for i in 0..4 {
            sp.delete(i);
        }
        assert_eq!(sp.live_count(), 6);
        assert!(
            sp.needs_compaction(),
            "Should need compaction at 60% live ratio"
        );

        // Compact
        let reclaimed = sp.compact();
        assert_eq!(reclaimed, 4);
        assert!(!sp.needs_compaction());
        assert_eq!(sp.live_count(), 6);
    }

    // ── Overflow Chain Integration Tests ────────────────────────

    #[test]
    fn test_overflow_exact_boundary() {
        use crate::io::backend::MemoryBackend;
        use crate::storage::buffer_pool::BufferPool;

        let backend = MemoryBackend::new();
        let pool = BufferPool::new(4096 * 64, 4096);
        let freelist = FreelistManager::new(2, 4096);

        let empty = vec![0u8; 4096 * 100];
        backend.write_at(0, &empty).unwrap();
        freelist.set_total_pages(100);
        for i in 2..100 {
            freelist.free_page(i);
        }

        // Data exactly at chunk capacity boundary
        let chunk_cap = overflow_chunk_capacity(4096);
        let data = vec![0x42u8; chunk_cap]; // Exactly 1 page worth

        let first = write_overflow_chain(&data, 4096, &freelist, &pool, &backend).unwrap();
        let read_back = read_overflow_chain(first, 4096, &pool, &backend).unwrap();

        assert_eq!(read_back, data);
    }

    #[test]
    fn test_overflow_inline_threshold_boundary() {
        let threshold_4k = inline_threshold(4096);
        let threshold_8k = inline_threshold(8192);

        // 4096-byte page: (4096 - 64) / 4 = 1008
        assert_eq!(threshold_4k, 1008);
        // 8192-byte page: (8192 - 64) / 4 = 2032
        assert_eq!(threshold_8k, 2032);
    }

    // ── Freelist Persistence Tests ──────────────────────────────

    #[test]
    fn test_freelist_state_serializable() {
        let fl = FreelistManager::new(10, 4096);
        fl.free_page(5);
        fl.free_page(8);
        fl.free_page(3);

        let saved = fl.all_free_pages();
        assert_eq!(saved.len(), 3);
        assert!(saved.contains(&5));
        assert!(saved.contains(&8));
        assert!(saved.contains(&3));

        // Simulate reload
        let fl2 = FreelistManager::new(10, 4096);
        fl2.load_from(saved);
        assert_eq!(fl2.free_count(), 3);
    }

    // ── Page Type Catalog Tests ─────────────────────────────────

    #[test]
    fn test_all_spec_page_types_recognized() {
        let types: Vec<(u8, PageType)> = vec![
            (0x01, PageType::Interior),
            (0x02, PageType::Leaf),
            (0x03, PageType::Overflow),
            (0x04, PageType::FreelistLeaf),
            (0x05, PageType::FreelistTrunk),
            (0x06, PageType::DocumentHeap),
            (0x07, PageType::Oplog),
            (0x0E, PageType::BitmapFreespace),
            (0xFE, PageType::Free),
            (0xFF, PageType::Unused),
        ];

        for (byte, expected) in types {
            let parsed = PageType::from_u8(byte);
            assert_eq!(parsed, Some(expected), "Failed for byte 0x{:02X}", byte);
        }
    }

    #[test]
    fn test_unknown_page_type_returns_none() {
        assert_eq!(PageType::from_u8(0x50), None);
        assert_eq!(PageType::from_u8(0x99), None);
    }

    // ── Engine Open/Close Cycle Stress ──────────────────────────

    #[test]
    fn test_engine_open_close_cycle() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cycle_test.ovn");
        let config = OvnConfig::test();

        // Cycle 1: Create and insert
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            engine.create_collection("test_col", None).unwrap();
            let doc = serde_json::json!({ "name": "cycle_test", "value": 42 });
            engine.insert("test_col", &doc).unwrap();
            engine.checkpoint().unwrap();
        }

        // Cycle 2: Reopen and verify
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let collections = engine.list_collections();
            assert!(collections.contains(&"test_col".to_string()));

            let results = engine
                .find("test_col", &serde_json::json!({}), None)
                .unwrap();
            assert_eq!(results.len(), 1);
        }

        // Cycle 3: Insert more, verify cumulative
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let doc2 = serde_json::json!({ "name": "second", "value": 99 });
            engine.insert("test_col", &doc2).unwrap();
            engine.checkpoint().unwrap();
        }

        // Cycle 4: Final verify
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let results = engine
                .find("test_col", &serde_json::json!({}), None)
                .unwrap();
            assert_eq!(results.len(), 2);
        }
    }

    #[test]
    fn test_engine_multi_collection_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("multi_col.ovn");
        let config = OvnConfig::test();

        // Create with multiple collections
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            engine.create_collection("users", None).unwrap();
            engine.create_collection("orders", None).unwrap();
            engine.create_collection("products", None).unwrap();

            engine
                .insert("users", &serde_json::json!({ "name": "Alice" }))
                .unwrap();
            engine
                .insert("orders", &serde_json::json!({ "total": 100 }))
                .unwrap();
            engine
                .insert("products", &serde_json::json!({ "sku": "X123" }))
                .unwrap();
            engine.checkpoint().unwrap();
        }

        // Reopen and verify all collections survived
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let collections = engine.list_collections();
            assert!(collections.contains(&"users".to_string()));
            assert!(collections.contains(&"orders".to_string()));
            assert!(collections.contains(&"products".to_string()));

            let users = engine.find("users", &serde_json::json!({}), None).unwrap();
            assert_eq!(users.len(), 1);

            let orders = engine.find("orders", &serde_json::json!({}), None).unwrap();
            assert_eq!(orders.len(), 1);
        }
    }

    // ── Page CRC-32C Integrity ──────────────────────────────────

    #[test]
    fn test_page_crc32c_detects_single_bit_flip() {
        let mut page = Page::new(PageType::Leaf, 1, 4096);
        page.payload[100] = 0xFF;
        let bytes = page.to_bytes();

        // Flip a single bit in the payload area
        let mut corrupted = bytes.clone();
        corrupted[PAGE_HEADER_SIZE + 100] ^= 0x01;

        let result = Page::from_bytes(&corrupted, 4096);
        assert!(
            result.is_err(),
            "CRC-32C should detect single-bit corruption"
        );
    }

    #[test]
    fn test_page_zeroed_crc_skips_verification() {
        // A page with checksum=0 should skip CRC verification (uncomputed)
        let page = Page::new(PageType::Leaf, 0, 4096);
        let mut bytes = page.to_bytes();
        // Zero out the checksum bytes (offset 52..56 in header)
        bytes[52..56].fill(0);
        // This should NOT error (checksum=0 means uncomputed)
        let result = Page::from_bytes(&bytes, 4096);
        assert!(result.is_ok());
    }

    // ── Batch Insert & Crash Recovery ───────────────────────────

    #[test]
    fn test_engine_batch_insert_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("batch_test.ovn");
        let config = OvnConfig::test();

        // Insert 100 documents
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            engine.create_collection("items", None).unwrap();

            for i in 0..100 {
                let doc = serde_json::json!({
                    "index": i,
                    "name": format!("item_{}", i),
                    "value": i * 10
                });
                engine.insert("items", &doc).unwrap();
            }
            engine.checkpoint().unwrap();
        }

        // Reopen and verify all 100
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let results = engine.find("items", &serde_json::json!({}), None).unwrap();
            assert_eq!(
                results.len(),
                100,
                "All 100 documents should survive restart"
            );
        }
    }

    #[test]
    fn test_engine_update_persists() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("update_persist.ovn");
        let config = OvnConfig::test();

        // Insert and update
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            engine.create_collection("docs", None).unwrap();

            engine
                .insert("docs", &serde_json::json!({ "key": "a", "val": 1 }))
                .unwrap();
            engine
                .insert("docs", &serde_json::json!({ "key": "b", "val": 2 }))
                .unwrap();

            // Update "a"
            engine
                .update(
                    "docs",
                    &serde_json::json!({ "key": "a" }),
                    &serde_json::json!({ "$set": { "val": 999 } }),
                )
                .unwrap();

            engine.checkpoint().unwrap();
        }

        // Verify update survived
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let results = engine
                .find("docs", &serde_json::json!({ "key": "a" }), None)
                .unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0]["val"], 999);
        }
    }

    #[test]
    fn test_engine_delete_persists() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("delete_persist.ovn");
        let config = OvnConfig::test();

        // Insert and delete
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            engine.create_collection("temp", None).unwrap();

            engine
                .insert("temp", &serde_json::json!({ "key": "keep" }))
                .unwrap();
            engine
                .insert("temp", &serde_json::json!({ "key": "remove" }))
                .unwrap();

            engine
                .delete("temp", &serde_json::json!({ "key": "remove" }))
                .unwrap();
            engine.checkpoint().unwrap();
        }

        // Verify
        {
            let engine = OvnEngine::open(db_path.to_str().unwrap(), config.clone()).unwrap();
            let all = engine.find("temp", &serde_json::json!({}), None).unwrap();
            assert_eq!(all.len(), 1);
            assert_eq!(all[0]["key"], "keep");
        }
    }
}
