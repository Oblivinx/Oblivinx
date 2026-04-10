use neon::prelude::*;

use crate::with_engine;

/// Register a trigger on a collection.
///
/// JS signature: `createTrigger(handle: number, collection: string, event: string): void`
pub fn ovn_create_trigger(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let event = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.create_trigger(&collection, &event)
    })?;

    Ok(cx.undefined())
}

/// Drop a trigger.
///
/// JS signature: `dropTrigger(handle: number, collection: string, event: string): void`
pub fn ovn_drop_trigger(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let event = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.drop_trigger(&collection, &event)
    })?;

    Ok(cx.undefined())
}

/// List triggers on a collection.
///
/// JS signature: `listTriggers(handle: number, collection: string): string` (JSON array)
pub fn ovn_list_triggers(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);

    let triggers = with_engine(&mut cx, handle_idx, |engine| {
        engine.list_triggers(&collection)
    })?;

    let json = serde_json::to_string(&triggers).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}
