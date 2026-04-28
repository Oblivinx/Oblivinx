# 18 — ROADMAP & MILESTONES

> **Audience:** Project leads, contributors planning work, downstream integrators forecasting capabilities.
> **Status:** Living plan; revised at the end of each minor release.
> **Cross refs:** All 00–17 (this is the implementation timeline for the architecture defined elsewhere).

---

## 1. Release model

* **Time-based + scope gated**: each minor release targets ~10–14 weeks but ships when its quality bar is met.
* **0.x.y** series: breaking changes allowed in minor; SemVer strictness begins at 1.0.
* **LTS:** 1.0 will be designated LTS for 18 months; subsequent LTS each year.
* **Release types**:
  * `α` (alpha) — internal only, daily nightly available
  * `β` (beta) — public, no SLA
  * `RC` (release candidate) — feature-frozen, only blocker fixes
  * stable

The roadmap below is **goal-driven**: each milestone names its theme and the user value it delivers.

---

## 2. Milestone summary table

| Version  | Theme                                | Target window     | Status        |
| -------- | ------------------------------------ | ----------------- | ------------- |
| v0.1     | Embedded engine MVP                  | Q2 2026           | in progress   |
| v0.2     | Compression + indexes                | Q3 2026           | planned       |
| v0.3     | Query language + MVCC                | Q4 2026           | planned       |
| v0.4     | Observability + REST sidecar         | Q1 2027           | planned       |
| v0.5     | Replication + sync                   | Q2 2027           | planned       |
| v0.6     | Plugins (WASM)                       | Q3 2027           | planned       |
| v0.7     | Vector + FTS + hybrid                | Q4 2027           | planned       |
| v0.8     | Security hardening + KMS             | Q1 2028           | planned       |
| v0.9     | Performance + distributions          | Q2 2028           | planned       |
| v1.0     | Stability LTS                        | Q3 2028           | planned       |

---

## 3. Milestone v0.1 — Embedded engine MVP

**Goal:** A single-file embedded document database opens, accepts inserts/finds, survives crashes.

### 3.1 Scope (must ship)

* [ ] `.ovn2` file format with header, pages, freelist `[[FILE-01]]` §3–§7
* [ ] Buffer pool (LRU first, ARC by v0.3) `[[FILE-01]]` §6
* [ ] WAL with group commit + fsync `[[FILE-02]]` §3
* [ ] OBE encoding for primitive types + nested objects `[[FILE-03]]` §2–§5
* [ ] B+ Tree primary index (IOT) for `_id` `[[FILE-04]]` §3
* [ ] Single-collection CRUD: `insert_one`, `find`, `update_one` (replace), `delete_one`
* [ ] Crash recovery from WAL replay `[[FILE-02]]` §6
* [ ] Rust + Node.js (Neon) bindings
* [ ] Basic CLI: `ovn open`, `ovn shell`
* [ ] Unit tests + crash recovery tests baseline `[[FILE-17]]` §9

### 3.2 Out of scope

* Compression, secondary indexes, MVCC, plugins, replication, OQL
* Full-text, vector, encryption
* Multi-collection transactions

### 3.3 Acceptance criteria

* Open/close 10,000 cycles → no leaks (LeakSanitizer green)
* Insert 100k docs → close → kill -9 mid-fsync → reopen → invariants hold (§9.3 of testing)
* P99 insert < 1 ms on local NVMe (sync mode)

---

## 4. Milestone v0.2 — Compression + indexes

**Goal:** The engine becomes useful for read-heavy workloads with secondary indexes; on-disk size shrinks.

### 4.1 Scope

* [ ] LZ4 page compression `[[FILE-11]]` §3.1, §5
* [ ] Secondary B+ index (single-key, multi-key arrays) `[[FILE-04]]` §4
* [ ] Composite indexes `[[FILE-04]]` §4.3
* [ ] Sparse + partial indexes `[[FILE-04]]` §4.4
* [ ] TTL indexes with reaper job `[[FILE-04]]` §4.5
* [ ] `update_one` with operators: `$set`, `$inc`, `$push`, `$unset`
* [ ] `bulk_write`
* [ ] `find_many` with filter, sort, limit, skip
* [ ] Index hint API
* [ ] Background index builder
* [ ] LRU → ARC buffer pool swap `[[FILE-01]]` §6
* [ ] Per-platform durability: `F_FULLFSYNC` macOS, `FILE_FLAG_WRITE_THROUGH` Win

