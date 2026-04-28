# 02 — WAL AND JOURNALING

> Specification of the write-ahead log, group commit, checkpoint protocol,
> and crash recovery procedures used by Oblivinx3x.
> Cross-references: `[[FILE-01]]` (page format), `[[FILE-06]]` (MVCC and
> recovery semantics), `[[FILE-10]]` (concurrency / threading),
> `[[FILE-20]]`/002 (journal-mode ADR).

---

## 1. Purpose

The Write-Ahead Log (WAL) is the durability backbone of the engine. It
provides:

1. **Crash atomicity** — a transaction either commits durably or
   appears never to have happened.
2. **Group commit** — multiple concurrent transactions amortize the
   cost of an `fsync` syscall.
3. **MVCC anchoring** — every committed write is assigned a Log
   Sequence Number (LSN), and snapshots reference an LSN to define
   their visible history.
4. **Replication source** — `[[FILE-09]]` tails the WAL to ship oplog
   records to replicas.
5. **Reactive query input** — `[[FILE-05]]` watchers subscribe to WAL
   ranges to compute differential updates.

It is **not** a replacement for the data file. Pages eventually flush
from the buffer pool; the WAL is **truncated** during checkpoint, not
kept forever (oplog and audit-log are separate streams; see §11).

---

## 2. Record Format

Each WAL record is a self-describing variable-length blob in the
ring-buffer region of the `.ovn2` file (offset `wal_offset` … `wal_offset
+ wal_size_bytes`, see `[[FILE-01]]` §3).

### 2.1 Header (32 bytes)

```
Byte offset  Size  Field
───────────  ────  ──────────────────────────────────────
   0          4    magic            = 0x57414C32 ("WAL2", LE)
   4          1    record_type      (see §2.2)
   5          1    flags            (bit0=compressed, bit1=encrypted,
                                     bit2=batch_start, bit3=batch_end,
                                     bit4=mvcc_commit, bit5=padding,
                                     bit6-7=reserved)
   6          2    payload_compression_codec (0=none,1=lz4,2=zstd)
   8          8    lsn              (monotonic; see §3)
  16          8    txn_id           (transaction id, 0 = autocommit)
  24          4    payload_len      (bytes of payload data after header)
  28          4    crc32c           (CRC-32C over header bytes 0..28
                                     concatenated with payload bytes)
```

```rust
#[repr(C, packed)]
pub struct WalRecordHeader {
    pub magic: [u8; 4],
    pub record_type: u8,
    pub flags: u8,
    pub payload_compression_codec: u16,
    pub lsn: u64,
    pub txn_id: u64,
    pub payload_len: u32,
    pub crc32c: u32,
}
const _: [u8; 32] = [0; std::mem::size_of::<WalRecordHeader>()];
```

### 2.2 Record types

```
0x00  RESERVED                     (must not appear; readers abort)
0x01  WAL_REC_BEGIN                (transaction start)
0x02  WAL_REC_COMMIT               (transaction end, durable point)
0x03  WAL_REC_ABORT                (transaction rollback)
0x04  WAL_REC_PAGE_IMAGE_FULL      (full page after image)
0x05  WAL_REC_PAGE_IMAGE_DELTA     (logical delta against previous LSN)
0x06  WAL_REC_PAGE_ALLOCATE        (new page id, type)
0x07  WAL_REC_PAGE_FREE            (page id returned to freelist)
0x08  WAL_REC_BTREE_SPLIT          (parent, left, right, promoted_key)
0x09  WAL_REC_BTREE_MERGE          (kept, removed)
0x0A  WAL_REC_DOC_INSERT           (collection_id, doc_id, full doc)
0x0B  WAL_REC_DOC_UPDATE           (collection_id, doc_id, diff)
0x0C  WAL_REC_DOC_DELETE           (collection_id, doc_id, tombstone)
0x0D  WAL_REC_INDEX_INSERT         (index_id, key, value_ref)
0x0E  WAL_REC_INDEX_DELETE         (index_id, key)
0x0F  WAL_REC_CHECKPOINT_BEGIN     (snapshot of dirty page set)
0x10  WAL_REC_CHECKPOINT_END       (durable mark for checkpoint)
0x11  WAL_REC_PRAGMA_CHANGE        (config update)
0x12  WAL_REC_SCHEMA_CHANGE        (collection create/drop/alter)
0x13  WAL_REC_FTS_POST             (FTS posting list update)
0x14  WAL_REC_VECTOR_INSERT        (vector index node update)
0x15  WAL_REC_OPLOG_FENCE          (replication fence)
0x16  WAL_REC_SAVEPOINT            (named subtransaction)
0x17  WAL_REC_SAVEPOINT_RELEASE
0x18  WAL_REC_SAVEPOINT_ROLLBACK
0x19  WAL_REC_NOOP                 (used by group commit padding)
0x1A  WAL_REC_RING_WRAP            (sentinel: next byte is at WAL start)
0x1B  WAL_REC_KEY_ROTATION         (encryption-at-rest rekey)
0x1C  WAL_REC_AUDIT_FENCE          (boundary for audit log)
0x1D..0x7F   reserved (engine future use)
0x80..0xEF   reserved (plugin records; plugin-id-tagged)
0xF0..0xFE   reserved
0xFF  WAL_REC_TRAILER              (zero-padded end of buffer)
```

