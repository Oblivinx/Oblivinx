use neon::prelude::*;

use crate::with_engine;

/// Set a pragma value.
///
/// JS signature: `setPragma(handle: number, name: string, valueJson: string): void`
pub fn ovn_set_pragma(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);
    let value_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let value: serde_json::Value = serde_json::from_str(&value_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid pragma value: {}", e)))?;

    with_engine(&mut cx, handle_idx, |engine| {
        engine.set_pragma(&name, &value)
    })?;

    Ok(cx.undefined())
}

/// Get a pragma value.
///
/// JS signature: `getPragma(handle: number, name: string): string` (JSON)
pub fn ovn_get_pragma(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let name = cx.argument::<JsString>(1)?.value(&mut cx);

    let value = with_engine(&mut cx, handle_idx, |engine| engine.get_pragma(&name))?;

    let json = serde_json::to_string(&value).unwrap_or_else(|_| "null".to_string());
    Ok(cx.string(json))
}
