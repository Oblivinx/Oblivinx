use neon::prelude::*;

use crate::with_engine;

/// Get comprehensive database metrics.
///
/// JS signature: `getMetrics(handle): string` (JSON object)
pub fn ovn_get_metrics(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    let metrics = with_engine(&mut cx, handle_idx, |engine| Ok(engine.get_metrics()))?;

    let result_str = serde_json::to_string(&metrics).unwrap_or_else(|_| "{}".to_string());
    Ok(cx.string(result_str))
}
