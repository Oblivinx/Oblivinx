//! Time-series collection storage.
//!
//! Groups documents into time-based buckets for efficient compression and retrieval.

use crate::engine::collection::TimeSeriesOptions;
use crate::error::OvnResult;

/// A single bucket containing multiple measurements.
#[derive(Debug, Clone)]
pub struct TimeSeriesBucket {
    pub min_time: u64,
    pub max_time: u64,
    pub count: usize,
    pub meta_field_value: Option<String>,
    pub measurements: Vec<Vec<u8>>, // OBE encoded documents
}

impl TimeSeriesBucket {
    pub fn new(time: u64, meta: Option<String>) -> Self {
        Self {
            min_time: time,
            max_time: time,
            count: 0,
            meta_field_value: meta,
            measurements: Vec::new(),
        }
    }
}

/// Time-Series Storage manager.
pub struct TimeSeriesManager {
    pub options: TimeSeriesOptions,
    // Placeholder: active buckets kept in memory before flushing
    // pub active_buckets: HashMap<String, TimeSeriesBucket>,
}

impl TimeSeriesManager {
    pub fn new(options: TimeSeriesOptions) -> Self {
        Self { options }
    }

    pub fn insert_measurement(&mut self, _time: u64, _doc: Vec<u8>) -> OvnResult<()> {
        // TODO: route measurement to correct bucket based on time and meta field
        Ok(())
    }
}
