//! Secondary index management.
//!
//! Secondary indexes are AHIT structures keyed on document field values.
//! Supports single-field, compound (with Skip-Column Optimization), and unique indexes.

use parking_lot::RwLock;
use std::collections::HashMap;

use crate::error::{OvnError, OvnResult};
use crate::format::obe::{ObeDocument, ObeValue};
use crate::index::ahit::AdaptiveHybridIndexTree;
use crate::storage::btree::BTreeEntry;

/// Index specification defining which fields are indexed and how.
#[derive(Debug, Clone)]
pub struct IndexSpec {
    /// Index name
    pub name: String,
    /// Collection this index belongs to
    pub collection: String,
    /// Fields and their sort order (1 = ascending, -1 = descending)
    pub fields: Vec<(String, i32)>,
    /// Whether this is a unique index
    pub unique: bool,
    /// Whether this is a text index
    pub text: bool,
    /// Whether this index is hidden from query planner
    pub hidden: bool,
}

impl IndexSpec {
    /// Generate a default index name from fields.
    pub fn default_name(fields: &[(String, i32)]) -> String {
        fields
            .iter()
            .map(|(f, dir)| format!("{f}_{dir}"))
            .collect::<Vec<_>>()
            .join("_")
    }

    /// Check if this is a compound index (multiple fields).
    pub fn is_compound(&self) -> bool {
        self.fields.len() > 1
    }
}

/// A secondary index backed by an AHIT.
pub struct SecondaryIndex {
    /// The underlying AHIT
    pub ahit: AdaptiveHybridIndexTree,
    /// Index specification
    pub spec: IndexSpec,
}

impl SecondaryIndex {
    /// Create a new secondary index.
    pub fn new(spec: IndexSpec) -> Self {
        let field_path = if spec.fields.len() == 1 {
            spec.fields[0].0.clone()
        } else {
            spec.fields
                .iter()
                .map(|(f, _)| f.as_str())
                .collect::<Vec<_>>()
                .join("+")
        };

        let ahit = AdaptiveHybridIndexTree::new(spec.name.clone(), field_path, spec.unique);

        Self { ahit, spec }
    }

    /// Index a document — extract field values and insert into the AHIT.
    pub fn index_document(&self, doc: &ObeDocument) -> OvnResult<()> {
        let key = self.build_index_key(doc);
        if let Some(key) = key {
            self.ahit.insert(key, doc.id.to_vec(), doc.txid)?;
        }
        Ok(())
    }

    /// Remove a document from the index.
    pub fn remove_document(&self, doc: &ObeDocument) {
        let key = self.build_index_key(doc);
        if let Some(key) = key {
            self.ahit.delete(&key);
        }
    }

    /// Look up document IDs by field value.
    pub fn lookup(&self, value: &ObeValue) -> Vec<Vec<u8>> {
        let key = Self::value_to_bytes(value);
        match self.ahit.get(&key) {
            Some(entry) => vec![entry.value],
            None => Vec::new(),
        }
    }

    /// Range scan on the index.
    pub fn range_scan(&self, from: &ObeValue, to: &ObeValue) -> Vec<BTreeEntry> {
        let from_bytes = Self::value_to_bytes(from);
        let to_bytes = Self::value_to_bytes(to);
        self.ahit.range_scan(&from_bytes, &to_bytes)
    }

    /// Build the index key from a document by extracting indexed field values.
    fn build_index_key(&self, doc: &ObeDocument) -> Option<Vec<u8>> {
        if self.spec.fields.len() == 1 {
            // Single field index
            let (field, _) = &self.spec.fields[0];
            let value = doc.get_path(field)?;
            Some(Self::value_to_bytes(value))
        } else {
            // Compound index — concatenate field values with SCO bitmap
            let mut key = Vec::new();
            let mut has_value = false;

            for (field, _) in &self.spec.fields {
                if let Some(value) = doc.get_path(field) {
                    let bytes = Self::value_to_bytes(value);
                    key.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                    key.extend_from_slice(&bytes);
                    has_value = true;
                } else {
                    // Null placeholder for missing field
                    key.extend_from_slice(&0u32.to_le_bytes());
                }
            }

            if has_value {
                // Append SCO bitmap — 64-bit fingerprint of each field's presence/hash
                let mut bitmap: u64 = 0;
                for (i, (field, _)) in self.spec.fields.iter().enumerate() {
                    if doc.get_path(field).is_some() {
                        bitmap |= 1 << i;
                    }
                }
                key.extend_from_slice(&bitmap.to_le_bytes());

                Some(key)
            } else {
                None
            }
        }
    }

    /// Convert an ObeValue to sortable bytes for indexing.
    fn value_to_bytes(value: &ObeValue) -> Vec<u8> {
        match value {
            ObeValue::Null => vec![0x00],
            ObeValue::Bool(false) => vec![0x01, 0x00],
            ObeValue::Bool(true) => vec![0x01, 0x01],
            ObeValue::Int32(v) => {
                let mut buf = vec![0x02];
                // Store as sortable bytes (flip sign bit for correct ordering)
                let sortable = (*v as u32) ^ 0x8000_0000;
                buf.extend_from_slice(&sortable.to_be_bytes());
                buf
            }
            ObeValue::Int64(v) => {
                let mut buf = vec![0x03];
                let sortable = (*v as u64) ^ 0x8000_0000_0000_0000;
                buf.extend_from_slice(&sortable.to_be_bytes());
                buf
            }
            ObeValue::Float64(v) => {
                let mut buf = vec![0x04];
                let bits = v.to_bits();
                let sortable = if bits >> 63 == 1 {
                    !bits // negative: flip all bits
                } else {
                    bits ^ (1u64 << 63) // positive: flip sign bit
                };
                buf.extend_from_slice(&sortable.to_be_bytes());
                buf
            }
            ObeValue::String(s) => {
                let mut buf = vec![0x05];
                buf.extend_from_slice(s.as_bytes());
                buf
            }
            ObeValue::Timestamp(ts) => {
                let mut buf = vec![0x06];
                buf.extend_from_slice(&ts.to_be_bytes());
                buf
            }
            ObeValue::ObjectId(oid) => {
                let mut buf = vec![0x07];
                buf.extend_from_slice(oid);
                buf
            }
            _ => {
                // For complex types (Document, Array, Binary), use JSON string repr
                let mut buf = vec![0xFF];
                let json = value.to_json().to_string();
                buf.extend_from_slice(json.as_bytes());
                buf
            }
        }
    }
}