### 2.3 Payload schemas

For the most-used record types:

#### WAL_REC_DOC_INSERT (0x0A)

```
Field                  Type        Notes
─────────────────────  ─────────  ───────────────────────────
collection_id          u32         hash-id of collection name
doc_id                 [u8; 12]    ObjectID
doc_size               u32
doc_bytes              var         OBE2-encoded document
```

#### WAL_REC_DOC_UPDATE (0x0B)

```
Field                  Type        Notes
─────────────────────  ─────────  ───────────────────────────
collection_id          u32
doc_id                 [u8; 12]
prev_lsn               u64         LSN of previous version
diff_op_count          u16
diff_ops               var         array of {field_path, op, value}
```

#### WAL_REC_PAGE_IMAGE_FULL (0x04)

```
Field                  Type        Notes
─────────────────────  ─────────  ───────────────────────────
page_id                u64
page_bytes_compressed  u32
page_bytes             var         optionally LZ4/Zstd-compressed
```

#### WAL_REC_PAGE_IMAGE_DELTA (0x05)

```
Field                  Type        Notes
─────────────────────  ─────────  ───────────────────────────
page_id                u64
prev_lsn               u64
diff_run_count         u16
diff_runs              var         array of {offset:u32, length:u32, bytes}
```

#### WAL_REC_BTREE_SPLIT (0x08)

```
Field                  Type        Notes
─────────────────────  ─────────  ───────────────────────────
parent_page            u64
left_page              u64
right_page             u64
promoted_key_len       u16
promoted_key           var
```

### 2.4 Record alignment

Records are 8-byte aligned. The writer pads with `WAL_REC_NOOP` of
`payload_len = 0` if needed, ensuring random reads can land on a header
without scanning bytes.

---

## 3. LSN (Log Sequence Number)

Every record carries a 64-bit LSN. Properties:

- **Monotonically increasing** per database, never reused.
- Encoded as **byte offset within the entire WAL stream** since database
  creation (modulo the ring wrap, see §6). This makes LSN ↔ record
  position lookup O(1).
- The **`durable_lsn`** is the highest LSN whose record has been
  fsynced. Pages must not flush past their record's `lsn > durable_lsn`
  (the WAL rule).

```rust
pub struct LsnRange {
    pub start: u64,   // inclusive
    pub end: u64,     // exclusive
}

pub struct WalState {
    pub written_lsn: AtomicU64,    // appended to buffer (may not be fsynced)
    pub durable_lsn: AtomicU64,    // fsynced to disk
    pub checkpoint_lsn: AtomicU64, // last successful checkpoint mark
    pub truncate_lsn: AtomicU64,   // bytes before this can be reused
}
```

---

## 4. Group Commit

Group commit batches multiple transactions into one fsync. Workflow:

```text
worker thread T:
    fill_record(buf, record)
    append_to_buffer(buf)         # atomic; updates written_lsn
    if record.flags & FLAG_FORCE_SYNC:
        signal_writer()
    park_until(durable_lsn >= my_lsn)

writer thread (only one):
    loop:
        wait_for_work_or_interval(commit_interval_us=1000)
        snapshot = (written_lsn, len of buffer)
        write_payload(buffer, snapshot)
        fsync(file)
        durable_lsn.store(snapshot.lsn)
        wake_all_parked()
```

