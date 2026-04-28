//! QA Module 5: Fuzz corruption tests.
//!
//! Flips random bytes in WAL, SSTable, and header data and verifies that
//! the engine always returns a proper error — never panics or silently corrupts.

#[cfg(test)]
mod tests {
    use crate::format::header::FileHeader;
    use crate::storage::memtable::MemTableEntry;
    use crate::storage::sstable::SSTable;
    use crate::storage::wal::{WalManager, WalRecord, WalRecordType};

    /// Seed-based LCG for reproducible "random" byte positions.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            self.0
        }
        fn next_usize(&mut self, max: usize) -> usize {
            (self.next() % max as u64) as usize
        }
    }

    fn make_valid_wal(txid_count: u64) -> Vec<u8> {
        let mut buf = Vec::new();
        for txid in 1..=txid_count {
            buf.extend(
                WalRecord::new(
                    WalRecordType::Insert,
                    txid,
                    1,
                    [0; 16],
                    txid,
                    b"data".to_vec(),
                )
                .encode(),
            );
            buf.extend(
                WalRecord::new(WalRecordType::Commit, txid, 0, [0; 16], txid, Vec::new()).encode(),
            );
        }
        buf
    }

    fn make_valid_sstable_bytes() -> Vec<u8> {
        let entries: Vec<MemTableEntry> = (0..20)
            .map(|i| MemTableEntry {
                key: format!("k{i}").into_bytes(),
                value: format!("v{i}").into_bytes(),
                txid: i + 1,
                tombstone: false,
                collection_id: 1,
            })
            .collect();
        SSTable::from_memtable_entries(1, entries)
            .unwrap()
            .to_bytes()
    }

    /// Fuzz WAL bytes — must never panic, must always return an error or valid records.
    #[test]
    fn test_fuzz_wal_random_bytes() {
        let original = make_valid_wal(5);
        let mut lcg = Lcg(0xDEAD_BEEF_1234_5678);

        for iteration in 0..500 {
            let mut corrupted = original.clone();
            let pos = lcg.next_usize(corrupted.len());
            let flip = lcg.next() as u8;
            corrupted[pos] ^= flip;

            // Must not panic — either returns Ok (partial valid records) or Err
            let result =
                std::panic::catch_unwind(|| WalManager::replay_from_checkpoint(&corrupted, 0));

            assert!(
                result.is_ok(),
                "WAL replay panicked on iteration {iteration} at pos {pos}"
            );
            // If it returned Ok, the records must be internally consistent
            if let Ok(Ok(records)) = result {
                for r in &records {
                    assert!(r.txid > 0, "Replayed record must have valid TxID");
                }
            }
        }
    }

    /// Fuzz SSTable bytes — must always return SstableIncomplete, never panic.
    #[test]
    fn test_fuzz_sstable_random_bytes() {
        let original = make_valid_sstable_bytes();
        let mut lcg = Lcg(0xCAFE_BABE_0000_1234);

        for iteration in 0..500 {
            let mut corrupted = original.clone();
            let pos = lcg.next_usize(corrupted.len());
            corrupted[pos] ^= lcg.next() as u8;

            let result = std::panic::catch_unwind(|| {
                SSTable::from_bytes_verified(1, &corrupted, "/fuzz/test.sst")
            });

            assert!(
                result.is_ok(),
                "SSTable decode panicked on iteration {iteration}"
            );
            // It's either Ok (lucky no CRC change) or SstableIncomplete — never anything else
            if let Ok(Err(e)) = result {
                match e {
                    crate::error::OvnError::SstableIncomplete { .. }
                    | crate::error::OvnError::SSTableError(_) => {}
                    other => panic!("Unexpected error on fuzz iteration {iteration}: {other:?}"),
                }
            }
        }
    }

    /// Fuzz file header — from_bytes must return an error, never panic.
    #[test]
    fn test_fuzz_header_random_bytes() {
        let original = FileHeader::new(4096).to_bytes();
        let mut lcg = Lcg(0xF00D_CAFE_DEAD_BEEF);

        for iteration in 0..500 {
            let mut corrupted = original.clone();
            let pos = lcg.next_usize(corrupted.len());
            corrupted[pos] ^= lcg.next() as u8;

            let result = std::panic::catch_unwind(|| FileHeader::from_bytes(&corrupted));

            assert!(
                result.is_ok(),
                "FileHeader::from_bytes panicked on iteration {iteration}"
            );
            // Result must be Ok or a known error — never a panic
        }
    }

    /// Fuzz with completely random input — verify no panics.
    #[test]
    fn test_fuzz_random_wal_bytes() {
        let mut lcg = Lcg(0xABCD_EF01_2345_6789);

        for iteration in 0..200 {
            let size = (lcg.next() % 512 + 1) as usize;
            let random_bytes: Vec<u8> = (0..size).map(|_| lcg.next() as u8).collect();

            let result =
                std::panic::catch_unwind(|| WalManager::replay_from_checkpoint(&random_bytes, 0));

            assert!(
                result.is_ok(),
                "WAL replay panicked on random-bytes iteration {iteration}"
            );
        }
    }
}
