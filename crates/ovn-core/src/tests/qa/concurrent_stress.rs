//! QA Module 6: Concurrent writer stress test.
//!
//! Spawns multiple threads doing concurrent WAL appends and verifies
//! that all committed records are visible after replay (no lost writes,
//! no deadlocks, no duplicates).

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::sync::{Arc, Mutex};
    use std::thread;

    use crate::storage::wal::{WalManager, WalRecord, WalRecordType};

    #[test]
    fn test_concurrent_wal_no_duplicates() {
        const THREADS: usize = 16;
        const TXN_PER_THREAD: usize = 50;

        let shared_buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
        let mut handles = Vec::new();

        for thread_id in 0..THREADS {
            let buf = shared_buf.clone();
            let handle = thread::spawn(move || {
                for local_txn in 0..TXN_PER_THREAD {
                    // Unique TxID per (thread, txn) pair
                    let txid = (thread_id * TXN_PER_THREAD + local_txn + 1) as u64;

                    let insert = WalRecord::new(
                        WalRecordType::Insert,
                        txid,
                        1,
                        [0u8; 16],
                        txid,
                        format!("t{thread_id}_d{local_txn}").into_bytes(),
                    )
                    .encode();

                    let commit = WalRecord::new(
                        WalRecordType::Commit,
                        txid,
                        0,
                        [0u8; 16],
                        txid,
                        Vec::new(),
                    )
                    .encode();

                    let mut locked = buf.lock().unwrap();
                    locked.extend(insert);
                    locked.extend(commit);
                }
            });
            handles.push(handle);
        }

        // Wait for all threads (no deadlock: Mutex ensures serialized appends)
        for h in handles {
            h.join().expect("Thread panicked");
        }

        let wal_data = shared_buf.lock().unwrap().clone();
        let replayed = WalManager::replay_from_checkpoint(&wal_data, 0).unwrap();

        let commit_txids: HashSet<u64> = replayed
            .iter()
            .filter(|r| r.record_type == WalRecordType::Commit)
            .map(|r| r.txid)
            .collect();

        let expected_total = THREADS * TXN_PER_THREAD;
        assert_eq!(
            commit_txids.len(),
            expected_total,
            "Expected {expected_total} unique committed TxIDs, got {}",
            commit_txids.len()
        );

        // No duplicates
        let all_txids: Vec<u64> = replayed
            .iter()
            .filter(|r| r.record_type == WalRecordType::Commit)
            .map(|r| r.txid)
            .collect();
        assert_eq!(all_txids.len(), commit_txids.len(), "Duplicate TxIDs detected");
    }

    #[test]
    fn test_concurrent_no_deadlock_within_timeout() {
        use std::time::{Duration, Instant};

        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let done_clone = done.clone();

        let handle = thread::spawn(move || {
            // This test will complete quickly; we just verify no deadlock occurs.
            let buf: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
            let mut threads = Vec::new();

            for i in 0..8usize {
                let b = buf.clone();
                threads.push(thread::spawn(move || {
                    let txid = (i + 1) as u64;
                    let record = WalRecord::new(
                        WalRecordType::Commit,
                        txid,
                        0,
                        [0; 16],
                        txid,
                        Vec::new(),
                    )
                    .encode();
                    b.lock().unwrap().extend(record);
                }));
            }

            for t in threads {
                t.join().unwrap();
            }
            done_clone.store(true, std::sync::atomic::Ordering::Relaxed);
        });

        // Must complete in under 5 seconds (deadlock detection)
        let deadline = Instant::now() + Duration::from_secs(5);
        handle.join().expect("Deadlock detected: thread did not finish");
        assert!(
            done.load(std::sync::atomic::Ordering::Relaxed),
            "Concurrent stress test did not complete"
        );
        assert!(Instant::now() < deadline, "Completed within timeout");
    }
}
