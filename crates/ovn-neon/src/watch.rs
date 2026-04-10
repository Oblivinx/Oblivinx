use neon::prelude::*;

use crate::with_engine;

/// Watch for change stream events across the database.
///
/// JS signature: `watch(handle: number, callback: (err: any, eventJson: string) => void): void`
pub fn ovn_watch(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let cb_root = cx.argument::<neon::types::JsFunction>(1)?.root(&mut cx);
    let callback = std::sync::Arc::new(cb_root);
    let channel = cx.channel();

    let rx = with_engine(&mut cx, handle_idx, |engine| {
        Ok(engine.change_stream.write().subscribe())
    })?;

    // Spawn a background thread to listen for events
    std::thread::spawn(move || {
        while let Ok(event) = rx.recv() {
            let event_type = match event.op_type {
                ovn_core::mvcc::change_stream::OperationType::Insert => "insert",
                ovn_core::mvcc::change_stream::OperationType::Update => "update",
                ovn_core::mvcc::change_stream::OperationType::Replace => "replace",
                ovn_core::mvcc::change_stream::OperationType::Delete => "delete",
                ovn_core::mvcc::change_stream::OperationType::Invalidate => "invalidate",
            };

            let full_doc_json = match event.full_document {
                Some(doc) => doc.to_json().to_string(),
                None => "null".to_string(),
            };

            let json = format!(
                r#"{{"opType":"{}","clusterTime":{},"documentKey":{:?},"fullDocument":{},"namespace":"{}","resumeToken":{:?}}}"#,
                event_type,
                event.cluster_time,
                event.document_key,
                full_doc_json,
                event.namespace,
                event.resume_token
            );

            let callback_clone = std::sync::Arc::clone(&callback);
            channel.send(move |mut cx| {
                let callback = callback_clone.to_inner(&mut cx);
                let this = cx.undefined();
                let err = cx.null();
                let data = cx.string(json);
                let args = vec![
                    err.upcast::<neon::types::JsValue>(),
                    data.upcast::<neon::types::JsValue>(),
                ];
                callback.call(&mut cx, this, args)?;
                Ok(())
            });
        }
    });

    Ok(cx.undefined())
}
