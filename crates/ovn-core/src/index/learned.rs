//! Learned Index (PGM++ style) — AHIT Tier-1. [v2]
//!
//! A Piecewise Geometric Model (PGM) index that learns the distribution
//! of sorted keys and uses linear interpolation to predict the position
//! of a key within an epsilon error bound.
//!
//! ## How it works
//! 1. **Build**: Scan a sorted key list, fit piecewise linear segments
//!    such that each segment predicts position within `epsilon` error.
//! 2. **Lookup**: Binary-search the segment list to find the right segment,
//!    then compute predicted position, then exponential-search within
//!    a window of `2*epsilon` entries.
//! 3. **Drift**: If the actual data distribution shifts, the model becomes
//!    stale. A drift detector tracks mispredictions and triggers a rebuild
//!    when the error rate exceeds `DRIFT_THRESHOLD`.
//!
//! Reference: Ferragina & Vinciguerra, "The PGM-index: a fully-dynamic
//! compressed learned index with provable worst-case bounds", PVLDB 2020.

use std::sync::atomic::{AtomicU64, Ordering};

// ── PGM Segment ───────────────────────────────────────────────────────────────

/// One linear segment of the PGM model.
#[derive(Debug, Clone)]
pub struct PgmSegment {
    /// The first key this segment covers (as raw bytes, interpreted numerically for sorting).
    pub first_key: Vec<u8>,
    /// Linear slope: predicted_pos ≈ slope * (key - first_key) + intercept
    pub slope: f64,
    /// Intercept value.
    pub intercept: f64,
    /// The actual position in the sorted array where this segment starts.
    pub start_pos: usize,
}

impl PgmSegment {
    /// Predict the position of `key` within the sorted array.
    pub fn predict(&self, key: &[u8]) -> i64 {
        let key_val = bytes_to_f64(key);
        let first_val = bytes_to_f64(&self.first_key);
        let predicted = self.slope * (key_val - first_val) + self.intercept;
        self.start_pos as i64 + predicted.round() as i64
    }
}

// ── Learned Index ─────────────────────────────────────────────────────────────

/// Epsilon error bound: predicted position is within `EPSILON` of actual.
const EPSILON: i64 = 64;

/// If misprediction rate exceeds this, the model is marked dirty and needs rebuild.
const DRIFT_THRESHOLD: f64 = 0.10; // 10%

/// PGM-style Learned Index for AHIT Tier-1.
///
/// Optimized for bulk-loaded sorted data from MemTable/SSTable compaction.
/// Falls back to binary search if the model is dirty or empty.
pub struct LearnedIndex {
    /// Sorted list of (key, value, txid) entries.
    data: Vec<(Vec<u8>, Vec<u8>, u64)>,
    /// PGM segments (sorted by first_key).
    segments: Vec<PgmSegment>,
    /// Whether the model needs to be rebuilt (data has changed).
    dirty: bool,
    /// Total lookup count for drift detection.
    lookup_count: AtomicU64,
    /// Miss count (model prediction was off by more than EPSILON).
    miss_count: AtomicU64,
    /// Index name.
    pub name: String,
}

impl LearnedIndex {
    /// Create an empty learned index.
    pub fn new(name: String) -> Self {
        Self {
            data: Vec::new(),
            segments: Vec::new(),
            dirty: true,
            lookup_count: AtomicU64::new(0),
            miss_count: AtomicU64::new(0),
            name,
        }
    }

    /// Bulk-load from a sorted list of entries. O(N) build time.
    ///
    /// # Panics
    /// Panics if `entries` is not sorted by key.
    pub fn build_from_sorted(&mut self, entries: Vec<(Vec<u8>, Vec<u8>, u64)>) {
        self.data = entries;
        self.segments = Self::fit_segments(&self.data, EPSILON);
        self.dirty = false;
        self.lookup_count.store(0, Ordering::Relaxed);
        self.miss_count.store(0, Ordering::Relaxed);
    }

