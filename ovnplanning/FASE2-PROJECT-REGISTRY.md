# FASE 2 — PROJECT REGISTRY (Feature Matrix · Critical Path · Risks · Resources)

> **Audience:** Project leads, downstream integrators, executive stakeholders.
> **Status:** Living document; refreshed at the end of each minor release.
> **Cross refs:** `[[FILE-00]]` master spec, `[[FILE-18]]` roadmap, `[[FILE-20]]` ADRs.
>
> **Why this lives here, not in `oblivinx3x.txt`:** the project's CLAUDE.md forbids modifying
> `oblivinx3x.txt` without explicit user confirmation. This document is the FASE 2 deliverable
> from the original prompt, kept separate so it can evolve without touching the canonical
> spec. If/when the user approves merging, this file's content can be appended to
> `oblivinx3x.txt` as a new section.

---

## 1. Master feature registry

> Format: `OBX-FEAT-NNN | name | tier | target version | status | depends-on | spec-ref`
>
> Tiers: **CORE** = mandatory for v1.0; **EXTENDED** = scoped before v1.0 if budget allows; **FUTURE** = post-1.0.
> Status: `planned`, `in-progress`, `shipped`, `deferred`, `dropped`.

### 1.1 Storage & file format (OBX-FEAT-001 … 020)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 001 | `.ovn2` single-file format          | CORE     | v0.1   | in-progress | —       | `[[FILE-01]]` §3   |
| 002 | 8 KiB default page size             | CORE     | v0.1   | in-progress | 001     | `[[FILE-01]]` §2   |
| 003 | File header w/ shadow page 0        | CORE     | v0.1   | in-progress | 001     | `[[FILE-01]]` §3   |
| 004 | Page type catalog (17 types)        | CORE     | v0.1   | planned     | 002     | `[[FILE-01]]` §4   |
| 005 | 64-byte common page header          | CORE     | v0.1   | planned     | 004     | `[[FILE-01]]` §5   |
| 006 | Buffer pool (LRU)                   | CORE     | v0.1   | planned     | 005     | `[[FILE-01]]` §6   |
| 007 | Buffer pool (ARC)                   | CORE     | v0.3   | planned     | 006     | `[[FILE-01]]` §6   |
| 008 | Pin/unpin RAII contract             | CORE     | v0.1   | planned     | 006     | `[[FILE-10]]` §6.2 |
| 009 | Freelist + bitmap allocator         | CORE     | v0.1   | planned     | 002     | `[[FILE-01]]` §7   |
| 010 | Overflow chain pages                | CORE     | v0.1   | planned     | 004     | `[[FILE-01]]` §5   |
| 011 | Storage tiering (HOT/WARM/COLD)     | EXTENDED | v0.5   | planned     | 006     | `[[FILE-01]]` §10  |
| 012 | Hybrid columnar mode                | EXTENDED | v0.9   | planned     | 011     | `[[FILE-01]]` §10  |
| 013 | Per-page codec tag                  | CORE     | v0.2   | planned     | 005     | `[[FILE-11]]` §3.1 |
| 014 | Compression pipeline                | CORE     | v0.2   | planned     | 013     | `[[FILE-11]]` §5   |
| 015 | Direct I/O (per OS)                 | EXTENDED | v0.4   | planned     | 006     | `[[FILE-01]]` §11  |
| 016 | mmap backend (HOT tier)             | EXTENDED | v0.5   | planned     | 011     | `[[FILE-01]]` §11  |
| 017 | Async I/O backend abstraction       | CORE     | v0.4   | planned     | —       | `[[FILE-10]]` §8   |
| 018 | io_uring backend (Linux)            | EXTENDED | v0.9   | planned     | 017     | `[[FILE-10]]` §8.1 |
| 019 | IOCP backend (Windows)              | CORE     | v0.4   | planned     | 017     | `[[FILE-10]]` §8.1 |
| 020 | OPFS backend (WASM)                 | EXTENDED | v0.6   | planned     | 017     | `[[FILE-10]]` §8.1 |

