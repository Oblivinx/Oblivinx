# 10 — CONCURRENCY MODEL

> **Audience:** Engine implementers touching threading, locking, async I/O, or memory ordering.
> **Status:** Specification (target v0.1–v1.0, evolves with platform support).
> **Cross refs:** `[[FILE-01]]` storage engine, `[[FILE-02]]` WAL, `[[FILE-04]]` indexes, `[[FILE-06]]` MVCC, `[[FILE-09]]` replication, `[[FILE-12]]` observability.

---

## 1. Purpose

Oblivinx3x must scale linearly across cores on modern hardware (8–128 cores typical) while remaining correct under arbitrary thread interleavings, signal interrupts, and OS scheduling jitter. This document specifies:

1. **Threading model** — which work runs where, with which priority.
2. **Synchronization primitives** — locks, latches, atomics, lock-free data structures.
3. **Async I/O integration** — io_uring, IOCP, kqueue, threadpool fallback.
4. **Memory ordering rules** — what is `Acquire`, `Release`, `SeqCst`, and why.
5. **Concurrency invariants** that the rest of the engine relies on.

The model is **MVCC-first** `[[FILE-06]]`: readers never block writers, writers never block readers; physical concurrency is bounded by latches on shared mutable structures (B-tree pages, buffer pool slots).

---

## 2. Concurrency goals & non-goals

### 2.1 Goals

* **Reads scale with cores** — N reader threads achieve ~N× throughput up to memory-bandwidth ceiling.
* **Writes scale with shards** — single-shard write throughput limited by WAL fsync; multi-collection workloads parallelize.
* **Bounded tail latency** — P99 read latency stays within 5× of P50 under sustained load.
* **No global locks on hot paths** — no single mutex held across page reads, allocations, or syscalls.
* **Predictable memory** — no unbounded queues; backpressure surfaces as `BUSY` errors before OOM.

### 2.2 Non-goals

* **Linearizable cross-shard transactions** — out of scope for v1; use single-shard or 2PC `[[FILE-06]]` §11.
* **Real-time guarantees** — best-effort latency, no hard deadlines.
* **Single-writer userland threads** — engine internally is multi-threaded regardless of how the API is called.

---

## 3. Threading model

### 3.1 Thread classes

```
┌────────────────────────────────────────────────────────────────────┐
│  PROCESS                                                           │
│                                                                    │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐               │
│  │ User Thread │   │ User Thread │ . │ User Thread │  (callers)    │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘               │
│         │                 │                 │                      │
│         └────────┬────────┴────────┬────────┘                      │
│                  ▼                 ▼                               │
│             ┌────────┐        ┌────────┐                           │
│             │ READ   │        │ WRITE  │  (engine task pools)      │
│             │ POOL   │        │ POOL   │                           │
│             └────┬───┘        └────┬───┘                           │
│                  ▼                 ▼                               │
│        ┌──────────────────────────────┐                            │
│        │     I/O REACTOR (1–N)        │ ← io_uring / IOCP / kqueue │
│        └──────────────────────────────┘                            │
│                                                                    │
│  Background:  WAL_FLUSH | CHECKPOINT | COMPACT | INDEX_BUILD       │
│               | VACUUM   | METRICS    | REPLICATION                 │
└────────────────────────────────────────────────────────────────────┘
```

| Class            | Count default          | Priority | Job                                       |
| ---------------- | ---------------------- | -------- | ----------------------------------------- |
| User threads     | unbounded (caller)     | inherited| Issue queries via API/Neon                |
| Read pool        | `min(8, ncpu)`         | normal   | Execute read queries                      |
| Write pool       | `max(2, ncpu/4)`       | normal   | Execute writes; serialized per shard      |
| I/O reactor(s)   | 1 (Linux/Mac), N (Win) | normal   | Drive async I/O completions               |
| WAL flusher      | 1                      | high     | fsync WAL group commits                   |
| Checkpoint       | 1                      | low      | Flush memtable → SST; truncate WAL        |
| Compactor        | 1–4                    | low      | Background SST compaction                 |
| Index builder    | 1–4                    | low      | Create / rebuild indexes                  |
| Vacuum           | 1                      | idle     | MVCC garbage collection                   |
| Metrics          | 1                      | low      | Aggregate counters; emit OTLP             |
| Replication      | 1 per peer             | normal   | Maintain replica connections              |

All counts are configurable via `OvnEngineConfig` and re-tunable at runtime through `engine.set_pool_size(...)`.

### 3.2 Thread naming

Every engine thread sets its OS-level name:

