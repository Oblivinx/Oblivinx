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
use ovn_core::engine::OvnEngine;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};

// ── Submodules ──────────────────────────────────────────────

mod aggregation;
mod attach;
mod blob;
mod collections;
mod crud;
mod explain;
mod index;
mod lifecycle;
mod metrics;
mod pragma;
mod relations;
mod triggers;
mod txn;
mod views;
mod watch;

// ── Shared Infrastructure ───────────────────────────────────

/// Thread-safe database handle stored per JS thread
pub(crate) type DbHandle = Arc<Mutex<OvnEngine>>;

thread_local! {
    pub(crate) static DATABASES: RefCell<Vec<Option<DbHandle>>> = const { RefCell::new(Vec::new()) };
}

/// Execute a closure with the engine pointed to by handle_idx.
/// Throws a JS error if the handle is invalid or the lock is poisoned.
pub(crate) fn with_engine<F, R>(cx: &mut FunctionContext, handle_idx: usize, f: F) -> NeonResult<R>
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

// ── Advanced Feature Helpers (not large enough for their own module) ──

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

// ── Module Registration ─────────────────────────────────────

#[neon::main]
fn main(mut cx: ModuleContext) -> NeonResult<()> {
    // Lifecycle
    cx.export_function("open", lifecycle::ovn_open)?;
    cx.export_function("close", lifecycle::ovn_close)?;
    cx.export_function("checkpoint", lifecycle::ovn_checkpoint)?;
    cx.export_function("getVersion", lifecycle::ovn_get_version)?;

    // Collections
    cx.export_function("createCollection", collections::ovn_create_collection)?;
    cx.export_function("dropCollection", collections::ovn_drop_collection)?;
    cx.export_function("listCollections", collections::ovn_list_collections)?;

    // CRUD
    cx.export_function("insert", crud::ovn_insert)?;
    cx.export_function("insertMany", crud::ovn_insert_many)?;
    cx.export_function("find", crud::ovn_find)?;
    cx.export_function("findWithOptions", crud::ovn_find_with_options)?;
    cx.export_function("findOne", crud::ovn_find_one)?;
    cx.export_function("count", crud::ovn_count)?;
    cx.export_function("update", crud::ovn_update)?;
    cx.export_function("updateMany", crud::ovn_update_many)?;
    cx.export_function("delete", crud::ovn_delete)?;
    cx.export_function("deleteMany", crud::ovn_delete_many)?;

    // Aggregation
    cx.export_function("aggregate", aggregation::ovn_aggregate)?;

    // Indexes
    cx.export_function("createIndex", index::ovn_create_index)?;
    cx.export_function("dropIndex", index::ovn_drop_index)?;
    cx.export_function("listIndexes", index::ovn_list_indexes)?;
    cx.export_function("hideIndex", index::ovn_hide_index)?;
    cx.export_function("unhideIndex", index::ovn_unhide_index)?;
    cx.export_function("createGeoIndex", index::ovn_create_geo_index)?;
    cx.export_function("createVectorIndex", index::ovn_create_vector_index)?;
    cx.export_function("vectorSearch", index::ovn_vector_search)?;

    // Blob Storage
    cx.export_function("putBlob", blob::ovn_put_blob)?;
    cx.export_function("getBlob", blob::ovn_get_blob)?;

    // Transactions
    cx.export_function("beginTransaction", txn::ovn_begin_transaction)?;
    cx.export_function("commitTransaction", txn::ovn_commit_transaction)?;
    cx.export_function("abortTransaction", txn::ovn_abort_transaction)?;
    cx.export_function("savepoint", txn::ovn_savepoint)?;
    cx.export_function("rollbackToSavepoint", txn::ovn_rollback_to_savepoint)?;
    cx.export_function("releaseSavepoint", txn::ovn_release_savepoint)?;

    // Views
    cx.export_function("createView", views::ovn_create_view)?;
    cx.export_function("dropView", views::ovn_drop_view)?;
    cx.export_function("listViews", views::ovn_list_views)?;
    cx.export_function("refreshView", views::ovn_refresh_view)?;

    // Relations
    cx.export_function("defineRelation", relations::ovn_define_relation)?;
    cx.export_function("dropRelation", relations::ovn_drop_relation)?;
    cx.export_function("listRelations", relations::ovn_list_relations)?;
    cx.export_function(
        "setReferentialIntegrity",
        relations::ovn_set_referential_integrity,
    )?;

    // Triggers
    cx.export_function("createTrigger", triggers::ovn_create_trigger)?;
    cx.export_function("dropTrigger", triggers::ovn_drop_trigger)?;
    cx.export_function("listTriggers", triggers::ovn_list_triggers)?;

    // Pragmas
    cx.export_function("setPragma", pragma::ovn_set_pragma)?;
    cx.export_function("getPragma", pragma::ovn_get_pragma)?;

    // Attached Databases
    cx.export_function("attach", attach::ovn_attach)?;
    cx.export_function("detach", attach::ovn_detach)?;
    cx.export_function("listAttached", attach::ovn_list_attached)?;

    // Explain & Query Diagnostics
    cx.export_function("explain", explain::ovn_explain)?;
    cx.export_function("explainAggregate", explain::ovn_explain_aggregate)?;

    // Metrics
    cx.export_function("getMetrics", metrics::ovn_get_metrics)?;

    // Real-Time Events
    cx.export_function("watch", watch::ovn_watch)?;

    // Advanced Features
    cx.export_function("autocomplete", ovn_autocomplete)?;
    cx.export_function("export", ovn_export)?;
    cx.export_function("backup", ovn_backup)?;

    Ok(())
}