### 4.1 Commit-interval policy

`pragma wal_commit_interval_us` (default 1000 = 1 ms) is the maximum
latency that an `INSERT` waits for `fsync`. The writer also flushes
**immediately** if either:

- the buffer reaches `wal_force_flush_bytes` (default 256 KB), or
- a record carries `FLAG_FORCE_SYNC` (e.g. an explicit `db.flush()`).

### 4.2 Throughput model

If we have `N` concurrent writers, each producing `B` bytes per record,
group commit yields a per-thread cost:

```
cost_per_record ≈ (Tᶠˢʸⁿᶜ / N) + Tʷʳⁱᵗᵉ(B)
```

Tᶠˢʸⁿᶜ on consumer NVMe ≈ 50 µs; Tʷʳⁱᵗᵉ for a 256 B record ≈ 0.5 µs.
At 32 concurrent writers, cost per record drops from 50 µs (single
writer fsync-per-record) to ~2 µs — a 25× improvement.

### 4.3 Fsync strategy

- **Linux:** `fdatasync` is preferred (only metadata-changing fsync
  required because we keep file size constant after `fallocate`).
- **macOS:** `fcntl(F_FULLFSYNC)` is required for true durability —
  plain `fsync` does not flush the disk cache. Detect APFS at mount
  and warn if HFS+.
- **Windows:** `FlushFileBuffers` after `WriteFile` with
  `FILE_FLAG_WRITE_THROUGH` open mode.
- **WASM / browser:** OPFS `FileSystemSyncAccessHandle.flush()` is
  best-effort; durability bounded to OS-level cache flush.

### 4.4 Buffer ring

In-memory WAL buffer is a 16 MiB ring (configurable). Writers append at
`tail`, the writer thread drains from `head`. When the buffer is full,
writers block on `parking_lot::Condvar`.

```rust
pub struct WalBuffer {
    data: Box<[u8; 16 * 1024 * 1024]>,
    head: AtomicU64,
    tail: AtomicU64,
    backpressure: Mutex<()>,
    cond_drained: Condvar,
}
```

---

## 5. Checkpoint

A checkpoint flushes dirty pages from the buffer pool back to the data
file region and **truncates** (logically) the WAL up to the
checkpoint LSN.

### 5.1 Modes

```
PASSIVE    Best-effort, no waiting on pinned pages. Used for periodic
           background checkpoints. May leave some dirty pages.
FULL       All dirty pages flushed. Briefly blocks new writes for a
           moment to capture a consistent dirty-page set.
RESTART    Like FULL, but additionally resets WAL ring to start.
           Used at clean shutdown.
TRUNCATE   Like RESTART, but also returns disk space (zeroes the WAL
           region's tail).
```

### 5.2 Algorithm (FULL)

```text
checkpoint_full():
    cp_lsn = wal.assign_lsn()
    wal.append(WAL_REC_CHECKPOINT_BEGIN, cp_lsn)
    fsync_wal()                      # ensure begin is durable

    # Stop the world briefly to snapshot dirty page set.
    pause_writers()
    snapshot = buffer_pool.dirty_pages_below_lsn(cp_lsn)
    resume_writers()

    for batch in snapshot.chunks(32):
        encrypt_and_compress_each(batch)
        pwritev(data_file, batch)    # one syscall per 32 pages
    fsync(data_file)

    wal.append(WAL_REC_CHECKPOINT_END, cp_lsn)
    fsync_wal()

    wal.truncate_lsn = cp_lsn
    file_header.checkpoint_lsn = cp_lsn
    write_file_header_with_crc()
    fsync(data_file)
```

### 5.3 Triggers

A checkpoint is **scheduled** by any of:

| Trigger                           | Default | Pragma                            |
|-----------------------------------|--------:|-----------------------------------|
| WAL bytes since last checkpoint   |  16 MiB | `checkpoint_wal_bytes`            |
| Time since last checkpoint        |  60 s   | `checkpoint_interval_s`           |
| Dirty pages > N% of buffer pool   |  50 %   | `checkpoint_dirty_pct`            |
| Explicit `db.checkpoint()`        |    —    | n/a                               |
| Clean shutdown                    |    —    | n/a (mode=`RESTART`)              |

