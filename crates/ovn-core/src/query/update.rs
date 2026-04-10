//! MQL update operators — $set, $unset, $inc, $push, $pull, $addToSet, etc.

use crate::error::{OvnError, OvnResult};
use crate::format::obe::{ObeDocument, ObeValue};
use std::collections::BTreeMap;

/// A parsed update operation.
#[derive(Debug, Clone)]
pub enum UpdateOp {
    /// $set: { field: value }
    Set(String, ObeValue),
    /// $unset: { field: "" }
    Unset(String),
    /// $inc: { field: number }
    Inc(String, f64),
    /// $mul: { field: number }
    Mul(String, f64),
    /// $min: { field: value }
    Min(String, ObeValue),
    /// $max: { field: value }
    Max(String, ObeValue),
    /// $rename: { oldField: newField }
    Rename(String, String),
    /// $push: { field: value }
    Push(String, ObeValue),
    /// $push: { field: { $each: [values] } }
    PushEach(String, Vec<ObeValue>),
    /// $pull: { field: value }
    Pull(String, ObeValue),
    /// $pullAll: { field: [value1, value2, ...] }
    PullAll(String, Vec<ObeValue>),
    /// $addToSet: { field: value }
    AddToSet(String, ObeValue),
    /// $addToSet: { field: { $each: [values] } }
    AddToSetEach(String, Vec<ObeValue>),
    /// $pop: { field: 1 or -1 }
    Pop(String, i32),
    /// $currentDate: { field: true }
    CurrentDate(String),
    /// $setOnInsert: { field: value } — applied only during upsert inserts
    SetOnInsert(String, ObeValue),
}

/// Parse update operators from a JSON update expression.
pub fn parse_update(json: &serde_json::Value) -> OvnResult<Vec<UpdateOp>> {
    let obj = json.as_object().ok_or_else(|| OvnError::QuerySyntaxError {
        position: 0,
        message: "Update expression must be a JSON object".to_string(),
    })?;

    let mut ops = Vec::new();

    for (op_key, op_value) in obj {
        let fields = op_value
            .as_object()
            .ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: format!("{op_key} value must be an object"),
            })?;

        for (field, value) in fields {
            match op_key.as_str() {
                "$set" => {
                    ops.push(UpdateOp::Set(field.clone(), ObeValue::from_json(value)));
                }
                "$unset" => {
                    ops.push(UpdateOp::Unset(field.clone()));
                }
                "$inc" => {
                    let num = value.as_f64().ok_or_else(|| OvnError::QuerySyntaxError {
                        position: 0,
                        message: "$inc value must be numeric".to_string(),
                    })?;
                    ops.push(UpdateOp::Inc(field.clone(), num));
                }
                "$mul" => {
                    let num = value.as_f64().ok_or_else(|| OvnError::QuerySyntaxError {
                        position: 0,
                        message: "$mul value must be numeric".to_string(),
                    })?;
                    ops.push(UpdateOp::Mul(field.clone(), num));
                }
                "$min" => {
                    ops.push(UpdateOp::Min(field.clone(), ObeValue::from_json(value)));
                }
                "$max" => {
                    ops.push(UpdateOp::Max(field.clone(), ObeValue::from_json(value)));
                }
                "$rename" => {
                    let new_name = value.as_str().ok_or_else(|| OvnError::QuerySyntaxError {
                        position: 0,
                        message: "$rename value must be a string".to_string(),
                    })?;
                    ops.push(UpdateOp::Rename(field.clone(), new_name.to_string()));
                }
                "$push" => {
                    // Check for $each modifier
                    if let Some(each_arr) = value.get("$each").and_then(|v| v.as_array()) {
                        let items: Vec<ObeValue> =
                            each_arr.iter().map(ObeValue::from_json).collect();
                        ops.push(UpdateOp::PushEach(field.clone(), items));
                    } else {
                        ops.push(UpdateOp::Push(field.clone(), ObeValue::from_json(value)));
                    }
                }
                "$pull" => {
                    ops.push(UpdateOp::Pull(field.clone(), ObeValue::from_json(value)));
                }
                "$pullAll" => {
                    let values = match value {
                        serde_json::Value::Array(arr) => {
                            arr.iter().map(ObeValue::from_json).collect()
                        }
                        _ => vec![ObeValue::from_json(value)],
                    };
                    ops.push(UpdateOp::PullAll(field.clone(), values));
                }
                "$addToSet" => {
                    // Check for $each modifier
                    if let Some(each_arr) = value.get("$each").and_then(|v| v.as_array()) {
                        let items: Vec<ObeValue> =
                            each_arr.iter().map(ObeValue::from_json).collect();
                        ops.push(UpdateOp::AddToSetEach(field.clone(), items));
                    } else {
                        ops.push(UpdateOp::AddToSet(
                            field.clone(),
                            ObeValue::from_json(value),
                        ));
                    }
                }
                "$pop" => {
                    let dir = value.as_i64().unwrap_or(1) as i32;
                    ops.push(UpdateOp::Pop(field.clone(), dir));
                }
                "$currentDate" => {
                    ops.push(UpdateOp::CurrentDate(field.clone()));
                }
                "$setOnInsert" => {
                    ops.push(UpdateOp::SetOnInsert(
                        field.clone(),
                        ObeValue::from_json(value),
                    ));
                }
                _ => {
                    return Err(OvnError::UnknownOperator(op_key.clone()));
                }
            }
        }
    }

    Ok(ops)
}

