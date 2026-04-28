//! Change Stream Emitter for real-time logical WAL streaming.
//!
//! Captures committed data mutations and emits them as streams
//! compatible with Node.js client bindings.

use crate::format::obe::ObeDocument;
use std::sync::mpsc::{channel, Receiver, Sender};

/// Type of change stream event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OperationType {
    Insert,
    Update,
    Replace,
    Delete,
    Invalidate,
}

/// A captured change event for a collection.
#[derive(Debug, Clone)]
pub struct ChangeStreamEvent {
    pub op_type: OperationType,
    pub cluster_time: u64,
    pub document_key: [u8; 16],
    pub full_document: Option<ObeDocument>,
    pub namespace: String,
    pub resume_token: Vec<u8>,
}

/// Emits change stream events efficiently to subscribers.
pub struct ChangeStreamEmitter {
    subscribers: Vec<Sender<ChangeStreamEvent>>,
}

impl Default for ChangeStreamEmitter {
    fn default() -> Self {
        Self::new()
    }
}

impl ChangeStreamEmitter {
    pub fn new() -> Self {
        Self {
            subscribers: Vec::new(),
        }
    }

    /// Register a new subscriber to the change stream.
    pub fn subscribe(&mut self) -> Receiver<ChangeStreamEvent> {
        let (tx, rx) = channel();
        self.subscribers.push(tx);
        rx
    }

    /// Emit an event to all active streams.
    pub fn emit(&mut self, event: ChangeStreamEvent) {
        // Retain only open channels
        self.subscribers.retain(|tx| tx.send(event.clone()).is_ok());
    }

    /// Garbage collect closed subscriber channels.
    /// Returns the number of removed channels.
    pub fn gc_closed_subscribers(&mut self) -> usize {
        let before = self.subscribers.len();
        self.subscribers.retain(|tx| {
            tx.send(ChangeStreamEvent {
                op_type: OperationType::Invalidate,
                cluster_time: 0,
                document_key: [0; 16],
                full_document: None,
                namespace: String::new(),
                resume_token: Vec::new(),
            })
            .is_ok()
        });
        before - self.subscribers.len()
    }
}
