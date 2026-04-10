use neon::prelude::*;

use crate::with_engine;

/// Explain a find query — return execution plan without executing.
///
/// JS signature: `explain(handle: number, collection: string, filterJson: string, optionsJson?: string): string`
pub fn ovn_explain(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let filter_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let filter: serde_json::Value = serde_json::from_str(&filter_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid filter: {}", e)))?;

    let options: Option<serde_json::Value> = if let Some(opts_arg) = cx.argument_opt(3) {
        if let Ok(opts_str) = opts_arg.downcast::<JsString, _>(&mut cx) {
            serde_json::from_str(&opts_str.value(&mut cx)).ok()
        } else {
            None
        }
    } else {
        None
    };

    let plan = with_engine(&mut cx, handle_idx, |engine| {
        engine.explain(&collection, &filter, options.as_ref())
    })?;

    let json = serde_json::to_string(&plan).unwrap_or_else(|_| "{}".to_string());
    Ok(cx.string(json))
}

/// Explain an aggregation pipeline.
///
/// JS signature: `explainAggregate(handle: number, collection: string, pipelineJson: string, optionsJson?: string): string`
pub fn ovn_explain_aggregate(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let collection = cx.argument::<JsString>(1)?.value(&mut cx);
    let pipeline_str = cx.argument::<JsString>(2)?.value(&mut cx);

    let pipeline: serde_json::Value = serde_json::from_str(&pipeline_str)
        .or_else(|e| cx.throw_error(format!("OvnError: Invalid pipeline: {}", e)))?;

    let options: Option<serde_json::Value> = if let Some(opts_arg) = cx.argument_opt(3) {
        if let Ok(opts_str) = opts_arg.downcast::<JsString, _>(&mut cx) {
            serde_json::from_str(&opts_str.value(&mut cx)).ok()
        } else {
            None
        }
    } else {
        None
    };

    let plan = with_engine(&mut cx, handle_idx, |engine| {
        engine.explain_aggregate(&collection, &pipeline, options.as_ref())
    })?;

    let json = serde_json::to_string(&plan).unwrap_or_else(|_| "{}".to_string());
    Ok(cx.string(json))
}
