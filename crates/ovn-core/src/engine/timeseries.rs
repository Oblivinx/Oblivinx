//! Time-Series Collection Engine.
//!
//! Handles the bucketing of time-series data. Documents inserted into a timeseries
//! collection are not stored individually, but grouped into "buckets" by the `metaField`
//! and a time boundary (granularity).

use crate::error::OvnResult;
use crate::format::obe::{ObeDocument, ObeValue};

#[derive(Debug, Clone)]
pub struct TimeBucket {
    pub id: [u8; 16],
    pub meta: ObeValue,
    pub min_time: i64,
    pub max_time: i64,
    pub measurements: Vec<ObeDocument>,
}

impl TimeBucket {
    /// Convert bucket into a single ObeDocument representing the stored physical document.
    pub fn to_document(&self) -> OvnResult<ObeDocument> {
        let mut doc = ObeDocument::new();
        doc.id = self.id;
        doc.set("meta".to_string(), self.meta.clone());
        doc.set("min_time".to_string(), ObeValue::Int64(self.min_time));
        doc.set("max_time".to_string(), ObeValue::Int64(self.max_time));

        let mut arr = Vec::new();
        for measurement in &self.measurements {
            arr.push(ObeValue::Document(measurement.fields.clone()));
        }
        doc.set("measurements".to_string(), ObeValue::Array(arr));

        Ok(doc)
    }

    /// Extract bucket boundaries based on granularity (seconds, minutes, hours)
    pub fn calculate_bucket_bounds(time: i64, granularity: &Option<String>) -> (i64, i64) {
        let span = match granularity.as_deref() {
            Some("seconds") => 1000,         // 1-second bucket
            Some("minutes") => 60 * 1000,    // 1-minute bucket
            Some("hours") => 60 * 60 * 1000, // 1-hour bucket
            _ => 60 * 60 * 1000,             // default to hour
        };

        let min_time = (time / span) * span;
        let max_time = min_time + span - 1;
        (min_time, max_time)
    }
}

pub struct TimeSeriesManager;

impl TimeSeriesManager {
    /// Format a newly inserted document into an update statement targeting an existing bucket,
    /// or signaling that a new bucket must be created.
    pub fn process_measurement(
        doc: &ObeDocument,
        time_field: &str,
        meta_field: &Option<String>,
        _granularity: &Option<String>,
    ) -> OvnResult<(ObeValue, i64)> {
        let time_val = doc
            .get_path(time_field)
            .and_then(|v| {
                if let ObeValue::Int64(t) = v {
                    Some(*t)
                } else if let ObeValue::Timestamp(t) = v {
                    Some(*t as i64)
                } else {
                    None
                }
            })
            .unwrap_or(0);

        let meta_val = if let Some(mfield) = meta_field {
            doc.get_path(mfield).cloned().unwrap_or(ObeValue::Null)
        } else {
            ObeValue::Null
        };

        Ok((meta_val, time_val))
    }
}
