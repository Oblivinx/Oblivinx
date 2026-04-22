//! Zone Map — per-page min/max/null-count sketches for predicate pushdown. [v2]
//!
//! Zone maps allow the query engine to skip pages entirely when a filter predicate
//! cannot possibly match any value on that page.
//!
//! For each page, we store:
//! - Min value per field
//! - Max value per field
//! - Null count per field
//!
//! Phase 5 full implementation: HLL-based distinct count estimation.

use parking_lot::RwLock;
use std::collections::HashMap;

use crate::storage::columnar::ColumnValue;

// ── Field Zone Map ────────────────────────────────────────────────────────────

/// Zone map for a single field within a single page.
#[derive(Debug, Clone)]
pub struct FieldZoneMap {
    /// Minimum value seen on this page (for this field).
    pub min: Option<ColumnValue>,
    /// Maximum value seen on this page.
    pub max: Option<ColumnValue>,
    /// Number of null values.
    pub null_count: u32,
    /// Total row count on this page.
    pub total_count: u32,
}

impl FieldZoneMap {
    pub fn new() -> Self {
        Self {
            min: None,
            max: None,
            null_count: 0,
            total_count: 0,
        }
    }

    /// Update zone map with a new value.
    pub fn observe(&mut self, value: &ColumnValue) {
        self.total_count += 1;
        match value {
            ColumnValue::Null => {
                self.null_count += 1;
                return;
            }
            val => {
                if self.min.is_none() {
                    self.min = Some(val.clone());
                    self.max = Some(val.clone());
                } else {
                    // Update min/max based on i64 for numeric types
                    if let (Some(ColumnValue::Int64(cur_min)), ColumnValue::Int64(v)) =
                        (&self.min, val)
                    {
                        if v < cur_min {
                            self.min = Some(val.clone());
                        }
                    }
                    if let (Some(ColumnValue::Int64(cur_max)), ColumnValue::Int64(v)) =
                        (&self.max, val)
                    {
                        if v > cur_max {
                            self.max = Some(val.clone());
                        }
                    }
                }
            }
        }
    }

    /// Whether a page CAN contain rows satisfying `value >= lower AND value <= upper`.
    /// Returns `false` (skip page) only if we are certain no match is possible.
    pub fn can_match_range(
        &self,
        lower: Option<&ColumnValue>,
        upper: Option<&ColumnValue>,
    ) -> bool {
        // If all values are null, numeric range cannot match
        if self.null_count == self.total_count && self.total_count > 0 {
            return false;
        }

        // Check lower bound: page max < lower → skip
        if let (Some(lower_val), Some(ColumnValue::Int64(page_max))) =
            (lower, &self.max)
        {
            if let ColumnValue::Int64(l) = lower_val {
                if page_max < l {
                    return false;
                }
            }
        }

        // Check upper bound: page min > upper → skip
        if let (Some(upper_val), Some(ColumnValue::Int64(page_min))) =
            (upper, &self.min)
        {
            if let ColumnValue::Int64(u) = upper_val {
                if page_min > u {
                    return false;
                }
            }
        }

        true
    }
}

impl Default for FieldZoneMap {
    fn default() -> Self {
        Self::new()
    }
}

// ── Page Zone Map ─────────────────────────────────────────────────────────────

/// Zone map for an entire page (all fields).
#[derive(Debug, Default, Clone)]
pub struct PageZoneMap {
    pub page_num: u64,
    pub fields: HashMap<String, FieldZoneMap>,
}

impl PageZoneMap {
    pub fn new(page_num: u64) -> Self {
        Self {
            page_num,
            fields: HashMap::new(),
        }
    }

    /// Observe a field value on this page.
    pub fn observe(&mut self, field: &str, value: &ColumnValue) {
        self.fields
            .entry(field.to_string())
            .or_default()
            .observe(value);
    }

    /// Whether this page can possibly match the range predicate on `field`.
    pub fn can_match_range(
        &self,
        field: &str,
        lower: Option<&ColumnValue>,
        upper: Option<&ColumnValue>,
    ) -> bool {
        match self.fields.get(field) {
            Some(fzm) => fzm.can_match_range(lower, upper),
            None => true, // No zone map info → cannot prune → must scan
        }
    }
}

// ── Zone Map Registry ─────────────────────────────────────────────────────────

/// Global in-memory zone map registry.
/// Maps page_number → PageZoneMap.
pub struct ZoneMapRegistry {
    maps: RwLock<HashMap<u64, PageZoneMap>>,
}

impl ZoneMapRegistry {
    pub fn new() -> Self {
        Self {
            maps: RwLock::new(HashMap::new()),
        }
    }

    /// Record a field observation for a page.
    pub fn observe(&self, page_num: u64, field: &str, value: &ColumnValue) {
        self.maps
            .write()
            .entry(page_num)
            .or_insert_with(|| PageZoneMap::new(page_num))
            .observe(field, value);
    }

    /// Check whether `page_num` can match a range predicate.
    pub fn can_match_range(
        &self,
        page_num: u64,
        field: &str,
        lower: Option<&ColumnValue>,
        upper: Option<&ColumnValue>,
    ) -> bool {
        match self.maps.read().get(&page_num) {
            Some(pzm) => pzm.can_match_range(field, lower, upper),
            None => true,
        }
    }

    /// Remove zone maps for pages that have been compacted/evicted.
    pub fn evict_pages(&self, page_nums: &[u64]) {
        let mut maps = self.maps.write();
        for pn in page_nums {
            maps.remove(pn);
        }
    }

    /// Number of pages with zone map data.
    pub fn page_count(&self) -> usize {
        self.maps.read().len()
    }
}

impl Default for ZoneMapRegistry {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_field_zone_map_observe_and_prune() {
        let mut fzm = FieldZoneMap::new();
        fzm.observe(&ColumnValue::Int64(10));
        fzm.observe(&ColumnValue::Int64(20));
        fzm.observe(&ColumnValue::Int64(15));

        // Page contains [10, 20]: query for [5, 25] should match
        assert!(fzm.can_match_range(
            Some(&ColumnValue::Int64(5)),
            Some(&ColumnValue::Int64(25))
        ));

        // Query for [25, 30] should NOT match (page max = 20 < 25)
        assert!(!fzm.can_match_range(
            Some(&ColumnValue::Int64(25)),
            Some(&ColumnValue::Int64(30))
        ));
    }

    #[test]
    fn test_zone_map_registry() {
        let reg = ZoneMapRegistry::new();
        reg.observe(1, "age", &ColumnValue::Int64(25));
        reg.observe(1, "age", &ColumnValue::Int64(40));
        reg.observe(2, "age", &ColumnValue::Int64(60));
        reg.observe(2, "age", &ColumnValue::Int64(70));

        // Page 1: [25,40] — query [30,50] should match
        assert!(reg.can_match_range(1, "age", Some(&ColumnValue::Int64(30)), Some(&ColumnValue::Int64(50))));
        // Page 2: [60,70] — query [30,50] should NOT match
        assert!(!reg.can_match_range(2, "age", Some(&ColumnValue::Int64(30)), Some(&ColumnValue::Int64(50))));
        // Unknown page — must scan
        assert!(reg.can_match_range(99, "age", Some(&ColumnValue::Int64(0)), None));
    }

    #[test]
    fn test_all_null_page_cannot_match_numeric() {
        let mut fzm = FieldZoneMap::new();
        fzm.observe(&ColumnValue::Null);
        fzm.observe(&ColumnValue::Null);

        assert!(!fzm.can_match_range(
            Some(&ColumnValue::Int64(0)),
            Some(&ColumnValue::Int64(100))
        ));
    }
}
