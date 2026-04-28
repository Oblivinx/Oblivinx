# ADR-005 — MVCC over Two-Phase Locking for Concurrency

**Status:** Accepted, 2026-04
**Owners:** MVCC / concurrency
**Cross refs:** `[[FILE-06]]`, `[[FILE-10]]`

---

## Context

The engine needs a concurrency control scheme that:

1. Lets reads scale linearly with cores (no reader/writer blocking).
2. Supports snapshot reads consistent across multiple statements (BEGIN..COMMIT).
3. Plays well with replication (HLC, oplog ordering).
4. Avoids reader starvation under long-running scans.

Options:

* **Pure 2PL** (two-phase locking) — strict serializability; reads block writes; not viable at the throughput targets.
* **MVCC + snapshot isolation** — readers see immutable past versions; writers proceed; SSI added on top for true serializability.
* **Optimistic only** — works for short txns; degrades under contention; doesn't naturally provide snapshot reads.

## Decision

Adopt **MVCC** as the backbone. Each tuple carries `(xmin_lsn, xmax_lsn, prev_ptr)`; snapshot acquisition records the active tx set; visibility rule: tuple visible if `xmin ∈ snapshot.committed AND xmax ∉ snapshot.committed`.

Isolation levels offered:

* `READ COMMITTED`
* `REPEATABLE READ` (default for `BEGIN`)
* `SNAPSHOT`
* `SERIALIZABLE` (Cahill 2008 SSI on top of snapshot)
* `STRICT SERIALIZABLE` (extra real-time order check; high cost)

Write conflict detection uses **first-writer-wins**; conflicting writer aborts with `WRITE_CONFLICT` (transient — caller retries). MVCC vacuum reclaims versions invisible to all live snapshots.

## Consequences

**Positive**

* Reads never block writes and vice versa.
* Snapshot semantics across statements are natural.
* MVCC version chains map directly onto the WAL/oplog model.

**Negative**

* Bloat: dead versions consume space until vacuum.
* SSI tracking adds memory overhead per active txn.
* Long-running snapshots delay vacuum (the "horizon" problem).

## Alternatives considered

* **Strict 2PL** — rejected: throughput ceiling and reader starvation.
* **Optimistic only** — used as a fast path on top of MVCC for hot leaves (`[[FILE-10]]` §5.4) but not as the global model.

## Open questions

* Should we offer a cheap "stale-snapshot" read mode for analytical queries (relax horizon constraint)?
* CRDT collections with multi-master: how does MVCC coexist with field-level CRDTs? (Tracked in `[[FILE-09]]` §6.)

*End of ADR-005.*