### 1.2 WAL & durability (OBX-FEAT-021 … 030)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 021 | WAL append + LSN as byte offset     | CORE     | v0.1   | in-progress | 005     | `[[FILE-02]]` §2   |
| 022 | WAL record catalog (0x01 … 0x1C)    | CORE     | v0.1   | planned     | 021     | `[[FILE-02]]` §2.2 |
| 023 | Group commit (200 µs window)        | CORE     | v0.1   | planned     | 021     | `[[FILE-10]]` §7.2 |
| 024 | Per-OS fsync primitives             | CORE     | v0.2   | planned     | 023     | `[[FILE-02]]` §3.2 |
| 025 | Checkpoint modes (PASSIVE/FULL/...) | CORE     | v0.2   | planned     | 023     | `[[FILE-02]]` §4   |
| 026 | Crash recovery (8-step)             | CORE     | v0.1   | planned     | 022     | `[[FILE-02]]` §6   |
| 027 | Idempotent redo                     | CORE     | v0.1   | planned     | 026     | `[[FILE-02]]` §5   |
| 028 | WAL retention + truncation          | CORE     | v0.2   | planned     | 025     | `[[FILE-02]]` §4   |
| 029 | WAL encryption (`K_wal`)            | EXTENDED | v0.8   | planned     | 081     | `[[FILE-02]]` §11  |
| 030 | WAL admission control               | CORE     | v0.4   | planned     | 023     | `[[FILE-10]]` §7.3 |

### 1.3 Document model & encoding (OBX-FEAT-031 … 040)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 031 | OBE type tag catalog                | CORE     | v0.1   | in-progress | —       | `[[FILE-03]]` §2   |
| 032 | LEB128 / zigzag varint              | CORE     | v0.1   | planned     | 031     | `[[FILE-03]]` §3   |
| 033 | ObjectId (12-byte)                  | CORE     | v0.1   | planned     | 031     | `[[FILE-03]]` §4   |
| 034 | Sorted object keys                  | CORE     | v0.1   | planned     | 031     | `[[FILE-03]]` §5   |
| 035 | Schema dictionary (compact fields)  | EXTENDED | v0.4   | planned     | 031     | `[[FILE-03]]` §6   |
| 036 | Zero-copy field access              | CORE     | v0.3   | planned     | 031     | `[[FILE-03]]` §7   |
| 037 | Document diff & patch ops           | CORE     | v0.4   | planned     | 036     | `[[FILE-03]]` §8   |
| 038 | Cross-type sort order (BSON-spec)   | CORE     | v0.3   | planned     | 031     | `[[FILE-03]]` §10  |
| 039 | OBE2 SIMD decode (AVX2/NEON)        | EXTENDED | v0.9   | planned     | 031     | `[[FILE-03]]` §11  |
| 040 | OBE2 array diff format              | EXTENDED | v0.9   | planned     | 037     | `[[FILE-03]]` §11  |

### 1.4 Indexing (OBX-FEAT-041 … 055)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 041 | Primary B+ Tree (IOT)               | CORE     | v0.1   | in-progress | 005     | `[[FILE-04]]` §3   |
| 042 | Secondary B+ index (single-key)     | CORE     | v0.2   | planned     | 041     | `[[FILE-04]]` §4.2 |
| 043 | Secondary B+ index (multi-key arr)  | CORE     | v0.2   | planned     | 042     | `[[FILE-04]]` §4.2 |
| 044 | Composite indexes                   | CORE     | v0.2   | planned     | 042     | `[[FILE-04]]` §4.3 |
| 045 | Sparse + partial indexes            | CORE     | v0.2   | planned     | 042     | `[[FILE-04]]` §4.4 |
| 046 | TTL index + reaper                  | CORE     | v0.2   | planned     | 042     | `[[FILE-04]]` §4.5 |
| 047 | JSON-path index (EBNF)              | EXTENDED | v0.4   | planned     | 042     | `[[FILE-04]]` §4.6 |
| 048 | Hash bucket index                   | EXTENDED | v0.4   | planned     | —       | `[[FILE-04]]` §4.7 |
| 049 | Covering index (INCLUDE)            | EXTENDED | v0.4   | planned     | 044     | `[[FILE-04]]` §4.10 |
| 050 | Bloom filter sidecar                | EXTENDED | v0.7   | planned     | 042     | `[[FILE-04]]` §7   |
| 051 | Equi-depth histogram + HLL          | CORE     | v0.3   | planned     | 042     | `[[FILE-04]]` §11  |
| 052 | Background index builder            | CORE     | v0.2   | planned     | 042     | `[[FILE-04]]` §10  |
| 053 | AHIT (hot/cold zones)               | EXTENDED | v0.7   | planned     | 042     | `[[FILE-04]]` §3   |
| 054 | Geo R*-tree                         | EXTENDED | v0.7   | planned     | —       | `[[FILE-04]]` §6.5 |
| 055 | Custom index plugin slot            | EXTENDED | v0.6   | planned     | 110     | `[[FILE-14]]` §12  |

