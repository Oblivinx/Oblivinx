# ADR-002 — Write-Ahead Log (WAL) over Shadow Paging or Rollback Journal

**Status:** Accepted, 2026-04
**Owners:** Storage / durability
**Cross refs:** `[[FILE-02]]`, `[[FILE-09]]`

---

## Context

The engine needs a durability mechanism that:

1. Tolerates power loss without silent corruption (torn writes, partial fsync).
2. Supports group commit so multi-writer throughput is acceptable.
3. Provides a stable change stream for replication & oplog projection.
4. Is portable across Linux/macOS/Windows + WASM.

Three families considered:

1. **Rollback journal** (SQLite default) — copies original page bytes before modification; small recovery footprint, simple. Serializes writes per page.
2. **Shadow paging** — never overwrite pages; allocate new pages and update a root pointer atomically. Simple recovery (just restart from root). Costly for small updates (full-page churn).
3. **Write-Ahead Log** — append modifications as records; flush WAL before page; redo on restart. Standard in production-grade engines (Postgres, InnoDB, WiredTiger).

## Decision

Adopt **WAL with group commit** as the primary durability mechanism. The WAL is the **source of truth** for both crash recovery and oplog projection (the latter for replication).

Key choices:

* WAL records are logical (DOC_INSERT/UPDATE/DELETE/...) plus selected physical (PAGE_IMAGE_FULL) for recovery completeness.
* LSN is the byte offset in WAL; monotonic.
* Group commit batches multiple txns per fsync (default 200 µs window).
* Per-OS durability primitives: `fdatasync` Linux, `F_FULLFSYNC` macOS, `FILE_FLAG_WRITE_THROUGH + FlushFileBuffers` Windows.

## Consequences

**Positive**

* Excellent write throughput via group commit (5–20× per-txn fsync).
* Replication piggybacks on the same log — single source of truth.
* Recovery time bounded by WAL retention (checkpoints prune).

**Negative**

* WAL retention vs disk usage tradeoff.
* Implementation requires careful invariants (WAL-before-page, idempotent redo).
* Replicas must also fsync their WAL before acking, doubling fsync cost in cascades.

## Alternatives considered

* **Rollback journal** — rejected: throughput cap; no natural change stream.
* **Shadow paging** — rejected: write amplification on small updates; complicates secondary indexes.
* **Hybrid (journal + WAL)** — rejected as unnecessary complexity.

## Open questions

* Should v0.5+ split DDL into a separate metadata log to reduce WAL contention?
* Encryption-at-rest for WAL: per-record vs per-segment key (tracked in ADR-003).

*End of ADR-002.*
