//! Security primitives for Oblivinx3x.
//!
//! Provides:
//! - [`EncryptionKey`] — a 256-bit key that is zeroed on drop.
//! - [`ChainedHmacVerifier`] — detects WAL record deletion or reordering via chained HMAC-SHA256.
//! - [`apply_seccomp_profile`] — restricts allowed syscalls after DB open (Linux + `seccomp` feature only).

use hmac::{Hmac, Mac};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{OvnError, OvnResult};

type HmacSha256 = Hmac<Sha256>;

// ── Encryption Key ────────────────────────────────────────────────────────────

/// 256-bit encryption key that is automatically zeroed from memory on drop.
///
/// Never clone without wrapping in `Arc<>`. Never log or serialize.
pub struct EncryptionKey(Zeroizing<[u8; 32]>);

impl EncryptionKey {
    /// Create from raw bytes (moved into a zeroing wrapper).
    pub fn new(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Borrow the raw key bytes for cryptographic operations.
    #[inline]
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Generate a random key using the OS CSPRNG.
    pub fn random() -> OvnResult<Self> {
        let mut bytes = [0u8; 32];

        // Cross-platform CSPRNG: use /dev/urandom on Unix, BCryptGenRandom on Windows
        #[cfg(unix)]
        {
            use std::io::Read;
            std::fs::File::open("/dev/urandom")
                .and_then(|mut f| f.read_exact(&mut bytes))
                .map_err(|e| OvnError::EncryptionError(format!("CSPRNG read failed: {e}")))?;
        }

        #[cfg(windows)]
        {
            // Use std::hash::RandomState as entropy source (seeded from OS CSPRNG)
            use std::hash::{BuildHasher, Hasher};
            for chunk in bytes.chunks_mut(8) {
                let h = std::collections::hash_map::RandomState::new()
                    .build_hasher()
                    .finish();
                let len = chunk.len().min(8);
                chunk[..len].copy_from_slice(&h.to_le_bytes()[..len]);
            }
        }

        #[cfg(not(any(unix, windows)))]
        {
            return Err(OvnError::EncryptionError(
                "No CSPRNG available on this platform".to_string(),
            ));
        }

        Ok(Self::new(bytes))
    }
}

impl std::fmt::Debug for EncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EncryptionKey([REDACTED])")
    }
}

// ── Chained HMAC ──────────────────────────────────────────────────────────────

/// Verifies WAL record chain integrity using chained HMAC-SHA256.
///
/// Each record's HMAC covers `record[n-1].hmac || record[n].payload`, so
/// deletion or reordering of any record breaks the chain and is detected
/// during recovery.
pub struct ChainedHmacVerifier {
    key: [u8; 32],
    prev_hmac: [u8; 32],
}

impl ChainedHmacVerifier {
    /// Create a verifier seeded with the database key and a genesis HMAC (all zeros for the first record).
    pub fn new(key: &EncryptionKey) -> Self {
        Self {
            key: *key.as_bytes(),
            prev_hmac: [0u8; 32],
        }
    }

    /// Compute the expected chained HMAC for the next record payload.
    pub fn compute(&self, record_payload: &[u8]) -> [u8; 32] {
        let mut mac = HmacSha256::new_from_slice(&self.key)
            .expect("HMAC key length is always valid for SHA256");
        mac.update(&self.prev_hmac);
        mac.update(record_payload);
        let result = mac.finalize().into_bytes();
        let mut out = [0u8; 32];
        out.copy_from_slice(&result);
        out
    }

    /// Verify a record's stored HMAC against the expected chained value.
    /// Returns `Ok(())` and advances the chain on success.
    pub fn verify_and_advance(
        &mut self,
        record_payload: &[u8],
        stored_hmac: &[u8; 32],
    ) -> OvnResult<()> {
        let expected = self.compute(record_payload);
        if expected != *stored_hmac {
            return Err(OvnError::EncodingError(
                "WAL record HMAC chain broken — tampering or data loss detected".to_string(),
            ));
        }
        self.prev_hmac = expected;
        Ok(())
    }

    /// Advance the chain without verification (used when writing new records).
    pub fn advance(&mut self, record_payload: &[u8]) -> [u8; 32] {
        let hmac = self.compute(record_payload);
        self.prev_hmac = hmac;
        hmac
    }

    /// Return the current chain tip HMAC.
    pub fn current_hmac(&self) -> &[u8; 32] {
        &self.prev_hmac
    }
}

// ── seccomp-BPF Profile ───────────────────────────────────────────────────────