The checkpoint scheduler picks **PASSIVE** by default unless any
"saturation" condition is met (WAL > 80% full, dirty pages > 80% pool),
in which case it escalates to **FULL** with bounded duration.

### 5.4 Admission control

A checkpoint that disrupts foreground latency is bad. Each checkpoint
runs with a **target duration** (`checkpoint_target_us`, default 200 ms)
and an **adaptive flush rate**:

```
flush_rate = clamp(
    dirty_pages / target_duration,
    min = 8 pages / 100 ms,
    max = buffer_pool.size / 100 ms
)
```

Between page batches the checkpointer sleeps `1 / flush_rate` to leave
I/O headroom.

---

## 6. WAL Ring Buffer

The WAL is a **fixed-size ring buffer** (default 64 MiB; configurable
via `wal_max_size_bytes`). When the writer reaches the end, it appends a
`WAL_REC_RING_WRAP` sentinel and continues from `wal_offset`.

Invariants:

1. `truncate_lsn ≤ durable_lsn ≤ written_lsn`.
2. `(written_lsn - truncate_lsn) ≤ wal_size_bytes`. If a writer is
   about to violate this, the writer **blocks** and forces a
   checkpoint. (Backpressure path; emits `obx_wal_backpressure_total`
   metric.)

Position formula:

```
file_offset(LSN) = wal_offset + (LSN - lsn_of_first_record_in_current_round)
```

Where `lsn_of_first_record_in_current_round` is the LSN that landed at
`wal_offset` after the last wrap.

```
                     ┌──── wrap ────┐
WAL region:  [........R............R......]
              ▲     ▲                    ▲
              head  tail                 wal_size_bytes

R = WAL_REC_RING_WRAP sentinel.
```

A torn wrap is detected by readers: if a header magic mismatches, a
`WAL_REC_RING_WRAP` precedes it, the reader resumes from `wal_offset`.

---

## 7. Crash Recovery Algorithm

Recovery runs at every database open. Steps:

```text
1. open(file)
2. parse_file_header() ⇒ checkpoint_lsn, wal_offset, wal_size_bytes
3. scan_wal(starting at checkpoint_lsn):
       for each record:
           verify_crc(record)
           if !valid: stop (assume torn write at tail)
           if record.txn_id ∈ committed_txns:
               apply_redo(record)
           else:
               buffer_pending(record)
   end_lsn = last_valid_record.lsn

4. process pending:
       for each (txn_id, records) in buffer_pending:
           if txn ended in WAL_REC_COMMIT:
               apply_redo(records)
           else:
               apply_undo(records)        # rollback partial txn

5. rebuild MVCC visibility:
       reconstruct_active_tx_table()
       publish_horizon(safe_horizon)

6. checkpoint_full()                       # produce a clean state
7. wal.truncate to end_lsn
8. open as RW
```

### 7.1 Idempotence

Every redo operation is idempotent:

- **PAGE_IMAGE_FULL:** unconditional overwrite — idempotent by
  definition.
- **PAGE_IMAGE_DELTA:** check `page.lsn >= record.prev_lsn` before
  applying.
- **DOC_INSERT:** check primary index does not already contain
  `doc_id`. If it does (replay artifact), skip.
- **DOC_DELETE:** if document already absent, skip.
- **BTREE_SPLIT/MERGE:** the resulting page LSNs are stamped equal to
  the WAL LSN; replay only if `page.lsn < record.lsn`.

### 7.2 Edge cases

| Failure scenario             | Detection                       | Recovery                              |
|------------------------------|---------------------------------|---------------------------------------|
| Torn WAL record at tail      | CRC mismatch / magic mismatch   | Truncate WAL after last valid record. |
| Torn page in data region     | Per-page CRC mismatch           | Restore from WAL `PAGE_IMAGE_FULL`.   |
| Partial fsync (file shorter) | Header `total_pages` >> file    | Truncate file to multiple of page;    |
|                              |                                 | replay WAL.                           |
| Power loss during checkpoint | `CHECKPOINT_END` missing        | Treat as PASSIVE; subsequent writes   |
|                              |                                 | rebuild via WAL.                      |
| Header corruption            | Header CRC fail                 | Use backup header at file end.        |
| Both headers corrupt         | Both CRCs fail                  | Refuse open without OPEN_FORCE_RECOVER|
| Encryption tag mismatch      | GCM auth fail                   | Refuse open; require key rotation.    |
| Disk full mid-write          | `ENOSPC`                        | Mark DB read-only; surface error.     |
| Clock skew (HLC)             | `now < last_lsn_time`           | Use HLC max + 1 instead.              |

