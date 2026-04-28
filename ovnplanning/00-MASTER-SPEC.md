# 00 — MASTER SPECIFICATION

> **Document role:** single entry point for the Oblivinx3x planning corpus.
> All other files in `ovnplanning/` are referenced from here using `[[FILE-NN]]`
> notation. When sections of two files conflict, the later-numbered file
> overrides for its specific subsystem.
>
> **Status:** authoritative draft for `v0.1.0` → `v1.0.0`.
> **Last revised:** 2026-04-27.
> **Owner:** Oblivinx3x core team.
> **Implementation language:** Rust 1.78+ (`crates/ovn-core`, `crates/ovn-neon`).

---

## 1. Executive Summary

Oblivinx3x ("OVN", codename **Nova**) is an **embedded document database
engine** designed for environments where SQLite is too rigid, MongoDB is too
heavy, and DuckDB is too OLAP-only. It targets desktop, server, edge,
serverless, and browser (WASM) deployments from a single source tree.

The engine merges three lineages:

1. **SQLite-class** single-file ACID storage (`.ovn2` file format) with
   crash-safe write-ahead logging.
2. **MongoDB-class** flexible schema, document model (OBE / OBE2 binary
   encoding), and the MQL operator family (`$eq`, `$gt`, `$lookup`, …).
3. **DuckDB-class** vectorized columnar mirror for analytical queries that
   would otherwise scan the whole document set.

On top of those it adds capabilities **none of the three above offer
natively at the embedded tier**:

- HNSW + DiskANN vector indexes with hybrid keyword/vector search
  (Reciprocal Rank Fusion).
- Reactive queries — observers fire on the differential change set rather
  than re-running the query.
- WASM plugins — third-party storage backends, tokenizers, and UDFs run in
  a Wasmtime sandbox with a hard memory and CPU budget.
- CRDT-based offline sync — LWW-Register, OR-Set, PN-Counter, LWW-Map for
  multi-master eventual consistency.
- Field-level encryption with searchable encryption (equality, range,
  prefix, suffix, substring) backed by AES-256-GCM-SIV.
- Hybrid row + columnar storage with auto-promotion to columnar for
  analytical access patterns.

### 1.1 Differentiation matrix

| Capability                         | SQLite | MongoDB | DuckDB | Oblivinx3x |
|------------------------------------|:------:|:-------:|:------:|:----------:|
| Single-file embedded               | ✅     | ❌      | ✅     | ✅         |
| Native document model              | ❌¹    | ✅      | ❌²    | ✅         |
| ACID, MVCC, snapshot isolation     | ✅     | ✅      | ✅     | ✅         |
| Multi-writer (no global lock)      | ❌     | ✅      | ❌     | ✅ (v0.6+) |
| Full-text search                   | ✅ (FTS5)| ✅    | ❌     | ✅         |
| Vector / ANN                       | ❌³    | ✅ (Atlas)| ❌   | ✅         |
| Geospatial (R-tree)                | ✅     | ✅      | ❌     | ✅         |
| Reactive change streams            | ❌     | ✅      | ❌     | ✅         |
| Field-level encryption             | ❌     | ✅⁴     | ❌     | ✅         |
| WASM plugin sandbox                | ❌     | ❌      | ❌     | ✅         |
| Browser (WASM/OPFS) target         | ✅     | ❌      | ✅     | ✅         |
| CRDT sync                          | ❌     | ❌      | ❌     | ✅         |
| Static binary < 5 MB               | ✅     | ❌      | ❌     | ✅         |

¹ JSON1 extension only; no native typed document.
² JSON struct/list types exist but no document indexing.
³ `sqlite-vss` / `sqlite-vec` exist as third-party.
⁴ Atlas / Enterprise only.

---

## 2. Vision, Mission, Non-Goals

### 2.1 Vision (3-5 year)

Oblivinx3x becomes the default embedded database for AI-native applications
running at the edge: every laptop, mobile app, browser tab, and edge worker
needs one local DB that handles documents, vectors, full-text search, and
reactive updates without external services.