/// Apply a list of update operations to a document.
pub fn apply_update(doc: &mut ObeDocument, ops: &[UpdateOp]) -> OvnResult<()> {
    for op in ops {
        apply_single_update(doc, op)?;
    }
    Ok(())
}

fn apply_single_update(doc: &mut ObeDocument, op: &UpdateOp) -> OvnResult<()> {
    match op {
        UpdateOp::Set(field, value) => {
            set_nested_field(&mut doc.fields, field, value.clone());
        }
        UpdateOp::Unset(field) => {
            unset_nested_field(&mut doc.fields, field);
        }
        UpdateOp::Inc(field, amount) => {
            let current = doc.get_path(field).cloned().unwrap_or(ObeValue::Int32(0));
            let new_val = match current {
                ObeValue::Int32(v) => {
                    if *amount == (*amount as i32 as f64) {
                        ObeValue::Int32(v + *amount as i32)
                    } else {
                        ObeValue::Float64(v as f64 + amount)
                    }
                }
                ObeValue::Int64(v) => {
                    if *amount == (*amount as i64 as f64) {
                        ObeValue::Int64(v + *amount as i64)
                    } else {
                        ObeValue::Float64(v as f64 + amount)
                    }
                }
                ObeValue::Float64(v) => ObeValue::Float64(v + amount),
                _ => {
                    return Err(OvnError::QuerySyntaxError {
                        position: 0,
                        message: format!("$inc requires numeric field, got {:?}", current),
                    })
                }
            };
            set_nested_field(&mut doc.fields, field, new_val);
        }
        UpdateOp::Mul(field, factor) => {
            let current = doc.get_path(field).cloned().unwrap_or(ObeValue::Int32(0));
            let new_val = match current {
                ObeValue::Int32(v) => ObeValue::Float64(v as f64 * factor),
                ObeValue::Int64(v) => ObeValue::Float64(v as f64 * factor),
                ObeValue::Float64(v) => ObeValue::Float64(v * factor),
                _ => {
                    return Err(OvnError::QuerySyntaxError {
                        position: 0,
                        message: "$mul requires numeric field".to_string(),
                    })
                }
            };
            set_nested_field(&mut doc.fields, field, new_val);
        }
        UpdateOp::Min(field, value) => {
            if let Some(current) = doc.get_path(field) {
                if let Some(std::cmp::Ordering::Less) = compare_for_update(value, current) {
                    set_nested_field(&mut doc.fields, field, value.clone());
                }
            } else {
                set_nested_field(&mut doc.fields, field, value.clone());
            }
        }
        UpdateOp::Max(field, value) => {
            if let Some(current) = doc.get_path(field) {
                if let Some(std::cmp::Ordering::Greater) = compare_for_update(value, current) {
                    set_nested_field(&mut doc.fields, field, value.clone());
                }
            } else {
                set_nested_field(&mut doc.fields, field, value.clone());
            }
        }
        UpdateOp::Rename(old_field, new_field) => {
            if let Some(value) = doc.fields.remove(old_field) {
                doc.fields.insert(new_field.clone(), value);
            }
        }
        UpdateOp::Push(field, value) => {
            let current = doc
                .fields
                .entry(field.clone())
                .or_insert(ObeValue::Array(Vec::new()));
            if let ObeValue::Array(arr) = current {
                arr.push(value.clone());
            } else {
                return Err(OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$push requires array field".to_string(),
                });
            }
        }
        UpdateOp::PushEach(field, values) => {
            let current = doc
                .fields
                .entry(field.clone())
                .or_insert(ObeValue::Array(Vec::new()));
            if let ObeValue::Array(arr) = current {
                for v in values {
                    arr.push(v.clone());
                }
            } else {
                return Err(OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$push with $each requires array field".to_string(),
                });
            }
        }
        UpdateOp::Pull(field, value) => {
            if let Some(ObeValue::Array(arr)) = doc.fields.get_mut(field) {
                arr.retain(|v| v != value);
            }
        }
        UpdateOp::PullAll(field, values) => {
            if let Some(ObeValue::Array(arr)) = doc.fields.get_mut(field) {
                arr.retain(|v| !values.contains(v));
            }
        }
        UpdateOp::AddToSet(field, value) => {
            let current = doc
                .fields
                .entry(field.clone())
                .or_insert(ObeValue::Array(Vec::new()));
            if let ObeValue::Array(arr) = current {
                if !arr.contains(value) {
                    arr.push(value.clone());
                }
            }
        }
        UpdateOp::AddToSetEach(field, values) => {
            let current = doc
                .fields
                .entry(field.clone())
                .or_insert(ObeValue::Array(Vec::new()));
            if let ObeValue::Array(arr) = current {
                for v in values {
                    if !arr.contains(v) {
                        arr.push(v.clone());
                    }
                }
            }
        }
        UpdateOp::Pop(field, direction) => {
            if let Some(ObeValue::Array(arr)) = doc.fields.get_mut(field) {
                if !arr.is_empty() {
                    if *direction >= 0 {
                        arr.pop();
                    } else {
                        arr.remove(0);
                    }
                }
            }
        }
        UpdateOp::CurrentDate(field) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            doc.fields.insert(field.clone(), ObeValue::Timestamp(now));
        }
        UpdateOp::SetOnInsert(field, value) => {
            // Applied only during upsert inserts; behaves like $set here.
            // The caller (engine) decides whether to include this op.
            set_nested_field(&mut doc.fields, field, value.clone());
        }
    }
    Ok(())
}