### 7.3 Recovery time

For the candidate workload (256 B docs, 8 KB pages):

- **Checkpoint frequent (every 16 MB):** worst-case WAL replay = 16 MB
  / ~150 MB/s = **~110 ms**.
- **Checkpoint infrequent (1 GB WAL):** ~7 s.
- Engine target: open with replay ≤ **500 ms** at 99th percentile —
  enforced by the 16 MB checkpoint default.

---

## 8. WAL for MVCC

A snapshot is anchored by an LSN: the snapshot reads the version of
each row whose `xmin_lsn ≤ snapshot_lsn ∧ (xmax_lsn = ∞ ∨ xmax_lsn >
snapshot_lsn)` (see `[[FILE-06]]` §3).

The WAL therefore carries `xmin_lsn` and `xmax_lsn` as part of every
DOC_INSERT / DOC_UPDATE / DOC_DELETE record. Old versions are **not**
in the data file (they live as version chain in the leaf page); the WAL
records both the old and new version on update, allowing the MVCC layer
to reconstruct the chain after a crash.

---

## 9. Concurrency

Concurrent WAL access:

- **Multiple writers** append in parallel using a lock-free CAS loop on
  `tail`. Each writer reserves `payload_len + 32` bytes; if the buffer
  is full, falls back to backpressure mutex.
- **Single writer thread** drains the buffer to disk (one `pwrite` →
  `fsync` cycle).
- **Readers** (recovery, replication, reactive queries) use `pread` with
  a shared lock on the WAL region. They never block the writer.

```rust
struct WalAppendCursor {
    lsn: u64,
    file_offset: u64,
}
fn reserve(payload_len: u32) -> WalAppendCursor {
    loop {
        let cur = tail.load(Ordering::Acquire);
        let next = cur + (32 + payload_len + padding(payload_len)) as u64;
        if next - head.load(Ordering::Relaxed) > WAL_BUFFER_BYTES {
            backpressure_wait();
            continue;
        }
        if tail.compare_exchange(cur, next, AcqRel, Acquire).is_ok() {
            return WalAppendCursor { lsn: cur, file_offset: cur };
        }
    }
}
```

---

## 10. WAL Compaction

WAL is **not** compacted in place — checkpoint is the compaction
mechanism. Once `checkpoint_lsn` advances, all bytes before
`checkpoint_lsn` are conceptually free, and the writer reuses them in
the next ring rotation.

For replication / oplog purposes, we **export** WAL records to the
oplog stream before truncation; see `[[FILE-09]]` §1.

---

## 11. Comparison: WAL vs Rollback Journal vs Shadow Paging

### 11.1 Rollback Journal (SQLite default pre-3.7)

- Concept: copy original page → journal, modify in place, on commit
  delete journal, on rollback restore from journal.
- Pros: simple recovery (restore journal).
- Cons: writes hit data file twice (journal + page), readers blocked
  by writers (no concurrency), checkpoint == every commit.

### 11.2 WAL (chosen)

- Concept: log every change to a separate file/region; data file lags.
- Pros: writers don't block readers (readers see snapshot at their
  LSN), group commit, fast crash recovery, oplog reuse.
- Cons: requires checkpoint to bound WAL size, slightly more complex
  recovery.

### 11.3 Shadow Paging (LMDB)

- Concept: copy-on-write — every modified page is rewritten elsewhere,
  meta-page atomically swapped.
- Pros: trivial crash safety (atomic root swap), zero in-place writes.
- Cons: write amplification 2-3×, no group commit, fragmentation,
  vacuum required to reclaim.

### 11.4 Decision matrix

|                          | Rollback | WAL    | Shadow |
|--------------------------|---------:|-------:|-------:|
| Read concurrency         |       1× |    N×  |    N×  |
| Write concurrency        |       1× |    N×¹ |     1× |
| Write amplification      |     2.0× |  1.2×² |   2.5× |
| Crash recovery time      |   O(WAL) | O(WAL) |  O(1)  |
| Fsync per commit         |     1-2  |  1/N³  |     1  |
| Fragmentation            |   none   | none   | growing|
| Disk space overhead      |     2×   |  1.05× | varies |

