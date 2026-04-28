//! ARC (Adaptive Replacement Cache) — v2 Buffer Pool eviction algorithm.
//!
//! ARC adaptively balances between recency (T1) and frequency (T2),
//! outperforming LRU on mixed workloads (sequential scans + random access).
//!
//! ## Algorithm
//! - T1: Recently-accessed pages (first access). LRU eviction target.
//! - T2: Frequently-accessed pages (accessed 2+ times). Protected.
//! - B1: Ghost list for pages evicted from T1 (tracks "recently evicted recency").
//! - B2: Ghost list for pages evicted from T2 (tracks "recently evicted frequency").
//! - p: Adaptive split parameter. Ghost hits push p toward protecting that tier.
//!
//! Reference: Megiddo & Modha, "ARC: A Self-Tuning, Low Overhead Replacement Cache", FAST 2003.

use parking_lot::Mutex;
use std::collections::{HashMap, VecDeque};

// ── Entry ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct ArcEntry<V: Clone> {
    pub value: V,
    pub pinned: bool,
}

// ── ARC Cache ─────────────────────────────────────────────────────────────────

/// ARC page cache. Generic over value type `V`.
pub struct ArcCache<V: Clone> {
    inner: Mutex<ArcInner<V>>,
    capacity: usize,
}

