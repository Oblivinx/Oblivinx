# 06 — TRANSACTIONS AND MVCC

> Transaction id allocation, version chains, isolation levels, snapshot
> acquisition, lock manager, deadlock detection, savepoints, two-phase
> commit, vacuum/garbage-collection, and optimistic concurrency control
> for Oblivinx3x.
> Cross-references: `[[FILE-02]]` (WAL anchoring), `[[FILE-04]]` (index
> updates), `[[FILE-09]]` (replication / HLC), `[[FILE-10]]` (latch
> protocol), `[[FILE-20]]`/005 (MVCC ADR).

---

## 1. Purpose

The MVCC layer provides:

- **ACID** transactions: atomic, consistent, isolated, durable.
- **Multi-version concurrency control** so readers never block writers
  and vice versa.
- **Configurable isolation** from `READ_UNCOMMITTED` (debugging only)
  through `SERIALIZABLE` (full SSI).
- **Conflict detection** for optimistic concurrency, with explicit
  `BEGIN CONCURRENT` for multi-writer (v0.6+).
- **Savepoints** for nested transactions with partial rollback.
- **Two-phase commit** for cross-collection / multi-engine coordination.
- **Garbage collection** of dead versions via a vacuum worker.

---

## 2. Transaction ID

### 2.1 Allocation

Per database, a 64-bit monotonic counter `tx_id_next` is persisted in
the file header (extension TLV tag `0x10`). On `begin()`, the engine
atomically increments and returns the new id. The id is also inserted
into the WAL as part of `WAL_REC_BEGIN`.

```rust
pub struct TxId(pub u64);
fn allocate_txid(db: &Database) -> TxId {
    TxId(db.tx_id_counter.fetch_add(1, Ordering::AcqRel) + 1)
}
```

### 2.2 Wraparound

