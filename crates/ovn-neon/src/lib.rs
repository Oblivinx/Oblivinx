//! Oblivinx3x Node.js Native Addon via Neon.
//!
//! This crate provides JavaScript bindings for the Oblivinx3x storage engine
//! using the Neon framework. All operations are exposed as synchronous functions
//! that can be called from Node.js.
//!
//! ## Usage from JavaScript
//! ```javascript
//! import ovn from 'oblivinx3x';
//! const db = ovn.open('data.ovn', {});
//! ```

use neon::prelude::*;
use ovn_core::engine::OvnEngine;
use ovn_core::engine::config::OvnConfig;
use std::sync::{Arc, Mutex};
use std::cell::RefCell;

// Thread-safe database handle stored in Neon's JsBox
type DbHandle = Arc<Mutex<OvnEngine>>;

// Store open databases in a thread-local for the JS context
thread_local! {
    static DATABASES: RefCell<Vec<DbHandle>> = RefCell::new(Vec::new());
}

/// Open a database — returns a handle index.
fn ovn_open(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let path = cx.argument::<JsString>(0)?.value(&mut cx);

    let config_arg = cx.argument_opt(1);
    let mut config = OvnConfig::default();

    if let Some(cfg_val) = config_arg {
        if let Ok(cfg_obj) = cfg_val.downcast::<JsObject, _>(&mut cx) {
            // Parse page size
            if let Ok(ps) = cfg_obj.get::<JsNumber, _, _>(&mut cx, "pageSize") {
                config.page_size = ps.value(&mut cx) as u32;
            }
            // Parse buffer pool
            if let Ok(bp) = cfg_obj.get::<JsString, _, _>(&mut cx, "bufferPool") {
                let bp_str = bp.value(&mut cx);
                if let Some(mb) = bp_str.strip_suffix("MB") {
                    if let Ok(n) = mb.parse::<usize>() {
                        config.buffer_pool_size = n * 1024 * 1024;
                    }
                }
            }
            // Parse read-only
            if let Ok(ro) = cfg_obj.get::<JsBoolean, _, _>(&mut cx, "readOnly") {
                config.read_only = ro.value(&mut cx);
            }
        }
    }

    let engine = OvnEngine::open(&path, config).or_else(|e| {
        cx.throw_error(format!("Failed to open database: {e}"))
    })?;

    let handle: DbHandle = Arc::new(Mutex::new(engine));

    let index = DATABASES.with(|dbs| {
        let mut dbs = dbs.borrow_mut();
        let idx = dbs.len();
        dbs.push(handle);
        idx
    });

    Ok(cx.number(index as f64))
}

/// Close a database.
fn ovn_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    DATABASES.with(|dbs| {
        let dbs = dbs.borrow();
        if let Some(db) = dbs.get(handle_idx) {
            let engine = db.lock().unwrap();
            engine.close().ok();
        }
    });

    Ok(cx.undefined())
}

/// Create a collection.
fn ovn_create_collection(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_collection(&name)
    })?;

    Ok(cx.undefined())
}

/// List collections.
fn ovn_list_collections(mut cx: FunctionContext) -> JsResult<JsArray> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let names = with_engine(&mut cx, handle_idx, |engine| {
        Ok(engine.list_collections())
    })?;

    let js_array = cx.empty_array();
    for (i, name) in names.iter().enumerate() {
        let js_str = cx.string(name);
        js_array.set(&mut cx, i as u32, js_str)?;
    }

    Ok(js_array)
}

/// Insert a document.
fn ovn_insert(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let doc_json: serde_json::Value = serde_json::from_str(&doc_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON: {e}"))
    })?;

    let id = with_engine(&mut cx, handle_idx, |engine| {
        engine.insert(&collection, &doc_json)
    })?;

    Ok(cx.string(id))
}

/// Insert many documents.
fn ovn_insert_many(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let docs_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let docs_json: Vec<serde_json::Value> = serde_json::from_str(&docs_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON: {e}"))
    })?;

    let ids = with_engine(&mut cx, handle_idx, |engine| {
        engine.insert_many(&collection, &docs_json)
    })?;

    let result = serde_json::to_string(&ids).unwrap_or_default();
    Ok(cx.string(result))
}