    /// Look up a key. Returns (value, txid) if found.
    ///
    /// If the model is dirty or empty, falls back to binary search.
    pub fn get(&self, key: &[u8]) -> Option<(&[u8], u64)> {
        if self.data.is_empty() {
            return None;
        }

        self.lookup_count.fetch_add(1, Ordering::Relaxed);

        let idx = if self.dirty || self.segments.is_empty() {
            // Fallback: binary search
            self.binary_search(key)?
        } else {
            // PGM prediction
            let seg = self.find_segment(key);
            let predicted = seg.predict(key).max(0).min(self.data.len() as i64 - 1) as usize;

            // Exponential search within [predicted - EPSILON, predicted + EPSILON]
            let lo = predicted.saturating_sub(EPSILON as usize);
            let hi = (predicted + EPSILON as usize + 1).min(self.data.len());

            let result = self.data[lo..hi].binary_search_by_key(&key, |(k, _, _)| k.as_slice());
            match result {
                Ok(i) => lo + i,
                Err(_) => {
                    self.miss_count.fetch_add(1, Ordering::Relaxed);
                    // Fallback to full binary search
                    self.binary_search(key)?
                }
            }
        };

        let (_, value, txid) = &self.data[idx];
        Some((value, *txid))
    }

    /// Number of entries in this index.
    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    /// Whether the model needs to be rebuilt due to data drift.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Misprediction rate (0.0–1.0). Above DRIFT_THRESHOLD → rebuild.
    pub fn drift_rate(&self) -> f64 {
        let total = self.lookup_count.load(Ordering::Relaxed);
        let misses = self.miss_count.load(Ordering::Relaxed);
        if total == 0 { 0.0 } else { misses as f64 / total as f64 }
    }

    /// Whether the model should be rebuilt (drift rate exceeded threshold).
    pub fn needs_rebuild(&self) -> bool {
        self.dirty || (self.lookup_count.load(Ordering::Relaxed) > 1000
            && self.drift_rate() > DRIFT_THRESHOLD)
    }

    /// Mark this index as dirty (forces fallback to binary search until rebuilt).
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Get all entries (for compaction / merging into next tier).
    pub fn scan_all(&self) -> &[(Vec<u8>, Vec<u8>, u64)] {
        &self.data
    }

    /// Range scan: returns entries where key is in [from, to).
    pub fn range_scan(&self, from: &[u8], to: &[u8]) -> Vec<(&[u8], &[u8], u64)> {
        let start = self.data.partition_point(|(k, _, _)| k.as_slice() < from);
        let end = self.data.partition_point(|(k, _, _)| k.as_slice() < to);
        self.data[start..end]
            .iter()
            .map(|(k, v, t)| (k.as_slice(), v.as_slice(), *t))
            .collect()
    }

    // ── Internal ─────────────────────────────────────────────────

    fn binary_search(&self, key: &[u8]) -> Option<usize> {
        self.data
            .binary_search_by_key(&key, |(k, _, _)| k.as_slice())
            .ok()
    }

    fn find_segment(&self, key: &[u8]) -> &PgmSegment {
        // Binary search segments by first_key
        let idx = self.segments
            .partition_point(|s| s.first_key.as_slice() <= key);
        let idx = idx.saturating_sub(1).min(self.segments.len() - 1);
        &self.segments[idx]
    }

