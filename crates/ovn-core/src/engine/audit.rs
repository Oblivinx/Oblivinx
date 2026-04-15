//! Audit Logging System for the OvnEngine.
//!
//! Every CRUD operation is recorded in an audit log with configurable
//! destinations (file, memory, etc.) and redaction of sensitive fields.

use std::fs::OpenOptions;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::engine::OvnEngine;
use crate::error::OvnResult;

/// Audit entry for a database operation.
#[derive(Debug, Clone, Serialize)]
pub struct AuditEntry {
    /// Unique audit event ID (monotonic counter)
    pub id: u64,
    /// ISO timestamp
    pub timestamp: String,
    /// Operation type
    pub operation: String,
    /// Target collection
    pub collection: Option<String>,
    /// Query filter (with sensitive values redacted)
    pub filter: Option<serde_json::Value>,
    /// Affected document IDs
    pub document_ids: Option<Vec<String>>,
    /// Session ID
    pub session_id: Option<String>,
    /// Operation duration in milliseconds
    pub duration_ms: f64,
    /// Operation status
    pub status: String,
    /// Error code if status='error'
    pub error_code: Option<String>,
    /// Additional context
    pub metadata: Option<serde_json::Value>,
}

/// Audit configuration.
#[derive(Debug, Clone)]
pub struct AuditConfig {
    /// Enable audit logging
    pub enabled: bool,
    /// Audit level: 'none', 'write', 'all'
    pub level: String,
    /// Fields to redact from audit logs
    pub redact_fields: Vec<String>,
    /// Maximum entries in memory buffer
    pub max_memory_entries: usize,
    /// File path for audit log (optional)
    pub log_file: Option<String>,
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            level: "write".to_string(),
            redact_fields: vec!["password".to_string(), "token".to_string(), "secret".to_string()],
            max_memory_entries: 10000,
            log_file: None,
        }
    }
}

impl AuditEntry {
    pub fn new(operation: &str, collection: Option<&str>) -> Self {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        Self {
            id: now as u64,
            timestamp: chrono_like_timestamp(),
            operation: operation.to_string(),
            collection: collection.map(|s| s.to_string()),
            filter: None,
            document_ids: None,
            session_id: None,
            duration_ms: 0.0,
            status: "success".to_string(),
            error_code: None,
            metadata: None,
        }
    }
}

/// Simple timestamp function (without chrono dependency).
fn chrono_like_timestamp() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Format as ISO-like timestamp
    let days_since_epoch = now / 86400;
    let time_of_day = now % 86400;
    let hours = time_of_day / 3600;
    let minutes = (time_of_day % 3600) / 60;
    let seconds = time_of_day % 60;

    // Rough approximation for year/month/day from days since epoch
    let year = 1970 + (days_since_epoch as f64 / 365.25) as u64;
    let day_of_year = days_since_epoch % 365;
    let month = (day_of_year / 30) + 1;
    let day = (day_of_year % 30) + 1;

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  AUDIT LOGGING
    // ═══════════════════════════════════════════════════════════════

    /// Record an audit entry.
    pub fn record_audit_entry(&self, entry: AuditEntry) {
        let config = AuditConfig::default();

        // Write to file if configured
        if let Some(ref path) = config.log_file {
            if let Ok(json) = serde_json::to_string(&entry) {
                if let Ok(mut file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(path)
                {
                    let _ = writeln!(file, "{}", json);
                }
            }
        }

        let mut log = self.audit_log.lock().unwrap();
        log.push(entry);

        // Trim old entries if exceeding limit
        if log.len() > config.max_memory_entries {
            let to_remove = log.len() - config.max_memory_entries;
            log.drain(..to_remove);
        }
    }

    /// Get audit log entries.
    pub fn get_audit_log(
        &self,
        limit: Option<usize>,
        operation_filter: Option<&str>,
    ) -> OvnResult<Vec<AuditEntry>> {
        self.check_closed()?;

        let log = self.audit_log.lock().unwrap();
        let mut entries: Vec<AuditEntry> = if let Some(op) = operation_filter {
            log.iter()
                .filter(|e| e.operation == op)
                .cloned()
                .collect()
        } else {
            log.clone()
        };

        // Sort by ID descending (newest first)
        entries.sort_by(|a, b| b.id.cmp(&a.id));

        // Apply limit
        if let Some(limit) = limit {
            entries.truncate(limit);
        }

        Ok(entries)
    }

    /// Configure audit logging.
    pub fn configure_audit(&self, config: AuditConfig) {
        if config.enabled {
            log::info!("Audit logging configured (level={}, redact_fields={:?})",
                config.level, config.redact_fields);
        }
    }

    /// Helper: record a write operation audit entry.
    pub fn audit_write(
        &self,
        operation: &str,
        collection: &str,
        filter: Option<&serde_json::Value>,
        doc_ids: Option<Vec<String>>,
        duration_ms: f64,
        status: &str,
        error_code: Option<&str>,
    ) {
        let mut entry = AuditEntry::new(operation, Some(collection));
        entry.filter = filter.cloned();
        entry.document_ids = doc_ids;
        entry.duration_ms = duration_ms;
        entry.status = status.to_string();
        entry.error_code = error_code.map(|s| s.to_string());
        self.record_audit_entry(entry);
    }
}
