# 14 — PLUGIN SYSTEM (WASM)

> **Audience:** Plugin authors, embedders extending Oblivinx3x with custom logic, security reviewers.
> **Status:** Specification (target v0.6 host ABI, v0.7 hot-reload).
> **Cross refs:** `[[FILE-03]]` document model, `[[FILE-04]]` indexes, `[[FILE-05]]` query engine, `[[FILE-07]]` security, `[[FILE-08]]` search engine, `[[FILE-12]]` observability, `[[FILE-20]]/007` ADR plugin sandbox.

---

## 1. Purpose

The plugin system extends the engine with **user-defined logic** — without recompiling the engine and without granting native code execution rights. Use cases:

* Custom **tokenizers** for full-text search (e.g., Japanese morphological).
* **User-defined functions (UDFs)** in queries (e.g., `myComputeScore(doc)`).
* **Triggers** on insert/update/delete (e.g., audit, denormalization).
* Custom **index types** (e.g., a domain-specific KNN).
* **Migration scripts** that need stronger guarantees than ad-hoc shell.
* **Validators** beyond JSON Schema.

The execution sandbox is **WebAssembly** (Wasmtime). This document specifies the host ABI, manifest format, lifecycle, security model, capability surface, and resource limits.

---

## 2. Goals & non-goals

### 2.1 Goals

* **Safe by default** — plugin cannot escape its memory, syscalls, file system.
* **Deterministic** — no access to wall clock, randomness, network unless granted.
* **Hot-reloadable** — replace plugin without restart in most cases.
* **Polyglot** — Rust, AssemblyScript, Go (TinyGo), C/C++, Zig.
* **Performant** — single-call latency < 50 µs; bulk paths streamed.
* **Versioned ABI** — host ABI is stable across minor versions.

### 2.2 Non-goals

* **Filesystem / OS access** for plugins (forbidden).
* **GPU access** (out of scope; v2.0 candidate).
* **Multi-threaded plugins** (single-instance per call; engine parallelizes via instance pools).

---

## 3. Plugin types

| Type            | Trait implemented (Rust SDK term) | Triggered when              | Mutates engine state |
| --------------- | --------------------------------- | --------------------------- | -------------------- |
| Tokenizer       | `Tokenizer`                       | FTS index/query             | no                   |
| UDF (scalar)    | `ScalarFunction`                  | Query expression            | no                   |
| UDF (aggregate) | `AggregateFunction`               | Aggregation `$group`        | no                   |
| Trigger         | `DocumentTrigger`                 | Insert/Update/Delete        | yes (via host calls) |
| Index           | `CustomIndex`                     | Index ops                   | no (writes via host) |
| Validator       | `Validator`                       | Insert/Update               | no                   |
| Migration       | `Migration`                       | Schema upgrade              | yes                  |
| Stage           | `PipelineStage`                   | Aggregation pipeline        | no                   |

Each type maps to a fixed set of **export functions** the WASM module must implement (§5).

---