```
ovn-rd-0, ovn-rd-1, ...        (read pool)
ovn-wr-0, ovn-wr-1, ...        (write pool)
ovn-io-0, ...                  (I/O reactor)
ovn-wal-flush                  (WAL)
ovn-ckpt                       (checkpoint)
ovn-cmpct-0, ...               (compactor)
ovn-idx-build-0, ...           (index)
ovn-vacuum                     (MVCC GC)
ovn-metrics                    (telemetry)
ovn-repl-<peer>                (replication)
```

Names ≤ 15 chars on Linux (kernel limit) and trimmed on macOS / Windows.

### 3.3 Affinity & NUMA

* On Linux with > 1 NUMA node, the I/O reactor and buffer pool partitions pin to the node hosting their backing DRAM.
* Read pool threads remain free-floating; the OS scheduler is trusted.
* `OVN_NUMA=node:0,1` env var can pin all engine threads to specific nodes.

---

## 4. Lock taxonomy

Oblivinx3x uses different primitives for different kinds of contention:

| Primitive            | Where used                                  | Properties                                          |
| -------------------- | ------------------------------------------- | --------------------------------------------------- |
| **Mutex**            | Configuration, cold paths                   | Adaptive (spin then park); not held across I/O      |
| **RwLock**           | Schema, namespace catalogs                  | Many readers, occasional writer                     |
| **Latch (page)**     | Buffer pool pages; B-tree nodes             | Lightweight RwLock; **no I/O while held**           |
| **Spinlock**         | Tiny critical sections (< 50 ns)            | Backoff after N spins                               |
| **Atomic counters**  | Stats, refcounts, version numbers           | `fetch_add`, `compare_exchange`                     |
| **Lock-free queues** | Background work submission                  | MPMC ring or Treiber stack                          |
| **Hazard pointers**  | LSM SST handle reclamation                  | Defer free until no thread observes pointer         |
| **Epoch reclaim**    | Buffer pool eviction                        | Crossbeam-epoch–style                               |
| **Channel (mpsc)**   | Cross-thread RPC                            | Bounded; backpressures producers                    |

### 4.1 The "no I/O under latch" rule

A page latch is held only while the page bytes are accessed in memory. If a fetch needs to issue an I/O (page miss), the caller:

1. Releases any latch on the parent.
2. Issues async read.
3. On completion, re-walks the path (B-tree latch coupling — see §5.2).

This avoids hot-page convoys when storage is slow.

### 4.2 Lock ordering

To prevent deadlocks, engine code follows a **strict global lock order**:

```
1. Schema RwLock        (catalogs)
2. Collection RwLock    (per collection)
3. Index RwLock         (per index)
4. Tx Manager Mutex     (txid allocation)
5. Buffer Pool partition Mutex (frame admission)
6. Page latch           (lowest in hierarchy)
7. WAL Mutex            (group commit; held briefly)
```

Acquiring locks out of order is a **debug-build assertion failure** (`#[cfg(debug_assertions)]` lock-order tracker).

---

## 5. B-tree concurrency

### 5.1 Page latch protocol

Each buffer pool frame has a latch with three modes:

* **READ (S)** — shared; multiple holders.
* **WRITE (X)** — exclusive.
* **OPTIMISTIC** — version counter; no actual lock; verified on use.

```rust
enum PageLatch {
    Read(RwLockReadGuard<'_, ()>),
    Write(RwLockWriteGuard<'_, ()>),
    Optimistic(u64), // captured version
}
```

### 5.2 Latch coupling (crab walking)

For B-tree descent during read:

```rust
fn lookup(key: &[u8]) -> Option<Tuple> {
    let mut node_id = root_id;
    let mut parent_latch = self.acquire_read(node_id);
    loop {
        let page = self.frame(node_id);
        if page.is_leaf() {
            // hold parent's read latch only until child latch is held
            let leaf_latch = self.acquire_read(page.id());
            drop(parent_latch);
            return search_leaf(&leaf_latch, key);
        }
        let child = page.find_child(key);
        let child_latch = self.acquire_read(child);
        drop(parent_latch);                 // release after grabbing child
        parent_latch = child_latch;
        node_id = child;
    }
}
```

For writes (insert/delete/split): the descent uses **optimistic** latches; on a node that may split, the write upgrades to **WRITE** and recursively re-acquires WRITE on ancestors that may also split.

### 5.3 Avoiding splits under contention

Splits hold up to root-level WRITE latches. To minimize the blast radius:

1. **Pessimistic prefetch** — when an inserter sees `fill > 0.85`, it pre-splits before the next inserter does.
2. **Right-link nodes (Lehman & Yao 1981)** — leaves form a singly-linked list; inserters walking right need not re-acquire parent.
3. **Sub-tree latching** — isolate splits to small sub-trees by deferring rebalancing to background.

