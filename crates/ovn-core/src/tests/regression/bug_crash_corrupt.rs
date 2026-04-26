//! Regression test — Bug 2: Database corrupt after crash.
//!
//! Verifies that WAL CRC errors mid-stream stop replay at the corruption point
//! and that only fully committed transactions are visible after recovery.

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crate::storage::wal::{WalManager, WalRecord, WalRecordType};

    /// Build a valid WAL batch with the given txid range, all committed.
    fn build_committed_batch(txid_start: u64, txid_end: u64) -> Vec<u8> {
        let mut buf = Vec::new();
        for txid in txid_start..=txid_end {
            buf.extend(
                WalRecord::new(WalRecordType::Insert, txid, 1, [0; 16], txid, format!("doc_{txid}").into_bytes())
                    .encode(),
            );
            buf.extend(
                WalRecord::new(WalRecordType::Commit, txid, 0, [0; 16], txid, Vec::new()).encode(),
            );
        }
        buf
    }

    #[test]
    fn test_recovery_after_truncated_wal() {
        // Transactions 1–5 committed cleanly.
        let mut wal_data = build_committed_batch(1, 5);

        // Simulate a crash mid-write: truncate WAL in the middle of txid=6's commit.
        let partial_insert = WalRecord::new(
            WalRecordType::Insert,
            6,
            1,
            [0; 16],
            6,
            b"partial_doc".to_vec(),
        )
        .encode();
        // Append only half the bytes (torn write)
        wal_data.extend_from_slice(&partial_insert[..partial_insert.len() / 2]);

        let replayed = WalManager::replay_from_checkpoint(&wal_data, 0).unwrap();
        let replayed_txids: HashSet<u64> = replayed.iter().map(|r| r.txid).collect();

        // Only txids 1–5 should be visible; 6 was not committed.
        for txid in 1u64..=5 {
            assert!(
                replayed_txids.contains(&txid),
                "Committed TxID {txid} must be visible after recovery"
            );
        }
        assert!(
            !replayed_txids.contains(&6),
            "Partial TxID 6 must NOT be visible (uncommitted / torn write)"
        );
    }

    #[test]
    fn test_recovery_crc_corruption_stops_replay() {
        // Transactions 1–3 committed cleanly.
        let mut wal_data = build_committed_batch(1, 3);

        // Corrupt a byte in txid=4's Insert record (simulates bit flip).
        let mut txid4_insert =
            WalRecord::new(WalRecordType::Insert, 4, 1, [0; 16], 4, b"doc4".to_vec()).encode();
        let corrupt_pos = txid4_insert.len() / 2;
        txid4_insert[corrupt_pos] ^= 0xFF;
        wal_data.extend(txid4_insert);

        // Txid=5 committed after the corrupted record — must also be invisible
        // because replay stops at the first CRC error.
        wal_data.extend(build_committed_batch(5, 5));

        let replayed = WalManager::replay_from_checkpoint(&wal_data, 0).unwrap();
        let replayed_txids: HashSet<u64> = replayed.iter().map(|r| r.txid).collect();

        for txid in 1u64..=3 {
            assert!(replayed_txids.contains(&txid), "TxID {txid} should be replayed");
        }
        // 4 and 5 must not appear — 4 is corrupt, 5 is after the corruption point.
        assert!(!replayed_txids.contains(&4), "Corrupt TxID 4 must not appear");
        assert!(!replayed_txids.contains(&5), "TxID 5 after corruption must not appear");
    }

    #[test]
    fn test_partial_state_not_visible() {
        // A transaction with multiple Insert records but no Commit must not appear.
        let mut buf = Vec::new();

        // TxID 1: fully committed (Insert + Insert + Commit)
        buf.extend(WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 1, b"a".to_vec()).encode());
        buf.extend(WalRecord::new(WalRecordType::Insert, 1, 1, [0; 16], 1, b"b".to_vec()).encode());
        buf.extend(WalRecord::new(WalRecordType::Commit, 1, 0, [0; 16], 1, Vec::new()).encode());

        // TxID 2: partial — two inserts, crashed before Commit
        buf.extend(WalRecord::new(WalRecordType::Insert, 2, 1, [0; 16], 2, b"c".to_vec()).encode());
        buf.extend(WalRecord::new(WalRecordType::Insert, 2, 1, [0; 16], 2, b"d".to_vec()).encode());

        let replayed = WalManager::replay_from_checkpoint(&buf, 0).unwrap();

        let txid1_inserts: Vec<_> = replayed
            .iter()
            .filter(|r| r.txid == 1 && r.record_type == WalRecordType::Insert)
            .collect();
        let txid2_inserts: Vec<_> = replayed
            .iter()
            .filter(|r| r.txid == 2)
            .collect();

        assert_eq!(txid1_inserts.len(), 2, "TxID 1 should have 2 Insert records");
        assert!(txid2_inserts.is_empty(), "TxID 2 (no Commit) must have zero records");
    }
}