## 4. Plugin lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│  REGISTERED  →  LOADED  →  INSTANTIATED  →  ACTIVE          │
│                  │             │              │              │
│                  │             │              ▼              │
│                  │             │         INVOKED (per call)  │
│                  │             ▼                              │
│                  │         INIT FAILED ──► QUARANTINED       │
│                  ▼                                            │
│              MODULE INVALID ──► REJECTED                     │
│                                                               │
│  ACTIVE → PAUSED → ACTIVE                  (admin command)   │
│  ACTIVE → DRAINING → UNLOADED              (hot-reload swap) │
└─────────────────────────────────────────────────────────────┘
```

Events:

* **REGISTERED** — manifest parsed, module bytes stored in `_ovn_plugins` system collection.
* **LOADED** — Wasmtime module compiled (cache-aware via cranelift).
* **INSTANTIATED** — fresh `Store` + `Instance` created from pool.
* **INVOKED** — exported function called with caller args.
* **DRAINING** — no new invocations accepted; in-flight finish.
* **UNLOADED** — instances dropped, module evicted.
* **QUARANTINED** — too many failures (configurable threshold); requires admin re-enable.

---

## 5. Host ABI v1

Plugins import host functions from module `"ovn"` and export entry points by convention.

### 5.1 Versioning

```
(import "ovn" "abi_version" (func (result i32)))
(export "_ovn_plugin_abi" (func $declared_abi))
```

The plugin's `_ovn_plugin_abi` returns its target ABI. Engine refuses to load if `plugin_abi != HOST_ABI` (no minor compatibility — strict, simple).

`HOST_ABI = 0x00010000` for v1.0; bumped on breaking changes.

### 5.2 Memory model

* Plugins run in 32-bit linear memory (Wasmtime default).
* Strings: UTF-8 bytes; passed as `(ptr: i32, len: i32)`.
* Documents: OBE-encoded blobs; same `(ptr, len)` convention.
* All memory passed to host **must be in plugin's linear memory**; host copies in/out.

### 5.3 Required exports per plugin

#### Common (every plugin)

```
(export "memory" (memory $mem))                ;; default linear memory
(export "_ovn_plugin_abi" (func (result i32))) ;; ABI version
(export "_ovn_alloc" (func (param i32) (result i32)))   ;; bytes → ptr
(export "_ovn_free"  (func (param i32 i32)))            ;; ptr, bytes → ()
(export "_ovn_init"  (func (param i32 i32) (result i32))) ;; config_ptr, config_len → status
(export "_ovn_shutdown" (func))
```

#### Tokenizer

```
(export "tokenize" (func (param $text_ptr i32) (param $text_len i32)
                          (result i32)))    ;; returns ptr to TokenList
;;                                          (length-prefixed [ {start,end,bytes_ptr,bytes_len,kind} ... ])
```

#### Scalar UDF

```
(export "udf_scalar" (func (param $args_ptr i32) (param $args_len i32)
                             (result i64)))     ;; high32=status, low32=result_ptr
                                                  ;; result is OBE Value
```

#### Aggregate UDF

```
(export "agg_init"     (func (result i32)))                       ;; state_ptr
(export "agg_update"   (func (param $state i32) (param $val i32)))
(export "agg_merge"    (func (param $a i32) (param $b i32) (result i32)))
(export "agg_finalize" (func (param $state i32) (result i32)))    ;; result_ptr (Value)
```

#### Trigger

```
(export "trigger_before" (func (param $event_ptr i32) (param $event_len i32) (result i32)))
(export "trigger_after"  (func (param $event_ptr i32) (param $event_len i32) (result i32)))
```

Status codes from triggers: `0`=OK, `1`=REJECT (abort write with `OvnError::ValidatedRejected`), `2`=AMEND (the plugin returns a new doc via `host_set_amended_doc`).

#### Custom index

```
(export "idx_open"     (func (param $cfg_ptr i32) (param $cfg_len i32) (result i32)))   ;; handle
(export "idx_insert"   (func (param $h i32) (param $key_ptr i32) (param $key_len i32)
                             (param $id_ptr i32) (param $id_len i32) (result i32)))
(export "idx_delete"   (func (param $h i32) (param $key_ptr i32) (param $key_len i32)
                             (param $id_ptr i32) (param $id_len i32) (result i32)))
(export "idx_search"   (func (param $h i32) (param $q_ptr i32) (param $q_len i32)
                             (result i32)))                ;; result_ptr (CursorState)
(export "idx_close"    (func (param $h i32)))
```

### 5.4 Host imports (capability gated)

Plugins import functions from `"ovn"` namespace; the engine validates the import list against the **manifest capabilities** at load time.

#### Logging (always allowed)

```
(import "ovn" "log" (func (param $level i32) (param $msg_ptr i32) (param $msg_len i32)))
```

#### Time (capability `time`)

```
(import "ovn" "now_ms"        (func (result i64)))   ;; monotonic
(import "ovn" "now_unix_ms"   (func (result i64)))   ;; wall clock (gated; rare)
```

#### Random (capability `random`)

```
(import "ovn" "random_bytes" (func (param $ptr i32) (param $len i32)))
```

#### Storage read (capability `storage_read`)

```
(import "ovn" "fetch_doc"
        (func (param $coll_ptr i32) (param $coll_len i32)
              (param $id_ptr i32)   (param $id_len i32)
              (result i32)))            ;; doc_ptr (OBE) or 0
```

#### Storage write (capability `storage_write`)

```
(import "ovn" "insert_doc"
        (func (param $coll_ptr i32) (param $coll_len i32)
              (param $obe_ptr i32)  (param $obe_len i32)
              (result i32)))           ;; status
