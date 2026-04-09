//! Aggregation pipeline — $match, $group, $project, $sort, $limit, $skip, $unwind, $lookup, $count,
//! $replaceRoot, $addFields, $merge, $out, $facet, $bucket.

use crate::error::{OvnError, OvnResult};
use crate::format::obe::{ObeDocument, ObeValue};
use crate::query::filter::{evaluate_filter, parse_filter};
use std::collections::BTreeMap;

/// Configuration for $lookup stage.
#[derive(Debug, Clone)]
pub struct LookupConfig {
    /// Foreign collection name
    pub from: String,
    /// Local field to match on
    pub local_field: String,
    /// Foreign collection field to match against
    pub foreign_field: String,
    /// Output array field name
    pub as_field: String,
    /// Optional pipeline-style lookup (advanced)
    pub pipeline: Option<Vec<serde_json::Value>>,
}

/// Configuration for $unwind stage.
#[derive(Debug, Clone)]
pub struct UnwindConfig {
    /// Field path (without $)
    pub path: String,
    /// Include array index in output document
    pub include_array_index: Option<String>,
    /// If true, emit documents where field is null or missing
    pub preserve_null_and_empty_arrays: bool,
}

/// A single stage in the aggregation pipeline.
#[derive(Debug, Clone)]
pub enum AggregateStage {
    /// $match — filter documents
    Match(serde_json::Value),
    /// $group — group by _id expression and compute accumulators
    Group {
        id_expr: String,
        accumulators: Vec<(String, Accumulator)>,
    },
    /// $project — include/exclude fields
    Project(BTreeMap<String, bool>),
    /// $addFields / $set — add or update fields without removing others
    AddFields(BTreeMap<String, serde_json::Value>),
    /// $sort — sort by fields (1 = asc, -1 = desc)
    Sort(Vec<(String, i32)>),
    /// $limit — limit number of documents
    Limit(usize),
    /// $skip — skip N documents
    Skip(usize),
    /// $unwind — deconstruct array field
    Unwind(UnwindConfig),
    /// $count — count documents and output as field
    Count(String),
    /// $lookup — join with another collection
    Lookup(LookupConfig),
    /// $replaceRoot / $replaceWith — replace document root
    ReplaceRoot(String),
    /// $facet - multi-faceted aggregation
    Facet(BTreeMap<String, Vec<AggregateStage>>),
    /// $bucket - bucket grouping
    Bucket(serde_json::Value),
    /// $merge — write results to a collection (stub)
    Merge(String),
    /// $out — write results to a collection, replacing it (stub)
    Out(String),
    /// $setWindowFields - analytical partitions (stub)
    SetWindowFields(serde_json::Value),
}

/// Accumulator operations for $group stage.
#[derive(Debug, Clone)]
pub enum Accumulator {
    Sum(AccumulatorExpr),
    Avg(AccumulatorExpr),
    Min(AccumulatorExpr),
    Max(AccumulatorExpr),
    First(AccumulatorExpr),
    Last(AccumulatorExpr),
    Push(AccumulatorExpr),
    AddToSet(AccumulatorExpr),
    Count,
}

/// Expression for accumulator — field path or literal.
#[derive(Debug, Clone)]
pub enum AccumulatorExpr {
    /// Field path reference: "$fieldName"
    FieldPath(String),
    /// Literal value (e.g., 1 for counting)
    Literal(ObeValue),
}

/// Parse aggregation pipeline stages from JSON array.
pub fn parse_pipeline(stages: &[serde_json::Value]) -> OvnResult<Vec<AggregateStage>> {
    stages.iter().map(parse_stage).collect()
}

