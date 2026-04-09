//! Oblivinx3x Node.js Native Addon via Neon.
//!
//! This crate provides JavaScript bindings for the Oblivinx3x storage engine
//! using the Neon framework. All operations are exposed as synchronous functions
//! that can be called from Node.js via the ESM wrapper.
//!
//! ## Architecture
//! The JS wrapper (`packages/oblivinx3x/src/index.js`) uses `worker_threads`
//! or simply calls these sync functions — since Neon v1 runs the Rust code
//! synchronously on the Node.js thread.
//!
//! ## Handle System
//! Each open database gets an integer handle (index into DATABASES vec).
//! The handle is passed as the first argument to every function.

use neon::prelude::*;
use neon::types::buffer::TypedArray;
use ovn_core::engine::config::OvnConfig;
use ovn_core::engine::FindOptions;
use ovn_core::engine::OvnEngine;
use ovn_core::engine::WriteOptions;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

// Thread-safe database handle stored per JS thread
type DbHandle = Arc<Mutex<OvnEngine>>;

thread_local! {
    static DATABASES: RefCell<Vec<Option<DbHandle>>> = const { RefCell::new(Vec::new()) };
}

// ── Database Lifecycle ──────────────────────────────────────

/// Open or create a database. Returns an integer handle.
///
/// JS signature: `open(path: string, options?: object): number`
fn ovn_open(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let path = cx.argument::<JsString>(0)?.value(&mut cx);

    let config_arg = cx.argument_opt(1);
    let mut config = OvnConfig::default();

    if let Some(cfg_val) = config_arg {
        if let Ok(cfg_obj) = cfg_val.downcast::<JsObject, _>(&mut cx) {
            // pageSize
            if let Ok(ps) = cfg_obj.get::<JsNumber, _, _>(&mut cx, "pageSize") {
                let v = ps.value(&mut cx) as u32;
                if (512..=65536).contains(&v) {
                    config.page_size = v;
                }
            }
            // bufferPool: "128MB" | "256MB" | bytes as number
            if let Ok(bp) = cfg_obj.get::<JsString, _, _>(&mut cx, "bufferPool") {
                let bp_str = bp.value(&mut cx);
                if let Some(mb) = bp_str.strip_suffix("MB") {
                    if let Ok(n) = mb.trim().parse::<usize>() {
                        config.buffer_pool_size = n * 1024 * 1024;
                    }
                } else if let Some(gb) = bp_str.strip_suffix("GB") {
                    if let Ok(n) = gb.trim().parse::<usize>() {
                        config.buffer_pool_size = n * 1024 * 1024 * 1024;
                    }
                }
            }
            // readOnly
            if let Ok(ro) = cfg_obj.get::<JsBoolean, _, _>(&mut cx, "readOnly") {
                config.read_only = ro.value(&mut cx);
            }
            // walMode (ignored at config level — WAL always on, but accept for compat)
            // compression: "none" | "lz4" | "zstd"
            if let Ok(comp) = cfg_obj.get::<JsString, _, _>(&mut cx, "compression") {
                let comp_str = comp.value(&mut cx);
                config.compression = match comp_str.to_lowercase().as_str() {
                    "lz4" => ovn_core::compression::CompressionType::Lz4,
                    "zstd" => ovn_core::compression::CompressionType::Zstd,
                    _ => ovn_core::compression::CompressionType::None,
                };
            }
        }
    }

    let engine = OvnEngine::open(&path, config)
        .or_else(|e| cx.throw_error(format!("OvnError: Failed to open '{}': {}", path, e)))?;

    let handle: DbHandle = Arc::new(Mutex::new(engine));

    let index = DATABASES.with(|dbs| {
        let mut dbs = dbs.borrow_mut();
        // Reuse freed slots
        for (i, slot) in dbs.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(handle.clone());
                return i;
            }
        }
        let idx = dbs.len();
        dbs.push(Some(handle));
        idx
    });

    Ok(cx.number(index as f64))
}

