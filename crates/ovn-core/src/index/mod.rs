//! Index Engine — Adaptive Hybrid Index Tree (AHIT) and secondary indexes.
//!
//! AHIT combines B+ tree range-scan efficiency with LSM write efficiency,
//! adding query-pattern-aware node promotion.

pub mod ahit;
pub mod fulltext;
pub mod geospatial;
pub mod secondary;
pub mod vector;

pub use ahit::AdaptiveHybridIndexTree;
pub use secondary::SecondaryIndex;
