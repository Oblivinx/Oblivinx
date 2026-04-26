//! Security and Rate Limiting for the OvnEngine.
//!
//! Implements rate limiting, DOS protection, and security limits
//! to prevent abuse of the database engine.

use std::time::{Duration, Instant};

use crate::engine::OvnEngine;
use crate::error::{OvnError, OvnResult};

/// Rate limiter state.
pub struct RateLimiter {
    /// Maximum queries per second
    pub max_qps: u64,
    /// Query count in current window
    query_count: u64,
    /// Window start time
    window_start: Instant,
    /// Window duration
    window_duration: Duration,
}

impl RateLimiter {
    pub fn new(max_qps: u64) -> Self {
        Self {
            max_qps,
            query_count: 0,
            window_start: Instant::now(),
            window_duration: Duration::from_secs(1),
        }
    }

    /// Check if a request is allowed.
    pub fn check_rate_limit(&mut self) -> OvnResult<()> {
        let now = Instant::now();
        if now.duration_since(self.window_start) > self.window_duration {
            // Reset window
            self.window_start = now;
            self.query_count = 0;
        }

        if self.query_count >= self.max_qps {
            return Err(OvnError::QueryError(
                format!(
                    "Rate limit exceeded: {} queries per second limit reached",
                    self.max_qps
                )
            ));
        }

        self.query_count += 1;
        Ok(())
    }

    /// Reset the rate limiter.
    #[allow(dead_code)]
    pub fn reset(&mut self) {
        self.query_count = 0;
        self.window_start = Instant::now();
    }
}

/// Security limits configuration.
#[derive(Debug, Clone)]
pub struct SecurityLimits {
    /// Maximum query execution time in milliseconds
    pub max_query_time_ms: u64,
    /// Maximum result documents
    pub max_result_documents: u64,
    /// Maximum aggregation memory in MB
    pub max_aggregation_memory_mb: u64,
    /// Maximum concurrent transactions
    pub max_concurrent_transactions: u64,
    /// Maximum document size in bytes
    pub max_document_size_bytes: u64,
    /// Maximum index key length in bytes
    pub max_index_key_length: u64,
}

impl Default for SecurityLimits {
    fn default() -> Self {
        Self {
            max_query_time_ms: 30000,
            max_result_documents: 10000,
            max_aggregation_memory_mb: 256,
            max_concurrent_transactions: 100,
            max_document_size_bytes: 16 * 1024 * 1024, // 16MB
            max_index_key_length: 1024,
        }
    }
}

impl OvnEngine {
    // ═══════════════════════════════════════════════════════════════
    //  SECURITY & RATE LIMITING
    // ═══════════════════════════════════════════════════════════════

    /// Check rate limit before processing a request.
    pub fn check_rate_limit(&self) -> OvnResult<()> {
        let mut limiter = self.rate_limiter.lock().unwrap();
        limiter.check_rate_limit()
    }

    /// Set the rate limit (queries per second).
    pub fn set_rate_limit(&self, max_qps: u64) {
        let mut limiter = self.rate_limiter.lock().unwrap();
        limiter.max_qps = max_qps;
        log::info!("Rate limit set to {} QPS", max_qps);
    }

    /// Get current rate limit status.
    pub fn rate_limit_status(&self) -> OvnResult<serde_json::Value> {
        let limiter = self.rate_limiter.lock().unwrap();
        let elapsed = limiter.window_start.elapsed().as_secs();
        Ok(serde_json::json!({
            "maxQps": limiter.max_qps,
            "currentQps": limiter.query_count,
            "windowElapsedSecs": elapsed,
        }))
    }

    /// Validate a document against security limits.
    pub fn validate_document_security_limits(&self, doc_size: usize) -> OvnResult<()> {
        let limits = SecurityLimits::default();

        if doc_size > limits.max_document_size_bytes as usize {
            return Err(OvnError::ValidationError(
                format!(
                    "Document size {} exceeds maximum {} bytes",
                    doc_size, limits.max_document_size_bytes
                )
            ));
        }

        Ok(())
    }

    /// Validate an index key against security limits.
    pub fn validate_index_key_limits(&self, key_size: usize) -> OvnResult<()> {
        let limits = SecurityLimits::default();

        if key_size > limits.max_index_key_length as usize {
            return Err(OvnError::ValidationError(
                format!(
                    "Index key size {} exceeds maximum {} bytes",
                    key_size, limits.max_index_key_length
                )
            ));
        }

        Ok(())
    }

    /// Get security configuration.
    pub fn security_config(&self) -> OvnResult<serde_json::Value> {
        let limits = SecurityLimits::default();
        let limiter = self.rate_limiter.lock().unwrap();
        Ok(serde_json::json!({
            "maxQueryTimeMs": limits.max_query_time_ms,
            "maxResultDocuments": limits.max_result_documents,
            "maxAggregationMemoryMB": limits.max_aggregation_memory_mb,
            "maxConcurrentTransactions": limits.max_concurrent_transactions,
            "maxDocumentSizeBytes": limits.max_document_size_bytes,
            "maxIndexKeyLength": limits.max_index_key_length,
            "rateLimit": {
                "maxQps": limiter.max_qps,
                "currentQps": limiter.query_count,
            },
        }))
    }
}