/// Manages all secondary indexes for a collection.
pub struct IndexManager {
    /// Map of index name → SecondaryIndex
    indexes: RwLock<HashMap<String, SecondaryIndex>>,
}

impl IndexManager {
    pub fn new() -> Self {
        Self {
            indexes: RwLock::new(HashMap::new()),
        }
    }

    /// Create a new index.
    pub fn create_index(&self, spec: IndexSpec) -> OvnResult<()> {
        let name = spec.name.clone();
        let collection = spec.collection.clone();

        let mut indexes = self.indexes.write();
        if indexes.contains_key(&name) {
            return Err(OvnError::IndexAlreadyExists { name, collection });
        }

        let index = SecondaryIndex::new(spec);
        indexes.insert(name, index);
        Ok(())
    }

    /// Drop an index.
    pub fn drop_index(&self, name: &str, collection: &str) -> OvnResult<()> {
        let mut indexes = self.indexes.write();
        if indexes.remove(name).is_none() {
            return Err(OvnError::IndexNotFound {
                name: name.to_string(),
                collection: collection.to_string(),
            });
        }
        Ok(())
    }

    /// Index a document across all indexes.
    pub fn index_document(&self, doc: &ObeDocument) -> OvnResult<()> {
        let indexes = self.indexes.read();
        for index in indexes.values() {
            index.index_document(doc)?;
        }
        Ok(())
    }

    /// Remove a document from all indexes.
    pub fn remove_document(&self, doc: &ObeDocument) {
        let indexes = self.indexes.read();
        for index in indexes.values() {
            index.remove_document(doc);
        }
    }

    /// Get an index by name.
    pub fn get_index(&self, name: &str) -> Option<()> {
        // Return existence check for now
        let indexes = self.indexes.read();
        if indexes.contains_key(name) {
            Some(())
        } else {
            None
        }
    }

    /// Look up documents by field value in the given index (by name).
    pub fn lookup_in_index(&self, name: &str, value: &ObeValue) -> Vec<Vec<u8>> {
        let indexes = self.indexes.read();
        if let Some(idx) = indexes.get(name) {
            idx.lookup(value)
        } else {
            Vec::new()
        }
    }

    /// List all index names.
    pub fn list_indexes(&self) -> Vec<IndexSpec> {
        let indexes = self.indexes.read();
        indexes.values().map(|idx| idx.spec.clone()).collect()
    }

    /// Find the best index for a given set of filter fields.
    pub fn find_best_index(&self, filter_fields: &[String]) -> Option<String> {
        let indexes = self.indexes.read();

        // Prefer exact match on single field
        for (name, idx) in indexes.iter() {
            if idx.spec.fields.len() == 1 && filter_fields.contains(&idx.spec.fields[0].0) {
                return Some(name.clone());
            }
        }

        // Check compound indexes (leftmost prefix match)
        for (name, idx) in indexes.iter() {
            if idx.spec.fields.len() > 1 {
                let first_field = &idx.spec.fields[0].0;
                if filter_fields.contains(first_field) {
                    return Some(name.clone());
                }
            }
        }

        None
    }

    /// Hide an index from the query planner.
    pub fn hide_index(&mut self, name: &str) {
        if let Some(_idx) = self.indexes.write().get_mut(name) {
            // Note: In a full implementation, we'd need to get write access to the specific index
            // For now, this is a placeholder
            log::info!("Hiding index '{}'", name);
        }
    }

    /// Unhide an index — make it available to the query planner.
    pub fn unhide_index(&mut self, name: &str) {
        if let Some(_idx) = self.indexes.write().get_mut(name) {
            log::info!("Unhiding index '{}'", name);
        }
    }

    /// Check if an index is hidden.
    pub fn is_index_hidden(&self, name: &str) -> bool {
        let indexes = self.indexes.read();
        if let Some(idx) = indexes.get(name) {
            idx.spec.hidden
        } else {
            false
        }
    }
}

impl Default for IndexManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secondary_index_single_field() {
        let spec = IndexSpec {
            name: "age_1".to_string(),
            collection: "users".to_string(),
            fields: vec![("age".to_string(), 1)],
            unique: false,
            text: false,
            hidden: false,
        };

        let index = SecondaryIndex::new(spec);

        let mut doc = ObeDocument::new();
        doc.set("age".to_string(), ObeValue::Int32(28));
        index.index_document(&doc).unwrap();

        let results = index.lookup(&ObeValue::Int32(28));
        assert_eq!(results.len(), 1);
        assert_eq!(results[0], doc.id.to_vec());
    }

    #[test]
    fn test_value_ordering() {
        // Ensure numeric values are sortable
        let bytes_neg = SecondaryIndex::value_to_bytes(&ObeValue::Int32(-10));
        let bytes_zero = SecondaryIndex::value_to_bytes(&ObeValue::Int32(0));
        let bytes_pos = SecondaryIndex::value_to_bytes(&ObeValue::Int32(10));

        assert!(bytes_neg < bytes_zero);
        assert!(bytes_zero < bytes_pos);
    }
}