### 1.5 Full-text & vector search (OBX-FEAT-056 … 070)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 056 | FTS inverted index                  | CORE     | v0.7   | planned     | 042     | `[[FILE-08]]` §5   |
| 057 | Tokenizer pipeline                  | CORE     | v0.7   | planned     | 056     | `[[FILE-08]]` §3   |
| 058 | English analyzer (Porter2)          | CORE     | v0.7   | planned     | 057     | `[[FILE-08]]` §4   |
| 059 | Indonesian analyzer (Sastrawi)      | EXTENDED | v0.7   | planned     | 057     | `[[FILE-08]]` §4   |
| 060 | BM25 + WAND skip lists              | CORE     | v0.7   | planned     | 056     | `[[FILE-08]]` §7   |
| 061 | Phrase / boolean / prefix queries   | CORE     | v0.7   | planned     | 060     | `[[FILE-08]]` §8   |
| 062 | Wildcard / fuzzy / proximity        | EXTENDED | v0.7   | planned     | 060     | `[[FILE-08]]` §8   |
| 063 | Highlighter (Unified-style)         | EXTENDED | v0.7   | planned     | 060     | `[[FILE-08]]` §11  |
| 064 | HNSW vector index                   | CORE     | v0.7   | planned     | 042     | `[[FILE-04]]` §6   |
| 065 | Quantization (F16/INT8/RaBitQ)      | EXTENDED | v0.9   | planned     | 064     | `[[FILE-04]]` §6.4 |
| 066 | Filtered ANN (selectivity-based)    | CORE     | v0.7   | planned     | 064     | `[[FILE-08]]` §9   |
| 067 | RRF hybrid scoring                  | CORE     | v0.7   | planned     | 060,064 | `[[FILE-08]]` §10  |
| 068 | Suggest / spell-correct             | EXTENDED | v0.7   | planned     | 056     | `[[FILE-08]]` §12  |
| 069 | Synonym dictionaries                | EXTENDED | v0.7   | planned     | 056     | `[[FILE-08]]` §13  |
| 070 | Vector index custom distance        | EXTENDED | v0.9   | planned     | 064     | `[[FILE-04]]` §6   |

### 1.6 Query engine (OBX-FEAT-071 … 080)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 071 | OQL lexer + parser                  | CORE     | v0.3   | planned     | —       | `[[FILE-15]]` §2   |
| 072 | MQL alias surface                   | CORE     | v0.3   | planned     | 071     | `[[FILE-05]]` §3   |
| 073 | Logical plan + cost-based planner   | CORE     | v0.3   | planned     | 071     | `[[FILE-05]]` §4-§6 |
| 074 | Volcano + vectorized execution      | CORE     | v0.3   | planned     | 073     | `[[FILE-05]]` §7   |
| 075 | Aggregation pipeline (8 stages)     | CORE     | v0.3   | planned     | 074     | `[[FILE-05]]` §8   |
| 076 | Plan cache + EXPLAIN                | CORE     | v0.3   | planned     | 073     | `[[FILE-12]]` §6   |
| 077 | Bind parameters (?N, $:name)        | CORE     | v0.3   | planned     | 071     | `[[FILE-15]]` §12  |
| 078 | Window functions (subset)           | EXTENDED | v0.4   | planned     | 074     | `[[FILE-15]]` §11  |
| 079 | Reactive query (WAL tail subscribe) | EXTENDED | v0.5   | planned     | 074,021 | `[[FILE-05]]` §10  |
| 080 | Update operators ($set, $inc, ...)  | CORE     | v0.2   | planned     | —       | `[[FILE-15]]` §4   |