/// Close a database and free its handle slot.
///
/// JS signature: `close(handle: number): void`
fn ovn_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    DATABASES.with(|dbs| {
        let mut dbs = dbs.borrow_mut();
        if let Some(slot) = dbs.get_mut(handle_idx) {
            if let Some(db) = slot.take() {
                if let Ok(engine) = db.lock() {
                    engine.close().ok();
                }
            }
        }
    });

    Ok(cx.undefined())
}

/// Force a checkpoint.
///
/// JS signature: `checkpoint(handle: number): void`
fn ovn_checkpoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    with_engine(&mut cx, handle_idx, |engine| engine.checkpoint())?;
    Ok(cx.undefined())
}

/// Get engine/library version info.
///
/// JS signature: `getVersion(): string`
fn ovn_get_version(mut cx: FunctionContext) -> JsResult<JsString> {
    let version = serde_json::json!({
        "engine": "Oblivinx3x",
        "version": "0.1.0",
        "format": "OVN/1.0",
        "neon": "1.x",
        "features": ["mvcc", "wal", "lz4", "zstd", "ahit", "fulltext", "geospatial", "vector", "lookup", "autocomplete"]
    });
    Ok(cx.string(version.to_string()))
}

// ── Collection Management ───────────────────────────────────

/// Create a collection.
///
/// JS signature: `createCollection(handle: number, name: string, optionsJson?: string): void`
fn ovn_create_collection(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    let mut options_json: Option<serde_json::Value> = None;

    if let Some(opts_arg) = cx.argument_opt(2) {
        if let Ok(opts_str) = opts_arg.downcast::<JsString, _>(&mut cx) {
            if let Ok(json) = serde_json::from_str(&opts_str.value(&mut cx)) {
                options_json = Some(json);
            }
        }
    }

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_collection(&name, options_json.as_ref())
    })?;
    Ok(cx.undefined())
}

/// Drop a collection.
///
/// JS signature: `dropCollection(handle: number, name: string): void`
fn ovn_drop_collection(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    with_engine(&mut cx, handle_idx, |engine| engine.drop_collection(&name))?;
    Ok(cx.undefined())
}

/// List all collection names as a JSON array.
///
/// JS signature: `listCollections(handle: number): string` (JSON string[])
fn ovn_list_collections(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let names = with_engine(&mut cx, handle_idx, |engine| Ok(engine.list_collections()))?;
    let json = serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}

// ── Document CRUD ───────────────────────────────────────────

