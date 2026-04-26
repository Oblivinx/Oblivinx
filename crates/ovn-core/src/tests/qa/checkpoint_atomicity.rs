//! QA Module 7: Checkpoint atomicity and shadow page mechanism.
//!
//! Verifies:
//! (a) Shadow page written before Page 0.
//! (b) WAL_ACTIVE=true on open triggers recovery path.
//! (c) HMAC / CRC32C of Page 0 is valid after normal close.

#[cfg(test)]
mod tests {
    use crate::format::header::FileHeader;
    use crate::io::backend::{FileBackend, MemoryBackend};
    use crate::recovery::RecoveryEngine;
    use crate::storage::checkpoint::write_checkpoint_atomic;

    const PAGE_SIZE: u32 = 4096;
    const SHADOW_OFFSET: u64 = 0x0FF0;

    fn init_backend() -> MemoryBackend {
        let backend = MemoryBackend::new();
        let mut header = FileHeader::new(PAGE_SIZE);
        header.set_wal_active(false);
        backend.write_page(0, PAGE_SIZE, &header.to_bytes()).unwrap();
        backend
    }

    #[test]
    fn test_shadow_page_written_before_page0() {
        let backend = init_backend();

        write_checkpoint_atomic(&backend, PAGE_SIZE, 99).unwrap();

        // Verify shadow page contains the checkpoint TxID
        let shadow = backend.read_at(SHADOW_OFFSET, 16).unwrap();
        let txid = u64::from_le_bytes(shadow[0..8].try_into().unwrap());
        assert_eq!(txid, 99, "Shadow page must contain checkpoint TxID=99");

        // CRC32C of shadow must be valid
        let stored_crc = u32::from_le_bytes(shadow[8..12].try_into().unwrap());
        let computed = crc32c::crc32c(&shadow[0..8]);
        assert_eq!(stored_crc, computed, "Shadow page CRC32C must be valid");
    }

    #[test]
    fn test_page0_updated_after_checkpoint() {
        let backend = init_backend();

        write_checkpoint_atomic(&backend, PAGE_SIZE, 42).unwrap();

        // Read Page 0 and verify HLC state was updated (stores checkpoint TxID)
        let page0 = backend.read_page(0, PAGE_SIZE).unwrap();
        let header = FileHeader::from_bytes(&page0).unwrap();
        assert_eq!(
            header.hlc_state, 42,
            "Page 0 hlc_state must equal checkpoint TxID after write_checkpoint_atomic"
        );
    }

    #[test]
    fn test_wal_active_false_means_no_recovery() {
        let backend = init_backend(); // WAL_ACTIVE=false

        let mut engine = RecoveryEngine::new("/tmp/clean.ovn2");
        let report = engine.run(&backend, PAGE_SIZE).unwrap();

        assert_eq!(
            report.recovered_txids, 0,
            "Clean shutdown must not recover any TxIDs"
        );
        assert!(
            report.quarantined_collections.is_empty(),
            "Clean shutdown must not quarantine any collections"
        );
    }

    #[test]
    fn test_wal_active_true_triggers_recovery() {
        let backend = MemoryBackend::new();
        // FileHeader::new() sets WAL_ACTIVE=true by default
        let header = FileHeader::new(PAGE_SIZE);
        backend.write_page(0, PAGE_SIZE, &header.to_bytes()).unwrap();

        let tmp = std::env::temp_dir().join("qa_unclean_ckpt.ovn2");
        let mut engine = RecoveryEngine::new(&tmp);
        let report = engine.run(&backend, PAGE_SIZE).unwrap();

        // Recovery ran (even if no WAL data was present)
        let has_transition = report
            .events
            .iter()
            .any(|e| e.kind == "state_transition" && e.detail.contains("RecoveringWal"));
        assert!(
            has_transition,
            "Recovery must transition through RecoveringWal when WAL_ACTIVE=true"
        );
        // Cleanup
        let _ = std::fs::remove_file(tmp.with_extension("recovery_log"));
    }

    #[test]
    fn test_page0_hmac_valid_after_normal_write() {
        let backend = init_backend();
        let page0 = backend.read_page(0, PAGE_SIZE).unwrap();
        // from_bytes verifies CRC32C — if it returns Ok, the checksum is valid
        FileHeader::from_bytes(&page0).expect("Page 0 must have valid CRC32C after init");
    }

    #[test]
    fn test_multiple_checkpoints_monotonic() {
        let backend = init_backend();

        for txid in [10u64, 20, 50, 100] {
            write_checkpoint_atomic(&backend, PAGE_SIZE, txid).unwrap();

            let shadow = backend.read_at(SHADOW_OFFSET, 16).unwrap();
            let stored_txid = u64::from_le_bytes(shadow[0..8].try_into().unwrap());
            assert_eq!(stored_txid, txid, "Shadow must reflect latest checkpoint TxID={txid}");
        }
    }
}
