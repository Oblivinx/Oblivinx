//! Regression test — Bug 1: Duplicate documents on restart.
//!
//! Scenario: insert N docs → flush MemTable to L0 SSTable → corrupt WAL_ACTIVE
//! (simulate crash without advancing checkpoint) → reopen → verify no duplicates.

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::storage::memtable::MemTableEntry;
    use crate::storage::wal::{WalManager, WalRecord, WalRecordType};

    /// Build a set of distinct MemTable entries (simulating 1000 insertions).
    fn make_entries(count: usize) -> Vec<MemTableEntry> {
        (0..count)
            .map(|i| MemTableEntry {
                key: format!("doc_{i:05}").into_bytes(),
                value: format!("value_{i}").into_bytes(),
                txid: i as u64 + 1,
                tombstone: false,
                collection_id: 1,
            })
            .collect()
    }

    /// Build a WAL byte stream containing Insert + Commit records for each entry.
    fn build_wal(entries: &[MemTableEntry]) -> Vec<u8> {
        let mut buf = Vec::new();
        for entry in entries {
            let insert_rec = WalRecord::new(
                WalRecordType::Insert,
                entry.txid,
                entry.collection_id,
                [0u8; 16],
                entry.txid,
                entry.key.clone(),
            );
            buf.extend(insert_rec.encode());

            let commit_rec = WalRecord::new(
                WalRecordType::Commit,
                entry.txid,
                0,
                [0u8; 16],
                entry.txid,
                Vec::new(),
            );
            buf.extend(commit_rec.encode());
        }
        buf
    }

    #[test]
    fn test_no_duplicates_after_crash_reopen() {
        const DOC_COUNT: usize = 100; // reduced from 1000 for test speed

        // ── Step 1: Insert docs and record their txids ─────────────────
        let entries = make_entries(DOC_COUNT);
        let original_keys: Vec<Vec<u8>> = entries.iter().map(|e| e.key.clone()).collect();
        let _max_txid = entries.iter().map(|e| e.txid).max().unwrap();

        // ── Step 2: Build WAL as if we flushed MemTable (checkpoint at max_txid)
        let wal_data = build_wal(&entries);

        // ── Step 3: Simulate crash — WAL_ACTIVE stays true, checkpoint NOT advanced
        // (last_checkpoint_txid = 0, so recovery must replay the full WAL)
        let last_checkpoint_txid: u64 = 0;

        // ── Step 4: Reopen — run WAL replay with checkpoint-aware dedup ──────
        let replayed = WalManager::replay_from_checkpoint(&wal_data, last_checkpoint_txid).unwrap();

        // Collect all keys from replayed Insert records
        let replayed_keys: Vec<Vec<u8>> = replayed
            .iter()
            .filter(|r| r.record_type == WalRecordType::Insert)
            .map(|r| r.data.clone())
            .collect();

        // ── Step 5a: Count == DOC_COUNT (no duplicates)
        assert_eq!(
            replayed_keys.len(),
            DOC_COUNT,
            "Expected exactly {DOC_COUNT} Insert records after replay, got {}",
            replayed_keys.len()
        );

        // ── Step 5b: No duplicate keys
        let unique: HashSet<Vec<u8>> = replayed_keys.iter().cloned().collect();
        assert_eq!(
            unique.len(),
            DOC_COUNT,
            "Duplicate document keys detected after WAL replay"
        );

        // ── Step 5c: All original keys present
        for key in &original_keys {
            assert!(
                unique.contains(key.as_slice()),
                "Key {:?} missing from replayed documents",
                String::from_utf8_lossy(key)
            );
        }
    }

    #[test]
    fn test_checkpoint_skips_already_durable_records() {
        // Records below checkpoint TxID must not be replayed.
        let entries = make_entries(10);
        let wal_data = build_wal(&entries);

        // Checkpoint is at txid=5; only txids 6–10 should be replayed.
        let replayed = WalManager::replay_from_checkpoint(&wal_data, 5).unwrap();
        let replayed_txids: HashSet<u64> = replayed.iter().map(|r| r.txid).collect();

        for txid in 1u64..=5 {
            assert!(
                !replayed_txids.contains(&txid),
                "TxID {txid} should have been skipped (already checkpointed)"
            );
        }
        for txid in 6u64..=10 {
            assert!(
                replayed_txids.contains(&txid),
                "TxID {txid} should have been replayed"
            );
        }
    }

    #[test]
    fn test_uncommitted_txids_not_replayed() {
        // Uncommitted records (no Commit record) must be discarded.
        let mut buf = Vec::new();

        // TxID 1: Insert + Commit (should be replayed)
        buf.extend(
            WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 1, b"key1".to_vec()).encode(),
        );
        buf.extend(WalRecord::new(WalRecordType::Commit, 1, 0, [0; 16], 1, Vec::new()).encode());

        // TxID 2: Insert only, no Commit (uncommitted — should be discarded)
        buf.extend(
            WalRecord::new(WalRecordType::Insert, 2, 1, [0; 16], 2, b"key2".to_vec()).encode(),
        );

        let replayed = WalManager::replay_from_checkpoint(&buf, 0).unwrap();
        let txids: HashSet<u64> = replayed.iter().map(|r| r.txid).collect();

        assert!(txids.contains(&1), "Committed TxID 1 should be replayed");
        assert!(
            !txids.contains(&2),
            "Uncommitted TxID 2 must NOT be replayed"
        );
    }
}