/// Insert a single document.
///
/// JS signature: `insert(handle: number, collection: string, docJson: string, lsid?: string, txn_number?: number): string`
fn ovn_insert(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let doc_json: serde_json::Value = serde_json::from_str(&doc_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON document: {}", e)))?;

    let mut options = WriteOptions::default();

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
fn ovn_insert_many(mut cx: FunctionContext) -> JsResult<JsString> {
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
fn ovn_find(mut cx: FunctionContext) -> JsResult<JsString> {
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
fn ovn_find_with_options(mut cx: FunctionContext) -> JsResult<JsString> {
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
fn ovn_find_one(mut cx: FunctionContext) -> JsResult<JsString> {
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
fn ovn_count(mut cx: FunctionContext) -> JsResult<JsNumber> {
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
fn ovn_update(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);
    let update_str = cx.argument::<JsString>(3)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid filter JSON: {}", e)))?;
    let update_json: serde_json::Value = serde_json::from_str(&update_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid update JSON: {}", e)))?;

    let mut options = WriteOptions::default();

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
fn ovn_update_many(mut cx: FunctionContext) -> JsResult<JsNumber> {
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
fn ovn_delete(mut cx: FunctionContext) -> JsResult<JsNumber> {
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
fn ovn_delete_many(mut cx: FunctionContext) -> JsResult<JsNumber> {
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

// ── Blob Management ─────────────────────────────────────────

/// Store a binary blob.
///
/// JS signature: `putBlob(handle: number, data: Buffer): string`
fn ovn_put_blob(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let buffer = cx.argument::<JsBuffer>(1)?;
    let data = buffer.as_slice(&cx).to_vec();

    let id = with_engine(&mut cx, handle_idx, |engine| engine.put_blob(&data))?;
    Ok(cx.string(id))
}

/// Retrieve a binary blob.
///
/// JS signature: `getBlob(handle: number, blobId: string): Buffer | null`
fn ovn_get_blob(mut cx: FunctionContext) -> JsResult<JsValue> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let blob_id = cx.argument::<JsString>(1)?.value(&mut cx);

    let data_opt = with_engine(&mut cx, handle_idx, |engine| engine.get_blob(&blob_id))?;

    match data_opt {
        Some(data) => {
            let mut buffer = cx.buffer(data.len())?;
            let buf_slice = buffer.as_mut_slice(&mut cx);
            buf_slice.copy_from_slice(&data);
            Ok(buffer.upcast())
        }
        None => Ok(cx.null().upcast()),
    }
}

// ── Aggregation ─────────────────────────────────────────────

/// Execute an aggregation pipeline.
///
/// JS signature: `aggregate(handle, collection, pipelineJson): string` (JSON doc[])
fn ovn_aggregate(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let pipeline_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let pipeline_json: Vec<serde_json::Value> = serde_json::from_str(&pipeline_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON pipeline: {}", e)))?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.aggregate(&collection, &pipeline_json)
    })?;

    let result_str = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

// ── Indexing ────────────────────────────────────────────────

/// Create a secondary index. Returns the index name.
///
/// JS signature: `createIndex(handle, collection, fieldsJson): string`
fn ovn_create_index(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let fields_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let fields_json: serde_json::Value = serde_json::from_str(&fields_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON: {}", e)))?;

    let name = with_engine(&mut cx, handle_idx, |engine| {
        engine.create_index(&collection, &fields_json)
    })?;

    Ok(cx.string(name))
}

/// Drop an index by name.
///
/// JS signature: `dropIndex(handle, collection, indexName): void`
fn ovn_drop_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let index_name = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.drop_index(&collection, &index_name)
    })?;

    Ok(cx.undefined())
}

/// List indexes for a collection.
///
/// JS signature: `listIndexes(handle, collection): string` (JSON index[])
fn ovn_list_indexes(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);

    let indexes = with_engine(&mut cx, handle_idx, |engine| {
        Ok(engine.list_indexes(&collection))
    })?;

    let result_str = serde_json::to_string(&indexes).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

// ── Transactions ────────────────────────────────────────────

/// Begin a transaction. Returns transaction ID as a string (u64 → string to avoid precision loss).
///
/// JS signature: `beginTransaction(handle): string`
fn ovn_begin_transaction(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txn = with_engine(&mut cx, handle_idx, |engine| engine.begin_transaction())?;
    Ok(cx.string(txn.txid.to_string()))
}

/// Commit a transaction.
///
/// JS signature: `commitTransaction(handle, txidStr): void`
fn ovn_commit_transaction(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);

    let txid: u64 = txid_str
        .parse()
        .or_else(|_| cx.throw_error("OvnError: Invalid transaction ID"))?;

    with_engine(&mut cx, handle_idx, |engine| {
        engine.commit_transaction(txid)
    })?;
    Ok(cx.undefined())
}

/// Abort (rollback) a transaction.
///
/// JS signature: `abortTransaction(handle, txidStr): void`
fn ovn_abort_transaction(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);

    let txid: u64 = txid_str
        .parse()
        .or_else(|_| cx.throw_error("OvnError: Invalid transaction ID"))?;

    DATABASES.with(|dbs| {
        let dbs = dbs.borrow();
        if let Some(Some(db)) = dbs.get(handle_idx) {
            if let Ok(engine) = db.lock() {
                engine.abort_transaction(txid);
            }
        }
    });

    Ok(cx.undefined())
}

// ── Metrics & Observability ─────────────────────────────────

/// Get comprehensive database metrics.
///
/// JS signature: `getMetrics(handle): string` (JSON object)
fn ovn_get_metrics(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let metrics = with_engine(&mut cx, handle_idx, |engine| Ok(engine.get_metrics()))?;

    let result_str = serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".to_string());
    Ok(cx.string(result_str))
}

// ── Advanced Features ───────────────────────────────────────

/// Autocomplete / prefix search on a field.
///
/// JS signature: `autocomplete(handle, collection, field, prefix, limit): string` (JSON doc[])
fn ovn_autocomplete(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let field = cx.argument::<JsString>(2)?.value(&mut cx);
    let prefix = cx.argument::<JsString>(3)?.value(&mut cx);
    let limit = cx.argument::<JsNumber>(4)?.value(&mut cx) as usize;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.autocomplete(&collection, &field, &prefix, limit)
    })?;

    let json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}

/// Export database as JSON.
///
/// JS signature: `export(handle): string` (JSON object with collections)
fn ovn_export(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let data = with_engine(&mut cx, handle_idx, |engine| engine.export())?;

    let json = serde_json::to_string(&data).unwrap_or_else(|_| "{}".to_string());
    Ok(cx.string(json))
}

/// Backup database to a file path.
///
/// JS signature: `backup(handle, destPath): void`
fn ovn_backup(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let dest_path = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| engine.backup(&dest_path))?;
    Ok(cx.undefined())
}

/// Create a geospatial index on a field.
///
/// JS signature: `createGeoIndex(handle, collection, field): void`
fn ovn_create_geo_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let field = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_geo_index(&collection, &field)
    })?;

    Ok(cx.undefined())
}

