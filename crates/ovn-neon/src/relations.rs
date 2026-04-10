use neon::prelude::*;

use crate::with_engine;

/// Define a relation between collections.
///
/// JS signature: `defineRelation(handle: number, relationJson: string): void`
pub fn ovn_define_relation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let rel_str = cx.argument::<JsString>(1)?.value(&mut cx);

    let relation: serde_json::Value = serde_json::from_str(&rel_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid relation definition: {}", e)))?;

    with_engine(&mut cx, handle_idx, |engine| {
        engine.define_relation(&relation)
    })?;

    Ok(cx.undefined())
}

/// Drop a relation definition.
///
/// JS signature: `dropRelation(handle: number, from: string, to: string): void`
pub fn ovn_drop_relation(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let from = cx.argument::<JsString>(1)?.value(&mut cx);
    let to = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.drop_relation(&from, &to)
    })?;

    Ok(cx.undefined())
}

/// List all relations.
///
/// JS signature: `listRelations(handle: number): string` (JSON array)
pub fn ovn_list_relations(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let relations = with_engine(&mut cx, handle_idx, |engine| engine.list_relations())?;

    let json = serde_json::to_string(&relations).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(json))
}

/// Set referential integrity mode.
///
/// JS signature: `setReferentialIntegrity(handle: number, mode: string): void`
pub fn ovn_set_referential_integrity(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let mode = cx.argument::<JsString>(1)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        engine.set_referential_integrity(&mode)
    })?;

    Ok(cx.undefined())
}
