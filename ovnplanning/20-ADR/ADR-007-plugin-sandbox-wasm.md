# ADR-007 — WebAssembly (Wasmtime) for the Plugin Sandbox

**Status:** Accepted, 2026-04
**Owners:** Plugin subsystem
**Cross refs:** `[[FILE-14]]`

---

## Context

User-extensible logic (tokenizers, UDFs, triggers, custom indexes) needs an execution model that:

1. Cannot escape the engine (no `unsafe` native code, no syscalls, no FS).
2. Has bounded CPU and memory consumption.
3. Is portable across all engine platforms.
4. Allows hot reload without restarting the host.
5. Supports multiple source languages (Rust, AssemblyScript, TinyGo, C).
6. Is deterministic for cross-replica consistency.

Options:

* **Native `dlopen`** — fastest but unsafe; one bad pointer kills the engine.
* **Lua / QuickJS** — embeddable; small ecosystem; weak typing.
* **WebAssembly (Wasmtime)** — sandboxed by design; memory-safe; multi-language; deterministic.
* **WASM (Wasmer)** — alternative runtime; similar profile, less mature on certain platforms.
* **JVM / .NET hosted** — too heavy for embedded; multiple runtimes.

## Decision

Use **Wasmtime** as the WASM runtime, with:

* Capability-gated host imports (manifest declares `capabilities`; engine refuses extra imports).
* Pooling allocator for fast instance reuse (claimed instance = ~5 µs).
* Fuel + epoch interruption for time bounds.
* `nan_canonicalization = true` for deterministic floats.
* Instance lifecycle: per-call fresh state by default; `stateful=true` opt-in disables hot reload.
* Module compile cache keyed by `(sha256, abi, host_cpu)`.
* Quarantine on repeat OOM/timeout/trap.

## Consequences

**Positive**

* Memory safety guaranteed by construction.
* Multi-language support increases addressable plugin author audience.
* Hot reload via atomic instance-pool swap.
* Cold-start cost amortized via compile cache.

**Negative**

* Cold-start (first ever load) cost: 50–500 ms for typical 1–10 MB modules.
* WASM ↔ host call boundary copies bytes (linear memory ↔ Rust heap); not free for very small/frequent calls.
* WASM lacks first-class threads; concurrency comes from instance pooling rather than intra-plugin threading.

## Alternatives considered

* **dlopen** — rejected: unsafe.
* **Lua** — considered for sub-MB tokenizer footprint; rejected for type safety and ecosystem reach.
* **Wasmer** — rejected for now; revisit if Wasmtime stalls.
* **JS via QuickJS** — interesting for very-low-overhead UDFs; deferred to post-1.0 plugin variant.

## Open questions

* WASM Component Model adoption timing (replaces ad-hoc `(ptr,len)` ABI with interface types).
* WASI Preview 2 capabilities (scoped FS) — only for migration-class plugins, never general.

*End of ADR-007.*
