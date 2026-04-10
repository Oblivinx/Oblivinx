use neon::prelude::*;

use crate::with_engine;

/// Execute an aggregation pipeline.
///
/// JS signature: `aggregate(handle, collection, pipelineJson): string` (JSON doc[])
pub fn ovn_aggregate(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let pipeline_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let pipeline_json: Vec<serde_json::Value> = serde_json::from_str(&pipeline_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid JSON pipeline: {}", e)))?;

    let results = with_engine(&mut cx, handle_idx, |engine| {
        engine.aggregate(&collection, &pipeline_json)
    })?;

    let result_str = serde_json::to_string(&results).unwrap_or_else(|_| "[]".to_string());
    Ok(cx.string(result_str))
}
