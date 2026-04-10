use neon::prelude::*;

use crate::with_engine;

/// Create a collection.
///
/// JS signature: `createCollection(handle: number, name: string, optionsJson?: string): void`
pub fn ovn_create_collection(mut cx: FunctionContext) -> JsResult<JsUndefined> {
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
pub fn ovn_drop_collection(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    with_engine(&mut cx, handle_idx, |engine| engine.drop_collection(&name))?;
    Ok(cx.undefined())
}

/// List all collection names as a JSON array.
///
/// JS signature: `listCollections(handle: number): string` (JSON string[])
pub fn ovn_list_collections(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let names = with_engine(&mut cx, handle_idx, |engine| Ok(engine.list_collections()))?;
    let json = serde_json::to_string(&names).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}