### 4.2 Out of scope

* OQL, MVCC, replication

### 4.3 Acceptance

* YCSB workload C (read 100%) on 10 GB DB: ≥ 50k qps single thread
* Compression ratio on en.wiki sample ≥ 2.0×
* All indexes survive crash recovery (deterministic property tests)

---

## 5. Milestone v0.3 — Query language + MVCC

**Goal:** Users write **OQL**; reads/writes can be wrapped in real transactions.

### 5.1 Scope

* [ ] OQL lexer + parser → AST `[[FILE-15]]`
* [ ] Logical plan + cost-based planner `[[FILE-05]]` §4–§6
* [ ] Volcano + vectorized execution hybrid `[[FILE-05]]` §7
* [ ] Aggregation pipeline stages: `$match`, `$project`, `$group`, `$sort`, `$limit`, `$skip`, `$unwind`, `$count`
* [ ] MQL surface kept as alias (lowering to same AST)
* [ ] MVCC version chains, snapshot reads `[[FILE-06]]` §3–§4
* [ ] Isolation: read-committed + snapshot
* [ ] OCC commit with first-writer-wins `[[FILE-06]]` §6
* [ ] `BEGIN` / `COMMIT` / `ROLLBACK` / savepoints
* [ ] Plan cache + EXPLAIN `[[FILE-12]]` §6
* [ ] Zstd compression option

### 5.2 Acceptance

* TPC-C-lite ACID-correct under 10 concurrent writers
* Plan cache hit ratio ≥ 90% on stable workload
* `EXPLAIN ANALYZE` matches actual rows examined to within ±10%

---

## 6. Milestone v0.4 — Observability + REST sidecar

**Goal:** Operators can run, observe, and remotely access the engine.

### 6.1 Scope

* [ ] Metrics registry as defined in `[[FILE-12]]` §3
* [ ] Prometheus exposition + structured JSON logs
* [ ] Slow query log `[[FILE-12]]` §5
* [ ] OpenTelemetry traces `[[FILE-12]]` §7
* [ ] `ovnsd` REST sidecar with all v1 endpoints `[[FILE-13]]` §7
* [ ] Health endpoints `[[FILE-12]]` §9
* [ ] Admin commands: status, queries, kill `[[FILE-12]]` §12
* [ ] WebSocket watch `[[FILE-13]]` §8
* [ ] Suggested Grafana dashboards committed under `monitoring/`

### 6.2 Acceptance

* `obx_*` metric names stable across PR builds (golden conformance)
* Slow query log captures both threshold-based and sampled entries
* REST passes OpenAPI conformance suite

---

## 7. Milestone v0.5 — Replication + sync

**Goal:** Master/replica replication for availability; offline-first sync gateway for mobile/edge.

### 7.1 Scope

* [ ] Oplog projection from WAL `[[FILE-09]]` §2
* [ ] Replication wire protocol v1 (HELLO/AUTH/OPLOG_REQUEST/BATCH/ACK) `[[FILE-09]]` §4
* [ ] Initial snapshot streaming `[[FILE-09]]` §4.4
* [ ] Steady-state oplog tailing
* [ ] Ack levels: none / replica / quorum / all
* [ ] Replica lag metrics + health states `[[FILE-09]]` §8
* [ ] PITR with binary-search time index `[[FILE-09]]` §9
* [ ] Incremental backup format `[[FILE-09]]` §10
* [ ] HLC implementation in `ovn-mvcc` `[[FILE-06]]` §13
* [ ] Gateway sync (mobile/edge) — WebSocket transport `[[FILE-09]]` §7

### 7.2 Acceptance

* Replica catches up after 1 GB of accumulated changes in < 60 s
* PITR restores within ±1 ms of target wall-clock
* Network partition test: no committed write lost; no uncommitted write visible

---

## 8. Milestone v0.6 — Plugins (WASM)

**Goal:** Users extend the engine without recompiling.

### 8.1 Scope

* [ ] Wasmtime host integration with capability gating `[[FILE-14]]` §5–§7
* [ ] Plugin types: tokenizer, scalar UDF, aggregate UDF, trigger, validator, custom index `[[FILE-14]]` §3
* [ ] Manifest format + signature verification `[[FILE-14]]` §6
* [ ] Instance pooling `[[FILE-14]]` §9
* [ ] Hot reload `[[FILE-14]]` §10
* [ ] Resource limits + quarantine `[[FILE-14]]` §8, §16
* [ ] Rust SDK (`oblivinx-plugin-sdk`) with macros
* [ ] AssemblyScript SDK
* [ ] Sample plugins shipped: Japanese tokenizer, audit trigger, geo-score UDF

