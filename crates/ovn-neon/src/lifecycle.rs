use neon::prelude::*;
use ovn_core::engine::config::OvnConfig;

use crate::{with_engine, DbHandle, DATABASES};

/// Open or create a database. Returns an integer handle.
///
/// JS signature: `open(path: string, options?: object): number`
pub fn ovn_open(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let path = cx.argument::<JsString>(0)?.value(&mut cx);

    let config_arg = cx.argument_opt(1);
    let mut config = OvnConfig::default();

    if let Some(cfg_val) = config_arg {
        if let Ok(cfg_obj) = cfg_val.downcast::<JsObject, _>(&mut cx) {
            // pageSize
            if let Ok(ps) = cfg_obj.get::<JsNumber, _, _>(&mut cx, "pageSize") {
                let v = ps.value(&mut cx) as u32;
                if (512..=65536).contains(&v) {
                    config.page_size = v;
                }
            }
            // bufferPool: "128MB" | "256MB" | bytes as number
            if let Ok(bp) = cfg_obj.get::<JsString, _, _>(&mut cx, "bufferPool") {
                let bp_str = bp.value(&mut cx);
                if let Some(mb) = bp_str.strip_suffix("MB") {
                    if let Ok(n) = mb.trim().parse::<usize>() {
                        config.buffer_pool_size = n * 1024 * 1024;
                    }
                } else if let Some(gb) = bp_str.strip_suffix("GB") {
                    if let Ok(n) = gb.trim().parse::<usize>() {
                        config.buffer_pool_size = n * 1024 * 1024 * 1024;
                    }
                }
            }
            // readOnly
            if let Ok(ro) = cfg_obj.get::<JsBoolean, _, _>(&mut cx, "readOnly") {
                config.read_only = ro.value(&mut cx);
            }
            // walMode (ignored at config level — WAL always on, but accept for compat)
            // compression: "none" | "lz4" | "zstd"
            if let Ok(comp) = cfg_obj.get::<JsString, _, _>(&mut cx, "compression") {
                let comp_str = comp.value(&mut cx);
                config.compression = match comp_str.to_lowercase().as_str() {
                    "lz4" => ovn_core::compression::CompressionType::Lz4,
                    "zstd" => ovn_core::compression::CompressionType::Zstd,
                    _ => ovn_core::compression::CompressionType::None,
                };
            }
        }
    }

    let engine = ovn_core::engine::OvnEngine::open(&path, config)
        .or_else(|e| cx.throw_error(format!("OvnError: Failed to open '{}': {}", path, e)))?;

    let handle: DbHandle = std::sync::Arc::new(std::sync::Mutex::new(engine));

    let index = DATABASES.with(|dbs| {
        let mut dbs = dbs.borrow_mut();
        // Reuse freed slots
        for (i, slot) in dbs.iter_mut().enumerate() {
            if slot.is_none() {
                *slot = Some(handle.clone());
                return i;
            }
        }
        let idx = dbs.len();
        dbs.push(Some(handle));
        idx
    });

    Ok(cx.number(index as f64))
}

/// Close a database and free its handle slot.
///
/// JS signature: `close(handle: number): void`
pub fn ovn_close(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;

    DATABASES.with(|dbs| {
        let mut dbs = dbs.borrow_mut();
        if let Some(slot) = dbs.get_mut(handle_idx) {
            if let Some(db) = slot.take() {
                if let Ok(engine) = db.lock() {
                    engine.close().ok();
                }
            }
        }
    });

    Ok(cx.undefined())
}

/// Force a checkpoint.
///
/// JS signature: `checkpoint(handle: number): void`
pub fn ovn_checkpoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    with_engine(&mut cx, handle_idx, |engine| engine.checkpoint())?;
    Ok(cx.undefined())
}

/// Get engine/library version info.
///
/// JS signature: `getVersion(): string`
pub fn ovn_get_version(mut cx: FunctionContext) -> JsResult<JsString> {
    let version = serde_json::json!({
        "engine": "Oblivinx3x",
        "version": "0.1.0",
        "format": "OVN/1.0",
        "neon": "1.x",
        "features": ["mvcc", "wal", "lz4", "zstd", "ahit", "fulltext", "geospatial", "vector", "lookup", "autocomplete"]
    });
    Ok(cx.string(version.to_string()))
}