(import "ovn" "update_doc" (func ...))
(import "ovn" "delete_doc" (func ...))
```

#### Index (capability `index_op`)

```
(import "ovn" "index_lookup"
        (func (param $coll i32 i32) (param $idx i32 i32) (param $key i32 i32)
              (result i32)))           ;; cursor handle
(import "ovn" "cursor_next" (func (param i32) (result i32)))   ;; doc_ptr or 0
(import "ovn" "cursor_close" (func (param i32)))
```

#### Pipeline (capability `pipeline`)

```
(import "ovn" "emit_doc" (func (param $obe_ptr i32) (param $obe_len i32)))
```

#### Trigger amend (capability `trigger_amend`, only triggers)

```
(import "ovn" "set_amended_doc" (func (param $obe_ptr i32) (param $obe_len i32)))
```

#### Network (capability `net_outbound`)

Reserved; **not granted by default**. Requires explicit operator approval; all calls are recorded in audit. Likely deferred to v0.8+.

---

## 6. Manifest

YAML or TOML; example YAML:

```yaml
ovn_plugin: 1                      # manifest version
name: japanese_tokenizer
version: 0.4.1
type: tokenizer
abi: 0x00010000
author: contoso
license: Apache-2.0
description: |
  Morphological tokenizer for Japanese using Sudachi.

module:                            # path relative to package root
  wasm: build/japanese.wasm
  sha256: 9f3c...                  # validated on load

capabilities:                      # explicit; unlisted = denied
  - time

limits:                            # caller-overridable downward only
  memory_pages: 256                # 16 MiB max linear memory
  fuel_per_call: 5_000_000         # ~ms of CPU
  max_call_seconds: 0.1
  max_string_kib: 1024

config_schema:                     # JSON Schema; validated on activation
  type: object
  required: [dict_path]
  properties:
    dict_path:        { type: string }
    user_dict_path:   { type: string }

bindings:                          # what the engine should expose
  fts:
    apply_to: [collection_a, collection_b]    # collections that may use this tokenizer

signing:
  required: false                  # for production registries set true
