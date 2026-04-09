//! Collection management — maintains per-collection metadata, indexes, and statistics.

use crate::index::secondary::IndexManager;
use crate::index::vector::HnswVectorIndex;

#[derive(Debug, Clone, Default)]
pub struct CollectionOptions {
    pub capped: bool,
    pub size: Option<u64>,
    pub max: Option<u64>,
    pub validator: Option<serde_json::Value>,
    pub validation_level: Option<String>,
    pub validation_action: Option<String>,
    pub timeseries: Option<TimeSeriesOptions>,
}

#[derive(Debug, Clone)]
pub struct TimeSeriesOptions {
    pub time_field: String,
    pub meta_field: Option<String>,
    pub granularity: Option<String>,
}

/// A collection within the database.
pub struct Collection {
    /// Collection name
    pub name: String,
    /// Configuration options (capped, validation, timeseries)
    pub options: CollectionOptions,
    /// Index manager for this collection
    pub index_manager: IndexManager,
    /// Optional Vector Index for similarity search
    pub vector_index: Option<HnswVectorIndex>,
    /// Document count
    pub doc_count: u64,
}

impl Collection {
    /// Create a new empty collection.
    /// Create a new empty collection with options.
    pub fn new_with_options(name: String, options: CollectionOptions) -> Self {
        Self {
            name,
            options,
            index_manager: IndexManager::new(),
            vector_index: None,
            doc_count: 0,
        }
    }

    /// Create a new empty collection with default options.
    pub fn new(name: String) -> Self {
        Self::new_with_options(name, CollectionOptions::default())
    }
}