### 8.2 Acceptance

* Plugin call P50 < 50 µs on hot path
* Misbehaving plugin (infinite loop / OOM) bounded; engine unaffected
* Hot reload: 0 dropped requests in load test

---

## 9. Milestone v0.7 — Vector + FTS + hybrid search

**Goal:** Full-text and vector search become first-class with RRF hybrid.

### 9.1 Scope

* [ ] FTS inverted index, English + Indonesian analyzers `[[FILE-08]]` §3, §6
* [ ] BM25 scoring + WAND skip lists `[[FILE-08]]` §7
* [ ] Phrase / boolean / prefix / wildcard / fuzzy / proximity queries
* [ ] Highlighter
* [ ] HNSW vector index `[[FILE-04]]` §6
* [ ] Quantization tiers (None/F16/INT8/RaBitQ)
* [ ] `VECTOR_SEARCH(...)` and `FTS(...)` table functions in OQL `[[FILE-15]]` §10
* [ ] RRF hybrid scoring `[[FILE-08]]` §10
* [ ] Suggestions / spell-correct
* [ ] Synonym dictionaries

### 9.2 Acceptance

* HNSW recall@10 ≥ 0.95 on SIFT-1M
* FTS bench: 5k qps on Wikipedia 1M
* Hybrid query: combined plan EXPLAIN matches expected RRF formula

---

## 10. Milestone v0.8 — Security hardening + KMS

**Goal:** Enterprise-ready: at-rest encryption, RBAC, audit, KMS, FLE.

### 10.1 Scope

* [ ] Page-level AES-256-GCM-SIV with HKDF sub-keys `[[FILE-07]]` §3
* [ ] Argon2id KDF for master key `[[FILE-07]]` §4
* [ ] Key rotation via WAL_REC_KEY_ROTATION `[[FILE-07]]` §4.4
* [ ] External KMS integrations: AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault `[[FILE-07]]` §4.5
* [ ] Field-level encryption (deterministic + randomized) `[[FILE-07]]` §5
* [ ] TLS 1.3 for all network surfaces `[[FILE-07]]` §3 + replication `[[FILE-09]]` §11
* [ ] RBAC + JWT sessions `[[FILE-07]]` §6
* [ ] Row-level security policies `[[FILE-07]]` §7
* [ ] HMAC-chained audit log `[[FILE-07]]` §10
* [ ] Rate limiting + parameterized queries `[[FILE-07]]` §8

### 10.2 Acceptance

* Cryptographic test vectors pass (NIST KAT)
* AWS KMS integration test green in CI (real account)
* Audit chain verifies via `ovn admin audit verify`

---

## 11. Milestone v0.9 — Performance + distributions

**Goal:** Final performance pass; ship to all packaging channels.

### 11.1 Scope

* [ ] io_uring backend on Linux ≥ 5.10
* [ ] OCC fast-path on hot B-tree leaves `[[FILE-10]]` §5.4
* [ ] NUMA-aware buffer pool partitioning
* [ ] Hybrid columnar mode for cold partitions `[[FILE-01]]` §10
* [ ] Gorilla / FOR / Dict columnar codecs `[[FILE-11]]` §7
* [ ] Bloom filter sidecars
* [ ] Macro benches green vs baseline budget
* [ ] All tier-1 + tier-2 platform binaries via release pipeline `[[FILE-16]]` §8.3
* [ ] Docker images for x86_64 + arm64
* [ ] PyPI / Homebrew / Chocolatey publish jobs

### 11.2 Acceptance

* P99 read latency on cached pages < 10 µs single-threaded
* TSan / ASan / MSan all green in nightly
* Reproducible build verifies byte-identical

---

## 12. Milestone v1.0 — Stability LTS

**Goal:** Frozen public API + format; first long-term-support release.

### 12.1 Scope

* [ ] All file/wire/ABI formats locked under SemVer rules
* [ ] Forward-compatibility tests (v1.0 reads v0.9 files; v0.9 reader rejects v1.0 cleanly)
* [ ] Documentation site complete (mdBook + API ref + tutorials)
* [ ] Migration guide from each 0.x → 1.0
* [ ] Jepsen full pass (single-master + multi-master + sync)
* [ ] Public benchmark report on standardized hardware
* [ ] LTS branch policy + back-port lane
* [ ] Conformance test suite published as standalone crate

