use neon::prelude::*;
use neon::types::buffer::TypedArray;

use crate::with_engine;

/// Store a binary blob.
///
/// JS signature: `putBlob(handle: number, data: Buffer): string`
pub fn ovn_put_blob(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let buffer = cx.argument::<JsBuffer>(1)?;
    let data = buffer.as_slice(&cx).to_vec();

    let id = with_engine(&mut cx, handle_idx, |engine| engine.put_blob(&data))?;
    Ok(cx.string(id))
}

/// Retrieve a binary blob.
///
/// JS signature: `getBlob(handle: number, blobId: string): Buffer | null`
pub fn ovn_get_blob(mut cx: FunctionContext) -> JsResult<JsValue> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let blob_id = cx.argument::<JsString>(1)?.value(&mut cx);

    let data_opt = with_engine(&mut cx, handle_idx, |engine| engine.get_blob(&blob_id))?;

    match data_opt {
        Some(data) => {
            let mut buffer = cx.buffer(data.len())?;
            let buf_slice = buffer.as_mut_slice(&mut cx);
            buf_slice.copy_from_slice(&data);
            Ok(buffer.upcast())
        }
        None => Ok(cx.null().upcast()),
    }
}