fn parse_stage(json: &serde_json::Value) -> OvnResult<AggregateStage> {
    let obj = json.as_object().ok_or_else(|| OvnError::QuerySyntaxError {
        position: 0,
        message: "Pipeline stage must be an object".to_string(),
    })?;

    if obj.len() != 1 {
        return Err(OvnError::QuerySyntaxError {
            position: 0,
            message: "Pipeline stage must have exactly one key".to_string(),
        });
    }

    let (key, value) = obj.iter().next().unwrap();

    match key.as_str() {
        "$match" => Ok(AggregateStage::Match(value.clone())),
        "$group" => parse_group_stage(value),
        "$project" => {
            let proj_obj = value
                .as_object()
                .ok_or_else(|| OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$project must be an object".to_string(),
                })?;
            let mut projection = BTreeMap::new();
            for (field, include) in proj_obj {
                let include = match include {
                    serde_json::Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
                    serde_json::Value::Bool(b) => *b,
                    _ => true,
                };
                projection.insert(field.clone(), include);
            }
            Ok(AggregateStage::Project(projection))
        }
        "$addFields" | "$set" => {
            let add_obj = value
                .as_object()
                .ok_or_else(|| OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$addFields must be an object".to_string(),
                })?;
            let fields: BTreeMap<String, serde_json::Value> = add_obj
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            Ok(AggregateStage::AddFields(fields))
        }
        "$sort" => {
            let sort_obj = value
                .as_object()
                .ok_or_else(|| OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$sort must be an object".to_string(),
                })?;
            let sort_fields: Vec<(String, i32)> = sort_obj
                .iter()
                .map(|(f, d)| (f.clone(), d.as_i64().unwrap_or(1) as i32))
                .collect();
            Ok(AggregateStage::Sort(sort_fields))
        }
        "$limit" => {
            let n = value.as_u64().ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: "$limit must be a number".to_string(),
            })? as usize;
            Ok(AggregateStage::Limit(n))
        }
        "$skip" => {
            let n = value.as_u64().ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: "$skip must be a number".to_string(),
            })? as usize;
            Ok(AggregateStage::Skip(n))
        }
        "$unwind" => {
            // $unwind can be a string (simple) or object (with options)
            let config = if let Some(s) = value.as_str() {
                let field = s.strip_prefix('$').unwrap_or(s);
                UnwindConfig {
                    path: field.to_string(),
                    include_array_index: None,
                    preserve_null_and_empty_arrays: false,
                }
            } else if let Some(obj) = value.as_object() {
                let path = obj
                    .get("path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .strip_prefix('$')
                    .unwrap_or("")
                    .to_string();
                let include_array_index = obj
                    .get("includeArrayIndex")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let preserve = obj
                    .get("preserveNullAndEmptyArrays")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                UnwindConfig {
                    path,
                    include_array_index,
                    preserve_null_and_empty_arrays: preserve,
                }
            } else {
                return Err(OvnError::QuerySyntaxError {
                    position: 0,
                    message: "$unwind must be a string or object".to_string(),
                });
            };
            Ok(AggregateStage::Unwind(config))
        }
        "$count" => {
            let field = value.as_str().unwrap_or("count");
            Ok(AggregateStage::Count(field.to_string()))
        }
        "$lookup" => parse_lookup_stage(value),
        "$replaceRoot" | "$replaceWith" => {
            // $replaceRoot: { newRoot: "$fieldName" } or $replaceWith: "$fieldName"
            let new_root = if let Some(obj) = value.as_object() {
                obj.get("newRoot")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .strip_prefix('$')
                    .unwrap_or("")
                    .to_string()
            } else if let Some(s) = value.as_str() {
                s.strip_prefix('$').unwrap_or(s).to_string()
            } else {
                String::new()
            };
            Ok(AggregateStage::ReplaceRoot(new_root))
        }
        "$facet" => {
            let facet_obj = value.as_object().ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: "$facet must be an object".to_string(),
            })?;
            let mut facets = BTreeMap::new();
            for (field, stages_json) in facet_obj {
                if let Some(arr) = stages_json.as_array() {
                    let stgs = parse_pipeline(arr)?;
                    facets.insert(field.clone(), stgs);
                }
            }
            Ok(AggregateStage::Facet(facets))
        }
        "$bucket" | "$bucketAuto" => Ok(AggregateStage::Bucket(value.clone())),
        "$merge" => {
            let coll = if let Some(s) = value.as_str() {
                s.to_string()
            } else if let Some(obj) = value.as_object() {
                obj.get("into")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            } else {
                String::new()
            };
            Ok(AggregateStage::Merge(coll))
        }
        "$out" => {
            let coll = value.as_str().unwrap_or("").to_string();
            Ok(AggregateStage::Out(coll))
        }
        "$setWindowFields" | "$fill" | "$densify" => {
            Ok(AggregateStage::SetWindowFields(value.clone()))
        }
        _ => Err(OvnError::UnknownOperator(key.clone())),
    }
}