¹ With BEGIN CONCURRENT (`[[FILE-06]]` §6).
² Write amp = (sizeof(record)+sizeof(checkpointed page chunk)) /
   sizeof(payload). Empirical 1.18× on document workloads.
³ Group commit.

**Conclusion: WAL** — best concurrency, best fsync amortization, and
oplog reuse without an additional structure.

---

## 12. WAL Encryption

When encryption-at-rest is enabled, every WAL record's payload is
**encrypted-then-CRC'd**:

```
payload   := AES-GCM-SIV(plaintext, key=K_wal, nonce = lsn || record_no)
crc32c    := CRC32C(header_bytes || encrypted_payload)
auth_tag  := 16 bytes appended after payload (GCM tag)
```

Note that `K_wal` is **distinct** from `K_data`: WAL uses a
`HKDF(master, "ovn:wal:v1")` derivation. This isolates a leaked WAL key
from the data file.

Group commit still works: encryption is per-record, parallel-safe.

---

## 13. WAL Compression

Records with `payload_len > 256` are LZ4-compressed if compression is
enabled. The codec is recorded in `payload_compression_codec` in the
header. Compression happens **before** encryption (you cannot compress
ciphertext effectively).

Empirically, 256-byte threshold balances: smaller records get more
overhead than benefit; larger get 1.6-2.5× compression on JSON-ish
payloads.

---

## 14. WAL Replication API

```rust
pub struct WalReader {
    file: SharedFile,
    cursor: u64,                  // current LSN
    end_lsn: u64,                 // tail at open
}

impl WalReader {
    pub fn open_at(lsn: u64) -> Result<Self, OvnError>;
    pub fn next(&mut self) -> Result<Option<WalRecordRef<'_>>, OvnError>;
    pub fn follow(&mut self) -> Result<WalRecordRef<'_>, OvnError>; // blocks
    pub fn position(&self) -> u64;
}
```

`follow()` blocks until a new record arrives (used by replication). It
is implemented via a per-database `Notify` woken by the WAL writer thread
after each fsync.

Read isolation: WAL records are immutable once written; the writer
appends only, so readers do not need locks beyond the standard ring-
buffer-position check.

---

## 15. Open Questions

1. **WAL pre-allocation.** We `fallocate` the WAL region on database
   creation, but ext4 may keep extent metadata dirty across boots. We
   should also `posix_fallocate` to force allocation up front and
   avoid fragmentation at runtime. Validate on btrfs / ZFS.
2. **NVMe atomic writes.** A 16 KiB record straddling two 4 KiB sectors
   has a small torn-write probability (~1e-7 per write per drive year).
   The CRC catches this; we should optionally enable `O_ATOMIC` on
   kernels that support it.
3. **WAL on tmpfs / RAM disk.** A future "memory" mode would let users
   put WAL on tmpfs with relaxed durability for benchmarking. Track via
   `pragma wal_durability = relaxed`.

---

## 16. Compatibility Notes

- WAL format magic `0x57414C32` (`"WAL2"`) is compatible only with the
  v2 spec. Version 1 magic was `"WAL1"`. We do **not** auto-upgrade
  WALs across major versions; clean shutdown of v1 is required.
- Plugin-defined WAL records (range `0x80..0xEF`) must be tagged with
  the plugin id in the first byte of the payload; readers without the
  plugin loaded skip these records gracefully (they still apply if the
  plugin's `redo` callback returns a no-op).
- For replication consistency, a replica reading a WAL it cannot fully
  parse (newer engine version) ignores plugin records but still applies
  page-image and document records.

---

## 17. Cross-References

- WAL-page interaction: `[[FILE-01]]` §15 (recovery hooks).
- MVCC visibility from WAL: `[[FILE-06]]` §3.
- Concurrency contract: `[[FILE-10]]` §2.
- Replication consumer: `[[FILE-09]]` §2.
- Encryption keys: `[[FILE-07]]` §2.
- Metrics: `[[FILE-12]]` §3 (`obx_wal_*`).
- ADR justifying WAL choice: `[[FILE-20]]`/002.

---

*End of `02-WAL-AND-JOURNALING.md` — 615 lines.*