struct ArcInner<V: Clone> {
    // Live entries
    t1: HashMap<u64, ArcEntry<V>>, // Recency list
    t2: HashMap<u64, ArcEntry<V>>, // Frequency list
    // Ordering lists (front = most recent)
    t1_order: VecDeque<u64>,
    t2_order: VecDeque<u64>,
    // Ghost lists (keys only, no values)
    b1: VecDeque<u64>,
    b2: VecDeque<u64>,
    // Adaptive parameter: target size for T1 (0..capacity)
    p: usize,
    // Stats
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl<V: Clone> ArcCache<V> {
    /// Create a new ARC cache with the given capacity (in pages).
    pub fn new(capacity: usize) -> Self {
        let cap = capacity.max(1); // minimum 1 page
        Self {
            capacity: cap,
            inner: Mutex::new(ArcInner {
                t1: HashMap::with_capacity(cap),
                t2: HashMap::with_capacity(cap),
                t1_order: VecDeque::with_capacity(cap),
                t2_order: VecDeque::with_capacity(cap),
                b1: VecDeque::with_capacity(cap),
                b2: VecDeque::with_capacity(cap),
                p: 0,
                hits: 0,
                misses: 0,
                evictions: 0,
            }),
        }
    }

    /// Capacity in pages.
    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Number of live cached entries.
    pub fn len(&self) -> usize {
        let g = self.inner.lock();
        g.t1.len() + g.t2.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Look up a page. Returns `Some` if in T1 or T2.
    /// A T1 hit promotes the entry to T2.
    pub fn get(&self, key: u64) -> Option<V> {
        let mut g = self.inner.lock();

        // T2 hit (frequent access)
        if let Some(entry) = g.t2.get(&key) {
            let val = entry.value.clone();
            // Move to front of T2
            g.t2_order.retain(|&k| k != key);
            g.t2_order.push_front(key);
            g.hits += 1;
            return Some(val);
        }

        // T1 hit (recent → promote to T2)
        if let Some(entry) = g.t1.remove(&key) {
            let val = entry.value.clone();
            g.t1_order.retain(|&k| k != key);
            g.t2.insert(
                key,
                ArcEntry {
                    value: val.clone(),
                    pinned: entry.pinned,
                },
            );
            g.t2_order.push_front(key);
            g.hits += 1;
            return Some(val);
        }

        g.misses += 1;
        None
    }

    /// Insert a page. Handles ghost-list adaptation and eviction.
    pub fn insert(&self, key: u64, value: V) {
        let mut g = self.inner.lock();
        let cap = self.capacity;

        // Case 1: Already in T1 or T2 — update value, promote if T1
        if g.t2.contains_key(&key) {
            if let Some(e) = g.t2.get_mut(&key) {
                e.value = value;
            }
            g.t2_order.retain(|&k| k != key);
            g.t2_order.push_front(key);
            return;
        }
        if g.t1.contains_key(&key) {
            g.t1.remove(&key);
            g.t1_order.retain(|&k| k != key);
            g.t2.insert(
                key,
                ArcEntry {
                    value,
                    pinned: false,
                },
            );
            g.t2_order.push_front(key);
            return;
        }

        // Case 2: Ghost hit in B1 (recently evicted from T1 — bias toward recency)
        if g.b1.contains(&key) {
            // Adapt p upward
            let b1_len = g.b1.len().max(1);
            let b2_len = g.b2.len().max(1);
            let delta = if b1_len >= b2_len { 1 } else { b2_len / b1_len };
            g.p = (g.p + delta).min(cap);
            g.b1.retain(|&k| k != key);
            g.arc_replace(&mut 0, cap, true);
            g.t2.insert(
                key,
                ArcEntry {
                    value,
                    pinned: false,
                },
            );
            g.t2_order.push_front(key);
            return;
        }

        // Case 3: Ghost hit in B2 (recently evicted from T2 — bias toward frequency)
        if g.b2.contains(&key) {
            let b1_len = g.b1.len().max(1);
            let b2_len = g.b2.len().max(1);
            let delta = if b2_len >= b1_len { 1 } else { b1_len / b2_len };
            g.p = g.p.saturating_sub(delta);
            g.b2.retain(|&k| k != key);
            g.arc_replace(&mut 0, cap, false);
            g.t2.insert(
                key,
                ArcEntry {
                    value,
                    pinned: false,
                },
            );
            g.t2_order.push_front(key);
            return;
        }

        // Case 4: Completely new page
        let total = g.t1.len() + g.t2.len();
        let total_with_ghost = total + g.b1.len() + g.b2.len();

        if total >= cap {
            // Cache is full — evict
            g.arc_replace(&mut 0, cap, false);
        } else if total_with_ghost >= cap {
            // Directory is full — trim a ghost
            if g.b1.len() + g.b2.len() + total >= 2 * cap {
                if let Some(oldest) = g.b2.pop_back() {
                    let _ = oldest;
                } else {
                    g.b1.pop_back();
                }
            }
        }

        g.t1.insert(
            key,
            ArcEntry {
                value,
                pinned: false,
            },
        );
        g.t1_order.push_front(key);
    }

    /// Remove a page from T1 or T2.
    pub fn remove(&self, key: u64) -> Option<V> {
        let mut g = self.inner.lock();
        if let Some(e) = g.t1.remove(&key) {
            g.t1_order.retain(|&k| k != key);
            return Some(e.value);
        }
        if let Some(e) = g.t2.remove(&key) {
            g.t2_order.retain(|&k| k != key);
            return Some(e.value);
        }
        None
    }

    /// Pin a page (prevent eviction).
    pub fn pin(&self, key: u64) {
        let mut g = self.inner.lock();
        if let Some(e) = g.t1.get_mut(&key) {
            e.pinned = true;
        } else if let Some(e) = g.t2.get_mut(&key) {
            e.pinned = true;
        }
    }

    /// Unpin a page.
    pub fn unpin(&self, key: u64) {
        let mut g = self.inner.lock();
        if let Some(e) = g.t1.get_mut(&key) {
            e.pinned = false;
        } else if let Some(e) = g.t2.get_mut(&key) {
            e.pinned = false;
        }
    }

    /// Drain all cached values (e.g. for flush).
    /// Returns (key, value) pairs for all entries in T1 ∪ T2.
    pub fn drain_all(&self) -> Vec<(u64, V)> {
        let g = self.inner.lock();
        let mut out = Vec::with_capacity(g.t1.len() + g.t2.len());
        for (k, e) in g.t1.iter().chain(g.t2.iter()) {
            out.push((*k, e.value.clone()));
        }
        out
    }

    /// Stats: (hits, misses, evictions).
    pub fn stats(&self) -> (u64, u64, u64) {
        let g = self.inner.lock();
        (g.hits, g.misses, g.evictions)
    }

    /// Reset stats.
    pub fn reset_stats(&self) {
        let mut g = self.inner.lock();
        g.hits = 0;
        g.misses = 0;
        g.evictions = 0;
    }
}

impl<V: Clone> ArcInner<V> {
    /// ARC replacement: evict one page from T1 or T2 depending on `p`.
    fn arc_replace(&mut self, _evicted: &mut usize, cap: usize, prefer_t2: bool) {
        let t1_len = self.t1.len();
        let t2_len = self.t2.len();

        // Try T1 if |T1| > p (or forced)
        let evict_t1 =
            !prefer_t2 && t1_len > 0 && (t1_len > self.p || (t1_len == self.p && t2_len > 0));

        if evict_t1 {
            if let Some(&victim) = self.t1_order.back() {
                if !self.t1.get(&victim).is_some_and(|e| e.pinned) {
                    self.t1.remove(&victim);
                    self.t1_order.pop_back();
                    // Add to B1 ghost list (cap size to `cap`)
                    self.b1.push_front(victim);
                    if self.b1.len() > cap {
                        self.b1.pop_back();
                    }
                    self.evictions += 1;
                    return;
                }
            }
        }

        // Evict from T2
        if let Some(&victim) = self.t2_order.back() {
            if !self.t2.get(&victim).is_some_and(|e| e.pinned) {
                self.t2.remove(&victim);
                self.t2_order.pop_back();
                self.b2.push_front(victim);
                if self.b2.len() > cap {
                    self.b2.pop_back();
                }
                self.evictions += 1;
                return;
            }
        }

        // Fallback: evict oldest unpinned from T1
        for _ in 0..self.t1_order.len() {
            if let Some(&victim) = self.t1_order.back() {
                if !self.t1.get(&victim).is_some_and(|e| e.pinned) {
                    self.t1.remove(&victim);
                    self.t1_order.pop_back();
                    self.b1.push_front(victim);
                    if self.b1.len() > cap {
                        self.b1.pop_back();
                    }
                    self.evictions += 1;
                    return;
                }
                // Pinned — move to front (protect it) and try next
                self.t1_order.pop_back();
                self.t1_order.push_front(victim);
            }
        }
        // If all T1 are pinned, try evicting from T2 (already tried above but without pin check)
        // This is a safety net — in practice, callers should unpin before overflow
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_arc_basic_get_insert() {
        let cache: ArcCache<u64> = ArcCache::new(4);
        cache.insert(1, 100);
        cache.insert(2, 200);

        assert_eq!(cache.get(1), Some(100));
        assert_eq!(cache.get(2), Some(200));
        assert_eq!(cache.get(99), None);

        let (hits, misses, _) = cache.stats();
        assert_eq!(hits, 2);
        assert_eq!(misses, 1);
    }

    #[test]
    fn test_arc_promotion_t1_to_t2() {
        let cache: ArcCache<u64> = ArcCache::new(8);
        cache.insert(1, 10);

        // First access — still in T1
        let v1 = cache.get(1);
        assert_eq!(v1, Some(10));

        // After T1 get, should be promoted to T2
        // Insert again shouldn't reset to T1
        cache.insert(1, 11);
        let v2 = cache.get(1);
        assert_eq!(v2, Some(11));
    }

    #[test]
    fn test_arc_eviction_on_capacity() {
        let cache: ArcCache<u64> = ArcCache::new(3);
        cache.insert(1, 1);
        cache.insert(2, 2);
        cache.insert(3, 3);
        cache.insert(4, 4); // Should trigger eviction

        // Verify at least one eviction occurred
        let (_, _, evictions) = cache.stats();
        assert!(
            evictions >= 1,
            "Expected at least one eviction, got {evictions}"
        );
    }

    #[test]
    fn test_arc_remove() {
        let cache: ArcCache<u64> = ArcCache::new(4);
        cache.insert(1, 100);
        assert_eq!(cache.remove(1), Some(100));
        assert_eq!(cache.get(1), None);
    }

    #[test]
    fn test_arc_pin_prevents_eviction() {
        let cache: ArcCache<u64> = ArcCache::new(2);
        cache.insert(1, 1);
        cache.insert(2, 2);
        cache.pin(1);
        cache.insert(3, 3); // Must evict 2, not 1
                            // Page 1 should still be accessible
        assert_eq!(cache.get(1), Some(1));
        cache.unpin(1);
    }

    #[test]
    fn test_arc_drain_all() {
        let cache: ArcCache<u32> = ArcCache::new(4);
        cache.insert(1, 10);
        cache.insert(2, 20);
        let all = cache.drain_all();
        assert_eq!(all.len(), 2);
    }
}
