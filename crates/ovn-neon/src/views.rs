use neon::prelude::*;

use crate::with_engine;

/// Create a view (logical or materialized).
///
/// JS signature: `createView(handle: number, name: string, definitionJson: string): void`
pub fn ovn_create_view(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    let def_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let definition: serde_json::Value = serde_json::from_str(&def_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid view definition: {}", e)))?;

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_view(&name, &definition)
    })?;

    Ok(cx.undefined())
}

/// Drop a view.
///
/// JS signature: `dropView(handle: number, name: string): void`
pub fn ovn_drop_view(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| engine.drop_view(&name))?;

    Ok(cx.undefined())
}

/// List all views.
///
/// JS signature: `listViews(handle: number): string` (JSON array)
pub fn ovn_list_views(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let views = with_engine(&mut cx, handle_idx, |engine| engine.list_views())?;

    let json = serde_json::to_string(&views).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}

/// Refresh a materialized view.
///
/// JS signature: `refreshView(handle: number, name: string): void`
pub fn ovn_refresh_view(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| engine.refresh_view(&name))?;

    Ok(cx.undefined())
}