```

Loading order:

1. Parse manifest; reject if schema invalid.
2. Verify SHA-256 of `wasm` file.
3. Validate signature if `signing.required`.
4. Compile module (cache key = sha256 + abi + cpu features).
5. Validate exports vs declared `type`.
6. Validate imports vs declared `capabilities` (no extra imports allowed).
7. Allocate first instance, call `_ovn_init(config)` with effective config.
8. Mark ACTIVE.

---

## 7. Sandbox guarantees

### 7.1 Wasmtime configuration

```rust
let mut cfg = wasmtime::Config::new();
cfg.consume_fuel(true);
cfg.epoch_interruption(true);
cfg.wasm_threads(false);
cfg.wasm_simd(true);                  // safe within sandbox
cfg.wasm_bulk_memory(true);
cfg.wasm_reference_types(true);
cfg.cranelift_nan_canonicalization(true); // determinism
cfg.cranelift_opt_level(OptLevel::Speed);
cfg.allocation_strategy(InstanceAllocationStrategy::Pooling(pool_cfg));
cfg.static_memory_maximum_size(0);    // disable static memory; rely on dynamic
```

### 7.2 Memory limits

* Per-instance linear memory cap (`memory_pages * 64 KiB`).
* Per-call temporary allocations capped via fuel + epoch.
* No shared memory between instances.

### 7.3 CPU limits

* **Fuel** — every wasm op consumes 1 unit; budget per call.
* **Epoch interruption** — every `epoch_period_us` (default 1000 µs), epoch counter increments; instances run with deadline.

Both are belt-and-braces; either alone halts runaway plugins.

### 7.4 Determinism

* `nan_canonicalization` to avoid platform-divergent NaN bit patterns.
* `wall-clock now_unix_ms` is gated; `now_ms` (monotonic) is allowed but not monotone-tied to host (epoch-boundaries reset).
* `random_bytes` requires capability and is logged.

### 7.5 Side-channel posture

The sandbox does **not** claim resistance to constant-time / cache-side-channel attacks across plugins. Operators must not co-host adversarial plugins with high-value data (in practice rare; embedded use case is single-tenant).

---

## 8. Resource limits & quotas

| Limit                          | Default          | Cap (max)        | Units             |
| ------------------------------ | ---------------- | ---------------- | ----------------- |
| `memory_pages`                 | 64 (4 MiB)       | 4096 (256 MiB)   | 64 KiB pages      |
| `fuel_per_call`                | 1,000,000        | 100,000,000      | wasm ops          |
| `max_call_seconds`             | 0.05             | 5                | wall-time seconds |
| `max_string_kib`               | 256              | 16384            | KiB               |
| `instance_pool_size`           | 16               | 256              | instances         |
| `oom_quarantine_after`         | 5                | 100              | OOM events        |
| `timeout_quarantine_after`     | 10               | 200              | timeouts          |

Per-call quotas may be tightened by the **caller** (e.g., a query may say "this UDF gets 10 ms max"), but never loosened beyond manifest.

---

## 9. Performance & instance pooling

### 9.1 Pooling strategy

For each plugin, the engine maintains a pool of pre-instantiated `Store + Instance` pairs, sized by `instance_pool_size`. A call:

1. Claim instance from pool (fast lock-free queue).
2. Reset fuel, epoch, optional `_ovn_reset` (if exported).
3. Copy args into linear memory via `_ovn_alloc`.
4. Invoke export.
5. Copy result out.
6. Return instance to pool.

Reset cost is ~5 µs vs. ~150 µs cold instantiation. If pool is empty, requests either:

* Wait briefly (≤ 1 ms) — for tokenizers and UDFs in hot paths.
* Return `OvnError::PluginBusy` — for triggers (caller decides retry).

### 9.2 Cold start

Wasmtime's cranelift compile cost on cold load: 50–500 ms for typical 1–10 MB modules. The engine **caches compiled modules** keyed by `(sha256, abi, host_cpu_features)` in `cache/wasm/`.

### 9.3 SIMD

Plugins compiled with SIMD opcodes get up to 2–3× speedup on tokenization workloads. Engine enables `wasm_simd=true` when host supports SSE4.2 (auto-detected).

---

## 10. Hot reload

Triggered by:

* Admin: `ovn admin plugin reload <name>`.
* Manifest change detected by watcher (optional).
* New version of plugin uploaded via API.

Algorithm:

```rust
fn hot_reload(plugin: &PluginRef, new_module: WasmModule) -> Result<(), OvnError> {
    // 1. Compile new module
    let compiled = engine.compile(&new_module)?;
    // 2. Validate exports/imports match the same plugin type
    validate_compat(plugin.kind(), &compiled)?;
    // 3. Build new instance pool of equal size
    let new_pool = InstancePool::new(compiled, plugin.config(), plugin.limits());
    // 4. Atomic swap
    let old_pool = plugin.swap_pool(new_pool);
    // 5. Mark old DRAINING; in-flight calls finish on the old pool
    old_pool.start_drain();
    // 6. After drain timeout (default 30 s), old pool is dropped
    spawn_drain_dropper(old_pool, Duration::from_secs(30));
    Ok(())
}
```

If `validate_compat` fails (e.g., new module is a different plugin type), the swap is rejected.

Hot reload is **not** allowed for plugins where state lives in linear memory across calls — these must declare `stateful: true` in manifest, which disables hot-reload (plugin must be unloaded explicitly).

---

## 11. Trigger semantics

### 11.1 Phases

* `trigger_before` — runs **inside** the txn, before WAL write. May reject (abort txn) or amend (replace doc).
* `trigger_after` — runs **after** the txn commits, asynchronously. Cannot reject; failures are logged but do not undo the commit.

### 11.2 Event payload (OBE)

```jsonc
{
  "op":         "insert" | "update" | "delete",
  "db":         "<db>",
  "coll":       "<coll>",
  "id":         <ObjectId>,
  "doc_before": <Document | null>,
  "doc_after":  <Document | null>,
  "patch":      [<JsonPatchOp>] | null,
  "user":       { "id": "...", "roles": [...] } | null,
  "hlc":        <int>,
  "txn_id":     <int>
}
```

### 11.3 Recursion guard

Triggers calling host write APIs may recursively trigger other triggers. The engine tracks recursion depth (default cap 4). Beyond cap, the inner call returns `OvnError::TriggerRecursionLimit`.

### 11.4 Atomicity

`trigger_before` runs in the same txn as the write — its host calls (`insert_doc`, etc.) are part of that txn and rolled back on conflict. `trigger_after` runs in a **fresh txn** so its mutations do not retroactively affect the committed change stream view.

---

## 12. Custom index integration

A custom index plugin appears alongside built-ins in `[[FILE-04]]`. It must:

1. Persist its own state via host `insert_doc`/`update_doc` into a system collection (or its own pages — v0.8+).
2. On `idx_search`, return a cursor handle the engine fetches from.
3. Survive crash recovery: provide `idx_recover(handle, last_safe_lsn)` so the engine can replay missing entries from oplog after restart.

Custom indexes are **not** allowed for primary key indexes.

---

## 13. UDF integration with the planner

The planner `[[FILE-05]]` §6 treats UDFs as opaque expressions with cost = `udf_cost_us` (declared in manifest, defaults to 50 µs). Implications:

* UDFs are **not pushed below indexes**; they evaluate after rows are produced.
* Aggregate UDFs are slot-based: state lives outside hash buckets.
* The planner avoids UDFs in selection predicates if equivalent indexed predicates exist.
* `IMMUTABLE` UDFs (declared in manifest) may be hoisted as constants when their args are constant.

Manifest hint:

```yaml
bindings:
  udf:
    name: my_score
    return_type: double
    arg_types: [object, double]
    cost_us: 30
    immutable: false
