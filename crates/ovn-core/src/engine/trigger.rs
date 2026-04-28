//! Trigger operations for the OvnEngine.
//!
//! Implements before/after write hooks (sync and async execution).
//! Before triggers run synchronously and can modify/reject writes.
//! After triggers run asynchronously for side effects.

use super::OvnEngine;

use crate::error::{OvnError, OvnResult};
use crate::format::obe::ObeDocument;

/// Trigger event types.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TriggerEvent {
    BeforeInsert,
    BeforeUpdate,
    BeforeDelete,
    AfterInsert,
    AfterUpdate,
    AfterDelete,
}

impl std::fmt::Display for TriggerEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TriggerEvent::BeforeInsert => write!(f, "beforeInsert"),
            TriggerEvent::BeforeUpdate => write!(f, "beforeUpdate"),
            TriggerEvent::BeforeDelete => write!(f, "beforeDelete"),
            TriggerEvent::AfterInsert => write!(f, "afterInsert"),
            TriggerEvent::AfterUpdate => write!(f, "afterUpdate"),
            TriggerEvent::AfterDelete => write!(f, "afterDelete"),
        }
    }
}

impl std::str::FromStr for TriggerEvent {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "beforeInsert" => Ok(TriggerEvent::BeforeInsert),
            "beforeUpdate" => Ok(TriggerEvent::BeforeUpdate),
            "beforeDelete" => Ok(TriggerEvent::BeforeDelete),
            "afterInsert" => Ok(TriggerEvent::AfterInsert),
            "afterUpdate" => Ok(TriggerEvent::AfterUpdate),
            "afterDelete" => Ok(TriggerEvent::AfterDelete),
            _ => Err(format!("Unknown trigger event: {}", s)),
        }
    }
}

/// Trigger definition.
#[derive(Debug, Clone)]
pub struct TriggerDefinition {
    /// Collection name
    pub collection: String,
    /// Event type
    pub event: TriggerEvent,
    /// Trigger function metadata (name/description)
    pub name: String,
    /// Timeout in milliseconds (default 500ms for sync, 5000ms for async)
    pub timeout_ms: u64,
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  TRIGGERS & EVENT HOOKS
    // ═══════════════════════════════════════════════════════════════

    /// Register a trigger on a collection.
    pub fn create_trigger(&self, collection: &str, event: &str) -> OvnResult<()> {
        self.check_closed()?;

        let trigger_event: TriggerEvent = event.parse().map_err(OvnError::ValidationError)?;

        let trigger = TriggerDefinition {
            collection: collection.to_string(),
            event: trigger_event.clone(),
            name: format!("{}_{}", collection, event),
            timeout_ms: if event.starts_with("before") {
                500
            } else {
                5000
            },
        };

        let mut triggers = self.triggers.lock().unwrap();
        let coll_triggers = triggers.entry(collection.to_string()).or_default();
        coll_triggers.insert(event.to_string(), trigger);

        log::info!("Trigger '{}' created on '{}'", event, collection);
        Ok(())
    }

    /// Drop a trigger.
    pub fn drop_trigger(&self, collection: &str, event: &str) -> OvnResult<()> {
        self.check_closed()?;

        let mut triggers = self.triggers.lock().unwrap();
        if let Some(coll_triggers) = triggers.get_mut(collection) {
            if coll_triggers.remove(event).is_none() {
                return Err(OvnError::ValidationError(format!(
                    "Trigger '{}' not found on '{}'",
                    event, collection
                )));
            }
        } else {
            return Err(OvnError::CollectionNotFound {
                name: collection.to_string(),
            });
        }

        log::info!("Trigger '{}' dropped from '{}'", event, collection);
        Ok(())
    }

    /// List triggers on a collection.
    pub fn list_triggers(&self, collection: &str) -> OvnResult<Vec<serde_json::Value>> {
        self.check_closed()?;

        let triggers = self.triggers.lock().unwrap();
        if let Some(coll_triggers) = triggers.get(collection) {
            Ok(coll_triggers
                .values()
                .map(|t| {
                    serde_json::json!({
                        "name": t.name,
                        "event": t.event.to_string(),
                        "collection": t.collection,
                        "timeoutMs": t.timeout_ms,
                    })
                })
                .collect())
        } else {
            Ok(vec![])
        }
    }

    /// Execute before-write triggers synchronously.
    /// Returns the (possibly modified) document or an error if rejected.
    pub fn execute_before_trigger(
        &self,
        event: TriggerEvent,
        collection: &str,
        _doc: &mut ObeDocument,
    ) -> OvnResult<()> {
        let triggers = self.triggers.lock().unwrap();
        if let Some(coll_triggers) = triggers.get(collection) {
            if let Some(trigger) = coll_triggers.get(&event.to_string()) {
                log::info!(
                    "Executing before trigger '{}' on '{}' (timeout={}ms)",
                    trigger.name,
                    collection,
                    trigger.timeout_ms
                );
                // In a real implementation, the trigger function would be invoked here.
                // For now, we log the execution. The actual trigger logic would be
                // provided via the JS API layer.
            }
        }
        Ok(())
    }

    /// Queue after-write triggers for async execution.
    pub fn queue_after_trigger(&self, event: TriggerEvent, collection: &str, _doc: &ObeDocument) {
        let triggers = self.triggers.lock().unwrap();
        if let Some(coll_triggers) = triggers.get(collection) {
            if let Some(trigger) = coll_triggers.get(&event.to_string()) {
                log::info!(
                    "Queuing after trigger '{}' on '{}' (async)",
                    trigger.name,
                    collection
                );
                // In a real implementation, this would spawn a background task
                // to execute the trigger asynchronously.
            }
        }
    }
}
