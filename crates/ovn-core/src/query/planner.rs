//! Query planner — cost-based index selection and plan optimization.

use crate::query::filter::{extract_filter_fields, Filter};

/// Query execution plan type.
#[derive(Debug, Clone)]
pub enum PlanType {
    /// Use an index for point lookup
    IndexPointLookup { index_name: String },
    /// Use an index for range scan
    IndexRangeScan { index_name: String },
    /// Covered index scan (no document fetch needed)
    CoveredIndexScan { index_name: String },
    /// Full collection scan
    CollectionScan,
}

/// A query execution plan with estimated cost.
#[derive(Debug, Clone)]
pub struct QueryPlan {
    pub plan_type: PlanType,
    pub estimated_cost: f64,
    pub estimated_docs: u64,
}

/// Plan cost constants (calibrated for NVMe SSD).
const PAGE_COST: f64 = 1.0;
const DECODE_COST: f64 = 0.1;
const CMP_COST: f64 = 0.01;

/// Generate the optimal query plan for a filter.
pub fn plan_query(
    filter: &Filter,
    available_indexes: &[String],
    collection_size: u64,
) -> QueryPlan {
    let filter_fields = extract_filter_fields(filter);

    // Try to find a matching index
    for index_name in available_indexes {
        // Simple heuristic: check if any filter field matches an index
        if filter_fields.iter().any(|f| index_name.contains(f)) {
            let estimated_docs = (collection_size as f64 * 0.1) as u64; // 10% selectivity estimate
            let cost =
                (estimated_docs as f64).log2() * PAGE_COST + estimated_docs as f64 * DECODE_COST;

            return QueryPlan {
                plan_type: PlanType::IndexRangeScan {
                    index_name: index_name.clone(),
                },
                estimated_cost: cost,
                estimated_docs,
            };
        }
    }

    // Fallback: full collection scan
    let cost = collection_size as f64 * (PAGE_COST + DECODE_COST + CMP_COST);
    QueryPlan {
        plan_type: PlanType::CollectionScan,
        estimated_cost: cost,
        estimated_docs: collection_size,
    }
}
