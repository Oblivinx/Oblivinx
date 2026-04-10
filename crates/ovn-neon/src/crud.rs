use neon::prelude::*;
use ovn_core::engine::FindOptions;
use std::collections::HashMap;

use crate::with_engine;

/// Insert a single document.
///
/// JS signature: `insert(handle: number, collection: string, docJson: string, lsid?: string, txn_number?: number): string`
pub fn ovn_insert(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let doc_json: serde_json::Value = serde_json::from_str(&doc_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON document: {}", e)))?;

    let mut options = ovn_core::engine::WriteOptions::default();

    if let Some(lsid_arg) = cx.argument_opt(3) {
        if let Ok(lsid_str) = lsid_arg.downcast::<JsString, _>(&mut cx) {
            let parsed = uuid::Uuid::parse_str(&lsid_str.value(&mut cx)).ok();
            if let Some(u) = parsed {
                options.lsid = Some(*u.as_bytes());
            }
        }
    }

    if let Some(txn_arg) = cx.argument_opt(4) {
        if let Ok(txn_num) = txn_arg.downcast::<JsNumber, _>(&mut cx) {
            options.txn_number = Some(txn_num.value(&mut cx) as u64);
        }
    }

    let id = with_engine(&mut cx, handle_idx, |engine| {
        engine.insert_with_options(&collection, &doc_json, options)
    })?;

    Ok(cx.string(id))
}

/// Insert multiple documents.
///
/// JS signature: `insertMany(handle: number, collection: string, docsJson: string): string` (JSON string[])
pub fn ovn_insert_many(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let docs_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let docs_json: Vec<serde_json::Value> = serde_json::from_str(&docs_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON array: {}", e)))?;

    let ids = with_engine(&mut cx, handle_idx, |engine| {
        engine.insert_many(&collection, &docs_json)
    })?;

    let result = serde_json::to_string(&ids).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result))
}

/// Find documents matching a filter.
///
/// JS signature: `find(handle: number, collection: string, filterJson: string): string` (JSON doc[])
pub fn ovn_find(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.find(&collection, &filter_json, None)
    })?;

    let result_str = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

/// Find documents with full options (sort, limit, skip, projection).
///
/// JS signature: `findWithOptions(handle, collection, filterJson, optionsJson): string`
pub fn ovn_find_with_options(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);
    let opts_str = cx.argument::<JsString>(3)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;

    let opts_json: serde_json::Value = serde_json::from_str(&opts_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON options: {}", e)))?;

    // Parse FindOptions from JSON
    let mut options = FindOptions::default();

    if let Some(obj) = opts_json.as_object() {
        // limit
        if let Some(limit) = obj.get("limit").and_then(|v| v.as_u64()) {
            options.limit = Some(limit as usize);
        }
        // skip
        if let Some(skip) = obj.get("skip").and_then(|v| v.as_u64()) {
            options.skip = skip as usize;
        }
        // sort: { field: 1 | -1 }
        if let Some(sort_obj) = obj.get("sort").and_then(|v| v.as_object()) {
            let sort: Vec<(String, i32)> = sort_obj
                .iter()
                .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(1) as i32))
                .collect();
            options.sort = Some(sort);
        }
        // projection: { field: 1 | 0 }
        if let Some(proj_obj) = obj.get("projection").and_then(|v| v.as_object()) {
            let proj: HashMap<String, i32> = proj_obj
                .iter()
                .map(|(k, v)| (k.clone(), v.as_i64().unwrap_or(1) as i32))
                .collect();
            options.projection = Some(proj);
        }
    }

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.find(&collection, &filter_json, Some(options))
    })?;

    let result_str = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

/// Find a single document.
///
/// JS signature: `findOne(handle, collection, filterJson): string` (JSON doc | null)
pub fn ovn_find_one(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;

    let result = with_engine(&mut cx, handle_idx, |engine| {
        engine.find_one(&collection, &filter_json)
    })?;

    let result_str = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
    Ok(cx.string(result_str))
}

/// Count documents matching a filter.
///
/// JS signature: `count(handle, collection, filterJson): number`
pub fn ovn_count(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.find(&collection, &filter_json, Some(FindOptions::default()))
    })?;

    Ok(cx.number(results.len() as f64))
}

/// Update a single matching document.
///
/// JS signature: `update(handle, collection, filterJson, updateJson): number`
pub fn ovn_update(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);
    let update_str = cx.argument::<JsString>(3)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid filter JSON: {}", e)))?;
    let update_json: serde_json::Value = serde_json::from_str(&update_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid update JSON: {}", e)))?;

    let mut options = ovn_core::engine::WriteOptions::default();

    if let Some(lsid_arg) = cx.argument_opt(4) {
        if let Ok(lsid_str) = lsid_arg.downcast::<JsString, _>(&mut cx) {
            let parsed = uuid::Uuid::parse_str(&lsid_str.value(&mut cx)).ok();
            if let Some(u) = parsed {
                options.lsid = Some(*u.as_bytes());
            }
        }
    }

    if let Some(txn_arg) = cx.argument_opt(5) {
        if let Ok(txn_num) = txn_arg.downcast::<JsNumber, _>(&mut cx) {
            options.txn_number = Some(txn_num.value(&mut cx) as u64);
        }
    }

    let count = with_engine(&mut cx, handle_idx, |engine| {
        engine.update_with_options(&collection, &filter_json, &update_json, options)
    })?;

    Ok(cx.number(count as f64))
}

/// Update all matching documents.
///
/// JS signature: `updateMany(handle, collection, filterJson, updateJson): number`
pub fn ovn_update_many(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);
    let update_str = cx.argument::<JsString>(3)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;
    let update_json: serde_json::Value = serde_json::from_str(&update_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON update: {}", e)))?;

    let count = with_engine(&mut cx, handle_idx, |engine| {
        engine.update_many(&collection, &filter_json, &update_json)
    })?;

    Ok(cx.number(count as f64))
}

/// Delete a single matching document.
///
/// JS signature: `delete(handle, collection, filterJson): number`
pub fn ovn_delete(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;

    let count = with_engine(&mut cx, handle_idx, |engine| {
        engine.delete(&collection, &filter_json)
    })?;

    Ok(cx.number(count as f64))
}

/// Delete all matching documents.
///
/// JS signature: `deleteMany(handle, collection, filterJson): number`
pub fn ovn_delete_many(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON filter: {}", e)))?;

    let count = with_engine(&mut cx, handle_idx, |engine| {
        engine.delete_many(&collection, &filter_json)
    })?;

    Ok(cx.number(count as f64))
}