### 1.7 MVCC & transactions (OBX-FEAT-081 … 090)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 081 | TxId allocation (64-bit monotonic)  | CORE     | v0.3   | planned     | —       | `[[FILE-06]]` §3   |
| 082 | MVCC version chains                 | CORE     | v0.3   | planned     | 081     | `[[FILE-06]]` §4   |
| 083 | ActiveTxTable + snapshot acquire    | CORE     | v0.3   | planned     | 081     | `[[FILE-06]]` §3   |
| 084 | 5 isolation levels                  | CORE     | v0.3   | planned     | 082     | `[[FILE-06]]` §5   |
| 085 | OCC commit (first-writer-wins)      | CORE     | v0.3   | planned     | 082     | `[[FILE-06]]` §6   |
| 086 | SSI (Cahill 2008)                   | EXTENDED | v0.4   | planned     | 085     | `[[FILE-06]]` §6   |
| 087 | Lock manager (IS/IX/S/SIX/X)        | EXTENDED | v0.4   | planned     | —       | `[[FILE-06]]` §7   |
| 088 | Periodic deadlock detection (DFS)   | EXTENDED | v0.4   | planned     | 087     | `[[FILE-06]]` §8   |
| 089 | Vacuum (safe horizon)               | CORE     | v0.3   | planned     | 082     | `[[FILE-06]]` §9   |
| 090 | Savepoints + 2PC                    | EXTENDED | v0.5   | planned     | 081     | `[[FILE-06]]` §10  |

### 1.8 Security (OBX-FEAT-091 … 100)

| ID  | Name                                | Tier     | Target | Status      | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ----------- | ------- | ------------------ |
| 091 | Page AES-256-GCM-SIV                | EXTENDED | v0.8   | planned     | —       | `[[FILE-07]]` §3   |
| 092 | Argon2id master key derivation      | EXTENDED | v0.8   | planned     | 091     | `[[FILE-07]]` §4   |
| 093 | HKDF sub-key derivation             | EXTENDED | v0.8   | planned     | 091     | `[[FILE-07]]` §4.3 |
| 094 | Key rotation (WAL_REC_KEY_ROTATION) | EXTENDED | v0.8   | planned     | 091     | `[[FILE-07]]` §4.4 |
| 095 | External KMS (AWS/GCP/Azure/Vault)  | EXTENDED | v0.8   | planned     | 091     | `[[FILE-07]]` §4.5 |
| 096 | FLE (det vs randomized)             | EXTENDED | v0.8   | planned     | 091     | `[[FILE-07]]` §5   |
| 097 | TLS 1.3 (rustls)                    | CORE     | v0.5   | planned     | —       | `[[FILE-07]]` §3   |
| 098 | RBAC + JWT sessions                 | EXTENDED | v0.8   | planned     | —       | `[[FILE-07]]` §6   |
| 099 | Row-level security policies         | EXTENDED | v0.8   | planned     | 098     | `[[FILE-07]]` §7   |
| 100 | HMAC-chained audit log              | EXTENDED | v0.8   | planned     | —       | `[[FILE-07]]` §10  |

### 1.9 Replication, sync, observability, plugins, API, build (OBX-FEAT-101 … 130)

