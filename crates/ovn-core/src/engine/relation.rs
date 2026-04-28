//! Relation operations for the OvnEngine.
//!
//! Implements foreign-key-like references between collections
//! with referential integrity validation (CASCADE, RESTRICT, SET NULL).

use serde::{Deserialize, Serialize};

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};
use crate::format::obe::ObeDocument;

/// Relation type between collections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum RelationType {
    #[serde(rename = "one-to-one")]
    OneToOne,
    #[serde(rename = "one-to-many")]
    OneToMany,
    #[serde(rename = "many-to-one")]
    ManyToOne,
    #[serde(rename = "many-to-many")]
    ManyToMany,
}

/// Action to take on DELETE for referenced documents.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OnDeleteAction {
    #[serde(rename = "restrict")]
    Restrict,
    #[serde(rename = "cascade")]
    Cascade,
    #[serde(rename = "set_null")]
    SetNull,
    #[serde(rename = "no_action")]
    NoAction,
}

/// Relation definition stored in metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RelationDefinition {
    /// Source collection and field (e.g. "posts.user_id")
    pub from_collection: String,
    pub from_field: String,
    /// Target collection and field (e.g. "users._id")
    pub to_collection: String,
    pub to_field: String,
    /// Relation type
    pub relation_type: RelationType,
    /// Action on delete
    pub on_delete: OnDeleteAction,
    /// Action on update
    pub on_update: OnDeleteAction,
    /// Whether to auto-create an index on the from field
    pub indexed: bool,
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  RELATIONS & REFERENTIAL INTEGRITY
    // ═══════════════════════════════════════════════════════════════

    /// Define a relation between collections.
    pub fn define_relation(&self, definition: &serde_json::Value) -> OvnResult<()> {
        self.check_closed()?;

        let rel: RelationDefinition = serde_json::from_value(definition.clone()).map_err(|e| {
            OvnError::ValidationError(format!("Invalid relation definition: {}", e))
        })?;

        // Auto-create index on from field if requested
        if rel.indexed {
            self.create_index(
                &rel.from_collection,
                &serde_json::json!({ &rel.from_field: 1 }),
                None,
            )?;
        }

        self.relations.lock().unwrap().push(rel.clone());

        log::info!(
            "Relation defined: {}.{} -> {}.{} (type={:?}, onDelete={:?})",
            rel.from_collection,
            rel.from_field,
            rel.to_collection,
            rel.to_field,
            rel.relation_type,
            rel.on_delete
        );
        Ok(())
    }

    /// Drop a relation definition.
    pub fn drop_relation(&self, from: &str, to: &str) -> OvnResult<()> {
        self.check_closed()?;

        let mut relations = self.relations.lock().unwrap();
        let before = relations.len();
        relations.retain(|r| !(r.from_collection == from && r.to_collection == to));

        if relations.len() == before {
            return Err(OvnError::ValidationError(format!(
                "Relation from '{}' to '{}' not found",
                from, to
            )));
        }

        log::info!("Relation dropped: {} -> {}", from, to);
        Ok(())
    }

    /// List all relations.
    pub fn list_relations(&self) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;

        let relations = self.relations.lock().unwrap();
        Ok(relations
            .iter()
            .filter_map(|r| serde_json::to_value(r).ok())
            .collect())
    }

    /// Set referential integrity mode.
    pub fn set_referential_integrity(&self, mode: &str) -> OvnResult<()> {
        self.check_closed()?;

        match mode {
            "off" | "soft" | "strict" => {
                *self.integrity_mode.write() = mode.to_string();
                log::info!("Referential integrity set to '{}'", mode);
                Ok(())
            }
            _ => Err(OvnError::ValidationError(format!(
                "Invalid integrity mode: '{}'. Must be 'off', 'soft', or 'strict'",
                mode
            ))),
        }
    }

    /// Validate referential integrity for a document being inserted/updated.
    /// Returns error if strict mode and references are invalid.
    pub fn validate_referential_integrity(
        &self,
        doc: &ObeDocument,
        collection: &str,
    ) -> OvnResult<()> {
        let mode = self.integrity_mode.read().clone();
        if mode == "off" {
            return Ok(());
        }

        let relations = self.relations.lock().unwrap();
        for rel in relations.iter() {
            // Check if this document has the from_field for relations from this collection
            if rel.from_collection == collection {
                if let Some(ref_value) = doc.get_path(&rel.from_field) {
                    // Look up the referenced document in the target collection
                    let ref_id = ref_value.to_json();
                    let found =
                        self.lookup_document_by_id(&rel.to_collection, &rel.to_field, &ref_id)?;

                    if !found && mode == "strict" {
                        return Err(OvnError::ValidationError(format!(
                            "Referential integrity violation: {}.{} = {:?} not found in {}.{}",
                            collection, rel.from_field, ref_id, rel.to_collection, rel.to_field
                        )));
                    } else if !found && mode == "soft" {
                        log::warn!(
                            "Referential integrity warning: {}.{} = {:?} not found in {}.{}",
                            collection,
                            rel.from_field,
                            ref_id,
                            rel.to_collection,
                            rel.to_field
                        );
                    }
                }
            }
        }

        Ok(())
    }

    /// Handle cascade delete when a referenced document is deleted.
    pub fn handle_cascade_delete(
        &self,
        collection: &str,
        doc_id: &serde_json::Value,
    ) -> OvnResult<()> {
        let relations = self.relations.lock().unwrap();
        let cascade_targets: Vec<_> = relations
            .iter()
            .filter(|r| {
                r.to_collection == collection && matches!(r.on_delete, OnDeleteAction::Cascade)
            })
            .cloned()
            .collect();
        drop(relations);

        for rel in cascade_targets {
            // Find all documents in from_collection that reference this doc
            let filter = serde_json::json!({ &rel.from_field: doc_id });
            self.delete_many(&rel.from_collection, &filter)?;
        }

        Ok(())
    }

    /// Helper: Look up a document by field value in a collection.
    fn lookup_document_by_id(
        &self,
        collection: &str,
        field: &str,
        value: &serde_json::Value,
    ) -> OvnResult<bool> {
        let filter = serde_json::json!({ field: value });
        let results = self.find(collection, &filter, None)?;
        Ok(!results.is_empty())
    }
}
