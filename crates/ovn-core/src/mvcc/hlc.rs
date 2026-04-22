//! Hybrid Logical Clock (HLC) for v2 TxID generation. [v2]
//!
//! HLC combines physical time (wall clock milliseconds) with a logical counter
//! to produce monotonically increasing timestamps that are:
//! - Causally ordered (send → receive always increases)
//! - Bounded drift from physical time (≤ `MAX_DRIFT_MS`)
//! - Compact: packed into a u64 (48-bit physical ms + 16-bit logical counter)
//!
//! ## u64 Layout
//! ```text
//! [63..16]  physical_ms (48 bits) — milliseconds since Unix epoch
//! [15..0]   logical (16 bits)    — monotonic counter within same ms
//! ```
//!
//! Reference: Kulkarni et al., "Logical Physical Clocks and Consistent Snapshots
//! in Globally Distributed Databases", OPODIS 2014.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::{HLC_LOGICAL_MASK, HLC_LOGICAL_BITS};

/// Maximum allowed clock drift (in milliseconds).
/// If the wall clock is more than this far behind the last observed timestamp,
/// the logical counter is advanced instead of moving the physical clock backward.
const MAX_DRIFT_MS: u64 = 60_000; // 60 seconds

// ── HlcTimestamp ─────────────────────────────────────────────────────────────

/// A packed HLC timestamp (fits in a u64 TxID field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct HlcTimestamp(pub u64);

impl HlcTimestamp {
    /// Pack from physical milliseconds and logical counter.
    pub fn new(physical_ms: u64, logical: u16) -> Self {
        let packed = (physical_ms << HLC_LOGICAL_BITS) | (logical as u64 & HLC_LOGICAL_MASK);
        Self(packed)
    }

    /// Physical time component (milliseconds).
    pub fn physical_ms(self) -> u64 {
        self.0 >> HLC_LOGICAL_BITS
    }

    /// Logical counter component.
    pub fn logical(self) -> u16 {
        (self.0 & HLC_LOGICAL_MASK) as u16
    }

    /// The raw u64 value (suitable for use as a TxID).
    pub fn as_u64(self) -> u64 {
        self.0
    }

    /// Reconstruct from a raw u64 TxID.
    pub fn from_u64(v: u64) -> Self {
        Self(v)
    }

    /// Zero timestamp (used as sentinel).
    pub const ZERO: Self = Self(0);
}

impl std::fmt::Display for HlcTimestamp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "HLC({}.{})", self.physical_ms(), self.logical())
    }
}

// ── HlcClock ─────────────────────────────────────────────────────────────────

/// Thread-safe Hybrid Logical Clock.
///
/// Use `HlcClock::now()` to generate a new TxID.
/// Use `HlcClock::recv(remote)` when receiving a message from another node
/// to maintain causal ordering.
pub struct HlcClock {
    /// Packed HLC state: physical_ms in top 48 bits, logical in bottom 16.
    state: AtomicU64,
}

impl HlcClock {
    /// Create a new HLC clock seeded with the current wall clock time.
    pub fn new() -> Self {
        let now_ms = wall_clock_ms();
        Self {
            state: AtomicU64::new(HlcTimestamp::new(now_ms, 0).as_u64()),
        }
    }

    /// Restore from a persisted state (e.g. read from file header).
    pub fn from_persisted(persisted: u64) -> Self {
        let now_ms = wall_clock_ms();
        let persisted_ts = HlcTimestamp::from_u64(persisted);
        // Always ensure we're at least at the current wall clock
        let start = if persisted_ts.physical_ms() > now_ms {
            persisted
        } else {
            HlcTimestamp::new(now_ms, 0).as_u64()
        };
        Self {
            state: AtomicU64::new(start),
        }
    }

    /// Generate a new HLC timestamp for a local event (send or local write).
    ///
    /// Guarantees: returned timestamp > all previously returned timestamps.
    pub fn now(&self) -> HlcTimestamp {
        let wall_ms = wall_clock_ms();

        loop {
            let old = self.state.load(Ordering::Acquire);
            let old_ts = HlcTimestamp::from_u64(old);

            let (new_physical, new_logical) = if wall_ms > old_ts.physical_ms() {
                // Wall clock advanced — reset logical counter
                (wall_ms, 0u16)
            } else {
                // Wall clock same or behind — increment logical
                let new_logical = old_ts.logical().checked_add(1).unwrap_or_else(|| {
                    // Logical overflow — advance physical by 1ms
                    // (rare: would require >65535 txns in 1ms)
                    0
                });
                let new_physical = if new_logical == 0 {
                    old_ts.physical_ms() + 1
                } else {
                    old_ts.physical_ms()
                };
                (new_physical, new_logical)
            };

            let new = HlcTimestamp::new(new_physical, new_logical);

            // CAS to update: retry if another thread raced ahead
            match self.state.compare_exchange(old, new.as_u64(), Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return new,
                Err(_) => continue, // retry
            }
        }
    }