### 2.2 Mission (current cycle)

Ship a stable v1.0 that an application developer can drop in via a single
dependency (`npm i oblivinx3x` or equivalent for Rust / Python / Go) and use
without ever running a daemon, configuring a server, or managing schemas.

### 2.3 Non-Goals (with reasons)

The following are deliberately **out of scope** and will not be added even
if requested:

| Non-goal                              | Reason |
|---------------------------------------|--------|
| Distributed consensus across regions  | Embedded-first; cross-region belongs to a higher-level service. We provide CRDT for offline-first, Raft for single-region replication, but not Paxos/Raft over WAN. |
| Full SQL standard compliance          | We expose an SQL subset for relational-style queries but the expressiveness ceiling is OQL/MQL. SQLite already owns full SQL. |
| Stored procedures / server-side JS    | Plugins via WASM are the extensibility surface. No `eval()` of arbitrary code. |
| Multi-tenant SaaS hosting layer       | The engine is a library, not a service. Hosting is a separate product. |
| Sub-microsecond write latency         | We trade a few µs for durability via WAL. If you need raw RAM speed, use sled or memcached. |
| GDPR / HIPAA compliance certification | We provide the security primitives (encryption, audit, secure delete). Certification is the integrator's responsibility. |

---

## 3. Architecture Overview (10 Layers)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 10  Bindings:  C  ·  C++  ·  Rust  ·  Node.js  ·  Python · WASM│
├─────────────────────────────────────────────────────────────────────┤
│ Layer 9   API: OQL parser, MQL pipeline, REST/HTTP, WebSocket Watch  │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 8   Query Engine: planner · optimizer · executor · explain     │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 7   Index Engine: B+ · Hash · FTS · HNSW · R-tree · Learned    │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 6   MVCC: TxID · snapshots · version chain · GC · lock manager │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 5   Document Layer: OBE2 encoding · projection · diff · schema │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 4   Storage Engine: B+ Tree + LSM · slab · freelist · overflow │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3   Buffer Pool: ARC eviction · pin/unpin · dirty tracking     │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2   WAL: group commit · checkpoint · recovery · LSN            │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 1   I/O Abstraction: io_uring · IOCP · kqueue · mmap · OPFS    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                   .ovn2 single-file format
                   (header · WAL · pages · indexes · oplog)
```

Cross-cutting concerns:

```
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│  Security    │ │ Observability│ │ Replication  │ │   Plugins    │
│  (encryption,│ │ (metrics,    │ │ (oplog, CRDT,│ │  (WASM, .so) │
│   RBAC, FLE) │ │  tracing)    │ │   Raft)      │ │              │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       └────────────────┴────────────────┴────────────────┘
                       attaches to layers 4–9
```

See `[[FILE-01]]` (storage), `[[FILE-02]]` (WAL), `[[FILE-03]]` (document
model), `[[FILE-04]]` (indexes), `[[FILE-05]]` (query), `[[FILE-06]]`
(MVCC), `[[FILE-07]]` (security), `[[FILE-08]]` (search), `[[FILE-09]]`
(replication), `[[FILE-10]]` (concurrency), `[[FILE-11]]` (compression),
`[[FILE-12]]` (observability), `[[FILE-13]]` (API), `[[FILE-14]]`
(plugins), `[[FILE-15]]` (OQL grammar), `[[FILE-16]]` (build),
`[[FILE-17]]` (testing), `[[FILE-18]]` (roadmap), `[[FILE-19]]`
(glossary), and `[[FILE-20]]` (ADRs).

---

## 4. Component Dependency Graph

```
                    ┌──────────┐
                    │  Tests   │
                    └────┬─────┘
                         │
        ┌────────────────┴────────────────┐
        │                                 │
   ┌────▼────┐  ┌──────────┐  ┌──────────▼──┐
   │ REST API│◄─│ Bindings │◄─│   Plugins   │
   └────┬────┘  └────┬─────┘  └──────┬──────┘
        │            │               │
        └────────────┼───────────────┘
                     ▼
              ┌──────────────┐
              │   API/OQL    │
              └──────┬───────┘
                     ▼
              ┌──────────────┐
              │ Query Engine │
              └──────┬───────┘
            ┌────────┼────────┐
            ▼        ▼        ▼
     ┌──────────┐┌──────┐┌──────────┐
     │   FTS    ││Index ││   Vec    │
     └────┬─────┘└──┬───┘└────┬─────┘
          └─────────┼─────────┘
                    ▼
             ┌──────────────┐
             │     MVCC     │
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │  Document    │
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │   Storage    │
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │ Buffer Pool  │
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │     WAL      │
             └──────┬───────┘
                    ▼
             ┌──────────────┐
             │  I/O Layer   │
             └──────────────┘