// ── Helper ──────────────────────────────────────────────────

/// Execute a closure with the engine pointed to by handle_idx.
/// Throws a JS error if the handle is invalid or the lock is poisoned.
fn with_engine<F, R>(cx: &mut FunctionContext, handle_idx: usize, f: F) -> NeonResult<R>
where
    F: FnOnce(&OvnEngine) -> Result<R, ovn_core::error::OvnError>,
{
    DATABASES.with(|dbs| {
        let dbs = dbs.borrow();
        let slot = dbs.get(handle_idx).ok_or_else(|| {
            cx.throw_error::<_, ()>(format!(
                "OvnError: Invalid database handle {}. Did you call open() first?",
                handle_idx
            ))
            .unwrap_err()
        })?;

        let db = slot.as_ref().ok_or_else(|| {
            cx.throw_error::<_, ()>(format!(
                "OvnError: Database handle {} has been closed.",
                handle_idx
            ))
            .unwrap_err()
        })?;

        let engine = db.lock().map_err(|e| {
            cx.throw_error::<_, ()>(format!("OvnError: Internal lock error: {}", e))
                .unwrap_err()
        })?;

        f(&engine).map_err(|e| cx.throw_error::<_, ()>(format!("{}", e)).unwrap_err())
    })
}

// ── Real-Time Change Streams ────────────────────────────────

/// Watch for change stream events across the database.
///
/// JS signature: `watch(handle: number, callback: (err: any, eventJson: string) => void): void`
fn ovn_watch(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let cb_root = cx.argument::<neon::types::JsFunction>(1)?.root(&mut cx);
    let callback = std::sync::Arc::new(cb_root);
    let channel = cx.channel();

    let rx = with_engine(&mut cx, handle_idx, |engine| {
        Ok(engine.change_stream.write().subscribe())
    })?;

    // Spawn a background thread to listen for events
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            // Serialize event manually or via serde_json if we derive Serialize
            // For now, let's manually build a simplistic JSON for the event
            let event_type = match event.op_type {
                ovn_core::mvcc::change_stream::OperationType::Insert => "insert",
                ovn_core::mvcc::change_stream::OperationType::Update => "update",
                ovn_core::mvcc::change_stream::OperationType::Replace => "replace",
                ovn_core::mvcc::change_stream::OperationType::Delete => "delete",
                ovn_core::mvcc::change_stream::OperationType::Invalidate => "invalidate",
            };
            
            let full_doc_json = match event.full_document {
                Some(doc) => doc.to_json().to_string(),
                None => "null".to_string(),
            };

            let json = format!(
                r#"{{"opType":"{}","clusterTime":{},"documentKey":{:?},"fullDocument":{},"namespace":"{}","resumeToken":{:?}}}"#,
                event_type, event.cluster_time, event.document_key, full_doc_json, event.namespace, event.resume_token
            );

            let callback_clone = std::sync::Arc::clone(&callback);
            channel.send(move |mut cx| {
                let callback = callback_clone.to_inner(&mut cx);
                let this = cx.undefined();
                let err = cx.null();
                let data = cx.string(json);
                let args = vec![err.upcast::<neon::types::JsValue>(), data.upcast::<neon::types::JsValue>()];
                callback.call(&mut cx, this, args)?;
                Ok(())
            });
        }
    });

    Ok(cx.undefined())
}

