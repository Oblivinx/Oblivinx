use neon::prelude::*;
use ovn_core::engine::config::{DurabilityLevel, IoEngineHint, OvnConfig};

use crate::{with_engine, DbHandle, DATABASES};

/// Open or create a database. Returns an integer handle.
///
/// JS signature: `open(path: string, options?: OpenOptions): number`
///
/// ## Options (v2.0)
/// ```typescript
/// interface OpenOptions {
///   pageSize?: number;           // 512–65536, default 4096
///   bufferPool?: string | number; // e.g. "256MB", "1GB", or bytes
///   readOnly?: boolean;          // default false
///   compression?: "none" | "lz4" | "zstd";
///   durability?: "d0" | "d1" | "d1strict" | "d2"; // v2: default "d1"
///   concurrentWrites?: boolean;  // v2: BEGIN CONCURRENT, default false
///   hlc?: boolean;               // v2: HLC TxIDs, default true
///   maxRetries?: number;         // v2: write conflict retries, default 8
///   ioEngine?: "auto" | "sync";  // v2: I/O backend hint, default "auto"
/// }
/// ```
pub fn ovn_open(mut cx: FunctionContext) -> JsResult<JsNumber> {
    let path = cx.argument::<JsString>(0)?.value(&mut cx);

    let config_arg = cx.argument_opt(1);
    let mut config = OvnConfig::default();

    if let Some(cfg_val) = config_arg {
        if let Ok(cfg_obj) = cfg_val.downcast::<JsObject, _>(&mut cx) {
            // ── Core ────────────────────────────────────────────────
            if let Ok(ps) = cfg_obj.get::<JsNumber, _, _>(&mut cx, "pageSize") {
                let v = ps.value(&mut cx) as u32;
                if (512..=65536).contains(&v) && v.is_power_of_two() {
                    config.page_size = v;
                }
            }

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

            if let Ok(ro) = cfg_obj.get::<JsBoolean, _, _>(&mut cx, "readOnly") {
                config.read_only = ro.value(&mut cx);
            }

            if let Ok(comp) = cfg_obj.get::<JsString, _, _>(&mut cx, "compression") {
                config.compression = match comp.value(&mut cx).to_lowercase().as_str() {
                    "lz4" => ovn_core::compression::CompressionType::Lz4,
                    "zstd" => ovn_core::compression::CompressionType::Zstd,
                    _ => ovn_core::compression::CompressionType::None,
                };
            }

            // ── v2: Durability ───────────────────────────────────────
            if let Ok(dur) = cfg_obj.get::<JsString, _, _>(&mut cx, "durability") {
                config.durability = match dur.value(&mut cx).to_lowercase().as_str() {
                    "d0" => DurabilityLevel::D0,
                    "d1" => DurabilityLevel::D1,
                    "d1strict" => DurabilityLevel::D1Strict,
                    "d2" => DurabilityLevel::D2,
                    _ => DurabilityLevel::D1, // default
                };
                // Keep legacy field in sync
                config.group_commit = config.is_group_commit();
            }

            // ── v2: Concurrent Writes ────────────────────────────────
            if let Ok(cw) = cfg_obj.get::<JsBoolean, _, _>(&mut cx, "concurrentWrites") {
                config.concurrent_writes = cw.value(&mut cx);
            }

            // ── v2: HLC ──────────────────────────────────────────────
            if let Ok(hlc) = cfg_obj.get::<JsBoolean, _, _>(&mut cx, "hlc") {
                config.hlc_enabled = hlc.value(&mut cx);
            }

            // ── v2: maxRetries ───────────────────────────────────────
            if let Ok(mr) = cfg_obj.get::<JsNumber, _, _>(&mut cx, "maxRetries") {
                let v = mr.value(&mut cx) as u32;
                config.max_retries = v.clamp(1, 64);
                config.max_retry = config.max_retries; // legacy compat
            }

            // ── v2: I/O engine hint ──────────────────────────────────
            if let Ok(io) = cfg_obj.get::<JsString, _, _>(&mut cx, "ioEngine") {
                config.io_engine = match io.value(&mut cx).to_lowercase().as_str() {
                    "sync" => IoEngineHint::Sync,
                    _ => IoEngineHint::Auto,
                };
            }
        }
    }

    let engine = ovn_core::engine::OvnEngine::open(&path, config)
        .or_else(|e| cx.throw_error(format!("Oblivinx3x: Failed to open '{}': {}", path, e)))?;

    let handle: DbHandle = std::sync::Arc::new(std::sync::Mutex::new(engine));

    let index = DATABASES.with(|dbs| {
        let mut dbs = dbs.borrow_mut();
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

/// Force a checkpoint (flush WAL + MemTable to persistent storage).
///
/// JS signature: `checkpoint(handle: number): void`
pub fn ovn_checkpoint(mut cx: FunctionContext) -> JsResult<JsUndefined> {
    let handle_idx = cx.argument::<JsNumber>(0)?.value(&mut cx) as usize;
    with_engine(&mut cx, handle_idx, |engine| engine.checkpoint())?;
    Ok(cx.undefined())
}

/// Get engine/library version info.
///
/// JS signature: `getVersion(): VersionInfo`
pub fn ovn_get_version(mut cx: FunctionContext) -> JsResult<JsString> {
    let version = serde_json::json!({
        "engine": "Oblivinx3x",
        "version": "2.0.0",
        "format": "OVN2/2.0",
        "neon": "1.x",
        "features": [
            "mvcc",
            "wal",
            "group-commit",
            "hlc-txid",
            "arc-buffer-pool",
            "lz4",
            "zstd",
            "ahit-v2",
            "art-tier0",
            "pgm-tier1",
            "fulltext",
            "geospatial",
            "vector-hnsw",
            "columnar-htap",
            "zone-maps",
            "cdc-log",
            "begin-concurrent",
            "v1-compat-readonly"
        ]
    });
    Ok(cx.string(version.to_string()))
}