```

Build order (no cycles allowed): I/O → WAL → Buffer Pool → Storage →
Document → MVCC → Index/FTS/Vec → Query Engine → API → Bindings →
Plugins/REST.

---

## 5. Target Platform Matrix

| Platform           | Architecture | Tier    | Build target              | Notes                                |
|--------------------|--------------|---------|---------------------------|--------------------------------------|
| Linux              | x86_64       | Tier 1  | `x86_64-unknown-linux-gnu`| Primary CI.                          |
| Linux              | aarch64      | Tier 1  | `aarch64-unknown-linux-gnu`| RPi 5 / AWS Graviton CI.            |
| Linux (musl)       | x86_64       | Tier 2  | `x86_64-unknown-linux-musl`| Static binary for Alpine/distroless.|
| Windows            | x86_64       | Tier 1  | `x86_64-pc-windows-msvc`  | IOCP backend.                        |
| Windows            | aarch64      | Tier 2  | `aarch64-pc-windows-msvc` | Surface Pro X / WoA.                 |
| macOS              | x86_64       | Tier 2  | `x86_64-apple-darwin`     | Maintenance only (Apple deprecated). |
| macOS              | aarch64      | Tier 1  | `aarch64-apple-darwin`    | Apple Silicon, kqueue backend.       |
| FreeBSD            | x86_64       | Tier 3  | `x86_64-unknown-freebsd`  | Best-effort.                         |
| WASM (browser)     | wasm32       | Tier 1  | `wasm32-unknown-unknown`  | OPFS persistence, IndexedDB fallback.|
| WASM (WASI)        | wasm32       | Tier 2  | `wasm32-wasi`             | Wasmtime / Wasmer host.              |
| iOS                | aarch64      | Tier 3  | via FFI                   | Static lib.                          |
| Android            | aarch64      | Tier 3  | via JNI                   | Static lib.                          |

**Tier definitions:**

- **Tier 1:** Full CI matrix on every PR (build + unit + integration +
  benchmarks). Released binaries published.
- **Tier 2:** CI build + unit on every PR. Released binaries published.
- **Tier 3:** Best-effort; nightly build only. No release binaries.

---

## 6. Performance Targets (v1.0 acceptance criteria)

Targets are the **floor**, not the ceiling. Hardware reference: Intel
i7-13700K (8P+8E), 32 GB DDR5-5600, Samsung 990 Pro NVMe SSD, Linux 6.6,
Tokio multi-threaded runtime with 8 worker threads.

### 6.1 Throughput (sustained, single-process)

| Operation                    | Target | Stretch | Workload notes                 |
|------------------------------|-------:|--------:|--------------------------------|
| Point insert (sync, fsync)   | 25k/s  | 50k/s   | 256 B doc, group commit 1 ms.  |
| Point insert (sync, no fsync)| 250k/s | 500k/s  | Group commit only, durable.    |
| Point read (cached)          | 1.0 M/s| 2.0 M/s | Hot buffer pool, B+ leaf hit.  |
| Point read (cold)            | 80k/s  | 150k/s  | Buffer pool miss, NVMe random. |
| Range scan (cached, 1 KB)    | 200 MB/s| 400 MB/s | Sequential B+ leaves.         |
| Update (in-place HOT)        | 50k/s  | 100k/s  | Unindexed-field update.        |
| Update (with index touch)    | 20k/s  | 40k/s   | Indexed field updated.         |
| Delete (single)              | 30k/s  | 60k/s   | Tombstone + index cleanup.     |
| FTS query (10-term BM25)     | 5k/s   | 15k/s   | 1 M doc corpus, posting-list   |
|                              |        |         | hit ratio 70%.                 |
| Vector search (HNSW, M=16)   | 8k/s   | 20k/s   | 1 M × 768-dim, recall@10 ≥0.97.|

### 6.2 Latency (P50 / P95 / P99 in microseconds)

| Operation                  | P50  | P95   | P99   |
|----------------------------|------|-------|-------|
| Point read (cached)        | 1    | 5     | 25    |
| Point read (cold, NVMe)    | 90   | 250   | 800   |
| Point insert (group commit)| 30   | 150   | 1500¹ |
| Update (HOT)               | 25   | 120   | 1000  |
| FTS query                  | 200  | 1200  | 8000  |
| HNSW search (top-10)       | 150  | 700   | 3000  |

¹ Tail spikes are dominated by checkpoint flush and WAL rotation; we
bound them with an admission-controlled checkpoint scheduler (see
`[[FILE-02]]` §6).

### 6.3 Storage overhead

- **Document overhead:** ≤ 5% over raw payload size for ≥ 256 B docs.
- **Index overhead:** ≤ 30% of indexed field size (excluding overhead) for
  unique B+ Tree, ≤ 50% for FTS.
- **WAL retention:** ≤ 2× working set size before forced checkpoint.
- **Free space amplification:** ≤ 1.4× live data (driven by vacuum).
- **Compression ratio:** target 2.5× average across mixed JSON workloads
  using LZ4 default; 3.5× with Zstd-3, 4.5× with Zstd-19 + dict.

### 6.4 Memory budget defaults

| Component         | Default   | Min      | Max         |
|-------------------|-----------|----------|-------------|
| Buffer pool       | 256 MB    | 8 MB     | 16 GB       |
| MemTable          | 64 MB     | 1 MB     | 1 GB        |
| Sort scratch      | 32 MB     | 256 KB   | spill-to-disk |
| Hash agg table    | 64 MB     | 256 KB   | spill-to-disk |
| FTS posting cache | 16 MB     | 256 KB   | 256 MB      |
| Vector index RAM  | 128 MB    | 32 MB    | 4 GB        |
| Plugin (per WASM) | 16 MB     | 1 MB     | 256 MB      |

All values configurable via pragma; see `[[FILE-13]]` §3.

### 6.5 Embedded MCU profile (oblivinx3x-embedded)

For ESP32-S3 / Cortex-M7 / RPi Zero class hardware:

- Total RAM footprint ≤ 2 MB.
- Buffer pool ≤ 256 KB.
- No vector index, no FTS, no plugins, no async I/O.
- Single-writer only, no MVCC version chain (just snapshot isolation
  via shadow row).
- Page size 4096 (one Flash page).

---

## 7. Full Feature Matrix (90+ Features)

Status legend: **CORE** (must ship for v1.0), **EXTENDED** (post-1.0
focus), **FUTURE** (research / staffing dependent).

| ID            | Feature                                       | Status   | Target ver |
|---------------|-----------------------------------------------|----------|-----------|
| OBX-FEAT-001  | Single-file `.ovn2` storage format            | CORE     | v0.1      |
| OBX-FEAT-002  | Page-based B+ Tree (8 KB pages)               | CORE     | v0.1      |
| OBX-FEAT-003  | Buffer pool with ARC eviction                 | CORE     | v0.1      |
| OBX-FEAT-004  | Pin/unpin API for pages                       | CORE     | v0.1      |
| OBX-FEAT-005  | Free-page management (freelist)               | CORE     | v0.1      |
| OBX-FEAT-006  | Overflow page chains for large values         | CORE     | v0.1      |
| OBX-FEAT-007  | Per-page CRC32C checksum                      | CORE     | v0.1      |
| OBX-FEAT-008  | WAL with group commit                         | CORE     | v0.1      |
| OBX-FEAT-009  | Crash recovery (WAL replay)                   | CORE     | v0.1      |
| OBX-FEAT-010  | Checkpoint (PASSIVE, FULL, RESTART, TRUNCATE) | CORE     | v0.1      |
| OBX-FEAT-011  | OBE document binary encoding                  | CORE     | v0.1      |
| OBX-FEAT-012  | Document type system (Null, Bool, Int*, …)   | CORE     | v0.1      |
| OBX-FEAT-013  | ObjectID (12-byte time + random + counter)    | CORE     | v0.1      |
| OBX-FEAT-014  | CRUD: insert / get / update / delete           | CORE     | v0.1      |
| OBX-FEAT-015  | Primary key index                              | CORE     | v0.1      |
| OBX-FEAT-016  | Single-field secondary index (B+)              | CORE     | v0.2      |
| OBX-FEAT-017  | Compound index (multi-field B+)                | CORE     | v0.2      |
| OBX-FEAT-018  | Sparse index (presence bitmap)                 | CORE     | v0.2      |
| OBX-FEAT-019  | Partial index (filter expression)              | CORE     | v0.2      |
| OBX-FEAT-020  | Unique constraint                              | CORE     | v0.2      |
| OBX-FEAT-021  | OQL parser & lexer                             | CORE     | v0.2      |
| OBX-FEAT-022  | MQL operators: $eq, $ne, $gt, $gte, $lt, $lte | CORE     | v0.2      |
| OBX-FEAT-023  | MQL operators: $in, $nin                       | CORE     | v0.2      |
| OBX-FEAT-024  | MQL logical: $and, $or, $not, $nor             | CORE     | v0.2      |
| OBX-FEAT-025  | MQL element: $exists, $type                    | CORE     | v0.2      |
| OBX-FEAT-026  | MQL array: $all, $elemMatch, $size              | CORE     | v0.2      |
| OBX-FEAT-027  | MQL update: $set, $unset, $inc, $mul            | CORE     | v0.2      |
| OBX-FEAT-028  | MQL update: $push, $pull, $addToSet, $pop       | CORE     | v0.2      |
| OBX-FEAT-029  | Aggregation: $match, $project, $sort, $limit, $skip | CORE | v0.2     |
| OBX-FEAT-030  | Aggregation: $group with accumulators           | CORE     | v0.2      |
| OBX-FEAT-031  | Aggregation: $unwind, $lookup, $count           | CORE     | v0.2      |
| OBX-FEAT-032  | EXPLAIN output (JSON tree, costs)               | CORE     | v0.2      |
| OBX-FEAT-033  | Cost-based query planner                        | CORE     | v0.2      |
| OBX-FEAT-034  | Histogram-based statistics                      | CORE     | v0.2      |
| OBX-FEAT-035  | Index intersection                              | EXTENDED | v0.6      |
| OBX-FEAT-036  | Covering index detection                        | CORE     | v0.2      |
| OBX-FEAT-037  | Full-text search (BM25)                         | CORE     | v0.3      |
| OBX-FEAT-038  | FTS tokenizer pipeline                          | CORE     | v0.3      |
| OBX-FEAT-039  | FTS stop words (ID + EN)                        | CORE     | v0.3      |
| OBX-FEAT-040  | FTS Porter / Sastrawi stemmer                   | CORE     | v0.3      |
| OBX-FEAT-041  | FTS phrase, prefix, wildcard, boolean queries   | CORE     | v0.3      |
| OBX-FEAT-042  | FTS fuzzy (Levenshtein via BK-tree)             | CORE     | v0.3      |
| OBX-FEAT-043  | FTS highlight & snippet                         | CORE     | v0.3      |
| OBX-FEAT-044  | TTL index                                       | CORE     | v0.3      |
| OBX-FEAT-045  | JSON path index                                 | CORE     | v0.3      |
| OBX-FEAT-046  | Hash index                                      | EXTENDED | v0.6      |
| OBX-FEAT-047  | AES-256-GCM-SIV encryption at rest              | CORE     | v0.4      |
| OBX-FEAT-048  | Argon2id key derivation                         | CORE     | v0.4      |
| OBX-FEAT-049  | Key rotation                                    | CORE     | v0.4      |
| OBX-FEAT-050  | RBAC user / role / permission model             | CORE     | v0.4      |
| OBX-FEAT-051  | JWT authentication (RS256)                      | CORE     | v0.4      |
| OBX-FEAT-052  | Session refresh tokens                          | CORE     | v0.4      |
| OBX-FEAT-053  | Audit log with HMAC chain                       | CORE     | v0.4      |
| OBX-FEAT-054  | Rate limiting (token bucket)                    | CORE     | v0.4      |
| OBX-FEAT-055  | Query parameterization (no string interp)       | CORE     | v0.4      |
| OBX-FEAT-056  | Field-level encryption (deterministic & random) | EXTENDED | v0.5      |
| OBX-FEAT-057  | Row-level security policies                     | EXTENDED | v0.5      |
| OBX-FEAT-058  | Secure delete (DOD 5220 + crypto-erase)         | EXTENDED | v0.5      |
| OBX-FEAT-059  | Integrity check (Merkle)                        | EXTENDED | v0.5      |
| OBX-FEAT-060  | Vector index HNSW                               | CORE     | v0.5      |
| OBX-FEAT-061  | Vector distance: cosine / euclidean / dot       | CORE     | v0.5      |
| OBX-FEAT-062  | Hybrid keyword + vector search (RRF)            | EXTENDED | v0.5      |
| OBX-FEAT-063  | Geospatial R-tree                               | EXTENDED | v0.5      |
| OBX-FEAT-064  | $near, $geoWithin, $geoIntersects               | EXTENDED | v0.5      |
| OBX-FEAT-065  | CRDT LWW-Register                               | EXTENDED | v0.5      |
| OBX-FEAT-066  | CRDT OR-Set                                     | EXTENDED | v0.5      |
| OBX-FEAT-067  | CRDT PN-Counter                                 | EXTENDED | v0.5      |
| OBX-FEAT-068  | CRDT LWW-Map                                    | EXTENDED | v0.5      |
| OBX-FEAT-069  | Reactive query (change observer)                | EXTENDED | v0.5      |
| OBX-FEAT-070  | WASM plugin host (Wasmtime)                     | EXTENDED | v0.5      |
| OBX-FEAT-071  | Plugin types: tokenizer / UDF / trigger / index | EXTENDED | v0.5      |
| OBX-FEAT-072  | REST/HTTP API                                   | EXTENDED | v0.5      |
| OBX-FEAT-073  | WebSocket change stream                         | EXTENDED | v0.5      |
| OBX-FEAT-074  | MVCC snapshot isolation                         | CORE     | v0.6      |
| OBX-FEAT-075  | MVCC SSI (serializable snapshot isolation)      | EXTENDED | v0.6      |
| OBX-FEAT-076  | BEGIN CONCURRENT multi-writer                   | EXTENDED | v0.6      |
| OBX-FEAT-077  | Async I/O (io_uring / IOCP / kqueue)            | EXTENDED | v0.6      |
| OBX-FEAT-078  | Columnar storage mode (HTAP)                    | EXTENDED | v0.6      |
| OBX-FEAT-079  | Vectorized execution                            | EXTENDED | v0.6      |
| OBX-FEAT-080  | Dictionary compression (Zstd-dict)              | EXTENDED | v0.6      |
| OBX-FEAT-081  | Connection pool                                 | EXTENDED | v0.6      |
| OBX-FEAT-082  | Prepared statement cache                        | EXTENDED | v0.6      |
| OBX-FEAT-083  | Prometheus / OpenTelemetry metrics              | EXTENDED | v0.7      |
| OBX-FEAT-084  | Slow query log                                  | EXTENDED | v0.7      |
| OBX-FEAT-085  | Query profiler                                  | EXTENDED | v0.7      |
| OBX-FEAT-086  | Health check endpoint                           | EXTENDED | v0.7      |
| OBX-FEAT-087  | Distributed tracing                             | EXTENDED | v0.7      |
| OBX-FEAT-088  | Oplog                                           | EXTENDED | v0.8      |
| OBX-FEAT-089  | Master–replica streaming                        | EXTENDED | v0.8      |
| OBX-FEAT-090  | Point-in-time recovery                          | EXTENDED | v0.8      |
| OBX-FEAT-091  | Incremental backup                              | EXTENDED | v0.8      |
| OBX-FEAT-092  | C++ RAII wrapper                                | EXTENDED | v0.9      |
| OBX-FEAT-093  | Python bindings (pyo3)                          | EXTENDED | v0.9      |
| OBX-FEAT-094  | Go bindings (cgo)                               | EXTENDED | v0.9      |
| OBX-FEAT-095  | CLI REPL with autocomplete                      | EXTENDED | v0.9      |
| OBX-FEAT-096  | Schema migration CLI                            | EXTENDED | v0.9      |
| OBX-FEAT-097  | Browser / WASM target (OPFS)                    | EXTENDED | v0.5      |
| OBX-FEAT-098  | Searchable encryption (equality+range)          | FUTURE   | v1.1      |
| OBX-FEAT-099  | Learned index tier (PGM++ / LMG)                | FUTURE   | v1.1      |
| OBX-FEAT-100  | Calvin-style deterministic transactions         | FUTURE   | v1.2      |

---

## 8. Versioning Roadmap (compact)

For full milestone breakdown see `[[FILE-18]]`.

```
v0.1.0  Foundation     ─── 3mo  ── Storage + WAL + CRUD
v0.2.0  Query          ─── 2mo  ── Planner + indexes + MQL
v0.3.0  Search         ─── 2mo  ── FTS + JSON path + TTL
v0.4.0  Security       ─── 2mo  ── Encryption + RBAC + audit
v0.5.0  Advanced       ─── 3mo  ── Vector + geo + CRDT + plugins
v0.6.0  Performance    ─── 2mo  ── MVCC + async I/O + columnar
v0.7.0  Observability  ─── 1mo  ── Metrics + tracing + profiler
v0.8.0  Replication    ─── 2mo  ── Oplog + master–replica + PITR
v0.9.0  SDK & DX       ─── 2mo  ── Multi-language + CLI
v1.0.0  Stable         ─── 2mo  ── Audit + benchmarks + docs
                       ────────
                       Total ~21 months for one experienced developer.
