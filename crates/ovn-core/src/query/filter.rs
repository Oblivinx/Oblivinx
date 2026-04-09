//! MQL filter evaluation engine.
//!
//! Parses and evaluates MongoDB-style filter expressions against OBE documents.
//! Supports comparison, logical, array, and element operators.

use crate::error::{OvnError, OvnResult};
use crate::format::obe::{ObeDocument, ObeValue};

/// A parsed filter expression.
#[derive(Debug, Clone)]
pub enum Filter {
    /// Match all documents
    MatchAll,
    /// Field comparison: { field: { $op: value } }
    Comparison(String, FilterOp, ObeValue),
    /// Logical AND: { $and: [filter1, filter2, ...] }
    And(Vec<Filter>),
    /// Logical OR: { $or: [filter1, filter2, ...] }
    Or(Vec<Filter>),
    /// Logical NOT: { $not: filter }
    Not(Box<Filter>),
    /// Logical NOR: { $nor: [filter1, filter2, ...] }
    Nor(Vec<Filter>),
    /// Field exists: { field: { $exists: true/false } }
    Exists(String, bool),
    /// Type check: { field: { $type: "string" } }
    Type(String, String),
    /// Full-text search: { $text: { $search: "query" } }
    FullTextSearch(String),
    /// Expression: { $expr: { $gt: ["$field", value] } } (simplified)
    Expr(serde_json::Value),
}

/// Comparison operator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FilterOp {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    In,
    Nin,
    All,
    ElemMatch,
    Size,
    Regex,
    GeoWithin,
    Near,
}

impl FilterOp {
    /// Parse a MQL operator string like `"$gt"` into a `FilterOp`.
    /// Named `parse_op` (not `from_str`) to avoid confusion with `std::str::FromStr`.
    pub fn parse_op(s: &str) -> OvnResult<Self> {
        match s {
            "$eq" => Ok(Self::Eq),
            "$ne" => Ok(Self::Ne),
            "$gt" => Ok(Self::Gt),
            "$gte" => Ok(Self::Gte),
            "$lt" => Ok(Self::Lt),
            "$lte" => Ok(Self::Lte),
            "$in" => Ok(Self::In),
            "$nin" => Ok(Self::Nin),
            "$all" => Ok(Self::All),
            "$elemMatch" => Ok(Self::ElemMatch),
            "$size" => Ok(Self::Size),
            "$regex" => Ok(Self::Regex),
            "$geoWithin" => Ok(Self::GeoWithin),
            "$near" | "$geoNear" => Ok(Self::Near),
            _ => Err(OvnError::UnknownOperator(s.to_string())),
        }
    }
}

/// Parse a JSON filter expression into a Filter AST.
pub fn parse_filter(json: &serde_json::Value) -> OvnResult<Filter> {
    let obj = match json {
        serde_json::Value::Object(obj) => obj,
        serde_json::Value::Null => return Ok(Filter::MatchAll),
        _ => {
            return Err(OvnError::QuerySyntaxError {
                position: 0,
                message: "Filter must be a JSON object".to_string(),
            })
        }
    };

    if obj.is_empty() {
        return Ok(Filter::MatchAll);
    }

    let mut conditions: Vec<Filter> = Vec::new();

    for (key, value) in obj {
        match key.as_str() {
            "$and" => {
                let arr = value.as_array().ok_or_else(|| OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$and must be an array".to_string(),
                })?;
                let filters: OvnResult<Vec<Filter>> = arr.iter().map(parse_filter).collect();
                conditions.push(Filter::And(filters?));
            }
            "$or" => {
                let arr = value.as_array().ok_or_else(|| OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$or must be an array".to_string(),
                })?;
                let filters: OvnResult<Vec<Filter>> = arr.iter().map(parse_filter).collect();
                conditions.push(Filter::Or(filters?));
            }
            "$not" => {
                let inner = parse_filter(value)?;
                conditions.push(Filter::Not(Box::new(inner)));
            }
            "$nor" => {
                let arr = value.as_array().ok_or_else(|| OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$nor must be an array".to_string(),
                })?;
                let filters: OvnResult<Vec<Filter>> = arr.iter().map(parse_filter).collect();
                conditions.push(Filter::Nor(filters?));
            }
            "$text" => {
                // { $text: { $search: "query text" } }
                let search_query = if let Some(obj) = value.as_object() {
                    obj.get("$search")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string()
                } else if let Some(s) = value.as_str() {
                    s.to_string()
                } else {
                    String::new()
                };
                conditions.push(Filter::FullTextSearch(search_query));
            }
            "$expr" => {
                conditions.push(Filter::Expr(value.clone()));
            }
            field => {
                // Field-level filter
                let filter = parse_field_filter(field, value)?;
                conditions.push(filter);
            }
        }
    }

    if conditions.len() == 1 {
        Ok(conditions.into_iter().next().unwrap())
    } else {
        Ok(Filter::And(conditions))
    }
}

