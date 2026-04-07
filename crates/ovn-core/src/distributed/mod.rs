//! Distributed coordination layer — Raft consensus stubs.
//!
//! Provides the scaffolding for multi-node replication using the Raft
//! consensus protocol. This module is structural scaffolding for v1.1.0
//! and is not yet fully wired into the engine.

use std::collections::HashMap;

/// Raft node state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RaftRole {
    Follower,
    Candidate,
    Leader,
}

/// Raft node configuration.
#[derive(Debug, Clone)]
pub struct RaftConfig {
    pub node_id: u64,
    pub election_timeout_ms: u64,
    pub heartbeat_interval_ms: u64,
    pub peers: Vec<u64>,
}

impl Default for RaftConfig {
    fn default() -> Self {
        Self {
            node_id: 1,
            election_timeout_ms: 300,
            heartbeat_interval_ms: 100,
            peers: Vec::new(),
        }
    }
}

/// A Raft log entry.
#[derive(Debug, Clone)]
pub struct RaftLogEntry {
    pub term: u64,
    pub index: u64,
    pub data: Vec<u8>,
}

/// Core Raft state machine (stub).
pub struct RaftNode {
    pub config: RaftConfig,
    pub role: RaftRole,
    pub current_term: u64,
    pub voted_for: Option<u64>,
    pub commit_index: u64,
    pub last_applied: u64,
    pub log: Vec<RaftLogEntry>,
    pub next_index: HashMap<u64, u64>,
    pub match_index: HashMap<u64, u64>,
}

impl RaftNode {
    /// Create a new Raft node in Follower state.
    pub fn new(config: RaftConfig) -> Self {
        let peers = config.peers.clone();
        let mut next_index = HashMap::new();
        let mut match_index = HashMap::new();

        for &peer in &peers {
            next_index.insert(peer, 1);
            match_index.insert(peer, 0);
        }

        Self {
            config,
            role: RaftRole::Follower,
            current_term: 0,
            voted_for: None,
            commit_index: 0,
            last_applied: 0,
            log: Vec::new(),
            next_index,
            match_index,
        }
    }

    /// Append a new entry to the Raft log (leader only).
    pub fn propose(&mut self, data: Vec<u8>) -> Option<u64> {
        if self.role != RaftRole::Leader {
            return None;
        }

        let index = self.log.len() as u64 + 1;
        self.log.push(RaftLogEntry {
            term: self.current_term,
            index,
            data,
        });

        Some(index)
    }

    /// Transition to candidate and start election (stub).
    pub fn start_election(&mut self) {
        self.role = RaftRole::Candidate;
        self.current_term += 1;
        self.voted_for = Some(self.config.node_id);
        // TODO: send RequestVote RPCs to all peers
    }

    /// Transition to leader after winning election (stub).
    pub fn become_leader(&mut self) {
        self.role = RaftRole::Leader;
        let last_log_index = self.log.len() as u64 + 1;
        for &peer in &self.config.peers {
            self.next_index.insert(peer, last_log_index);
            self.match_index.insert(peer, 0);
        }
        // TODO: send initial heartbeat AppendEntries to all peers
    }

    /// Get current state summary for diagnostics.
    pub fn state_summary(&self) -> serde_json::Value {
        serde_json::json!({
            "nodeId": self.config.node_id,
            "role": format!("{:?}", self.role),
            "term": self.current_term,
            "commitIndex": self.commit_index,
            "lastApplied": self.last_applied,
            "logLength": self.log.len(),
            "peerCount": self.config.peers.len(),
        })
    }
}