```

---

## 9. Glossary Pointer

Domain terms (LSN, ObjectID, AHIT, RRF, BM25, MVCC, OBE, OBE2, etc.) are
defined in `[[FILE-19]]`. When a term first appears in a doc, link to its
glossary entry on first use.

---

## 10. Architecture Decision Records

All major design choices have a corresponding ADR. See `[[FILE-20]]/`:

- ADR-001 — Storage engine: hybrid B+ / LSM (vs LMDB CoW vs pure LSM).
- ADR-002 — WAL vs shadow paging (vs rollback journal).
- ADR-003 — Encryption: AES-256-GCM-SIV (vs vanilla GCM, ChaCha20-Poly1305).
- ADR-004 — Query language: OQL + MQL (vs SQL subset).
- ADR-005 — MVCC: per-tuple version chain in B+ leaf (vs version table).
- ADR-006 — Vector index: HNSW for ≤10 M, IVF-PQ for >50 M.
- ADR-007 — Plugin sandbox: Wasmtime (vs `dlopen`).
- ADR-008 — Compression: LZ4 default, Zstd opt-in.
- ADR-009 — Sync: CRDT LWW + OR-Set (vs OT vs strong-only).
- ADR-010 — API: C ABI as foundation, idiomatic wrappers per language.

---

## 11. Document Structure Conventions

Every `ovnplanning/NN-*.md` file uses the following section template:

```
# NN — TITLE
## 1. Purpose
## 2. Concepts and terminology
## 3. Detailed design (binary layouts, algorithms, data structures)
## 4. Algorithms (pseudocode + Rust references)
## 5. Tradeoffs and alternatives considered
## 6. Cross-references
## 7. Open questions / TODO
## 8. Compatibility notes
```

When a section is structurally absent (e.g. a doc has no "open
questions"), the heading is **kept** with a single line `None.` so cross-
referencing tooling can rely on stable anchors.

---

## 12. Cross-Reference Index (high level)

| Topic                  | Primary file       | Secondary references                |
|------------------------|--------------------|--------------------------------------|
| Page format            | `[[FILE-01]]` §3   | `[[FILE-02]]`, `[[FILE-11]]`         |
| WAL record             | `[[FILE-02]]` §2   | `[[FILE-06]]`, `[[FILE-10]]`         |
| OBE encoding           | `[[FILE-03]]` §2   | `[[FILE-04]]`, `[[FILE-08]]`         |
| Index tree layout      | `[[FILE-04]]` §3   | `[[FILE-01]]`                        |
| Query AST              | `[[FILE-05]]` §3   | `[[FILE-15]]`                        |
| Lock manager           | `[[FILE-06]]` §6   | `[[FILE-10]]` §2                     |
| RBAC schema            | `[[FILE-07]]` §4   | `[[FILE-13]]` §5                     |
| Tokenizer pipeline     | `[[FILE-08]]` §2   | `[[FILE-04]]` §FTS                   |
| CRDT types             | `[[FILE-09]]` §3   | `[[FILE-06]]`                        |
| Threading              | `[[FILE-10]]` §1   | `[[FILE-02]]` §6                     |
| Compression decision   | `[[FILE-11]]` §3   | `[[FILE-01]]` §11, `[[FILE-20]]`/008 |
| Metric registry        | `[[FILE-12]]` §3   | `[[FILE-13]]`                        |
| C / C++ / REST API     | `[[FILE-13]]` §1-7 | `[[FILE-15]]`                        |
| Plugin ABI             | `[[FILE-14]]` §3   | `[[FILE-13]]`                        |
| OQL grammar (EBNF)     | `[[FILE-15]]` §1   | `[[FILE-05]]`                        |
| Build pipeline         | `[[FILE-16]]` §3   | `[[FILE-17]]`                        |
| Test pyramid           | `[[FILE-17]]` §1   | all                                  |
| Roadmap                | `[[FILE-18]]` §1   | this file §8                         |
| Glossary               | `[[FILE-19]]`      | all                                  |
| ADRs                   | `[[FILE-20]]/*`    | all                                  |

---

## 13. Open Questions

(Master file only; subsystem-specific opens live in their own file.)

1. **Single-file vs sharded files at scale (>1 TB).** Current decision:
   keep single-file; plan an "OVN-archive" mode in v1.2 that lazily
   migrates cold partitions to per-month files.
2. **Rust toolchain MSRV.** Locked at 1.78 as of 2026-04-27; revisit at
   the start of every minor release.
3. **WASM threading.** `wasm32-unknown-unknown` lacks shared memory by
   default. We currently bypass MVCC (single-writer only) on this target;
   evaluate `wasm32-unknown-emscripten` + SharedArrayBuffer for v1.1.
4. **Apple File System fsync semantics.** `fcntl(F_FULLFSYNC)` is
   required for true durability; we should auto-detect and warn if the
   filesystem is HFS+ rather than APFS.

---

## 14. Compatibility Notes

- v0.x → v1.0: file format may break. Versions before 1.0 do **not**
  carry the file-format compatibility guarantee; users must re-import.
- v1.0 → v1.x: file format is forward-compatible (older readers ignore
  unknown OBE2 type tags ≥ 0x10) and backward-compatible (newer readers
  can read v1.0 files).
- v1.x → v2.0: a one-time `db.migrate_v1_v2()` is required.

---

*End of `00-MASTER-SPEC.md` — 539 lines.*