/// Parse a field-level filter expression.
fn parse_field_filter(field: &str, value: &serde_json::Value) -> OvnResult<Filter> {
    match value {
        serde_json::Value::Object(ops) => {
            let mut conditions = Vec::new();
            for (op_key, op_val) in ops {
                match op_key.as_str() {
                    "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte" => {
                        let op = FilterOp::parse_op(op_key)?;
                        conditions.push(Filter::Comparison(
                            field.to_string(),
                            op,
                            ObeValue::from_json(op_val),
                        ));
                    }
                    "$in" | "$nin" => {
                        let op = FilterOp::parse_op(op_key)?;
                        let arr_val = ObeValue::from_json(op_val);
                        conditions.push(Filter::Comparison(field.to_string(), op, arr_val));
                    }
                    "$exists" => {
                        let exists = op_val.as_bool().unwrap_or(true);
                        conditions.push(Filter::Exists(field.to_string(), exists));
                    }
                    "$type" => {
                        let type_str = op_val.as_str().unwrap_or("string");
                        conditions.push(Filter::Type(field.to_string(), type_str.to_string()));
                    }
                    "$all" | "$elemMatch" | "$size" | "$regex" | "$geoWithin" | "$near" | "$geoNear" => {
                        let op = FilterOp::parse_op(op_key)?;
                        conditions.push(Filter::Comparison(
                            field.to_string(),
                            op,
                            ObeValue::from_json(op_val),
                        ));
                    }
                    _ => {
                        return Err(OvnError::UnknownOperator(op_key.clone()));
                    }
                }
            }
            if conditions.len() == 1 {
                Ok(conditions.into_iter().next().unwrap())
            } else {
                Ok(Filter::And(conditions))
            }
        }
        // Implicit $eq
        _ => Ok(Filter::Comparison(
            field.to_string(),
            FilterOp::Eq,
            ObeValue::from_json(value),
        )),
    }
}

/// Evaluate a filter against an OBE document.
pub fn evaluate_filter(filter: &Filter, doc: &ObeDocument) -> bool {
    match filter {
        Filter::MatchAll => true,
        Filter::Comparison(field, op, target) => {
            let doc_value = doc.get_path(field);
            evaluate_comparison(doc_value, op, target)
        }
        Filter::And(filters) => filters.iter().all(|f| evaluate_filter(f, doc)),
        Filter::Or(filters) => filters.iter().any(|f| evaluate_filter(f, doc)),
        Filter::Not(inner) => !evaluate_filter(inner, doc),
        Filter::Nor(filters) => !filters.iter().any(|f| evaluate_filter(f, doc)),
        Filter::Exists(field, should_exist) => {
            let exists = doc.get_path(field).is_some();
            exists == *should_exist
        }
        Filter::Type(field, type_name) => {
            if let Some(value) = doc.get_path(field) {
                match_type(value, type_name)
            } else {
                false
            }
        }
        Filter::FullTextSearch(query) => {
            // Simple full-text: check if any string field contains all query words
            let query_lower = query.to_lowercase();
            let words: Vec<&str> = query_lower.split_whitespace().collect();
            if words.is_empty() {
                return true;
            }
            // Search across all string fields in the document
            doc.fields.values().any(|val| {
                if let Some(s) = val.as_str() {
                    let s_lower = s.to_lowercase();
                    words.iter().any(|w| s_lower.contains(*w))
                } else {
                    false
                }
            })
        }
        Filter::Expr(expr) => {
            // Simplified $expr evaluation: support { $gt: ["$field", value] }
            evaluate_expr(expr, doc)
        }
    }
}

