//! Regression test — Bug 3: Corrupt on panic/error.
//!
//! Verifies that:
//! (a) SSTable CRC32C footer detects incomplete files from crash.
//! (b) Background worker panic is caught and the worker can be restarted.

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use crate::background::{BackgroundPool, WorkerConfig};
    use crate::storage::memtable::MemTableEntry;
    use crate::storage::sstable::SSTable;

    // ── SSTable CRC tests ─────────────────────────────────────────────────────

    fn make_sstable_entries(count: usize) -> Vec<MemTableEntry> {
        (0..count)
            .map(|i| MemTableEntry {
                key: format!("key_{i}").into_bytes(),
                value: format!("val_{i}").into_bytes(),
                txid: i as u64 + 1,
                tombstone: false,
                collection_id: 1,
            })
            .collect()
    }

    #[test]
    fn test_sstable_valid_crc_roundtrip() {
        let entries = make_sstable_entries(50);
        let sst = SSTable::from_memtable_entries(1, entries).unwrap();
        let bytes = sst.to_bytes(); // includes 8-byte CRC footer

        let decoded = SSTable::from_bytes_verified(1, &bytes, "/tmp/test.sst").unwrap();
        assert_eq!(decoded.len(), 50);
    }

    #[test]
    fn test_sstable_truncated_file_detected() {
        let entries = make_sstable_entries(10);
        let sst = SSTable::from_memtable_entries(1, entries).unwrap();
        let bytes = sst.to_bytes();

        // Truncate to simulate crash mid-write (remove last 20 bytes)
        let truncated = &bytes[..bytes.len().saturating_sub(20)];
        let result = SSTable::from_bytes_verified(1, truncated, "/tmp/truncated.sst");
        assert!(
            result.is_err(),
            "Truncated SSTable must fail CRC verification"
        );
        match result.unwrap_err() {
            crate::error::OvnError::SstableIncomplete { path } => {
                assert_eq!(path, "/tmp/truncated.sst");
            }
            other => panic!("Expected SstableIncomplete, got {other:?}"),
        }
    }

    #[test]
    fn test_sstable_corrupted_byte_detected() {
        let entries = make_sstable_entries(10);
        let sst = SSTable::from_memtable_entries(1, entries).unwrap();
        let mut bytes = sst.to_bytes();

        // Flip a byte in the middle of the payload
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xFF;

        let result = SSTable::from_bytes_verified(1, &bytes, "/tmp/corrupt.sst");
        assert!(result.is_err(), "Corrupted SSTable must fail CRC verification");
    }

    // ── Background worker panic recovery tests ────────────────────────────────

    #[test]
    fn test_background_worker_survives_panic() {
        // Worker panics on first call, then succeeds on subsequent calls.
        let call_count = Arc::new(AtomicU32::new(0));
        let call_count_clone = call_count.clone();
        let succeeded = Arc::new(AtomicBool::new(false));
        let succeeded_clone = succeeded.clone();

        let mut pool = BackgroundPool::new();
        pool.spawn(
            WorkerConfig {
                name: "test_panic_worker".to_string(),
                interval: Duration::from_millis(50),
                enabled: true,
            },
            move || {
                let n = call_count_clone.fetch_add(1, Ordering::Relaxed);
                if n == 0 {
                    panic!("intentional test panic");
                }
                succeeded_clone.store(true, Ordering::Relaxed);
            },
        );

        // Wait enough time for: panic → backoff(1s) → second call
        std::thread::sleep(Duration::from_millis(1200));
        pool.shutdown();

        assert!(
            succeeded.load(Ordering::Relaxed),
            "Worker must execute successfully after recovering from panic"
        );
        assert!(
            call_count.load(Ordering::Relaxed) >= 2,
            "Worker must have been called at least twice (first panic, then success)"
        );
    }

    #[test]
    fn test_background_worker_no_crash_on_repeated_panic() {
        // A worker that always panics must not crash the whole process.
        let panic_count = Arc::new(AtomicU32::new(0));
        let panic_count_clone = panic_count.clone();

        let mut pool = BackgroundPool::new();
        pool.spawn(
            WorkerConfig {
                name: "always_panic_worker".to_string(),
                interval: Duration::from_millis(10),
                enabled: true,
            },
            move || {
                panic_count_clone.fetch_add(1, Ordering::Relaxed);
                panic!("always panics");
            },
        );

        // Give it time to panic once (backoff starts at 1s so it won't retry fast)
        std::thread::sleep(Duration::from_millis(200));
        pool.shutdown();

        // Process must still be alive here (no abort)
        assert!(
            panic_count.load(Ordering::Relaxed) >= 1,
            "Worker should have panicked at least once"
        );
    }
}