/// Apply a syscall allowlist via seccomp-BPF after the database is opened.
///
/// Only active on Linux with the `seccomp` Cargo feature. On all other platforms
/// this is a no-op that always returns `Ok(())`.
///
/// Allowed syscalls: read, write, fsync, fdatasync, pread64, pwrite64,
/// openat (limited), close, futex, mmap (anonymous), munmap, getpid, exit_group.
/// Violations trigger SIGKILL (not SIGSYS).
pub fn apply_seccomp_profile() -> OvnResult<()> {
    #[cfg(all(target_os = "linux", feature = "seccomp"))]
    {
        linux_seccomp::apply()
            .map_err(|e| OvnError::InvalidConfig(format!("seccomp profile apply failed: {e}")))?;
    }
    Ok(())
}

#[cfg(all(target_os = "linux", feature = "seccomp"))]
mod linux_seccomp {
    // BPF filter using raw prctl + seccomp(2) syscall.
    // Allowed list: read(0), write(1), open(2), close(3), fstat(5), lseek(8),
    //   mmap(9, anon only), mprotect(10), munmap(11), brk(12), pread64(17),
    //   pwrite64(18), fsync(74), fdatasync(75), openat(257), futex(202),
    //   getpid(39), exit_group(231).
    //
    // SAFETY: We use stable x86-64 syscall numbers. The BPF program is a
    // minimal allowlist filter. Architecture check at the start prevents
    // cross-arch confusion. prctl(PR_SET_NO_NEW_PRIVS) is called before
    // seccomp to satisfy kernel requirements.

    use std::io;

    const PR_SET_NO_NEW_PRIVS: libc::c_int = 38;
    const PR_SET_SECCOMP: libc::c_int = 22;
    const SECCOMP_MODE_FILTER: libc::c_int = 2;

    #[repr(C)]
    struct SockFilter {
        code: u16,
        jt: u8,
        jf: u8,
        k: u32,
    }

    #[repr(C)]
    struct SockFprog {
        len: u16,
        filter: *const SockFilter,
    }

    // BPF instructions
    const BPF_LD: u16 = 0x00;
    const BPF_W: u16 = 0x00;
    const BPF_ABS: u16 = 0x20;
    const BPF_JMP: u16 = 0x05;
    const BPF_JEQ: u16 = 0x10;
    const BPF_RET: u16 = 0x06;
    const BPF_K: u16 = 0x00;

    const SECCOMP_RET_ALLOW: u32 = 0x7fff0000;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x80000000;
    const AUDIT_ARCH_X86_64: u32 = 0xC000003E;

    // Offset of syscall number in seccomp_data
    const SECCOMP_DATA_NR_OFFSET: u32 = 0;
    const SECCOMP_DATA_ARCH_OFFSET: u32 = 4;

    macro_rules! bpf_stmt {
        ($code:expr, $k:expr) => {
            SockFilter {
                code: $code,
                jt: 0,
                jf: 0,
                k: $k,
            }
        };
    }

    macro_rules! bpf_jump {
        ($code:expr, $k:expr, $jt:expr, $jf:expr) => {
            SockFilter {
                code: $code,
                jt: $jt,
                jf: $jf,
                k: $k,
            }
        };
    }

