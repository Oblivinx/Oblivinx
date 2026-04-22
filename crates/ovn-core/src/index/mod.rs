//! Index Engine — Adaptive Hybrid Index Tree (AHIT v2) and secondary indexes. [v2]
//!
//! AHIT v2 hierarchy:
//! - Tier-0: [`art`]     — ART (in-memory, O(k) point lookup)
//! - Tier-1: [`learned`] — PGM++ Learned Index (bulk-loaded SSTable ranges)
//! - Tier-2: [`ahit`]    — B+ tree (disk-resident, persistent)
//!
//! Additional indexes:
//! - [`fulltext`]    — BM25 full-text search with trigram shingles
//! - [`geospatial`]  — R-tree / S2 cell geospatial index
//! - [`secondary`]   — Generic secondary index (field → doc_id list)
//! - [`vector`]      — HNSW approximate nearest neighbor vector search [v2]

pub mod ahit;
pub mod art;
pub mod fulltext;
pub mod geospatial;
pub mod learned;
pub mod secondary;
pub mod vector;

pub use ahit::AdaptiveHybridIndexTree;
pub use art::ArtIndex;
pub use learned::LearnedIndex;
pub use secondary::SecondaryIndex;