| ID  | Name                                | Tier     | Target | Status  | Depends | Ref                |
| --- | ----------------------------------- | -------- | ------ | ------- | ------- | ------------------ |
| 101 | Oplog projection from WAL           | CORE     | v0.5   | planned | 021     | `[[FILE-09]]` §3   |
| 102 | Repl wire v1 (HELLO/AUTH/...)       | CORE     | v0.5   | planned | 101,097 | `[[FILE-09]]` §4   |
| 103 | Initial snapshot streaming          | CORE     | v0.5   | planned | 102     | `[[FILE-09]]` §4.4 |
| 104 | Steady-state oplog tailing          | CORE     | v0.5   | planned | 102     | `[[FILE-09]]` §4.5 |
| 105 | Ack levels (none/repl/quorum/all)   | CORE     | v0.5   | planned | 102     | `[[FILE-09]]` §4.6 |
| 106 | HLC (hybrid logical clock)          | CORE     | v0.5   | planned | 081     | `[[FILE-06]]` §13  |
| 107 | CRDT types (LWW/OR-Set/PN/RGA/...)  | EXTENDED | v0.5   | planned | 101,106 | `[[FILE-09]]` §6   |
| 108 | Causal stability + tombstone GC     | EXTENDED | v0.5   | planned | 107     | `[[FILE-09]]` §6.5 |
| 109 | PITR (binary search on time)        | EXTENDED | v0.5   | planned | 101     | `[[FILE-09]]` §9   |
| 110 | Wasmtime plugin host                | EXTENDED | v0.6   | planned | —       | `[[FILE-14]]` §5   |
| 111 | Plugin manifest + signing           | EXTENDED | v0.6   | planned | 110     | `[[FILE-14]]` §6   |
| 112 | Capability-gated host imports       | EXTENDED | v0.6   | planned | 110     | `[[FILE-14]]` §5.4 |
| 113 | Instance pooling + hot reload       | EXTENDED | v0.6   | planned | 110     | `[[FILE-14]]` §9-§10 |
| 114 | Plugin types (5 kinds)              | EXTENDED | v0.6   | planned | 110     | `[[FILE-14]]` §3   |
| 115 | Metrics registry (`obx_*`)          | CORE     | v0.4   | planned | —       | `[[FILE-12]]` §3   |
| 116 | Slow query log + sampling           | CORE     | v0.4   | planned | 115     | `[[FILE-12]]` §5   |
| 117 | OpenTelemetry traces                | EXTENDED | v0.4   | planned | 115     | `[[FILE-12]]` §7   |
| 118 | REST sidecar (`ovnsd`)              | EXTENDED | v0.4   | planned | —       | `[[FILE-13]]` §7   |
| 119 | WebSocket watch                     | EXTENDED | v0.4   | planned | 118     | `[[FILE-13]]` §8   |
| 120 | gRPC surface                        | EXTENDED | v0.5   | planned | 118     | `[[FILE-13]]` §9   |
| 121 | Rust API (canonical)                | CORE     | v0.1   | in-progress | —   | `[[FILE-13]]` §3   |
| 122 | Node.js (Neon) bindings             | CORE     | v0.1   | in-progress | 121 | `[[FILE-13]]` §4   |
| 123 | C ABI                               | EXTENDED | v0.3   | planned | 121     | `[[FILE-13]]` §5   |
| 124 | Python (PyO3) bindings              | EXTENDED | v0.5   | planned | 121     | `[[FILE-13]]` §1   |
| 125 | WASM target (browser via OPFS)      | EXTENDED | v0.6   | planned | 020,121 | `[[FILE-16]]` §3   |
| 126 | Cargo workspace + crates layout     | CORE     | v0.1   | shipped | —       | `[[FILE-16]]` §2   |
| 127 | CI matrix (GitHub Actions)          | CORE     | v0.1   | shipped | 126     | `[[FILE-16]]` §8   |
| 128 | Release pipeline + signing          | EXTENDED | v0.9   | planned | 127     | `[[FILE-16]]` §10  |
| 129 | Cargo-deny supply chain policy      | CORE     | v0.2   | planned | —       | `[[FILE-16]]` §10.4 |
| 130 | Reproducible builds                 | EXTENDED | v0.9   | planned | 128     | `[[FILE-16]]` §9   |

---

## 2. Critical path

```
                    ┌────────────────────┐
                    │  v0.1 Engine MVP   │
                    └─────────┬──────────┘
                              │
         ┌────────────────────┴────────────────────┐
         ▼                                         ▼
 ┌────────────────┐                     ┌────────────────────┐
 │ v0.2 Indexes + │                     │  v0.3 OQL + MVCC   │
 │  Compression   │                     └──────────┬─────────┘
 └───────┬────────┘                                │
         │                                         │
         │                                ┌────────┴────────┐
         │                                ▼                 ▼
         │                      ┌──────────────────┐  ┌──────────────────┐
         │                      │ v0.4 Observ +    │  │ v0.6 Plugins     │
         │                      │      REST        │  │  (parallel)      │
         │                      └────────┬─────────┘  └──────────────────┘
         │                               │
         │                               ▼
         │                      ┌──────────────────┐
         │                      │ v0.5 Replication │
         │                      │     + Sync       │
         │                      └────────┬─────────┘
         │                               │
         ▼                               ▼
 ┌──────────────────┐           ┌──────────────────┐
 │ v0.7 FTS+Vector  │           │ v0.8 Security +  │
 │   + Hybrid       │           │      KMS         │
 └────────┬─────────┘           └────────┬─────────┘
          │                              │
          └─────────────┬────────────────┘
                        ▼
             ┌────────────────────┐
             │ v0.9 Perf+Distros  │
             └─────────┬──────────┘
                       ▼
              ┌────────────────┐
              │  v1.0 LTS      │
              └────────────────┘
```

