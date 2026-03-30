//! Collection management — maintains per-collection metadata, indexes, and statistics.

use crate::index::secondary::IndexManager;

/// A collection within the database.
pub struct Collection {
    /// Collection name
    pub name: String,
    /// Index manager for this collection
    pub index_manager: IndexManager,
    /// Document count
    pub doc_count: u64,
}

impl Collection {
    /// Create a new empty collection.
    pub fn new(name: String) -> Self {
        Self {
            name,
            index_manager: IndexManager::new(),
            doc_count: 0,
        }
    }
}