/// Evaluate a comparison operator.
fn evaluate_comparison(doc_value: Option<&ObeValue>, op: &FilterOp, target: &ObeValue) -> bool {
    match op {
        FilterOp::Eq => doc_value.map_or(target.is_null(), |v| values_equal(v, target)),
        FilterOp::Ne => doc_value.map_or(!target.is_null(), |v| !values_equal(v, target)),
        FilterOp::Gt => doc_value
            .is_some_and(|v| compare_values(v, target) == Some(std::cmp::Ordering::Greater)),
        FilterOp::Gte => doc_value.is_some_and(|v| {
            matches!(
                compare_values(v, target),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            )
        }),
        FilterOp::Lt => {
            doc_value.is_some_and(|v| compare_values(v, target) == Some(std::cmp::Ordering::Less))
        }
        FilterOp::Lte => doc_value.is_some_and(|v| {
            matches!(
                compare_values(v, target),
                Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
            )
        }),
        FilterOp::In => {
            if let ObeValue::Array(arr) = target {
                doc_value.is_some_and(|v| arr.iter().any(|t| values_equal(v, t)))
            } else {
                false
            }
        }
        FilterOp::Nin => {
            if let ObeValue::Array(arr) = target {
                doc_value.is_none_or(|v| !arr.iter().any(|t| values_equal(v, t)))
            } else {
                true
            }
        }
        FilterOp::All => {
            if let (Some(ObeValue::Array(doc_arr)), ObeValue::Array(target_arr)) =
                (doc_value, target)
            {
                target_arr
                    .iter()
                    .all(|t| doc_arr.iter().any(|d| values_equal(d, t)))
            } else {
                false
            }
        }
        FilterOp::Size => {
            if let (Some(ObeValue::Array(arr)), Some(size)) = (doc_value, target.as_i64()) {
                arr.len() == size as usize
            } else {
                false
            }
        }
        FilterOp::Regex => {
            if let (Some(ObeValue::String(s)), ObeValue::String(pattern)) = (doc_value, target) {
                s.contains(pattern.as_str()) // Simplified regex matching
            } else {
                false
            }
        }
        FilterOp::ElemMatch => {
            // Simplified: check if any array element matches value
            if let Some(ObeValue::Array(arr)) = doc_value {
                arr.iter().any(|elem| values_equal(elem, target))
            } else {
                false
            }
        }
        FilterOp::GeoWithin => {
            let point = extract_geo_point(doc_value);
            if let (Some(pt), ObeValue::Document(box_doc)) = (point, target) {
                if let Some(ObeValue::Array(arr)) = box_doc.get("$box") {
                    if arr.len() == 2 {
                        if let (ObeValue::Array(min_coords), ObeValue::Array(max_coords)) = (&arr[0], &arr[1]) {
                            if min_coords.len() == 2 && max_coords.len() == 2 {
                                let min_lng = min_coords[0].as_f64().unwrap_or(0.0);
                                let min_lat = min_coords[1].as_f64().unwrap_or(0.0);
                                let max_lng = max_coords[0].as_f64().unwrap_or(0.0);
                                let max_lat = max_coords[1].as_f64().unwrap_or(0.0);
                                
                                return pt.lng >= min_lng && pt.lng <= max_lng && pt.lat >= min_lat && pt.lat <= max_lat;
                            }
                        }
                    }
                }
            }
            false
        }
        FilterOp::Near => {
            let point = extract_geo_point(doc_value);
            if let (Some(pt), ObeValue::Document(near_doc)) = (point, target) {
                if let Some(geom) = near_doc.get("$geometry") {
                    let target_pt = extract_geo_point(Some(geom));
                    if let Some(tpt) = target_pt {
                        let max_dist = near_doc.get("$maxDistance").and_then(|v| v.as_f64()).unwrap_or(f64::MAX);
                        let dx = pt.lng - tpt.lng;
                        let dy = pt.lat - tpt.lat;
                        let dist = (dx * dx + dy * dy).sqrt();
                        return dist <= max_dist;
                    }
                }
            }
            false
        }
    }
}

/// Helper to extract Geo coordinate from ObeValue [lng, lat] or { lng, lat }
fn extract_geo_point(val: Option<&ObeValue>) -> Option<crate::index::geospatial::GeoPoint> {
    match val {
        Some(ObeValue::Array(arr)) if arr.len() == 2 => {
            if let (Some(lng), Some(lat)) = (arr[0].as_f64(), arr[1].as_f64()) {
                Some(crate::index::geospatial::GeoPoint { lng, lat })
            } else {
                None
            }
        }
        Some(ObeValue::Document(doc)) => {
            // Check for GeoJSON format { type: "Point", coordinates: [lng, lat] }
            if let Some(ObeValue::Array(coords)) = doc.get("coordinates") {
                if coords.len() == 2 {
                    if let (Some(lng), Some(lat)) = (coords[0].as_f64(), coords[1].as_f64()) {
                        return Some(crate::index::geospatial::GeoPoint { lng, lat });
                    }
                }
            }
            // Check for { lng, lat } format
            if let (Some(lng_val), Some(lat_val)) = (doc.get("lng"), doc.get("lat")) {
                if let (Some(lng), Some(lat)) = (lng_val.as_f64(), lat_val.as_f64()) {
                    return Some(crate::index::geospatial::GeoPoint { lng, lat });
                }
            }
            None
        }
        _ => None,
    }
}