```

---

## 14. Distribution & registry

### 14.1 Local registry

Plugin packages stored in `plugins/` directory under data dir:

```
plugins/
├── japanese_tokenizer/
│   ├── manifest.yaml
│   ├── build/japanese.wasm
│   └── README.md
└── audit_trigger/
    ├── manifest.yaml
    └── build/audit.wasm
```

`ovn admin plugin install <path-or-url>` copies into directory and registers.

### 14.2 Remote registry (optional)

A future `oblivinx.dev/registry` would host signed packages:

```
ovn admin plugin install ovnpkg://oblivinx/japanese_tokenizer@0.4.1
```

Verification:

1. Download `<name>-<version>.ovnpkg` (zip with manifest + wasm + signature).
2. Verify signature against trusted public keys (`plugins/trusted_keys.pem`).
3. Validate sha256 of wasm against manifest.
4. Install if all checks pass.

### 14.3 Signing

Manifests carry an Ed25519 signature over `(name|version|sha256(wasm)|capabilities|abi)`. Operators may set `signing.required=true` globally to refuse unsigned plugins.

---

## 15. Observability of plugins

Metrics (defined in `[[FILE-12]]` §3.12):

* `obx_plugin_loaded`
* `obx_plugin_call_total{name,fn,result}`
* `obx_plugin_call_seconds{name,fn}`
* `obx_plugin_memory_bytes{name}`
* `obx_plugin_oom_total{name}`
* `obx_plugin_timeout_total{name}`

Spans:

* `obx.plugin.invoke{name,fn}` — root span per call.
* `obx.plugin.cold_compile{name}` — module compile.
* `obx.plugin.reload{name}` — hot reload.

Logs:

* `info` on load/unload.
* `warn` on per-call failures (with rate limiter to avoid spam).
* `error` on quarantine.

---

## 16. Failure handling & quarantine

A plugin is quarantined when it crosses thresholds:

| Counter                | Default cap (per 1 h) | Action on cap         |
| ---------------------- | --------------------- | --------------------- |
| OOM                    | 5                     | quarantine 1 h        |
| Timeout                | 10                    | quarantine 1 h        |
| Trap (panic)           | 20                    | quarantine 1 h        |
| Init failure           | 1                     | quarantine until edit |
| Capability violation   | 1                     | quarantine permanent  |

Quarantined plugins:

* Reject new invocations with `OvnError::PluginQuarantined`.
* Engine continues without them — callers must handle the error.
* Operators clear via `ovn admin plugin clear-quarantine <name>` after investigating.

---

## 17. Migration plugins

Migration plugins implement:

```
(export "migrate" (func (param $from_version i32) (param $to_version i32) (result i32)))
```

Run during DDL operations (e.g., adding a required field, splitting a collection). Invoked from a privileged context that has `storage_write` and `storage_read` capabilities by default. Migrations are tracked in `_ovn_migrations`:

```jsonc
{
  "_id":      "users.v1_to_v2",
  "applied":  "<hlc>",
  "duration_ms": 42100,
  "status":   "ok",
  "checksum": "<xxh3-128>"
}
```

If `_ovn_migrations` shows a migration as `applied`, re-running it is a no-op (idempotent expectation on the plugin author).

---

## 18. Examples

### 18.1 Rust SDK skeleton (scalar UDF)

```rust
use oblivinx_plugin_sdk::*;