**Hard dependencies** (cannot start before predecessor ships):

* v0.5 needs **v0.3** (HLC visibility) AND **v0.4** (replica health metrics).
* v0.6 needs **v0.3** (UDFs in OQL) but can run in parallel with v0.4.
* v0.7 needs **v0.2** (indexes); independent of MVCC, can overlap with v0.5.
* v0.8 needs **v0.5** (TLS+oplog encryption foundation).
* v0.9 needs **v0.5–v0.7** (the things being benchmarked & hardened).
* v1.0 needs **everything**, plus 60 days of public RC stability.

**Effort distribution (rough engineer-months):**

| Release | Eng-months | Comment                                     |
| ------- | ---------- | ------------------------------------------- |
| v0.1    | 6          | bedrock                                     |
| v0.2    | 5          | secondary indexes + LZ4                     |
| v0.3    | 9          | parser + planner + MVCC                     |
| v0.4    | 5          | metrics, traces, REST                       |
| v0.5    | 9          | replication is hard                         |
| v0.6    | 6          | wasmtime integration + SDKs                 |
| v0.7    | 8          | FTS quality + HNSW recall                   |
| v0.8    | 7          | crypto + KMS                                |
| v0.9    | 5          | perf passes; cross-platform packaging       |
| v1.0    | 4          | docs, freeze, Jepsen                        |
| **Σ**   | **64**     | ≈ 5 engineers × 13 months full focus        |

---

## 3. Risk register (15 risks)

> Format: ID · Risk · Likelihood (L/M/H) · Impact (L/M/H) · Mitigation · Owner.

### R-01 · Crash recovery edge case on Windows (torn write of WAL header)

* L=M, I=H.
* Mitigation: shadow page 0; CRC on every WAL record header; Windows-VM power-loss tests in nightly; `[[FILE-17]]` §9.
* Owner: storage subsystem.

### R-02 · MVCC vacuum starvation under long snapshots

* L=M, I=M.
* Mitigation: configurable horizon timeout; "stale snapshot" mode for analytics (deferred); metric `obx_mvcc_horizon_seconds` alerted; `[[FILE-06]]` §9.
* Owner: MVCC.

### R-03 · Planner cost-model regression as workload grows

* L=H, I=M.
* Mitigation: macro benches gating PRs (>25% regressions block); EXPLAIN-ANALYZE conformance tests; `[[FILE-17]]` §11.
* Owner: query.

### R-04 · OpenTelemetry dependency churn breaking `metrics`

* L=M, I=L.
* Mitigation: pin OTel versions in `Cargo.toml`; isolated `metrics` feature flag; vendor critical dependencies; `[[FILE-16]]` §2.1.
* Owner: observability.

### R-05 · Replication split-brain under partitioned multi-master

* L=L, I=H.
* Mitigation: HLC-anchored term mechanism; documented operator-required intervention; Jepsen suite `[[FILE-17]]` §12.1.
* Owner: replication.

### R-06 · Wasmtime ABI churn between minor versions

* L=M, I=M.
* Mitigation: pin to wasmtime LTS branch; quarterly ABI compatibility tests; `[[FILE-14]]` §5.1.
* Owner: plugins.

### R-07 · HNSW recall regression on quantized indexes

* L=M, I=M.
* Mitigation: per-tier ground-truth gating in benches; recall reported in `obx_vector_recall_at_10`; documented quality-vs-memory tradeoff; `[[FILE-04]]` §6.4.
* Owner: vector.

### R-08 · KMS provider outage prevents engine open

* L=M, I=H.
* Mitigation: local-fallback wrapped key + offline mode; KMS call retry with exponential backoff; alert on `obx_kms_call_total{result="fail"}`; `[[FILE-07]]` §4.5.
* Owner: security.

### R-09 · io_uring kernel bugs on certain distros

* L=M, I=M.
* Mitigation: feature-flag `io-uring`; threadpool fallback always available; runtime kernel-version probe; `[[FILE-10]]` §8.1.
* Owner: storage / platform.

### R-10 · Premature API freeze locking suboptimal surfaces at v1.0

* L=M, I=H.
* Mitigation: ≥ 60-day public RC; LTS branch policy permits API-additive minors; documented deprecation cycle; `[[FILE-13]]` §11.
* Owner: API governance.