/// Check if two OBE values are equal.
fn values_equal(a: &ObeValue, b: &ObeValue) -> bool {
    match (a, b) {
        (ObeValue::Null, ObeValue::Null) => true,
        (ObeValue::Bool(a), ObeValue::Bool(b)) => a == b,
        (ObeValue::String(a), ObeValue::String(b)) => a == b,
        // Numeric comparisons with coercion
        (a, b) if a.as_f64().is_some() && b.as_f64().is_some() => {
            (a.as_f64().unwrap() - b.as_f64().unwrap()).abs() < f64::EPSILON
        }
        (ObeValue::Array(a), ObeValue::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| values_equal(x, y))
        }
        (ObeValue::Document(a), ObeValue::Document(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, v)| b.get(k).is_some_and(|bv| values_equal(v, bv)))
        }
        _ => false,
    }
}

/// Compare two OBE values for ordering.
fn compare_values(a: &ObeValue, b: &ObeValue) -> Option<std::cmp::Ordering> {
    match (a, b) {
        (a, b) if a.as_f64().is_some() && b.as_f64().is_some() => {
            a.as_f64().unwrap().partial_cmp(&b.as_f64().unwrap())
        }
        (ObeValue::String(a), ObeValue::String(b)) => Some(a.cmp(b)),
        (ObeValue::Timestamp(a), ObeValue::Timestamp(b)) => Some(a.cmp(b)),
        (ObeValue::Bool(a), ObeValue::Bool(b)) => Some(a.cmp(b)),
        _ => None,
    }
}

/// Check if a value matches a BSON type name.
fn match_type(value: &ObeValue, type_name: &str) -> bool {
    match type_name {
        "null" => matches!(value, ObeValue::Null),
        "bool" | "boolean" => matches!(value, ObeValue::Bool(_)),
        "int" | "int32" => matches!(value, ObeValue::Int32(_)),
        "long" | "int64" => matches!(value, ObeValue::Int64(_)),
        "double" | "float64" => matches!(value, ObeValue::Float64(_)),
        "string" => matches!(value, ObeValue::String(_)),
        "array" => matches!(value, ObeValue::Array(_)),
        "object" | "document" => matches!(value, ObeValue::Document(_)),
        "binData" | "binary" => matches!(value, ObeValue::Binary(_)),
        "timestamp" => matches!(value, ObeValue::Timestamp(_)),
        "objectId" => matches!(value, ObeValue::ObjectId(_)),
        _ => false,
    }
}

/// Extract filter fields for index selection.
pub fn extract_filter_fields(filter: &Filter) -> Vec<String> {
    match filter {
        Filter::MatchAll => Vec::new(),
        Filter::Comparison(field, _, _) => vec![field.clone()],
        Filter::Exists(field, _) => vec![field.clone()],
        Filter::Type(field, _) => vec![field.clone()],
        Filter::And(filters) | Filter::Or(filters) | Filter::Nor(filters) => {
            filters.iter().flat_map(extract_filter_fields).collect()
        }
        Filter::Not(inner) => extract_filter_fields(inner),
        Filter::FullTextSearch(_) => Vec::new(),
        Filter::Expr(_) => Vec::new(),
    }
}