### 5.4 Optimistic concurrency control (OCC) for read-heavy

Each frame has a `version: AtomicU64`. Read flow:

```
v1 = frame.version.load(Acquire)
if v1 & 1 == 1 { /* writer in progress, retry */ }
... do read into local buffer ...
v2 = frame.version.load(Acquire)
if v1 != v2 { retry }
return buffer
```

Writers `fetch_add(1, AcqRel)` before modifying (parity = 1, "in progress"), then `fetch_add(1, AcqRel)` after (parity = 0). This eliminates RwLock cache-line contention on hot leaves.

---

## 6. Buffer pool concurrency `[[FILE-01]]` §6

### 6.1 Striping

The buffer pool is divided into `N_PARTITIONS = next_pow2(ncpu)` shards. Each shard owns:

* A page table (HashMap page_id → frame_id).
* A free list.
* An ARC eviction structure (T1, T2, B1, B2).
* A partition mutex (only for table mutations).

Page lookup: `partition = hash(page_id) & (N_PARTITIONS - 1)`.

### 6.2 Pin/unpin

Each frame has a `pin_count: AtomicU32`. Pin = `fetch_add(1, AcqRel)`; unpin = `fetch_sub(1, AcqRel)`. Eviction skips frames with `pin_count > 0` and re-tries with backoff.

```rust
struct PinGuard<'p> { pool: &'p BufferPool, frame: FrameId }
impl Drop for PinGuard<'_> {
    fn drop(&mut self) { self.pool.unpin(self.frame); }
}
```

Pins are RAII to prevent leaks under panic.

### 6.3 Eviction & hazard pointers

Eviction may concurrently free a frame whose page another reader is about to acquire. Two protections:

1. **Pin-before-touch** — never read frame bytes without a pin.
2. **Hazard pointers** — eviction publishes its candidate frame_id into a hazard slot; readers check before final dereference.

Combined: pin-then-verify-id; if id changed, retry lookup.

---

## 7. Write serialization & group commit

### 7.1 Per-shard write queue

Writes are sharded by **collection id mod write-pool size**. Each write thread owns a queue; all writes to a shard are serial within that thread. This:

* Avoids per-collection mutexes on the hot path.
* Preserves single-writer correctness for B-tree nodes within a collection.
* Allows different collections to commit in parallel.

### 7.2 Group commit

When multiple txns flush concurrently, the WAL flusher batches them:

```rust
fn flusher_loop(rx: Receiver<TxnFlush>) {
    let mut buf = Vec::with_capacity(1 << 20);
    loop {
        let first = rx.recv().expect("shutdown");
        buf.clear();
        buf.extend(&first.bytes);
        let deadline = Instant::now() + Duration::from_micros(GROUP_COMMIT_US);
        let mut acks = vec![first.ack];
        while let Ok(more) = rx.recv_deadline(deadline) {
            if buf.len() + more.bytes.len() > MAX_BATCH { break; }
            buf.extend(&more.bytes);
            acks.push(more.ack);
            if buf.len() > BATCH_SOFT_TARGET { break; }
        }
        wal_file.append_and_fsync(&buf);
        for a in acks { a.send(Ok(())).ok(); }
    }
}
```

Tunables:

* `GROUP_COMMIT_US` (default 200 µs) — max wait for additional batches.
* `MAX_BATCH` (default 4 MiB) — hard ceiling.
* `BATCH_SOFT_TARGET` (default 1 MiB) — flush when reached.

Throughput model: `commits/s ≈ 1 / (fsync_us + GROUP_COMMIT_US/2) × batch_factor`.

### 7.3 Write admission control

If WAL backlog > `wal_high_water` (default 64 MiB), new writes return `OvnError::WriteBackpressure(retry_after_ms)`. The retry-after value is computed from current flush throughput.

---

## 8. Async I/O integration

### 8.1 Backends

| Platform | Primary           | Fallback              |
| -------- | ----------------- | --------------------- |
| Linux    | io_uring          | epoll + threadpool    |
| macOS    | kqueue            | threadpool            |
| Windows  | IOCP              | threadpool            |
| WASM/JS  | OPFS async API    | (none)                |

io_uring is enabled when:

* Kernel ≥ 5.10
* `io_uring_setup` succeeds
* `OVN_DISABLE_IO_URING` env var not set

### 8.2 Operation submission

