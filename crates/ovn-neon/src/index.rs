use neon::prelude::*;

use crate::with_engine;

/// Create a secondary index. Returns the index name.
///
/// JS signature: `createIndex(handle, collection, fieldsJson, optionsJson?): string`
pub fn ovn_create_index(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let fields_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let fields_json: serde_json::Value = serde_json::from_str(&fields_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON: {}", e)))?;

    // Parse options if provided
    let options: Option<serde_json::Value> = if let Some(opts_arg) = cx.argument_opt(3) {
        if let Ok(opts_str) = opts_arg.downcast::<JsString, _>(&mut cx) {
            serde_json::from_str(&opts_str.value(&mut cx)).ok()
        } else {
            None
        }
    } else {
        None
    };

    let name = with_engine(&mut cx, handle_idx, |engine| {
        engine.create_index(&collection, &fields_json, options.as_ref())
    })?;

    Ok(cx.string(name))
}

/// Drop an index by name.
///
/// JS signature: `dropIndex(handle, collection, indexName): void`
pub fn ovn_drop_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
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
pub fn ovn_list_indexes(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);

    let indexes = with_engine(&mut cx, handle_idx, |engine| {
        Ok(engine.list_indexes(&collection))
    })?;

    let result_str = serde_json::to_string(&indexes).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}

/// Create a geospatial index on a field.
///
/// JS signature: `createGeoIndex(handle, collection, field): void`
pub fn ovn_create_geo_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let field = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_geo_index(&collection, &field)
    })?;

    Ok(cx.undefined())
}

/// Create a Vector Index on a specific field.
///
/// JS signature: `createVectorIndex(handle: number, collection: string, field: string): void`
pub fn ovn_create_vector_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
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
pub fn ovn_vector_search(mut cx: FunctionContext) -> JsResult<JsString> {
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

/// Hide an index from the query planner.
///
/// JS signature: `hideIndex(handle: number, collection: string, indexName: string): void`
pub fn ovn_hide_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let index_name = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.hide_index(&collection, &index_name)
    })?;

    Ok(cx.undefined())
}

/// Unhide an index — make it available to the query planner.
///
/// JS signature: `unhideIndex(handle: number, collection: string, indexName: string): void`
pub fn ovn_unhide_index(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let index_name = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.unhide_index(&collection, &index_name)
    })?;

    Ok(cx.undefined())
}
