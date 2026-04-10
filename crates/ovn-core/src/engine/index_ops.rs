//! Index operations for the OvnEngine.

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};
use crate::format::obe::ObeDocument;
use crate::index::vector::VectorEmbedding;

impl OvnEngine {
    /// Create a secondary index.
    pub fn create_index(
        &self,
        collection: &str,
        fields_json: &serde_json::Value,
        options: Option<&serde_json::Value>,
    ) -> OvnResult<String> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let fields_obj = fields_json
            .as_object()
            .ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: "Index fields must be an object".to_string(),
            })?;

        let fields: Vec<(String, i32)> = fields_obj
            .iter()
            .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(1) as i32))
            .collect();

        let name = crate::index::secondary::IndexSpec::default_name(&fields);

        let unique = options
            .and_then(|o| o.get("unique"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let text = fields_obj
            .values()
            .any(|v| v.as_str().map(|s| s == "text").unwrap_or(false));

        let hidden = options
            .and_then(|o| o.get("hidden"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let spec = crate::index::secondary::IndexSpec {
            name: name.clone(),
            collection: collection.to_string(),
            fields,
            unique,
            text,
            hidden,
        };

        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager.create_index(spec)?;
        }

        Ok(name)
    }

    /// List all indexes for a collection.
    pub fn list_indexes(&self, collection: &str) -> Vec<serde_json::Value> {
        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager
                .list_indexes()
                .into_iter()
                .map(|spec| {
                    serde_json::json!({
                        "name": spec.name,
                        "fields": spec.fields.iter()
                            .map(|(f, d)| (f.clone(), serde_json::Value::from(*d)))
                            .collect::<serde_json::Map<String, serde_json::Value>>(),
                        "unique": spec.unique,
                    })
                })
                .collect()
        } else {
            Vec::new()
        }
    }

    /// Drop a named index from a collection.
    pub fn drop_index(&self, collection: &str, index_name: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.ensure_collection(collection)?;
        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            coll.index_manager.drop_index(index_name, collection)?;
        }
        Ok(())
    }

    /// Hide an index from the query planner.
    pub fn hide_index(&self, collection: &str, index_name: &str) -> OvnResult<()> {
        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            coll.index_manager.hide_index(index_name);
            Ok(())
        } else {
            Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            })
        }
    }

    /// Unhide an index -- make it available to the query planner.
    pub fn unhide_index(&self, collection: &str, index_name: &str) -> OvnResult<()> {
        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            coll.index_manager.unhide_index(index_name);
            Ok(())
        } else {
            Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            })
        }
    }

    /// Create a Vector Index (HNSW) for a specific field.
    pub fn create_vector_index(&self, collection: &str, field: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            if coll.vector_index.is_some() {
                return Err(OvnError::IndexAlreadyExists {
                    name: "vector_index".to_string(),
                    collection: collection.to_string(),
                });
            }

            use crate::index::vector::HnswVectorIndex;
            let mut vector_index = HnswVectorIndex::new(field.to_string());

            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    if let Some(val) = doc.get_path(field) {
                        if let Some(arr) = val.as_array() {
                            let mut values = Vec::new();
                            for v in arr {
                                if let Some(f) = v.as_f64() {
                                    values.push(f as f32);
                                }
                            }
                            if !values.is_empty() {
                                let _ = vector_index
                                    .insert_vector(&doc.id, VectorEmbedding::new(values));
                            }
                        }
                    }
                }
            }

            coll.vector_index = Some(vector_index);
            Ok(())
        } else {
            Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            })
        }
    }

    /// Perform a Vector Search query.
    pub fn vector_search(
        &self,
        collection: &str,
        query_vector: &[f32],
        limit: usize,
    ) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let collections = self.collections.read();
        if let Some(coll) = collections.get(collection) {
            if let Some(vector_index) = &coll.vector_index {
                let query_embedding = VectorEmbedding::new(query_vector.to_vec());
                let matches = vector_index.search(&query_embedding, limit);

                let mut results = Vec::new();
                for (doc_id, _) in matches {
                    if let Some(entry) = self.btree.get(&doc_id) {
                        if !entry.tombstone {
                            if let Ok(doc) = ObeDocument::decode(&entry.value) {
                                results.push(doc.to_json());
                            }
                        }
                    }
                }
                return Ok(results);
            } else {
                return Err(OvnError::IndexNotFound {
                    name: "vector_index".to_string(),
                    collection: collection.to_string(),
                });
            }
        }

        Err(OvnError::CollectionNotFound {
            name: collection.to_string(),
        })
    }

    /// Create a geospatial index on a field for a collection.
    pub fn create_geo_index(&self, collection: &str, field: &str) -> OvnResult<()> {
        self.check_closed()?;
        self.ensure_collection(collection)?;

        let mut collections = self.collections.write();
        if let Some(coll) = collections.get_mut(collection) {
            if coll.geo_index.is_some() {
                return Err(OvnError::IndexAlreadyExists {
                    name: format!("{}_geo", field),
                    collection: collection.to_string(),
                });
            }

            use crate::index::geospatial::{GeoPoint, GeoSpatialIndex};
            let mut geo_idx = GeoSpatialIndex::new();

            let all_entries = self.btree.scan_all();
            for entry in all_entries {
                if entry.tombstone {
                    continue;
                }
                if let Ok(doc) = ObeDocument::decode(&entry.value) {
                    if let Some(val) = doc.get_path(field) {
                        if let Some(arr) = val.as_array() {
                            if arr.len() == 2 {
                                let lng = arr[0].as_f64().unwrap_or(0.0);
                                let lat = arr[1].as_f64().unwrap_or(0.0);
                                let _ = geo_idx.index_point(&doc.id, GeoPoint::new(lng, lat));
                            }
                        }
                    }
                }
            }

            let _ = coll
                .index_manager
                .create_index(crate::index::secondary::IndexSpec {
                    name: format!("{}_{}_2dsphere", collection, field),
                    collection: collection.to_string(),
                    fields: vec![(field.to_string(), 1)],
                    unique: false,
                    text: false,
                    hidden: false,
                });

            coll.geo_index = Some(geo_idx);

            log::info!("Created geospatial index on {}.{}", collection, field);
            Ok(())
        } else {
            Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            })
        }
    }
}