/// Find documents.
fn ovn_find(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON filter: {e}"))
    })?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.find(&collection, &filter_json, None)
    })?;

    let result_str = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

/// Find one document.
fn ovn_find_one(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON filter: {e}"))
    })?;

    let result = with_engine(&mut cx, handle_idx, |engine| {
        engine.find_one(&collection, &filter_json)
    })?;

    let result_str = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
    Ok(cx.string(result_str))
}

/// Update documents.
fn ovn_update(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);
    let update_str = cx.argument::<JsString>(3)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON filter: {e}"))
    })?;
    let update_json: serde_json::Value = serde_json::from_str(&update_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON update: {e}"))
    })?;

    let count = with_engine(&mut cx, handle_idx, |engine| {
        engine.update(&collection, &filter_json, &update_json)
    })?;

    Ok(cx.number(count as f64))
}

/// Delete documents.
fn ovn_delete(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter_json: serde_json::Value = serde_json::from_str(&filter_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON filter: {e}"))
    })?;

    let count = with_engine(&mut cx, handle_idx, |engine| {
        engine.delete(&collection, &filter_json)
    })?;

    Ok(cx.number(count as f64))
}

/// Aggregate pipeline.
fn ovn_aggregate(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let pipeline_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let pipeline_json: Vec<serde_json::Value> = serde_json::from_str(&pipeline_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON pipeline: {e}"))
    })?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.aggregate(&collection, &pipeline_json)
    })?;

    let result_str = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

/// Get metrics.
fn ovn_get_metrics(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let metrics = with_engine(&mut cx, handle_idx, |engine| {
        Ok(engine.get_metrics())
    })?;

    let result_str = serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".to_string());
    Ok(cx.string(result_str))
}

/// Create index.
fn ovn_create_index(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let fields_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let fields_json: serde_json::Value = serde_json::from_str(&fields_str).or_else(|e| {
        cx.throw_error(format!("Invalid JSON: {e}"))
    })?;

    let name = with_engine(&mut cx, handle_idx, |engine| {
        engine.create_index(&collection, &fields_json)
    })?;

    Ok(cx.string(name))
}

/// Checkpoint.
fn ovn_checkpoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    with_engine(&mut cx, handle_idx, |engine| {
        engine.checkpoint()
    })?;

    Ok(cx.undefined())
}

// ── Helper ─────────────────────────────────────────────────

fn with_engine<F, R>(cx: &mut FunctionContext, handle_idx: usize, f: F) -> NeonResult<R>
where
    F: FnOnce(&OvnEngine) -> Result<R, ovn_core::error::OvnError>,
{
    DATABASES.with(|dbs| {
        let dbs = dbs.borrow();
        let db = dbs.get(handle_idx).ok_or_else(|| {
            cx.throw_error::<_, ()>("Invalid database handle").unwrap_err()
        })?;
        let engine = db.lock().map_err(|e| {
            cx.throw_error::<_, ()>(format!("Lock error: {e}")).unwrap_err()
        })?;
        f(&engine).map_err(|e| {
            cx.throw_error::<_, ()>(format!("{e}")).unwrap_err()
        })
    })
}

// ── Module Registration ────────────────────────────────────

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    cx.export_function("open", ovn_open)?;
    cx.export_function("close", ovn_close)?;
    cx.export_function("createCollection", ovn_create_collection)?;
    cx.export_function("listCollections", ovn_list_collections)?;
    cx.export_function("insert", ovn_insert)?;
    cx.export_function("insertMany", ovn_insert_many)?;
    cx.export_function("find", ovn_find)?;
    cx.export_function("findOne", ovn_find_one)?;
    cx.export_function("update", ovn_update)?;
    cx.export_function("delete", ovn_delete)?;
    cx.export_function("aggregate", ovn_aggregate)?;
    cx.export_function("getMetrics", ovn_get_metrics)?;
    cx.export_function("createIndex", ovn_create_index)?;
    cx.export_function("checkpoint", ovn_checkpoint)?;
    Ok(())
}