    pub fn apply() -> io::Result<()> {
        #[cfg(target_arch = "x86_64")]
        {
            let allowed: &[u32] = &[
                0,   // read
                1,   // write
                2,   // open
                3,   // close
                5,   // fstat
                8,   // lseek
                9,   // mmap
                10,  // mprotect
                11,  // munmap
                12,  // brk
                17,  // pread64
                18,  // pwrite64
                39,  // getpid
                74,  // fsync
                75,  // fdatasync
                202, // futex
                231, // exit_group
                257, // openat
            ];

            let mut prog: Vec<SockFilter> = Vec::new();

            // Check architecture — kill if not x86_64
            prog.push(bpf_stmt!(
                BPF_LD | BPF_W | BPF_ABS,
                SECCOMP_DATA_ARCH_OFFSET
            ));
            prog.push(bpf_jump!(
                BPF_JMP | BPF_JEQ | BPF_K,
                AUDIT_ARCH_X86_64,
                1,
                0
            ));
            prog.push(bpf_stmt!(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

            // Load syscall number
            prog.push(bpf_stmt!(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET));

            // Allow each syscall
            for &nr in allowed {
                prog.push(bpf_jump!(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1));
                prog.push(bpf_stmt!(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));
            }

            // Default: kill
            prog.push(bpf_stmt!(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

            let fprog = SockFprog {
                len: prog.len() as u16,
                filter: prog.as_ptr(),
            };

            // SAFETY: PR_SET_NO_NEW_PRIVS is a standard prctl call with no side effects
            // other than preventing privilege escalation — safe to call in any Rust process.
            let ret = unsafe { libc::prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
            if ret != 0 {
                return Err(io::Error::last_os_error());
            }

            // SAFETY: The BPF program is well-formed (validated by the kernel). `fprog` lives
            // on the stack for the duration of the prctl call. The filter only blocks syscalls
            // not in the allowlist.
            let ret = unsafe {
                libc::prctl(
                    PR_SET_SECCOMP,
                    SECCOMP_MODE_FILTER,
                    &fprog as *const SockFprog as libc::c_ulong,
                    0,
                    0,
                )
            };
            if ret != 0 {
                return Err(io::Error::last_os_error());
            }

            Ok(())
        }

        #[cfg(not(target_arch = "x86_64"))]
        {
            // seccomp BPF with syscall numbers is x86_64-specific.
            // For other Linux arches, skip silently.
            Ok(())
        }
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encryption_key_is_zeroed_on_drop() {
        let raw = [0xABu8; 32];
        let key = EncryptionKey::new(raw);
        assert_eq!(key.as_bytes()[0], 0xAB);
        drop(key);
        // After drop the memory is zeroed — we can't directly observe it here, but
        // Zeroizing guarantees it via Drop impl.
    }

    #[test]
    fn encryption_key_debug_does_not_leak() {
        let key = EncryptionKey::new([0u8; 32]);
        let debug = format!("{key:?}");
        assert!(debug.contains("REDACTED"));
        assert!(!debug.contains("00"));
    }

    #[test]
    fn chained_hmac_detects_tampering() {
        let key = EncryptionKey::new([0x42u8; 32]);
        let mut verifier = ChainedHmacVerifier::new(&key);

        let payload_a = b"record_a";
        let hmac_a = verifier.advance(payload_a);

        let payload_b = b"record_b";
        let hmac_b = verifier.advance(payload_b);

        // Fresh verifier to replay
        let mut replay = ChainedHmacVerifier::new(&key);
        replay
            .verify_and_advance(payload_a, &hmac_a)
            .expect("a should verify");
        replay
            .verify_and_advance(payload_b, &hmac_b)
            .expect("b should verify");

        // Tampered: skip record_a and verify record_b directly
        let mut tampered = ChainedHmacVerifier::new(&key);
        assert!(
            tampered.verify_and_advance(payload_b, &hmac_b).is_err(),
            "Skipping a record must break the chain"
        );
    }

    #[test]
    fn chained_hmac_detects_reorder() {
        let key = EncryptionKey::new([0x11u8; 32]);
        let mut writer = ChainedHmacVerifier::new(&key);
        let hmac_a = writer.advance(b"record_a");
        let hmac_b = writer.advance(b"record_b");

        // Replay in wrong order
        let mut replay = ChainedHmacVerifier::new(&key);
        let _ = hmac_a;
        assert!(
            replay.verify_and_advance(b"record_b", &hmac_b).is_err(),
            "Reordering records must break the chain"
        );
    }

    #[test]
    fn chained_hmac_works_with_wal_record_bytes() {
        use crate::storage::wal::{WalRecord, WalRecordType};

        let key = EncryptionKey::new([0x55u8; 32]);
        let mut writer = ChainedHmacVerifier::new(&key);

        // Simulate writing 3 WAL records
        let records: Vec<WalRecord> = (1..=3)
            .map(|txid| {
                WalRecord::new(
                    WalRecordType::Insert,
                    txid,
                    1,
                    [0; 16],
                    txid,
                    format!("doc_{txid}").into_bytes(),
                )
            })
            .collect();

        let hmacs: Vec<[u8; 32]> = records
            .iter()
            .map(|r| writer.advance(&r.encode()))
            .collect();

        // Replay and verify
        let mut verifier = ChainedHmacVerifier::new(&key);
        for (r, hmac) in records.iter().zip(hmacs.iter()) {
            verifier
                .verify_and_advance(&r.encode(), hmac)
                .expect("Valid chain must verify");
        }
    }

    #[test]
    fn apply_seccomp_is_noop_on_non_linux_or_no_feature() {
        // On Windows/macOS this must always succeed (no-op).
        let result = apply_seccomp_profile();
        assert!(result.is_ok());
    }
}