/// Parse a $lookup stage.
fn parse_lookup_stage(value: &serde_json::Value) -> OvnResult<AggregateStage> {
    let obj = value.as_object().ok_or_else(|| OvnError::QuerySyntaxError {
        position: 0,
        message: "$lookup must be an object".to_string(),
    })?;

    let from = obj
        .get("from")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let local_field = obj
        .get("localField")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let foreign_field = obj
        .get("foreignField")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let as_field = obj
        .get("as")
        .and_then(|v| v.as_str())
        .unwrap_or("joined")
        .to_string();
    let pipeline = obj
        .get("pipeline")
        .and_then(|v| v.as_array())
        .map(|arr| arr.to_vec());

    Ok(AggregateStage::Lookup(LookupConfig {
        from,
        local_field,
        foreign_field,
        as_field,
        pipeline,
    }))
}

fn parse_group_stage(value: &serde_json::Value) -> OvnResult<AggregateStage> {
    let obj = value
        .as_object()
        .ok_or_else(|| OvnError::QuerySyntaxError {
            position: 0,
            message: "$group must be an object".to_string(),
        })?;

    let id_expr = obj
        .get("_id")
        .and_then(|v| v.as_str())
        .unwrap_or("null")
        .strip_prefix('$')
        .unwrap_or("null")
        .to_string();

    let mut accumulators = Vec::new();

    for (field, acc_value) in obj {
        if field == "_id" {
            continue;
        }

        let acc_obj = acc_value
            .as_object()
            .ok_or_else(|| OvnError::QuerySyntaxError {
                position: 0,
                message: format!("Accumulator for '{field}' must be an object"),
            })?;

        for (acc_op, acc_expr) in acc_obj {
            let expr = parse_accumulator_expr(acc_expr);
            let accumulator = match acc_op.as_str() {
                "$sum" => Accumulator::Sum(expr),
                "$avg" => Accumulator::Avg(expr),
                "$min" => Accumulator::Min(expr),
                "$max" => Accumulator::Max(expr),
                "$first" => Accumulator::First(expr),
                "$last" => Accumulator::Last(expr),
                "$push" => Accumulator::Push(expr),
                "$addToSet" => Accumulator::AddToSet(expr),
                _ => Accumulator::Count,
            };
            accumulators.push((field.clone(), accumulator));
        }
    }

    Ok(AggregateStage::Group {
        id_expr,
        accumulators,
    })
}

fn parse_accumulator_expr(value: &serde_json::Value) -> AccumulatorExpr {
    if let Some(s) = value.as_str() {
        if let Some(field) = s.strip_prefix('$') {
            return AccumulatorExpr::FieldPath(field.to_string());
        }
    }
    AccumulatorExpr::Literal(ObeValue::from_json(value))
}

/// Execute an aggregation pipeline against a list of documents.
pub fn execute_pipeline(
    docs: Vec<ObeDocument>,
    stages: &[AggregateStage],
) -> OvnResult<Vec<ObeDocument>> {
    let mut result = docs;

    for stage in stages {
        result = execute_stage(result, stage)?;
    }

    Ok(result)
}

/// Public single-stage executor for engine-level integration (e.g., $lookup).
pub fn execute_stage_single(
    docs: Vec<ObeDocument>,
    stage: &AggregateStage,
) -> OvnResult<Vec<ObeDocument>> {
    execute_stage(docs, stage)
}