64 bits = ~5×10¹⁸ transactions. At 1 M txn/s, wraparound takes >580 K
years. We do **not** implement freezing/wraparound recycling (unlike
PostgreSQL's `vacuum freeze`); we treat 64-bit txids as effectively
infinite.

### 2.3 Active transaction table

Per-database in-memory map:

```rust
pub struct ActiveTxTable {
    by_id: DashMap<TxId, TxState>,
    next_id: AtomicU64,
}

pub struct TxState {
    pub id: TxId,
    pub started_at_lsn: u64,
    pub snapshot_lsn: u64,            // for SI / SSI reads
    pub mode: TxMode,                 // Read / Write / ReadWrite
    pub isolation: IsolationLevel,
    pub locks_held: Mutex<HashSet<LockKey>>,
    pub savepoints: Mutex<Vec<Savepoint>>,
    pub written_pages: Mutex<HashMap<u64, BeforeImage>>,
    pub status: AtomicU8,             // 0=running 1=committed 2=aborted
}
```

Used by:

- **Snapshot acquisition** (§3) — minimum active txid sets the GC
  horizon.
- **Conflict detection** (§5).
- **Lock manager** (§6).
- **Recovery** (§9) — pending txns at crash time are aborted.

---

## 3. MVCC Version Chain

### 3.1 Per-tuple metadata

Every document version carries:

```
xmin_lsn:  WAL LSN at which this version became visible (creator commit)
xmax_lsn:  WAL LSN at which this version was superseded (∞ = still alive)
prev_ptr:  pointer to older version (0 = none)
```

These three fields are appended to the OBE document when stored:

```
+--------------+-----------+-----------+--------+----------+
| OBE doc body |  xmin     |  xmax     | prev_p | flags    |
| (sized)      |  u64      |  u64      | u64    | u8       |
+--------------+-----------+-----------+--------+----------+
```

`flags`: bit0 = HOT update, bit1 = tombstone.

### 3.2 Visibility rule

A version `V` is visible to transaction `T` iff:

```
V.xmin_lsn  ≤ T.snapshot_lsn  AND
(V.xmax_lsn = ∞  OR  V.xmax_lsn  > T.snapshot_lsn)
```

Equivalently: V was created before T started and either never deleted
or deleted after T started.

### 3.3 Snapshot acquisition

```rust
fn acquire_snapshot(tx: &mut TxState, lvl: IsolationLevel) {
    tx.snapshot_lsn = match lvl {
        IsolationLevel::ReadUncommitted => u64::MAX,
        IsolationLevel::ReadCommitted   => current_durable_lsn(),
        IsolationLevel::RepeatableRead | IsolationLevel::Serializable
            | IsolationLevel::SnapshotIsolation
            => current_durable_lsn(),
    };
    tx.started_at_lsn = wal.append(WAL_REC_BEGIN { tx_id: tx.id }).lsn;
}
```

For **READ_COMMITTED**, the snapshot LSN is refreshed before each
statement (so each statement sees latest committed data). For
**REPEATABLE_READ** / **SI**, taken once at begin.

### 3.4 Walking the chain

When reading via index → primary lookup, the engine reads the latest
version on the leaf and walks `prev_ptr` until finding the visible
version:

```text
read_visible(coll, doc_id, snapshot_lsn) -> Option<Doc>:
    v = primary_index.lookup(doc_id)
    while v != null:
        if v.xmin_lsn <= snapshot_lsn AND (v.xmax_lsn == ∞ OR v.xmax_lsn > snapshot_lsn):
            if flag.tombstone: return None
            else: return v
        v = follow(v.prev_ptr)
    return None
```

Old versions live as overflow chains attached to the leaf record. The
vacuum worker (§7) reclaims them once safe.

---

## 4. Isolation Levels

### 4.1 Levels supported

```
0  READ_UNCOMMITTED        (debug-only)
1  READ_COMMITTED          (default for autocommit)
2  REPEATABLE_READ
3  SNAPSHOT_ISOLATION       (default for explicit BEGIN)
4  SERIALIZABLE             (SSI; opt-in)
```

### 4.2 Anomalies prevented

| Level                | Dirty Read | Non-Repeatable | Phantom | Write Skew | Lost Update |
|----------------------|:----------:|:--------------:|:-------:|:----------:|:-----------:|
| READ_UNCOMMITTED     |    no      |     no         |   no    |    no      |    no       |
| READ_COMMITTED       |    yes     |     no         |   no    |    no      |    no       |
| REPEATABLE_READ      |    yes     |     yes        |   no¹   |    no      |    yes²     |
| SNAPSHOT_ISOLATION   |    yes     |     yes        |   yes³  |    no      |    yes      |
| SERIALIZABLE (SSI)   |    yes     |     yes        |   yes   |    yes     |    yes      |

¹ Phantoms still possible because RR uses gap-locks only when SI not
selected; we tag RR == SI in our impl, so phantoms prevented.
² Lost updates prevented via write conflict detection (§5).
³ SI prevents phantoms by virtue of snapshot.

### 4.3 SSI implementation

SSI tracks two sets per transaction:

- **rw-conflict in:** transactions whose writes conflict with this
  txn's reads.
- **rw-conflict out:** transactions whose reads conflict with this
  txn's writes.

A "dangerous structure" (T1 → T2 → T3 with T3 committed first) triggers
abort. Implementation per Cahill 2008. Costs ~2x SI overhead; opt-in.

### 4.4 Default selection

- `db.users.insertOne(...)` (autocommit) → `READ_COMMITTED`.
- `db.beginTransaction()` (no level) → `SNAPSHOT_ISOLATION`.
- `db.beginTransaction({level: 'serializable'})` → `SSI`.

---

## 5. Write Conflict Detection

### 5.1 First-writer-wins rule

When transaction T1 attempts to update a row whose latest version was
written by T2 (active or committed after T1's snapshot):

```
if latest_version.xmin_lsn > T1.snapshot_lsn AND
   T2 is committed:                               → Abort T1, retry
if T2 is active:                                  → Abort T1 (no wait)
```

This is the **first-writer-wins** semantics: T1 was unaware of T2's
write; we cannot proceed without violating SI. T1 aborts with
`OvnError::WriteConflict` and the application retries.

### 5.2 Lost update prevention

Without conflict detection, two concurrent `update({a: a + 1})` could
both read `a=5`, both write `a=6`, losing one increment. With first-
writer-wins, the second writer sees the new version and aborts.

### 5.3 Optimistic concurrency control (OCC)

Default mode. Transactions execute optimistically; conflict only
checked at commit time:

```text
commit():
    for each (page_id, version) in tx.read_set:
        if page.lsn > version.captured_lsn: abort; return
    for each (key, before_value) in tx.write_set:
        if leaf_value_now(key) != before_value: abort; return
    write WAL_REC_COMMIT
    fsync_wal()
    apply writes
    publish snapshot
```

### 5.4 Pessimistic mode

`pragma concurrency_mode = pessimistic` switches to lock-on-read. Used
when the workload has high abort rate under OCC (>10%).

---

## 6. Lock Manager

### 6.1 Lock granularities

```
Database        DB_S, DB_X, DB_IS, DB_IX, DB_SIX
Collection      C_S,  C_X,  C_IS,  C_IX,  C_SIX
Page            P_S,  P_X,  P_IS,  P_IX
Row             R_S,  R_X
```

Mode compatibility matrix (rows requested vs columns held):

```
       IS  IX  S   SIX X
  IS    ✓   ✓   ✓   ✓   ✗
  IX    ✓   ✓   ✗   ✗   ✗
  S     ✓   ✗   ✓   ✗   ✗
  SIX   ✓   ✗   ✗   ✗   ✗
  X     ✗   ✗   ✗   ✗   ✗
```

Intent locks (IS/IX/SIX) at higher granularities are required before
acquiring real locks at lower levels.

### 6.2 Lock table

Hash table keyed by `LockKey { coll: u32, page_or_row: u64 }`:

```rust
pub struct LockEntry {
    pub mode: LockMode,
    pub holders: HashSet<TxId>,
    pub waiters: VecDeque<(TxId, LockMode, OneshotSender<()>)>,
}
```

### 6.3 Lock escalation

When a transaction holds > `pragma lock_escalation_threshold` (default
5000) row locks on one collection, the manager escalates to a single
collection-level X lock. Reduces lock-table overhead at cost of
concurrency.

### 6.4 Lock timeout and deadlock

Each `lock()` call has a default timeout of 5 seconds. On timeout, the
transaction aborts.

For active deadlock detection: a periodic (every 100 ms) "wait-for"
graph cycle check via DFS. Cycles → abort the youngest transaction in
the cycle (smallest WAL begin LSN preserved).

```
wait_for[A] = {B : A is waiting on B}
cycle = dfs(wait_for); if cycle: abort youngest_in_cycle
```

### 6.5 Lock manager statistics

Metrics emitted (`[[FILE-12]]` §3):

- `obx_lock_acquisitions_total{mode}`
- `obx_lock_waits_seconds`
- `obx_deadlocks_total`
- `obx_lock_escalations_total`

---

## 7. Garbage Collection (Vacuum)

### 7.1 Safe horizon

The **safe horizon** is the highest LSN below which all dead versions
can be reclaimed:

```
safe_horizon = min(active_tx.snapshot_lsn for tx in active_tx_table)
                 - GC_LAG_LSN  (default 0; conservative)
```

Versions whose `xmax_lsn ≤ safe_horizon` can be deleted (no active
transaction can see them).

### 7.2 Vacuum worker

Background thread, runs every `pragma vacuum_interval_s` (default 30):

```text
loop:
    sleep(30s)
    horizon = compute_safe_horizon()
    for coll in collections:
        for page in coll.btree.iterate_leaves():
            for record in page:
                while record.has_old_versions():
                    v = record.oldest_version
                    if v.xmax_lsn <= horizon:
                        free_version(v)
                        page.dirty = true
                    else: break
        compact_pages_below(coll, threshold = 0.4)
```

Vacuum is **incremental**: ten leaf pages per cycle then yield.

### 7.3 Aggressive mode

`db.vacuum({mode: "aggressive"})` triggers a full single-pass GC over
all collections, intended for off-peak windows.

### 7.4 Tombstone reclamation

Tombstones (deleted documents) have `xmax_lsn = creation_lsn`. Once
horizon passes, they are unlinked from indexes and removed from the
heap.

---

## 8. Savepoints

### 8.1 Concept

A named checkpoint within a transaction; rolling back to a savepoint
undoes all changes after that point but keeps the transaction alive.

```
BEGIN
INSERT INTO users {...}
SAVEPOINT after_insert
UPDATE users SET ...
ROLLBACK TO SAVEPOINT after_insert    -- update undone, insert kept
COMMIT
```

### 8.2 Implementation

Each savepoint records the WAL LSN at creation:

```rust
pub struct Savepoint {
    pub name: String,
    pub lsn: u64,
    pub locks_at_create: HashSet<LockKey>,
    pub savepoint_id: u64,
}
```

`ROLLBACK TO SAVEPOINT s`:

1. WAL: emit `WAL_REC_SAVEPOINT_ROLLBACK { name: s }`.
2. Apply the **inverse** of every WAL record from `s.lsn` to current
   LSN (using before-images stored in `tx.written_pages`).
3. Release locks acquired since `s.lsn` not in `s.locks_at_create`.
4. Discard newer savepoints.

Savepoints are **non-durable** by default — a crash mid-transaction
loses them. Set `pragma durable_savepoints = true` to fsync after each
savepoint.

---

## 9. Two-Phase Commit (2PC)

For coordinated commits across multiple resource managers (e.g. another
Oblivinx3x DB, a remote service via plugin).

### 9.1 Protocol

```
Coordinator                                Participants
───────────                                ─────────────
                  PREPARE  ──────────►
                                           apply writes to WAL,
                                           emit WAL_REC_PREPARE { tx_id }
                                           fsync WAL
                  ◄───────  YES / NO       (response)
        all YES?
        ├── yes: COMMIT  ──────────►
                                           emit WAL_REC_COMMIT
                                           fsync, apply
                  ◄────── ACK
        └── any no: ABORT  ──────────►
                                           rollback
                  ◄────── ACK
```

### 9.2 In-doubt resolution

If a participant survives PREPARE but the coordinator dies before
COMMIT/ABORT:

- The participant remains in **in-doubt** state.
- On startup, queries the coordinator's recovery log (or external
  resolver) for the outcome.
- Manual override via `db.commit_in_doubt(tx_id, "commit"|"abort")`.

### 9.3 Lock retention

Locks acquired before PREPARE are retained until final COMMIT/ABORT.
This blocks readers; long in-doubt windows are user-actionable.

---

## 10. BEGIN CONCURRENT (Multi-writer MVCC)

Default mode allows only one writer at a time (single WAL appender
serializes commits). `BEGIN CONCURRENT` lifts this:

```
BEGIN CONCURRENT
INSERT INTO ...
COMMIT
```

Behavior:

- Multiple writers may have overlapping write sets.
- At commit, **last committer detects conflict** by re-reading written
  versions; aborts if another writer's commit invalidated them.
- Throughput can scale to # CPU cores for non-conflicting workloads.

Implementation: per-transaction write set tracked separately, merged at
commit under a brief commit-time lock.

---

## 11. Hybrid Logical Clocks (HLC)

### 11.1 Concept

For replicated / distributed deployments, plain wall-clock timestamps
are unsafe (clock skew). HLC combines physical and logical components:

```
HLC = (physical_time_ms: u48, logical_counter: u16)
```

### 11.2 Algorithm

```text
on local event:
    pt = max(now_ms, hlc.pt)
    if pt == hlc.pt: hlc.logical += 1
    else:           hlc.logical = 0
    hlc.pt = pt
    return (pt, logical)

on receive event with remote_hlc:
    pt = max(hlc.pt, remote_hlc.pt, now_ms)
    if pt == hlc.pt and pt == remote_hlc.pt:
        hlc.logical = max(hlc.logical, remote_hlc.logical) + 1
    elif pt == hlc.pt:
        hlc.logical += 1
    elif pt == remote_hlc.pt:
        hlc.logical = remote_hlc.logical + 1
    else:
        hlc.logical = 0
    hlc.pt = pt
```

HLC is used for:

- Cross-replica `xmin_lsn` ordering (replication, `[[FILE-09]]`).
- LWW conflict resolution in CRDTs.
- Distributed transactions.

---

## 12. Recovery from Crash

On open, the MVCC layer:

1. Parses `WAL_REC_BEGIN` / `WAL_REC_COMMIT` / `WAL_REC_ABORT` records.
2. Builds `committed_txns` set (have COMMIT in WAL).
3. Builds `pending_txns` set (BEGIN but no end).
4. For pending txns: roll back any partial writes via undo records.
5. Resume the active tx counter from `max(seen_tx_id) + 1`.
6. Vacuum runs once before opening for writes (to reset horizon).

---

## 13. Tradeoffs and Alternatives Considered

| Choice                | Picked              | Considered           | Why we picked     |
|-----------------------|---------------------|----------------------|-------------------|
| Concurrency model     | MVCC                | 2PL                  | Reads never block. |
| Isolation default     | RC autocommit / SI tx | Serializable        | Practical default. |
| Conflict resolution   | First-writer-wins   | Last-writer-wins      | Predictable, no lost data. |
| Version chain location| In-leaf overflow    | Side table            | Avoids extra page lookup. |
| GC strategy           | Lazy vacuum worker  | Synchronous on commit | Bounded latency. |
| Deadlock detection    | Periodic DFS        | Lock graph mutex      | Acceptable latency. |
| Savepoints            | Non-durable default | Always durable        | fsync cost. |
| Distributed clock     | HLC                 | TrueTime / Lamport    | TrueTime infeasible; Lamport too coarse. |

---

## 14. Open Questions

1. **Snapshot too old.** Long-running readers eventually see versions
   that are GC'd. We should emit a warning + planner recommendation
   for `lease_max_seconds`.
2. **In-memory lock table size.** With 1 M concurrent locks, ~64 MB
   RAM. Spill to disk would be slow; instead enforce
   `lock_escalation_threshold`.
3. **Replicated 2PC.** Currently single-process 2PC; cross-node 2PC
   requires Raft-style coordination — defer to v0.8.

---

## 15. Compatibility Notes

- Version chain layout is backward-compatible: older readers see only
  `xmin/xmax` and ignore the prev pointer.
- HLC introduction in v0.5 changes WAL record `created_at_ns` to HLC;
  v0.4 readers interpret as truncated wall clock — acceptable since
  v0.4 had no replication.

---

## 16. Cross-References

- WAL records: `[[FILE-02]]` §2.
- Index update path under MVCC: `[[FILE-04]]` §15.2.
- Replication's use of HLC: `[[FILE-09]]` §6.
- Threading and latching: `[[FILE-10]]` §3-4.
- ADR: `[[FILE-20]]`/005 (MVCC strategy).

---

*End of `06-TRANSACTION-MVCC.md` — 540 lines.*