### R-11 · Long-offline mobile sync outbox overflow

* L=M, I=M.
* Mitigation: bounded outbox (default 100 MiB) with overflow event; CRDT writes never dropped (separate quota); operator-tunable; `[[FILE-09]]` §13.6.
* Owner: replication / mobile SDK.

### R-12 · Plugin author writes UB plugin → engine instability

* L=L (sandbox), I=L.
* Mitigation: WASM sandbox prevents memory unsafety; quarantine after repeated faults; per-call fuel + epoch caps; `[[FILE-14]]` §16.
* Owner: plugins.

### R-13 · Compression dictionary blow-up (many dicts, never GC)

* L=M, I=L.
* Mitigation: lifecycle states (active/decoder-only/garbage); periodic full-scan reference count during vacuum; metric `obx_compress_dict_count` alert; `[[FILE-11]]` §6.4.
* Owner: storage.

### R-14 · Bench infrastructure drift hides perf regressions

* L=M, I=M.
* Mitigation: dedicated perf hardware in CI; baseline updated only on release tags; macro benches re-run on RC; `[[FILE-17]]` §11.
* Owner: build / perf.

### R-15 · Documentation lag blocks adoption at v1.0

* L=M, I=H.
* Mitigation: docs gated as part of milestone Definition of Done `[[FILE-18]]` §16; mdBook builds in CI; OpenAPI rendered each PR; `[[FILE-16]]` §12.
* Owner: docs / DevRel.

---

## 4. Resource estimates

### 4.1 Headcount

| Role                                  | FTE (avg over 0.1→1.0) |
| ------------------------------------- | ---------------------- |
| Storage / WAL engineer (Rust)         | 1.0                    |
| Query / planner engineer (Rust)       | 1.0                    |
| MVCC / replication engineer (Rust)    | 1.0                    |
| Security / cryptography engineer      | 0.5                    |
| Plugin / FFI engineer                 | 0.5                    |
| Bindings (Node/Py/C) engineer         | 0.5                    |
| Test / QA engineer                    | 0.5                    |
| DevRel / docs                         | 0.5                    |
| Project lead                          | 0.5                    |
| **Total**                             | **~6.0 FTE**           |

### 4.2 Compute & CI

| Resource                              | Estimate                              |
| ------------------------------------- | ------------------------------------- |
| GitHub Actions minutes (PR matrix)    | ~20k min/month at peak                |
| Self-hosted Linux/ARM benches         | 1 box (16-core, NVMe)                 |
| macOS runner (perf reproducibility)   | 1 mac mini M2                         |
| Windows VM (power-loss tests)         | 1 ephemeral VM (cloud)                |
| Object storage for fuzz corpora       | ~1 TiB                                |
| Backup/restore tests target           | ~10 TiB transient                     |
| Fuzz farm (OSS-Fuzz integration)      | shared, free                          |

### 4.3 External services

| Service                          | Purpose                                |
| -------------------------------- | -------------------------------------- |
| AWS KMS / GCP KMS / Azure KV     | KMS integration tests (one each)       |
| HashiCorp Vault                  | self-hosted in CI                      |
| Sigstore                         | artifact signing                       |
| crates.io / npm / PyPI           | distribution                           |
| Docker Hub / GHCR                | container distribution                 |
| Codecov                          | coverage reports                       |

### 4.4 Time budget per release (calendar weeks)

| Release | Weeks (target) | Buffer (wks) |
| ------- | -------------- | ------------ |
| v0.1    | 12             | +2           |
| v0.2    | 10             | +2           |
| v0.3    | 14             | +3           |
| v0.4    | 10             | +2           |
| v0.5    | 14             | +3           |
| v0.6    | 12             | +2           |
| v0.7    | 14             | +3           |
| v0.8    | 12             | +2           |
| v0.9    | 10             | +2           |
| v1.0    | 8              | +2 (RC soak) |

---

## 5. Cross-references

* `[[FILE-00]]` master spec — feature matrix in §3 of master.
* `[[FILE-18]]` roadmap — milestone definitions consumed here.
* `[[FILE-20]]/001 … 010` — ADRs that justify architectural choices.
* `[[FILE-17]]` — testing strategy that gates each release.

---

*End of `FASE2-PROJECT-REGISTRY.md` — 350 lines.*