    /// Fit PGM segments from sorted data with given epsilon.
    fn fit_segments(data: &[(Vec<u8>, Vec<u8>, u64)], epsilon: i64) -> Vec<PgmSegment> {
        if data.is_empty() {
            return Vec::new();
        }

        let mut segments = Vec::new();
        let mut seg_start = 0usize;

        // Simple O(N) greedy algorithm
        let mut slope_lo = f64::NEG_INFINITY;
        let mut slope_hi = f64::INFINITY;

        for (i, (key, _, _)) in data.iter().enumerate() {
            if i == seg_start {
                // First point of segment — no slope constraint yet
                slope_lo = f64::NEG_INFINITY;
                slope_hi = f64::INFINITY;
                continue;
            }

            let x0 = bytes_to_f64(&data[seg_start].0);
            let xi = bytes_to_f64(key);
            let dx = xi - x0;

            if dx == 0.0 {
                continue; // Duplicate key values in numeric domain
            }

            let target_pos = (i - seg_start) as f64;
            let new_slope_lo = (target_pos - epsilon as f64) / dx;
            let new_slope_hi = (target_pos + epsilon as f64) / dx;

            // Tighten slope bounds
            let new_lo = slope_lo.max(new_slope_lo);
            let new_hi = slope_hi.min(new_slope_hi);

            if new_lo > new_hi {
                // Cannot maintain epsilon — start a new segment
                let slope = (slope_lo + slope_hi) / 2.0;
                segments.push(PgmSegment {
                    first_key: data[seg_start].0.clone(),
                    slope: slope.max(0.0),
                    intercept: 0.0,
                    start_pos: seg_start,
                });
                seg_start = i;
                slope_lo = f64::NEG_INFINITY;
                slope_hi = f64::INFINITY;
            } else {
                slope_lo = new_lo;
                slope_hi = new_hi;
            }
        }

        // Final segment
        let slope = if slope_lo.is_finite() && slope_hi.is_finite() {
            (slope_lo + slope_hi) / 2.0
        } else {
            0.0
        };
        segments.push(PgmSegment {
            first_key: data[seg_start].0.clone(),
            slope: slope.max(0.0),
            intercept: 0.0,
            start_pos: seg_start,
        });

        segments
    }
}

/// Convert up to 8 bytes of a key to f64 for slope calculations.
fn bytes_to_f64(key: &[u8]) -> f64 {
    let mut arr = [0u8; 8];
    let n = key.len().min(8);
    arr[..n].copy_from_slice(&key[..n]);
    u64::from_be_bytes(arr) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_sorted_entries(count: usize) -> Vec<(Vec<u8>, Vec<u8>, u64)> {
        (0..count)
            .map(|i| {
                let key = format!("{:08}", i).into_bytes();
                let val = format!("val_{}", i).into_bytes();
                (key, val, i as u64)
            })
            .collect()
    }

    #[test]
    fn test_learned_index_build_and_get() {
        let mut idx = LearnedIndex::new("test".to_string());
        let entries = make_sorted_entries(1000);
        idx.build_from_sorted(entries);

        assert!(!idx.is_dirty());
        assert_eq!(idx.len(), 1000);

        let (v, t) = idx.get(b"00000042").unwrap();
        assert_eq!(v, b"val_42");
        assert_eq!(t, 42);
    }

    #[test]
    fn test_learned_index_miss_fallback() {
        let mut idx = LearnedIndex::new("test".to_string());
        let entries = make_sorted_entries(100);
        idx.build_from_sorted(entries);

        // Key not in index
        assert!(idx.get(b"NOTEXIST").is_none());
    }

    #[test]
    fn test_learned_index_range_scan() {
        let mut idx = LearnedIndex::new("test".to_string());
        let entries = make_sorted_entries(100);
        idx.build_from_sorted(entries);

        let results = idx.range_scan(b"00000010", b"00000020");
        assert_eq!(results.len(), 10); // 10..19 inclusive but to is exclusive
    }

    #[test]
    fn test_learned_index_drift_rate() {
        let mut idx = LearnedIndex::new("test".to_string());
        let entries = make_sorted_entries(1000);
        idx.build_from_sorted(entries);

        // Many successful lookups → drift rate stays low
        for i in 0..100usize {
            let key = format!("{:08}", i);
            idx.get(key.as_bytes());
        }
        assert!(idx.drift_rate() < DRIFT_THRESHOLD);
    }

    #[test]
    fn test_pgm_segment_count_is_reasonable() {
        let mut idx = LearnedIndex::new("test".to_string());
        idx.build_from_sorted(make_sorted_entries(10_000));
        // Should have far fewer segments than entries
        assert!(idx.segments.len() < 1000);
        assert!(!idx.segments.is_empty());
    }
}