fn execute_stage(docs: Vec<ObeDocument>, stage: &AggregateStage) -> OvnResult<Vec<ObeDocument>> {
    match stage {
        AggregateStage::Match(filter_json) => {
            let filter = parse_filter(filter_json)?;
            Ok(docs
                .into_iter()
                .filter(|d| evaluate_filter(&filter, d))
                .collect())
        }
        AggregateStage::Project(projection) => {
            let result: Vec<ObeDocument> = docs
                .into_iter()
                .map(|doc| {
                    let mut new_doc = ObeDocument::with_id(doc.id);
                    new_doc.txid = doc.txid;

                    let has_includes = projection.values().any(|&v| v);

                    if has_includes {
                        // Include mode: only include specified fields
                        for (field, include) in projection {
                            if *include {
                                if let Some(val) = doc.get(field) {
                                    new_doc.set(field.clone(), val.clone());
                                }
                            }
                        }
                    } else {
                        // Exclude mode: copy all except excluded
                        for (field, val) in &doc.fields {
                            if projection.get(field).is_none_or(|&exclude| exclude) {
                                new_doc.set(field.clone(), val.clone());
                            }
                        }
                    }

                    new_doc
                })
                .collect();
            Ok(result)
        }
        AggregateStage::Sort(sort_fields) => {
            let mut sorted = docs;
            sorted.sort_by(|a, b| {
                for (field, direction) in sort_fields {
                    let val_a = a.get_path(field);
                    let val_b = b.get_path(field);

                    let ord = match (val_a, val_b) {
                        (Some(va), Some(vb)) => {
                            if let (Some(fa), Some(fb)) = (va.as_f64(), vb.as_f64()) {
                                fa.partial_cmp(&fb).unwrap_or(std::cmp::Ordering::Equal)
                            } else if let (Some(sa), Some(sb)) = (va.as_str(), vb.as_str()) {
                                sa.cmp(sb)
                            } else {
                                std::cmp::Ordering::Equal
                            }
                        }
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        _ => std::cmp::Ordering::Equal,
                    };

                    let ord = if *direction < 0 { ord.reverse() } else { ord };
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
                std::cmp::Ordering::Equal
            });
            Ok(sorted)
        }
        AggregateStage::Limit(n) => Ok(docs.into_iter().take(*n).collect()),
        AggregateStage::Skip(n) => Ok(docs.into_iter().skip(*n).collect()),
        AggregateStage::AddFields(fields_map) => {
            let docs: Vec<ObeDocument> = docs
                .into_iter()
                .map(|mut doc| {
                    for (field, expr_json) in fields_map {
                        // If expression starts with "$", resolve as field ref
                        let value = if let Some(field_ref) = expr_json.as_str().and_then(|s| s.strip_prefix('$')) {
                            doc.get_path(field_ref).cloned().unwrap_or(ObeValue::Null)
                        } else {
                            ObeValue::from_json(expr_json)
                        };
                        doc.set(field.clone(), value);
                    }
                    doc
                })
                .collect();
            Ok(docs)
        }
        AggregateStage::Unwind(config) => {
            let mut result = Vec::new();
            for (idx, doc) in docs.into_iter().enumerate() {
                let arr_val = doc.get(&config.path).cloned();
                match arr_val {
                    Some(ObeValue::Array(arr)) if !arr.is_empty() => {
                        for (arr_idx, elem) in arr.into_iter().enumerate() {
                            let mut new_doc = doc.clone();
                            new_doc.set(config.path.clone(), elem);
                            if let Some(ref idx_field) = config.include_array_index {
                                new_doc.set(idx_field.clone(), ObeValue::Int64(arr_idx as i64));
                            }
                            result.push(new_doc);
                        }
                    }
                    Some(ObeValue::Array(_)) => {
                        // Empty array
                        if config.preserve_null_and_empty_arrays {
                            result.push(doc);
                        }
                    }
                    Some(ObeValue::Null) | None => {
                        // Null or missing field
                        if config.preserve_null_and_empty_arrays {
                            result.push(doc);
                        }
                    }
                    Some(_) => {
                        // Non-array: treat as single element
                        result.push(doc);
                    }
                }
                let _ = idx; // suppress unused warning
            }
            Ok(result)
        }
        AggregateStage::Count(output_field) => {
            let count = docs.len();
            let mut result_doc = ObeDocument::new();
            result_doc.set(output_field.clone(), ObeValue::Int64(count as i64));
            Ok(vec![result_doc])
        }
        AggregateStage::Group {
            id_expr,
            accumulators,
        } => execute_group(docs, id_expr, accumulators),
        AggregateStage::Lookup(_config) => {
            // $lookup requires access to the engine's btree for foreign collection.
            // In the pipeline context, we don't have engine reference here.
            // The engine-level aggregate() wraps this in a $lookup-aware execution.
            // For now, attach empty array for each doc (field will be populated by
            // the engine before calling execute_pipeline when lookup_docs is provided).
            Ok(docs)
        }
        AggregateStage::ReplaceRoot(new_root_field) => {
            let result: Vec<ObeDocument> = docs
                .into_iter()
                .filter_map(|doc| {
                    if new_root_field.is_empty() {
                        Some(doc)
                    } else if let Some(ObeValue::Document(nested)) = doc.get_path(new_root_field).cloned() {
                        let mut new_doc = ObeDocument::new();
                        for (k, v) in nested {
                            new_doc.set(k, v);
                        }
                        Some(new_doc)
                    } else {
                        None
                    }
                })
                .collect();
            Ok(result)
        }
        AggregateStage::Facet(facets) => {
            let mut result_doc = ObeDocument::new();
            for (facet_name, facet_stages) in facets {
                let facet_result = execute_pipeline(docs.clone(), facet_stages)?;
                let arr: Vec<ObeValue> = facet_result
                    .into_iter()
                    .map(|d| ObeValue::Document(d.fields))
                    .collect();
                result_doc.set(facet_name.clone(), ObeValue::Array(arr));
            }
            Ok(vec![result_doc])
        }
        AggregateStage::Bucket(bucket_cfg) => execute_bucket(docs, bucket_cfg),
        AggregateStage::Merge(_) | AggregateStage::Out(_) => {
            // Stub: output stages — would write docs to a collection.
            // Results are passed through unchanged for now.
            Ok(docs)
        }
        AggregateStage::SetWindowFields(_) => {
            // Window functions — pass through (not yet implemented)
            Ok(docs)
        }
    }
}

fn execute_group(
    docs: Vec<ObeDocument>,
    id_expr: &str,
    accumulators: &[(String, Accumulator)],
) -> OvnResult<Vec<ObeDocument>> {
    // Group documents by the _id expression
    let mut groups: BTreeMap<String, Vec<&ObeDocument>> = BTreeMap::new();

    for doc in &docs {
        let group_key = if id_expr == "null" {
            "null".to_string()
        } else {
            doc.get_path(id_expr)
                .map(|v| v.to_json().to_string())
                .unwrap_or("null".to_string())
        };
        groups.entry(group_key).or_default().push(doc);
    }

    let mut result = Vec::new();

    for (group_key, group_docs) in &groups {
        let mut result_doc = ObeDocument::new();

        // Set _id
        if group_key == "null" {
            result_doc.set("_id".to_string(), ObeValue::Null);
        } else {
            // Parse the group key back from JSON string
            if let Ok(json_val) = serde_json::from_str::<serde_json::Value>(group_key) {
                result_doc.set("_id".to_string(), ObeValue::from_json(&json_val));
            } else {
                result_doc.set("_id".to_string(), ObeValue::String(group_key.clone()));
            }
        }

        // Compute accumulators
        for (output_field, accumulator) in accumulators {
            let value = compute_accumulator(accumulator, group_docs);
            result_doc.set(output_field.clone(), value);
        }

        result.push(result_doc);
    }

    Ok(result)
}

fn compute_accumulator(acc: &Accumulator, docs: &[&ObeDocument]) -> ObeValue {
    match acc {
        Accumulator::Sum(expr) => {
            let sum: f64 = docs.iter().map(|d| resolve_expr_f64(expr, d)).sum();
            if sum == (sum as i64 as f64) {
                ObeValue::Int64(sum as i64)
            } else {
                ObeValue::Float64(sum)
            }
        }
        Accumulator::Avg(expr) => {
            if docs.is_empty() {
                return ObeValue::Null;
            }
            let sum: f64 = docs.iter().map(|d| resolve_expr_f64(expr, d)).sum();
            ObeValue::Float64(sum / docs.len() as f64)
        }
        Accumulator::Min(expr) => docs
            .iter()
            .filter_map(|d| resolve_expr_value(expr, d))
            .min_by(|a, b| {
                a.as_f64()
                    .unwrap_or(f64::MAX)
                    .partial_cmp(&b.as_f64().unwrap_or(f64::MAX))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(ObeValue::Null),
        Accumulator::Max(expr) => docs
            .iter()
            .filter_map(|d| resolve_expr_value(expr, d))
            .max_by(|a, b| {
                a.as_f64()
                    .unwrap_or(f64::MIN)
                    .partial_cmp(&b.as_f64().unwrap_or(f64::MIN))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(ObeValue::Null),
        Accumulator::First(expr) => docs
            .first()
            .and_then(|d| resolve_expr_value(expr, d))
            .unwrap_or(ObeValue::Null),
        Accumulator::Last(expr) => docs
            .last()
            .and_then(|d| resolve_expr_value(expr, d))
            .unwrap_or(ObeValue::Null),
        Accumulator::Push(expr) => {
            let values: Vec<ObeValue> = docs
                .iter()
                .filter_map(|d| resolve_expr_value(expr, d))
                .collect();
            ObeValue::Array(values)
        }
        Accumulator::AddToSet(expr) => {
            let mut values: Vec<ObeValue> = Vec::new();
            for d in docs {
                if let Some(v) = resolve_expr_value(expr, d) {
                    if !values.contains(&v) {
                        values.push(v);
                    }
                }
            }
            ObeValue::Array(values)
        }
        Accumulator::Count => ObeValue::Int64(docs.len() as i64),
    }
}

fn resolve_expr_f64(expr: &AccumulatorExpr, doc: &ObeDocument) -> f64 {
    match expr {
        AccumulatorExpr::FieldPath(path) => {
            doc.get_path(path).and_then(|v| v.as_f64()).unwrap_or(0.0)
        }
        AccumulatorExpr::Literal(val) => val.as_f64().unwrap_or(1.0),
    }
}

fn resolve_expr_value(expr: &AccumulatorExpr, doc: &ObeDocument) -> Option<ObeValue> {
    match expr {
        AccumulatorExpr::FieldPath(path) => doc.get_path(path).cloned(),
        AccumulatorExpr::Literal(val) => Some(val.clone()),
    }
}

fn execute_bucket(
    docs: Vec<ObeDocument>,
    bucket_cfg: &serde_json::Value,
) -> OvnResult<Vec<ObeDocument>> {
    let cfg = bucket_cfg.as_object().unwrap();
    let group_by = cfg.get("groupBy").and_then(|v| v.as_str()).unwrap_or("").strip_prefix('$').unwrap_or("");
    let boundaries = cfg.get("boundaries").and_then(|v| v.as_array()).unwrap();
    
    // Simplification: assume boundaries are numbers
    let mut buckets: BTreeMap<i64, Vec<&ObeDocument>> = BTreeMap::new();
    let mut default_bucket: Vec<&ObeDocument> = Vec::new();
    
    for doc in &docs {
        if let Some(val) = doc.get_path(group_by).and_then(|v| v.as_f64()) {
            let mut found = false;
            for i in 0..boundaries.len() - 1 {
                let lower = boundaries[i].as_f64().unwrap_or(f64::MIN);
                let upper = boundaries[i+1].as_f64().unwrap_or(f64::MAX);
                if val >= lower && val < upper {
                    buckets.entry(i as i64).or_default().push(doc);
                    found = true;
                    break;
                }
            }
            if !found {
                default_bucket.push(doc);
            }
        } else {
            default_bucket.push(doc);
        }
    }
    
    let mut result = Vec::new();
    for (i, contents) in buckets {
        let mut d = ObeDocument::new();
        d.set("_id".to_string(), ObeValue::from_json(&boundaries[i as usize]));
        d.set("count".to_string(), ObeValue::Int64(contents.len() as i64));
        result.push(d);
    }
    
    if !default_bucket.is_empty() {
        let mut d = ObeDocument::new();
        if let Some(def_id) = cfg.get("default") {
            d.set("_id".to_string(), ObeValue::from_json(def_id));
        } else {
            d.set("_id".to_string(), ObeValue::String("Other".to_string()));
        }
        d.set("count".to_string(), ObeValue::Int64(default_bucket.len() as i64));
        result.push(d);
    }
    
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_order(customer: &str, amount: f64, year: i32) -> ObeDocument {
        let mut doc = ObeDocument::new();
        doc.set(
            "customerId".to_string(),
            ObeValue::String(customer.to_string()),
        );
        doc.set("amount".to_string(), ObeValue::Float64(amount));
        doc.set("year".to_string(), ObeValue::Int32(year));
        doc.set(
            "status".to_string(),
            ObeValue::String("completed".to_string()),
        );
        doc
    }

    #[test]
    fn test_match_stage() {
        let docs = vec![
            make_order("c1", 100.0, 2025),
            make_order("c2", 200.0, 2024),
            make_order("c1", 150.0, 2025),
        ];

        let stage = AggregateStage::Match(serde_json::json!({ "year": 2025 }));
        let result = execute_stage(docs, &stage).unwrap();
        assert_eq!(result.len(), 2);
    }

    #[test]
    fn test_sort_and_limit() {
        let docs = vec![
            make_order("c1", 300.0, 2025),
            make_order("c2", 100.0, 2025),
            make_order("c3", 200.0, 2025),
        ];

        let pipeline = vec![
            AggregateStage::Sort(vec![("amount".to_string(), -1)]),
            AggregateStage::Limit(2),
        ];

        let result = execute_pipeline(docs, &pipeline).unwrap();
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].get("amount").unwrap().as_f64(), Some(300.0));
        assert_eq!(result[1].get("amount").unwrap().as_f64(), Some(200.0));
    }

    #[test]
    fn test_group_stage() {
        let docs = vec![
            make_order("c1", 100.0, 2025),
            make_order("c2", 200.0, 2025),
            make_order("c1", 150.0, 2025),
        ];

        let stage = AggregateStage::Group {
            id_expr: "customerId".to_string(),
            accumulators: vec![
                (
                    "totalAmount".to_string(),
                    Accumulator::Sum(AccumulatorExpr::FieldPath("amount".to_string())),
                ),
                ("orderCount".to_string(), Accumulator::Count),
            ],
        };

        let result = execute_stage(docs, &stage).unwrap();
        assert_eq!(result.len(), 2); // Two customers: c1 and c2

        // Find c1's result
        let c1 = result
            .iter()
            .find(|d| d.get("_id").is_some_and(|v| v.as_str() == Some("c1")));
        assert!(c1.is_some());
    }

    #[test]
    fn test_unwind() {
        let mut doc = ObeDocument::new();
        doc.set("name".to_string(), ObeValue::String("test".to_string()));
        doc.set(
            "tags".to_string(),
            ObeValue::Array(vec![
                ObeValue::String("a".to_string()),
                ObeValue::String("b".to_string()),
                ObeValue::String("c".to_string()),
            ]),
        );

        let result = execute_stage(vec![doc], &AggregateStage::Unwind(UnwindConfig {
            path: "tags".to_string(),
            include_array_index: None,
            preserve_null_and_empty_arrays: false,
        }))
        .unwrap();
        assert_eq!(result.len(), 3);
    }
}
