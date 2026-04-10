use neon::prelude::*;

use crate::{with_engine, DATABASES};

/// Begin a transaction. Returns transaction ID as a string (u64 → string to avoid precision loss).
///
/// JS signature: `beginTransaction(handle): string`
pub fn ovn_begin_transaction(mut cx: FunctionContext) -> JsResult<JsString> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txn = with_engine(&mut cx, handle_idx, |engine| engine.begin_transaction())?;
    Ok(cx.string(txn.txid.to_string()))
}

/// Commit a transaction.
///
/// JS signature: `commitTransaction(handle, txidStr): void`
pub fn ovn_commit_transaction(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);

    let txid: u64 = txid_str
        .parse()
        .or_else(|_| cx.throw_error("OvnError: Invalid transaction ID"))?;

    with_engine(&mut cx, handle_idx, |engine| {
        engine.commit_transaction(txid)
    })?;
    Ok(cx.undefined())
}

/// Abort (rollback) a transaction.
///
/// JS signature: `abortTransaction(handle, txidStr): void`
pub fn ovn_abort_transaction(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);

    let txid: u64 = txid_str
        .parse()
        .or_else(|_| cx.throw_error("OvnError: Invalid transaction ID"))?;

    DATABASES.with(|dbs| {
        let dbs = dbs.borrow();
        if let Some(Some(db)) = dbs.get(handle_idx) {
            if let Ok(engine) = db.lock() {
                engine.abort_transaction(txid);
            }
        }
    });

    Ok(cx.undefined())
}

/// Create a savepoint within a transaction.
///
/// JS signature: `savepoint(handle: number, txid: string, name: string): void`
pub fn ovn_savepoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);
    let name = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        let txid: u64 =
            txid_str
                .parse()
                .map_err(|e| ovn_core::error::OvnError::InvalidTransaction {
                    detail: format!("Invalid txid: {}", e),
                })?;
        engine.create_savepoint(txid, &name)
    })?;

    Ok(cx.undefined())
}

/// Rollback to a savepoint.
///
/// JS signature: `rollbackToSavepoint(handle: number, txid: string, name: string): void`
pub fn ovn_rollback_to_savepoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);
    let name = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        let txid: u64 =
            txid_str
                .parse()
                .map_err(|e| ovn_core::error::OvnError::InvalidTransaction {
                    detail: format!("Invalid txid: {}", e),
                })?;
        engine.rollback_to_savepoint(txid, &name)
    })?;

    Ok(cx.undefined())
}

/// Release a savepoint.
///
/// JS signature: `releaseSavepoint(handle: number, txid: string, name: string): void`
pub fn ovn_release_savepoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    let txid_str = cx.argument::<JsString>(1)?.value(&mut cx);
    let name = cx.argument::<JsString>(2)?.value(&mut cx);

    with_engine(&mut cx, handle_idx, |engine| {
        let txid: u64 =
            txid_str
                .parse()
                .map_err(|e| ovn_core::error::OvnError::InvalidTransaction {
                    detail: format!("Invalid txid: {}", e),
                })?;
        engine.release_savepoint(txid, &name)
    })?;

    Ok(cx.undefined())
}