/// Evaluate a simplified $expr expression against a document.
/// Supports: { $gt: ["$field", value] }, { $eq: [...] }, { $lt: [...] }
fn evaluate_expr(expr: &serde_json::Value, doc: &ObeDocument) -> bool {
    let obj = match expr.as_object() {
        Some(o) => o,
        None => return false,
    };

    for (op, args) in obj {
        let arr = match args.as_array() {
            Some(a) if a.len() == 2 => a,
            _ => return false,
        };

        // Resolve left side (field ref or literal)
        let left = if let Some(field) = arr[0].as_str().and_then(|s| s.strip_prefix('$')) {
            doc.get_path(field).cloned().unwrap_or(ObeValue::Null)
        } else {
            ObeValue::from_json(&arr[0])
        };

        // Resolve right side
        let right = if let Some(field) = arr[1].as_str().and_then(|s| s.strip_prefix('$')) {
            doc.get_path(field).cloned().unwrap_or(ObeValue::Null)
        } else {
            ObeValue::from_json(&arr[1])
        };

        let result = match op.as_str() {
            "$gt" => compare_values(&left, &right) == Some(std::cmp::Ordering::Greater),
            "$gte" => matches!(
                compare_values(&left, &right),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            ),
            "$lt" => compare_values(&left, &right) == Some(std::cmp::Ordering::Less),
            "$lte" => matches!(
                compare_values(&left, &right),
                Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
            ),
            "$eq" => values_equal(&left, &right),
            "$ne" => !values_equal(&left, &right),
            _ => false,
        };

        if !result {
            return false;
        }
    }

    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn make_doc() -> ObeDocument {
        let mut doc = ObeDocument::new();
        doc.set("name".to_string(), ObeValue::String("Alice".to_string()));
        doc.set("age".to_string(), ObeValue::Int32(28));
        doc.set("active".to_string(), ObeValue::Bool(true));
        doc.set(
            "tags".to_string(),
            ObeValue::Array(vec![
                ObeValue::String("admin".to_string()),
                ObeValue::String("dev".to_string()),
            ]),
        );

        let mut addr = BTreeMap::new();
        addr.insert("city".to_string(), ObeValue::String("Jakarta".to_string()));
        doc.set("address".to_string(), ObeValue::Document(addr));

        doc
    }

    #[test]
    fn test_eq_filter() {
        let doc = make_doc();
        let filter = Filter::Comparison(
            "name".to_string(),
            FilterOp::Eq,
            ObeValue::String("Alice".to_string()),
        );
        assert!(evaluate_filter(&filter, &doc));

        let filter = Filter::Comparison(
            "name".to_string(),
            FilterOp::Eq,
            ObeValue::String("Bob".to_string()),
        );
        assert!(!evaluate_filter(&filter, &doc));
    }

    #[test]
    fn test_numeric_comparison() {
        let doc = make_doc();

        let filter = Filter::Comparison("age".to_string(), FilterOp::Gt, ObeValue::Int32(18));
        assert!(evaluate_filter(&filter, &doc));

        let filter = Filter::Comparison("age".to_string(), FilterOp::Lt, ObeValue::Int32(30));
        assert!(evaluate_filter(&filter, &doc));

        let filter = Filter::Comparison("age".to_string(), FilterOp::Gte, ObeValue::Int32(28));
        assert!(evaluate_filter(&filter, &doc));
    }

    #[test]
    fn test_dot_notation_filter() {
        let doc = make_doc();
        let filter = Filter::Comparison(
            "address.city".to_string(),
            FilterOp::Eq,
            ObeValue::String("Jakarta".to_string()),
        );
        assert!(evaluate_filter(&filter, &doc));
    }

    #[test]
    fn test_logical_and_or() {
        let doc = make_doc();

        let filter = Filter::And(vec![
            Filter::Comparison(
                "name".to_string(),
                FilterOp::Eq,
                ObeValue::String("Alice".to_string()),
            ),
            Filter::Comparison("age".to_string(), FilterOp::Gt, ObeValue::Int32(20)),
        ]);
        assert!(evaluate_filter(&filter, &doc));

        let filter = Filter::Or(vec![
            Filter::Comparison("age".to_string(), FilterOp::Gt, ObeValue::Int32(50)),
            Filter::Comparison("active".to_string(), FilterOp::Eq, ObeValue::Bool(true)),
        ]);
        assert!(evaluate_filter(&filter, &doc));
    }

    #[test]
    fn test_in_operator() {
        let doc = make_doc();
        let filter = Filter::Comparison(
            "age".to_string(),
            FilterOp::In,
            ObeValue::Array(vec![
                ObeValue::Int32(25),
                ObeValue::Int32(28),
                ObeValue::Int32(30),
            ]),
        );
        assert!(evaluate_filter(&filter, &doc));
    }

    #[test]
    fn test_exists() {
        let doc = make_doc();
        assert!(evaluate_filter(
            &Filter::Exists("name".to_string(), true),
            &doc
        ));
        assert!(evaluate_filter(
            &Filter::Exists("nonexistent".to_string(), false),
            &doc
        ));
    }

    #[test]
    fn test_parse_json_filter() {
        let json = serde_json::json!({ "age": { "$gt": 18 } });
        let filter = parse_filter(&json).unwrap();
        let doc = make_doc();
        assert!(evaluate_filter(&filter, &doc));
    }
}
