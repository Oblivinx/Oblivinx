//! Neon bindings for the Versioned Document System.
//!
//! Exposes versioning operations (get_version, list_versions, diff_versions,
//! rollback_to_version, enable_versioning, tag_version) to JavaScript.

use neon::prelude::*;

use crate::with_engine;

// ─── ovn_enable_versioning ────────────────────────────────────────────────────

/// Enable versioning for a collection.
///
/// JS signature:
/// ```js
/// enableVersioning(handle: number, collection: string, configJson?: string): void
/// ```
pub fn ovn_enable_versioning(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let config_json: Option<String> = cx
        .argument_opt(2)
        .and_then(|v| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|s| s.value(&mut cx));

    let config_value: Option<serde_json::Value> = config_json
        .as_deref()
        .and_then(|s| serde_json::from_str(s).ok());

    with_engine(&mut cx, handle_idx, |engine| {
        engine.enable_versioning(&collection, config_value.as_ref())
    })?;

    Ok(cx.undefined())
}

// ─── ovn_disable_versioning ───────────────────────────────────────────────────

/// Disable versioning for a collection.
///
/// JS signature:
/// ```js
/// disableVersioning(handle: number, collection: string): void
/// ```
pub fn ovn_disable_versioning(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.disable_versioning(&collection)
    })?;

    Ok(cx.undefined())
}

// ─── ovn_get_document_version ─────────────────────────────────────────────────

/// Get a specific version of a document.
///
/// JS signature:
/// ```js
/// getDocumentVersion(handle: number, collection: string, docId: string, version: number): string
/// // Returns JSON of the versioned document (with __version, __versionedAt) or "null"
/// ```
pub fn ovn_get_document_version(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_id = cx.argument::<JsString>(2)?.value(&mut cx);
    let version = cx.argument::<JsNumber>(3)?.value(&mut cx) as u64;

    let result = with_engine(&mut cx, handle_idx, |engine| {
        engine.get_document_version(&collection, &doc_id, version)
    })?;

    let json = match result {
        Some(doc) => serde_json::to_string(&doc).unwrap_or_else(|_| "null".to_string()),
        None => "null".to_string(),
    };

    Ok(cx.string(json))
}

// ─── ovn_list_document_versions ──────────────────────────────────────────────

/// List all versions of a document.
///
/// JS signature:
/// ```js
/// listDocumentVersions(handle: number, collection: string, docId: string): string
/// // Returns JSON of VersionInfo[]
/// ```
pub fn ovn_list_document_versions(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_id = cx.argument::<JsString>(2)?.value(&mut cx);

    let versions = with_engine(&mut cx, handle_idx, |engine| {
        engine.list_document_versions(&collection, &doc_id)
    })?;

    let json = serde_json::to_string(&versions).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}

// ─── ovn_diff_document_versions ──────────────────────────────────────────────

/// Compute diff between two versions of a document.
///
/// JS signature:
/// ```js
/// diffDocumentVersions(handle: number, collection: string, docId: string, v1: number, v2: number): string
/// // Returns JSON of VersionDiff: { fromVersion, toVersion, added, modified, removed }
/// ```
pub fn ovn_diff_document_versions(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_id = cx.argument::<JsString>(2)?.value(&mut cx);
    let v1 = cx.argument::<JsNumber>(3)?.value(&mut cx) as u64;
    let v2 = cx.argument::<JsNumber>(4)?.value(&mut cx) as u64;

    let diff = with_engine(&mut cx, handle_idx, |engine| {
        engine.diff_document_versions(&collection, &doc_id, v1, v2)
    })?;

    // Serialize the VersionDiff. modified values are (from, to) tuples;
    // we convert to { from, to } objects for JS consumption.
    let json = serde_json::json!({
        "fromVersion": diff.from_version,
        "toVersion": diff.to_version,
        "added": diff.added,
        "modified": diff.modified.iter().map(|(k, (from, to))| {
            (k.clone(), serde_json::json!({ "from": from, "to": to }))
        }).collect::<serde_json::Map<String, serde_json::Value>>(),
        "removed": diff.removed,
    });

    Ok(cx.string(serde_json::to_string(&json).unwrap_or_else(|_| "{}".to_string())))
}

// ─── ovn_rollback_to_version ──────────────────────────────────────────────────

/// Rollback document to a specific version (creates a new version with old content).
///
/// JS signature:
/// ```js
/// rollbackToVersion(handle: number, collection: string, docId: string, version: number, author?: string): string
/// // Returns JSON of the restored document
/// ```
pub fn ovn_rollback_to_version(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_id = cx.argument::<JsString>(2)?.value(&mut cx);
    let version = cx.argument::<JsNumber>(3)?.value(&mut cx) as u64;
    let author: Option<String> = cx
        .argument_opt(4)
        .and_then(|v| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|s| s.value(&mut cx));

    let result = with_engine(&mut cx, handle_idx, |engine| {
        engine.rollback_to_version(&collection, &doc_id, version, author.clone())
    })?;

    let json = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
    Ok(cx.string(json))
}

// ─── ovn_tag_document_version ─────────────────────────────────────────────────

/// Assign a named tag to a specific document version.
///
/// JS signature:
/// ```js
/// tagDocumentVersion(handle: number, collection: string, docId: string, version: number, tag: string): void
/// ```
pub fn ovn_tag_document_version(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_id = cx.argument::<JsString>(2)?.value(&mut cx);
    let version = cx.argument::<JsNumber>(3)?.value(&mut cx) as u64;
    let tag = cx.argument::<JsString>(4)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.tag_document_version(&collection, &doc_id, version, &tag)
    })?;

    Ok(cx.undefined())
}

// ─── ovn_restore_from_tag ─────────────────────────────────────────────────────

/// Restore a document from a named tag.
///
/// JS signature:
/// ```js
/// restoreFromTag(handle: number, collection: string, docId: string, tag: string, author?: string): string
/// // Returns JSON of the restored document
/// ```
pub fn ovn_restore_from_tag(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let doc_id = cx.argument::<JsString>(2)?.value(&mut cx);
    let tag = cx.argument::<JsString>(3)?.value(&mut cx);
    let author: Option<String> = cx
        .argument_opt(4)
        .and_then(|v| v.downcast::<JsString, _>(&mut cx).ok())
        .map(|s| s.value(&mut cx));

    let result = with_engine(&mut cx, handle_idx, |engine| {
        engine.restore_from_tag(&collection, &doc_id, &tag, author.clone())
    })?;

    let json = serde_json::to_string(&result).unwrap_or_else(|_| "null".to_string());
    Ok(cx.string(json))
}