### 12.2 Acceptance

* No Sev-1 issues open for 30 days
* All P99 SLO targets in `[[FILE-00]]` met on reference hardware
* Three independent integrations confirm production readiness

---

## 13. Post-1.0 candidates (parking lot)

Not yet committed to a release; tracked for future planning:

* Sharded write coordinators (multi-node single-master extension)
* GPU-accelerated vector index (CUDA / Metal)
* SQL-99 compatibility mode (richer joins, recursive CTEs)
* Time-travel queries (`AS OF TIMESTAMP`)
* Graph traversal syntax (Cypher-like)
* Peer-to-peer mesh discovery (mDNS / DNS-SD)
* Materialized views with incremental maintenance
* Multi-tenant resource governance
* WASI Preview 2 plugins with interface types
* ARM SVE / x86 AVX-512 SIMD paths in HNSW
* Streaming export to data warehouses (Iceberg, Delta)

---

## 14. Critical path & dependency graph

```
v0.1 (engine MVP)
  ├─► v0.2 (indexes + compression)
  │       └─► v0.7 (FTS + Vector + Hybrid)
  └─► v0.3 (OQL + MVCC)
          ├─► v0.4 (Observability + REST)
          │       └─► v0.5 (Replication + Sync)
          │               └─► v0.8 (Security + KMS)
          └─► v0.6 (Plugins)
                  └─► v0.9 (Perf + Distros)
                          └─► v1.0 (LTS)
```

* v0.5 cannot start before v0.3 (needs MVCC for HLC visibility) and v0.4 (needs metrics for replica health).
* v0.6 plugins need v0.3 (UDFs in OQL) but can run in parallel with v0.4.
* v0.7 vector/FTS depends on v0.2 (indexes) but is independent of MVCC, so it can also overlap with v0.5.

---

## 15. Risk register (per-release headline risks)

| Release | Top risk                                                         | Mitigation                                              |
| ------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| v0.1    | Crash recovery edge cases on Windows                             | dm-flakey-equivalent (Windows: power-loss VM tests)     |
| v0.2    | Background index build under concurrent writes                   | Property tests; consistent crash recovery hooks         |
| v0.3    | Planner cost model regressions                                   | Macro benches gating; planner JSON conformance          |
| v0.4    | OTel exporter dependency churn                                   | Pin OTel versions; isolated `metrics` feature           |
| v0.5    | Replication corner cases (split brain, clock skew)               | Jepsen suite; HLC cap on physical skew                  |
| v0.6    | Wasmtime ABI churn between minor versions                        | Pin wasmtime to LTS branch                              |
| v0.7    | HNSW recall regressions on quantized indexes                     | Recall benches; per-tier ground-truth gating            |
| v0.8    | KMS provider outages → engine unable to open                     | Local fallback key wrap; offline mode                   |
| v0.9    | io_uring kernel bugs on certain distros                          | Threadpool fallback; opt-in flag                        |
| v1.0    | Premature freeze locking in suboptimal API                       | Public RC period ≥ 60 days; LTS branch can iterate     |

---

## 16. Definition of Done (per milestone)

A milestone is **done** only if all of the following hold:

* [ ] All scoped checkboxes ticked.
* [ ] Acceptance criteria measured and met.
* [ ] Documentation updated for new surfaces (CLAUDE.md, mdBook chapters, API ref).
* [ ] CHANGELOG entry written.
* [ ] Migration notes added to `docs/migrations/<from>-to-<to>.md` if breaking.
* [ ] Conformance / golden tests updated.
* [ ] CI green on all tier-1 platforms; tier-2 smoke green.
* [ ] No Sev-1 / Sev-2 known issues at release tag.
* [ ] Public release notes posted.

---

## 17. Cross-references

* `[[FILE-00]]` master spec — feature matrix this roadmap implements.
* `[[FILE-01]]`–`[[FILE-15]]` — design specs scoped per release.
* `[[FILE-16]]` — build & release pipeline aligned with milestones.
* `[[FILE-17]]` — testing strategy gates each release.
* `[[FILE-19]]` — glossary for any terms used here.
* `[[FILE-20]]` — ADRs that may unlock or block specific milestones.

*End of `18-ROADMAP-MILESTONES.md` — 470 lines.*