```rust
trait IoBackend {
    fn read(&self, fd: Fd, off: u64, buf: BufMut)  -> IoFuture<usize>;
    fn write(&self, fd: Fd, off: u64, buf: Buf)    -> IoFuture<usize>;
    fn fsync(&self, fd: Fd)                        -> IoFuture<()>;
    fn fdatasync(&self, fd: Fd)                    -> IoFuture<()>;
    fn fallocate(&self, fd: Fd, off: u64, len: u64)-> IoFuture<()>;
}
```

`IoFuture<T>` is a custom future that integrates with the engine's scheduler (Tokio if Tokio is the host runtime; otherwise the engine's own.

### 8.3 SQE batching

Engine accumulates I/O ops in a per-thread submission ring; the reactor submits in batches every `IO_BATCH_US` (default 50 µs) or when ring half full. This amortizes syscall cost.

### 8.4 Read-ahead

For sequential B-tree leaf scans, the read-ahead engine submits `READ_AHEAD_DEPTH` (default 8) parallel reads on detected sequentiality (page_id deltas mostly +1). On random access, depth drops to 0.

### 8.5 WAL fsync barrier

`fsync` issued via async backend; WAL flusher awaits completion before acking writers. On platforms where async fsync is not available (kqueue, OPFS), a dedicated kernel thread runs the fsync; the reactor parks until it returns.

---

## 9. Lock-free data structures

### 9.1 MPMC ring buffer (background queues)

Used for `compactor.submit(Task)`, `metrics.emit(Metric)`, etc. Implementation: bounded ring with per-slot version counter (Vyukov-style). Producer:

```
seq = (slot.version & MASK)
if seq != idx { spin or back off }
slot.payload = msg
slot.version.store(idx + 1, Release)
```

### 9.2 Treiber stack (free lists)

For frame free-list and small object pools. Lock-free with hazard pointers protecting the popped node from ABA.

### 9.3 RCU-style reads (catalog)

The schema catalog is read on every query. Strategy: store it in an `Arc<Catalog>` swapped via `arc_swap`. Readers do `arc_swap.load_full()` (1 atomic load). Writers `arc_swap.store(Arc::new(new_catalog))`. Old version is dropped when last reader releases.

### 9.4 SeqLock for tiny structs

Used for the global `EngineStats` snapshot exposed to `engine.stats()`:

```rust
struct SeqLockStats {
    seq:   AtomicU64,
    inner: UnsafeCell<Stats>,
}
```

Reader retries until two consecutive even sequences match.

---

## 10. Memory ordering reference

This is the **definitive table** of orderings used in Oblivinx3x. Deviations require an ADR.

| Site                                  | Load order  | Store order | Reason                                     |
| ------------------------------------- | ----------- | ----------- | ------------------------------------------ |
| `pin_count` increment                 | —           | `AcqRel`    | Pair with eviction's `Acquire` snapshot    |
| Buffer pool frame `version`           | `Acquire`   | `AcqRel`    | OCC reader observes consistent state       |
| WAL `last_lsn`                        | `Acquire`   | `Release`   | Reader needs Release-published bytes       |
| Tx manager `next_txid`                | —           | `AcqRel`    | Used as identity; relax to `Relaxed` ok    |
| MVCC version chain `next` pointer     | `Acquire`   | `Release`   | Publish chain link before observable       |
| Catalog `Arc` swap                    | (`arc_swap`)| (`arc_swap`)| Library handles ordering                    |
| Stats counters (best-effort)          | `Relaxed`   | `Relaxed`   | Approximate values acceptable               |
| Replication peer `last_seen_hlc`      | `Acquire`   | `Release`   | GC needs causal observation                |
| Plugin lifecycle handshakes           | `SeqCst`    | `SeqCst`    | Cross-component initialization barrier     |

**General rule:** prefer `Acquire/Release` over `SeqCst`. Use `SeqCst` only when total ordering across multiple variables is required.

---

## 11. Cancellation & timeouts

### 11.1 Cancellation token

Every long-running operation accepts a `CancelToken`:

```rust
pub struct CancelToken { inner: Arc<AtomicBool> }
impl CancelToken {
    pub fn cancel(&self) { self.inner.store(true, Release); }
    pub fn is_cancelled(&self) -> bool { self.inner.load(Acquire) }
}
```

Hot loops poll between iterations:

```rust
for batch in source.batches() {
    if cancel.is_cancelled() { return Err(OvnError::Cancelled); }
    sink.consume(batch)?;
}
```

I/O futures honor cancellation by issuing async cancel (io_uring `IORING_OP_ASYNC_CANCEL`) where supported; otherwise wait for completion then drop result.

### 11.2 Per-query timeouts

