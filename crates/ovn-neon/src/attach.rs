use neon::prelude::*;

use crate::with_engine;

/// Attach an external .ovn database with an alias.
///
/// JS signature: `attach(handle: number, path: string, alias: string): void`
pub fn ovn_attach(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let path = cx.argument::<JsString>(1)?.value(&mut cx);
    let alias = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.attach_database(&path, &alias)
    })?;

    Ok(cx.undefined())
}

/// Detach an attached database.
///
/// JS signature: `detach(handle: number, alias: string): void`
pub fn ovn_detach(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let alias = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| engine.detach_database(&alias))?;

    Ok(cx.undefined())
}

/// List all attached databases.
///
/// JS signature: `listAttached(handle: number): string` (JSON array)
pub fn ovn_list_attached(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let attached = with_engine(&mut cx, handle_idx, |engine| engine.list_attached())?;

    let json = serde_json::to_string(&attached).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}