/// Set a possibly nested field using dot notation.
fn set_nested_field(fields: &mut BTreeMap<String, ObeValue>, path: &str, value: ObeValue) {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() == 1 {
        fields.insert(path.to_string(), value);
        return;
    }

    let first = parts[0];
    let rest = parts[1..].join(".");

    let entry = fields
        .entry(first.to_string())
        .or_insert_with(|| ObeValue::Document(BTreeMap::new()));

    if let ObeValue::Document(sub) = entry {
        set_nested_field(sub, &rest, value);
    }
}

/// Unset a possibly nested field using dot notation.
fn unset_nested_field(fields: &mut BTreeMap<String, ObeValue>, path: &str) {
    let parts: Vec<&str> = path.split('.').collect();
    if parts.len() == 1 {
        fields.remove(path);
        return;
    }

    let first = parts[0];
    let rest = parts[1..].join(".");

    if let Some(ObeValue::Document(sub)) = fields.get_mut(first) {
        unset_nested_field(sub, &rest);
    }
}

fn compare_for_update(a: &ObeValue, b: &ObeValue) -> Option<std::cmp::Ordering> {
    match (a, b) {
        (a, b) if a.as_f64().is_some() && b.as_f64().is_some() => {
            a.as_f64().unwrap().partial_cmp(&b.as_f64().unwrap())
        }
        (ObeValue::String(a), ObeValue::String(b)) => Some(a.cmp(b)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_set_and_unset() {
        let mut doc = ObeDocument::new();
        doc.set("name".to_string(), ObeValue::String("Alice".to_string()));

        apply_update(
            &mut doc,
            &[
                UpdateOp::Set("age".to_string(), ObeValue::Int32(28)),
                UpdateOp::Unset("name".to_string()),
            ],
        )
        .unwrap();

        assert!(doc.get("name").is_none());
        assert_eq!(doc.get("age"), Some(&ObeValue::Int32(28)));
    }

    #[test]
    fn test_inc() {
        let mut doc = ObeDocument::new();
        doc.set("count".to_string(), ObeValue::Int32(10));

        apply_update(&mut doc, &[UpdateOp::Inc("count".to_string(), 5.0)]).unwrap();
        assert_eq!(doc.get("count"), Some(&ObeValue::Int32(15)));
    }

    #[test]
    fn test_push_and_pull() {
        let mut doc = ObeDocument::new();
        doc.set(
            "tags".to_string(),
            ObeValue::Array(vec![ObeValue::String("a".to_string())]),
        );

        apply_update(
            &mut doc,
            &[UpdateOp::Push(
                "tags".to_string(),
                ObeValue::String("b".to_string()),
            )],
        )
        .unwrap();

        if let Some(ObeValue::Array(arr)) = doc.get("tags") {
            assert_eq!(arr.len(), 2);
        }

        apply_update(
            &mut doc,
            &[UpdateOp::Pull(
                "tags".to_string(),
                ObeValue::String("a".to_string()),
            )],
        )
        .unwrap();

        if let Some(ObeValue::Array(arr)) = doc.get("tags") {
            assert_eq!(arr.len(), 1);
            assert_eq!(arr[0], ObeValue::String("b".to_string()));
        }
    }

    #[test]
    fn test_parse_update_json() {
        let json = serde_json::json!({
            "$set": { "name": "Bob" },
            "$inc": { "age": 1 }
        });
        let ops = parse_update(&json).unwrap();
        assert_eq!(ops.len(), 2);
    }

    #[test]
    fn test_push_each() {
        let mut doc = ObeDocument::new();
        doc.set("tags".to_string(), ObeValue::Array(vec![]));

        apply_update(
            &mut doc,
            &[UpdateOp::PushEach(
                "tags".to_string(),
                vec![
                    ObeValue::String("a".to_string()),
                    ObeValue::String("b".to_string()),
                    ObeValue::String("c".to_string()),
                ],
            )],
        )
        .unwrap();

        if let Some(ObeValue::Array(arr)) = doc.get("tags") {
            assert_eq!(arr.len(), 3);
        }
    }

    #[test]
    fn test_pull_all() {
        let mut doc = ObeDocument::new();
        doc.set(
            "tags".to_string(),
            ObeValue::Array(vec![
                ObeValue::String("a".to_string()),
                ObeValue::String("b".to_string()),
                ObeValue::String("c".to_string()),
            ]),
        );

        apply_update(
            &mut doc,
            &[UpdateOp::PullAll(
                "tags".to_string(),
                vec![
                    ObeValue::String("a".to_string()),
                    ObeValue::String("c".to_string()),
                ],
            )],
        )
        .unwrap();

        if let Some(ObeValue::Array(arr)) = doc.get("tags") {
            assert_eq!(arr.len(), 1);
            assert_eq!(arr[0], ObeValue::String("b".to_string()));
        }
    }

    #[test]
    fn test_add_to_set_each() {
        let mut doc = ObeDocument::new();
        doc.set(
            "tags".to_string(),
            ObeValue::Array(vec![ObeValue::String("a".to_string())]),
        );

        apply_update(
            &mut doc,
            &[UpdateOp::AddToSetEach(
                "tags".to_string(),
                vec![
                    ObeValue::String("a".to_string()), // duplicate
                    ObeValue::String("b".to_string()),
                    ObeValue::String("c".to_string()),
                ],
            )],
        )
        .unwrap();

        if let Some(ObeValue::Array(arr)) = doc.get("tags") {
            assert_eq!(arr.len(), 3); // a, b, c — no duplicate
        }
    }

    #[test]
    fn test_set_on_insert() {
        let mut doc = ObeDocument::new();
        apply_update(
            &mut doc,
            &[UpdateOp::SetOnInsert(
                "createdAt".to_string(),
                ObeValue::Timestamp(1234567890),
            )],
        )
        .unwrap();

        assert_eq!(doc.get("createdAt"), Some(&ObeValue::Timestamp(1234567890)));
    }

    #[test]
    fn test_parse_update_with_each() {
        let json = serde_json::json!({
            "$push": { "tags": { "$each": ["a", "b", "c"] } },
            "$addToSet": { "colors": { "$each": ["red", "blue"] } },
            "$pullAll": { "remove": ["x", "y"] },
            "$setOnInsert": { "createdAt": 12345 }
        });
        let ops = parse_update(&json).unwrap();
        assert_eq!(ops.len(), 4);

        // Check that each operator type is present (order is not guaranteed)
        let has_push_each = ops
            .iter()
            .any(|op| matches!(op, UpdateOp::PushEach(_, v) if v.len() == 3));
        let has_add_to_set_each = ops
            .iter()
            .any(|op| matches!(op, UpdateOp::AddToSetEach(_, v) if v.len() == 2));
        let has_pull_all = ops
            .iter()
            .any(|op| matches!(op, UpdateOp::PullAll(_, v) if v.len() == 2));
        let has_set_on_insert = ops
            .iter()
            .any(|op| matches!(op, UpdateOp::SetOnInsert(_, _)));

        assert!(has_push_each, "Missing $push with $each");
        assert!(has_add_to_set_each, "Missing $addToSet with $each");
        assert!(has_pull_all, "Missing $pullAll");
        assert!(has_set_on_insert, "Missing $setOnInsert");
    }
}