#[ovn_plugin(kind = "udf_scalar")]
pub struct GeoScore;

impl ScalarFunction for GeoScore {
    type Args = (Document, GeoPoint);
    type Out  = f64;

    fn call(&self, (doc, here): Self::Args, _ctx: &Ctx) -> Result<f64> {
        let dist = haversine(doc.path("/loc"), here);
        let recency = (now_ms() - doc.get_int64("/updated")?) as f64;
        Ok(1.0 / (dist * 0.001 + recency * 1e-7).max(1e-6))
    }
}
```

The macro generates the required exports, manifest stub, and signature glue. Build with `cargo ovn build --target wasm32-unknown-unknown`.

### 18.2 AssemblyScript trigger

```typescript
@ovnTrigger
export function triggerBefore(event: TriggerEvent): TriggerResult {
  if (event.op == "insert" && event.docAfter!.getString("status") == null) {
    event.docAfter!.set("status", "pending");
    return TriggerResult.AMEND;
  }
  return TriggerResult.OK;
}
```

### 18.3 Custom tokenizer (Rust, simplified)

```rust
#[ovn_plugin(kind = "tokenizer")]
pub struct Splitter;

impl Tokenizer for Splitter {
    fn tokenize(&self, text: &str, out: &mut TokenSink) {
        for (i, w) in text.split_whitespace().enumerate() {
            out.push(Token {
                start: w.as_ptr() as u32 - text.as_ptr() as u32,
                end:   (w.as_ptr() as u32 - text.as_ptr() as u32) + w.len() as u32,
                bytes: w.to_string(),
                kind:  TokenKind::Word,
            });
        }
    }
}
```

---

## 19. Tradeoffs

| Decision                          | Chosen                            | Alternative              | Why                                  |
| --------------------------------- | --------------------------------- | ------------------------ | ------------------------------------ |
| WASM vs native dynlib             | WASM                              | dlopen .so               | Sandboxed; portable; deterministic   |
| Wasmtime vs Wasmer                | Wasmtime                          | Wasmer                   | More mature, cranelift bug-fixes     |
| Capability-gated imports          | Yes                               | Free imports             | Principle of least privilege         |
| Per-call fresh state              | Default; opt-in `stateful`        | Always state             | Hot reload + concurrency             |
| Determinism (NaN canon)           | Yes                               | Off                      | Cross-replica consistency            |
| Polyglot SDKs                     | Rust first, AS second             | Rust only                | Lower barrier to entry               |
| Manifest format                   | YAML (TOML accepted)              | JSON                     | Hand-written ergonomic               |
| Signing                           | Optional default, required prod   | Always                   | Embedded scenarios differ             |

---

## 20. Open questions & future

* **WASM Component Model** — adopt when stabilized; gives interface types instead of `(ptr,len)`.
* **WASI Preview 2** — strictly subset; may grant scoped FS for migration tooling.
* **GPU plugins** — WebGPU sandbox future.
* **Per-tenant plugin scoping** — prefix-namespaced plugin instances per tenant.
* **DSL plugins** — let frameworks register custom query syntax that lowers to OQL AST.

---

## 21. Cross-references

* `[[FILE-04]]` — custom index plugin slot.
* `[[FILE-05]]` — UDFs participate in plan cost.
* `[[FILE-07]]` — plugin signing keys live in security subsystem.
* `[[FILE-08]]` — tokenizer plugin used by FTS.
* `[[FILE-12]]` — plugin metrics & spans.
* `[[FILE-13]]` — admin REST endpoints for plugin lifecycle.
* `[[FILE-20]]/007` — ADR for sandbox choice.

*End of `14-PLUGIN-WASM.md` — 590 lines.*