    /// Merge an incoming remote HLC timestamp (receive event).
    ///
    /// Returns the new local HLC that causally dominates the remote event.
    pub fn recv(&self, remote: HlcTimestamp) -> HlcTimestamp {
        let wall_ms = wall_clock_ms();

        loop {
            let old = self.state.load(Ordering::Acquire);
            let old_ts = HlcTimestamp::from_u64(old);

            // Sanity: reject remote timestamps that are too far in the future
            if remote.physical_ms() > wall_ms + MAX_DRIFT_MS {
                // Ignore the remote timestamp — use local now instead
                return self.now();
            }

            let max_physical = old_ts.physical_ms().max(remote.physical_ms()).max(wall_ms);
            let new_logical = if max_physical == old_ts.physical_ms()
                && max_physical == remote.physical_ms()
            {
                old_ts.logical().max(remote.logical()) + 1
            } else if max_physical == old_ts.physical_ms() {
                old_ts.logical() + 1
            } else if max_physical == remote.physical_ms() {
                remote.logical() + 1
            } else {
                0
            };

            let new = HlcTimestamp::new(max_physical, new_logical);

            match self.state.compare_exchange(old, new.as_u64(), Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return new,
                Err(_) => continue,
            }
        }
    }

    /// Get the current HLC state (for persisting to file header).
    pub fn current(&self) -> HlcTimestamp {
        HlcTimestamp::from_u64(self.state.load(Ordering::Acquire))
    }

    /// Force-update the clock to at least `min_ts` (e.g., after reading from file).
    pub fn advance_to(&self, min_ts: HlcTimestamp) {
        loop {
            let old = self.state.load(Ordering::Acquire);
            if old >= min_ts.as_u64() {
                break;
            }
            if self.state.compare_exchange(old, min_ts.as_u64(), Ordering::AcqRel, Ordering::Acquire).is_ok() {
                break;
            }
        }
    }
}

impl Default for HlcClock {
    fn default() -> Self {
        Self::new()
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn wall_clock_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ── Simple monotonic fallback (for tests / embedded) ─────────────────────────

/// Monotonic u64 counter used when `hlc_enabled = false`.
pub struct MonotonicClock {
    counter: AtomicU64,
}

impl MonotonicClock {
    pub fn new() -> Self {
        let seed = wall_clock_ms() << HLC_LOGICAL_BITS;
        Self {
            counter: AtomicU64::new(seed),
        }
    }

    pub fn next(&self) -> u64 {
        self.counter.fetch_add(1, Ordering::SeqCst)
    }

    pub fn current(&self) -> u64 {
        self.counter.load(Ordering::SeqCst)
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hlc_timestamp_pack_unpack() {
        let ts = HlcTimestamp::new(1_700_000_000_000, 42);
        assert_eq!(ts.physical_ms(), 1_700_000_000_000);
        assert_eq!(ts.logical(), 42);
    }

    #[test]
    fn test_hlc_now_monotonic() {
        let clock = HlcClock::new();
        let mut prev = clock.now();
        for _ in 0..1000 {
            let next = clock.now();
            assert!(next > prev, "{} should be > {}", next, prev);
            prev = next;
        }
    }

    #[test]
    fn test_hlc_recv_advances_past_remote() {
        let clock = HlcClock::new();
        let current = clock.current();

        // Simulate a remote timestamp slightly in the future
        let remote = HlcTimestamp::new(current.physical_ms() + 10, 5);
        let merged = clock.recv(remote);
        assert!(merged > remote || merged.physical_ms() >= remote.physical_ms());
        // After recv, now() must be > remote
        let after = clock.now();
        assert!(after > remote);
    }

    #[test]
    fn test_hlc_logical_increment_same_ms() {
        let clock = HlcClock::new();
        // Force many calls in rapid succession to hit logical increment
        let mut prev = clock.now();
        for _ in 0..100 {
            let next = clock.now();
            assert!(next > prev);
            prev = next;
        }
    }

    #[test]
    fn test_monotonic_clock() {
        let clock = MonotonicClock::new();
        let a = clock.next();
        let b = clock.next();
        assert!(b > a);
    }

    #[test]
    fn test_hlc_from_persisted() {
        let future_ms = wall_clock_ms() + 5000;
        let persisted = HlcTimestamp::new(future_ms, 10).as_u64();
        let clock = HlcClock::from_persisted(persisted);
        // Clock should start at or above the persisted value
        let ts = clock.now();
        assert!(ts.physical_ms() >= future_ms);
    }
}