// ── Vector Search ───────────────────────────────────────────

/// Create a Vector Index on a specific field.
///
/// JS signature: `createVectorIndex(handle: number, collection: string, field: string): void`
fn ovn_create_vector_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let field = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_vector_index(&collection, &field)
    })?;

    Ok(cx.undefined())
}

/// Perform a Vector Search query.
///
/// JS signature: `vectorSearch(handle: number, collection: string, queryVectorJson: string, limit: number): string`
fn ovn_vector_search(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let vector_str = cx.argument::<JsString>(2)?.value(&mut cx);
    let limit = cx.argument::<JsNumber>(3)?.value(&mut cx) as usize;

    let query_vector: Vec<f32> = serde_json::from_str(&vector_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid query vector: {}", e)))?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.vector_search(&collection, &query_vector, limit)
    })?;

    let json = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}

// ── Module Registration ─────────────────────────────────────

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    // Lifecycle
    cx.export_function("open", ovn_open)?;
    cx.export_function("close", ovn_close)?;
    cx.export_function("checkpoint", ovn_checkpoint)?;
    cx.export_function("getVersion", ovn_get_version)?;

    // Collections
    cx.export_function("createCollection", ovn_create_collection)?;
    cx.export_function("dropCollection", ovn_drop_collection)?;
    cx.export_function("listCollections", ovn_list_collections)?;

    // CRUD
    cx.export_function("insert", ovn_insert)?;
    cx.export_function("insertMany", ovn_insert_many)?;
    cx.export_function("find", ovn_find)?;
    cx.export_function("findWithOptions", ovn_find_with_options)?;
    cx.export_function("findOne", ovn_find_one)?;
    cx.export_function("count", ovn_count)?;
    cx.export_function("update", ovn_update)?;
    cx.export_function("updateMany", ovn_update_many)?;
    cx.export_function("delete", ovn_delete)?;
    cx.export_function("deleteMany", ovn_delete_many)?;

    // Aggregation
    cx.export_function("aggregate", ovn_aggregate)?;

    // Indexes
    cx.export_function("createIndex", ovn_create_index)?;
    cx.export_function("dropIndex", ovn_drop_index)?;
    cx.export_function("listIndexes", ovn_list_indexes)?;

    // Geospatial Index
    cx.export_function("createGeoIndex", ovn_create_geo_index)?;

    // Vector Index
    cx.export_function("createVectorIndex", ovn_create_vector_index)?;
    cx.export_function("vectorSearch", ovn_vector_search)?;

    // Blob Storage
    cx.export_function("putBlob", ovn_put_blob)?;
    cx.export_function("getBlob", ovn_get_blob)?;

    // Transactions
    cx.export_function("beginTransaction", ovn_begin_transaction)?;
    cx.export_function("commitTransaction", ovn_commit_transaction)?;
    cx.export_function("abortTransaction", ovn_abort_transaction)?;

    // Metrics
    cx.export_function("getMetrics", ovn_get_metrics)?;

    // Real-Time Events
    cx.export_function("watch", ovn_watch)?;

    // Advanced Features
    cx.export_function("autocomplete", ovn_autocomplete)?;
    cx.export_function("export", ovn_export)?;
    cx.export_function("backup", ovn_backup)?;

    Ok(())
}