Queries accept `max_time_ms`. Implementation: a token is auto-cancelled after the deadline by a single timer-thread (delta queue, O(log N)).

### 11.3 Graceful shutdown

`engine.shutdown()` sequence:

1. Stop accepting new work; subsequent API calls return `Shutdown`.
2. Cancel all background workers.
3. Drain in-flight read/write txns (bounded wait, default 30 s).
4. Force checkpoint (flush memtable, fsync WAL).
5. Close file descriptors / release locks.
6. Join threads.

Forced shutdown (`engine.abort()`) skips drain and goes straight to checkpoint + close, accepting a small recovery work for next open.

---

## 12. Concurrency invariants (must hold at all times)

I1. **No latch is held across an `await`** other than the brief inner `await` inside async I/O backends — those latches are page version atomics, not lockable mutexes.

I2. **`pin_count > 0` ⇒ frame not evicted.**

I3. **WAL `last_lsn` increases monotonically in fsync order.**

I4. **A txn's `commit_lsn` is observed only after the WAL bytes containing its commit record are durable.**

I5. **MVCC version chains are append-only at the head; previous versions are immutable.**

I6. **Replicas advance `applied_lsn` monotonically.**

I7. **Page LSN ≤ WAL last_lsn at all times.** (WAL-before-page rule.)

I8. **HLC components are monotonic per process.**

Violations are debug-assert-fatal; release builds log and switch the engine to `READ_ONLY`.

---

## 13. Failure modes & detection

| Failure                       | Symptom                              | Detection                                        |
| ----------------------------- | ------------------------------------ | ------------------------------------------------ |
| Deadlock                      | All write threads parked             | Periodic deadlock detector (every 1 s)           |
| Lock convoy                   | P99 latch acquire > 10 ms            | Histogram alert; auto-switch to OCC on suspect   |
| Reader starvation             | No readers progress for 1 s          | Writer back-off triggers                         |
| Channel overflow              | Background queue full                | Producer returns BUSY; metric `obx_queue_full`   |
| FD exhaustion                 | I/O ops fail with EMFILE             | Pool capacity gate; admission control            |
| Memory pressure               | Allocator returns null               | OOM handler → engine pauses writers, dumps state |
| Misordered locks              | Debug assert; release log            | Lock-order tracker (debug only)                  |

---

## 14. Tradeoffs

| Decision                                | Chosen                       | Alternative              | Why                                  |
| --------------------------------------- | ---------------------------- | ------------------------ | ------------------------------------ |
| MVCC vs locks for readers               | MVCC                         | 2PL                      | Read scaling, no reader/writer block |
| Per-shard write threads                 | Hash by collection           | Single writer            | Multi-collection parallelism         |
| OCC vs RwLock on hot leaves             | OCC fallback                 | Always RwLock            | Eliminates cache-line ping-pong      |
| io_uring vs threadpool                  | io_uring on Linux ≥ 5.10     | Threadpool only          | 2–4× syscall reduction                |
| Group commit                            | Adaptive (200 µs default)    | Per-txn fsync            | 5–20× write throughput                |
| Lock-free vs mutex queue                | Lock-free MPMC ring          | Mutex + condvar          | Lower latency; no thundering herd     |
| Catalog snapshot                        | arc_swap (RCU)               | RwLock                   | Reader path is wait-free              |
| NUMA pinning                            | Optional, opt-in             | Always on                | Most users single-socket             |

---

## 15. Open questions & future

* **Hardware transactional memory (Intel TSX, ARM TME)** — could replace OCC on supported CPUs.
* **Userspace scheduler (e.g., Glommio shard-per-core)** — for ultra-low-latency embedded use.
* **eBPF observability** — emit per-thread latch wait histograms without instrumentation overhead.
* **Cross-shard parallel compaction** with work stealing.
* **Adaptive sharding** — dynamically split hot collections across multiple write threads.

---

## 16. Cross-references

* `[[FILE-01]]` §6 — buffer pool internals consumed here.
* `[[FILE-02]]` §3 — group commit in WAL flusher.
* `[[FILE-04]]` — index latching strategies.
* `[[FILE-06]]` §4 — MVCC visibility uses memory ordering rules from §10.
* `[[FILE-09]]` — replication threads (one per peer) participate in this model.
* `[[FILE-12]]` — concurrency metrics (`obx_latch_wait_us`, `obx_queue_depth`).
* `[[FILE-17]]` — race detection, ThreadSanitizer harness.
* `[[FILE-20]]/005` — ADR for MVCC vs locking choice.

*End of `10-CONCURRENCY.md` — 470 lines.*
