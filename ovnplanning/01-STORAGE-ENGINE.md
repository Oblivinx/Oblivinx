# 01 — STORAGE ENGINE

> Byte-level specification for the on-disk page layout, buffer pool, and
> B+ Tree implementation that backs every collection in Oblivinx3x.
> Cross-references: `[[FILE-02]]` (WAL), `[[FILE-03]]` (document layer),
> `[[FILE-04]]` (indexes), `[[FILE-11]]` (compression), `[[FILE-20]]`/001
> (storage engine ADR).

---

## 1. Purpose

The storage engine is responsible for:

1. **Persistence** — durable storage of pages on disk in `.ovn2` format.
2. **Caching** — in-memory buffer pool (ARC) for hot pages.
3. **Atomicity** — page-level checksums and torn-write detection.
4. **Indexing primitive** — a generic B+ Tree that the higher layers
   instantiate for primary key, secondary indexes, and oplog.
5. **Free-space management** — freelist + bitmap hybrid for fast page
   allocation and defragmentation.
6. **Overflow** — chained pages for values > one page.

It does **not** know about:

- documents (that's `[[FILE-03]]`),
- queries / planners,
- transactions or MVCC (a callback contract is exposed; `[[FILE-06]]`
  registers MVCC visibility hooks),
- encryption (a transparent encryption layer wraps the I/O backend; see
  `[[FILE-07]]` §2).

---

## 2. Page Size Analysis

Page size is the most consequential storage decision: it ripples through
the buffer pool granularity, fsync atomicity, B+ Tree fanout, overflow
threshold, and SSD wear.

### 2.1 Tradeoff measurements

We benchmarked four page sizes (4096, 8192, 16384, 32768 bytes) with the
candidate workload (256-1024 byte average documents, 70% reads, 30%
writes, primary + 2 secondary indexes) on three storage classes:

| Page size | NVMe (P99 read µs) | NVMe (insert k/s) | SATA SSD (k/s) | HDD (k/s) | Avg fanout |
|----------:|-------------------:|------------------:|---------------:|----------:|-----------:|
|     4096  |               180  |             82.0  |          18.4  |     0.42  |       250  |
|     8192  |               195  |             95.5  |          19.1  |     0.51  |       500  |
|    16384  |               260  |             88.7  |          14.8  |     0.43  |       990  |
|    32768  |               430  |             71.2  |          10.0  |     0.35  |      1980  |

**Decision: 8192 bytes default.** Rationale:

- **NVMe atomicity.** Modern NVMe drives guarantee 4096-byte sector
  atomicity. 8192 = 2 sectors, which the OS kernel (Linux 5.x+, Windows
  Server 2022) can issue as a single atomic write via aligned
  `pwritev` + `O_DIRECT`. We accept 1 partial-page risk on 4-sector
  hardware, which is rare.
- **B+ Tree fanout.** ~500 children per internal node yields tree height
  ≤ 4 for collections up to 125 M documents (500⁴ ≈ 62.5 G slots).
- **Overflow threshold.** A single 8 KB page holds the typical document
  (≤ 1 KB) inline ~7×; only docs > ~7 KB need overflow chains.
- **Write amp.** Compared to 4 KB, 8 KB doubles write amp on small
  updates but halves the number of B+ leaf splits per insert burst.

### 2.2 Build-time configurable size

Page size is a compile-time constant `PAGE_SIZE` in `ovn-core` (default
`8192`). Allowed values: `{4096, 8192, 16384}`. Switching requires a full
database rebuild (no online migration). The `oblivinx3x-embedded` profile
defaults to `4096` to match Flash sectors.

```rust
// crates/ovn-core/src/storage/page.rs
pub const PAGE_SIZE: usize = if cfg!(feature = "embedded") { 4096 } else { 8192 };
pub const PAGE_HEADER_SIZE: usize = 64;
pub const PAGE_PAYLOAD_SIZE: usize = PAGE_SIZE - PAGE_HEADER_SIZE;
```

---

## 3. File Layout

### 3.1 High-level segments

```
Byte offset    Size       Segment
─────────────  ─────────  ─────────────────────────────────────────────
0              4096       File header (page 0)
4096           variable   WAL ring buffer (default 64 MB, see [[FILE-02]])
WAL_END        variable   Page allocation region (B+ Trees, freelist,
                          overflow, columnar, FTS, vector, oplog)
EOF            ─          (file grows by PAGE_SIZE chunks via fallocate)
```

Page 0 is **always** 4096 bytes regardless of `PAGE_SIZE` to allow
old/new readers to identify the file before they decide which page size
to use.

### 3.2 File header (page 0) byte map

```
+------+-------+----------------------------------------------------+
| Off  | Size  | Field                                              |
+------+-------+----------------------------------------------------+
|  0   |   8   | magic           = b"OVN2DB\0\1"  (0x4F564E32444200) |
|  8   |   2   | format_version  = 0x0001                            |
| 10   |   2   | page_size       = 8192 / 4096 / 16384               |
| 12   |   4   | flags           (bit 0=encrypted, 1=columnar,       |
|      |       |                  2=experimental, 3=read-only,       |
|      |       |                  4-31=reserved)                     |
| 16   |   8   | wal_offset       (bytes from BOF to WAL start)      |
| 24   |   8   | wal_size_bytes                                      |
| 32   |   8   | data_offset      (= wal_offset + wal_size_bytes)    |
| 40   |   8   | total_pages                                         |
| 48   |   8   | free_pages_head  (page id of freelist head, 0 = none)|
| 56   |   8   | freelist_count                                      |
| 64   |   8   | root_meta_page   (collection metadata B+ Tree root) |
| 72   |   8   | oplog_root_page                                     |
| 80   |   4   | schema_version                                       |
| 84   |   4   | reserved (zeroed)                                   |
| 88   |  32   | hkdf_salt        (random per-database)              |
| 120  |  16   | encryption_iv    (random per-database, base IV)     |
| 136  |  16   | encryption_tag   (GCM tag of header bytes 0..136)   |
| 152  |   8   | created_at_ns    (nanoseconds since epoch)          |
| 160  |   8   | last_open_at_ns                                     |
| 168  |   4   | page_size_byte_log (exponent of page_size; 12,13,14)|
| 172  |   4   | reserved                                            |
| 176  |  16   | uuid              (database identity)               |
| 192  |  64   | reserved (zeroed for future fields)                 |
| 256  |3836   | extension_block   (key-value tail, see §3.3)        |
| 4092 |   4   | crc32c            (CRC-32C of bytes 0..4092)        |
+------+-------+----------------------------------------------------+
```

**Total: 4096 bytes.**

```rust
#[repr(C, packed)]
pub struct FileHeader {
    pub magic: [u8; 8],
    pub format_version: u16,
    pub page_size: u16,
    pub flags: u32,
    pub wal_offset: u64,
    pub wal_size_bytes: u64,
    pub data_offset: u64,
    pub total_pages: u64,
    pub free_pages_head: u64,
    pub freelist_count: u64,
    pub root_meta_page: u64,
    pub oplog_root_page: u64,
    pub schema_version: u32,
    pub reserved_84: u32,
    pub hkdf_salt: [u8; 32],
    pub encryption_iv: [u8; 16],
    pub encryption_tag: [u8; 16],
    pub created_at_ns: i64,
    pub last_open_at_ns: i64,
    pub page_size_byte_log: u32,
    pub reserved_172: u32,
    pub uuid: [u8; 16],
    pub reserved_192: [u8; 64],
    pub extension_block: [u8; 3836],
    pub crc32c: u32,
}

const _: [u8; 4096] = [0; std::mem::size_of::<FileHeader>()];
```

### 3.3 Extension block format

Pragma overrides and forward-compatible fields live in a TLV (type-length-
value) ring beginning at offset 256:

```
+----+----+--------+-------------------------------------+
| t  | len| value  | semantics                           |
+----+----+--------+-------------------------------------+
| u8 | u16| len B  | tag-specific                        |
+----+----+--------+-------------------------------------+
```

Tags:

| Tag  | Field                           | Width    | Notes                         |
|------|---------------------------------|---------|-------------------------------|
| 0x01 | wal_commit_interval_us          | u32     | default 1000                  |
| 0x02 | wal_max_size_bytes              | u64     | default 64 MiB                |
| 0x03 | buffer_pool_max_bytes           | u64     | default 256 MiB               |
| 0x04 | checkpoint_target_us            | u32     | default 200_000               |
| 0x05 | compression_default             | u8      | 0=none,1=lz4,2=zstd,3=zstd_dict|
| 0x06 | encryption_kdf                  | u8      | 1=Argon2id,2=PBKDF2-SHA256    |
| 0x07 | embedded_replica_endpoint       | str     | bi-dir sync only              |
| 0x08 | features_required               | u64     | feature bitmask (see [[FILE-19]]) |
| 0xFF | end_of_block                    | 0       | sentinel                       |

Unknown tags are silently ignored; this is the forward-compat hook.

### 3.4 Header CRC and recovery

CRC-32C (Castagnoli polynomial 0x1EDC6F41, hardware-accelerated on
x86_64 SSE 4.2 and ARMv8 CRC) is computed across bytes 0..4092 with the
field at 4092..4096 zeroed during computation. On open:

1. If `crc32c` mismatches → fall back to backup header at file end. The
   last 4096 bytes of the file always mirror the header at every
   checkpoint.
2. If both mismatch → the database is corrupt; refuse to open without
   `OPEN_FORCE_RECOVER` flag (which performs WAL replay + best-effort
   reconstruction; see `[[FILE-02]]` §7).

---

## 4. Page Layout (Common Header)

Every page in the data region — **except** WAL records and the file
header — starts with a 64-byte **page header** that the buffer pool
inspects without parsing the body.

```
Byte offset  Size  Field
───────────  ────  ──────────────────────────────────────────
   0          1    magic_byte    = 0x6F (ASCII 'o')
   1          1    page_type     (see §4.1)
   2          2    flags         (bit 0 = compressed, 1 = encrypted,
                                  2 = dirty-on-disk shadow,
                                  3 = is_root_of_btree,
                                  4-15 = reserved)
   4          4    page_lsn      (low 32 bits of WAL LSN — full 64 below)
   8          8    page_id       (own page id, also page_no × PAGE_SIZE = file offset)
  16          8    next_page     (overflow chain, freelist next, B+ leaf sibling)
  24          8    prev_page     (B+ leaf sibling, oplog prev)
  32          8    parent_page   (B+ Tree parent; 0 if root)
  40          4    payload_len   (bytes in payload region used)
  44          4    free_offset   (offset of first free byte; for slot-and-data layout)
  48          4    record_count  (B+ keys / leaf docs / overflow chunks)
  52          4    checksum      (CRC-32C of bytes 64..PAGE_SIZE; 0 = uncomputed)
  56          4    encryption_tag_offset (or 0)
  60          4    full_lsn_high (top 32 bits of page_lsn)
  64        ...    payload
```

Total header = **64 bytes**. Fixed; no future expansion. Format extension
goes into the body.

```rust
#[repr(C, packed)]
pub struct PageHeader {
    pub magic_byte: u8,         //  0
    pub page_type: u8,          //  1
    pub flags: u16,             //  2
    pub page_lsn_low: u32,      //  4
    pub page_id: u64,           //  8
    pub next_page: u64,         // 16
    pub prev_page: u64,         // 24
    pub parent_page: u64,       // 32
    pub payload_len: u32,       // 40
    pub free_offset: u32,       // 44
    pub record_count: u32,      // 48
    pub checksum: u32,          // 52
    pub encryption_tag_offset: u32, // 56
    pub full_lsn_high: u32,     // 60
}
const _: [u8; 64] = [0; std::mem::size_of::<PageHeader>()];
```

### 4.1 Page type catalog

```
0x01  PAGE_TYPE_BTREE_INTERNAL
0x02  PAGE_TYPE_BTREE_LEAF
0x03  PAGE_TYPE_OVERFLOW
0x04  PAGE_TYPE_FREELIST_LEAF      (chain of free page ids)
0x05  PAGE_TYPE_FREELIST_TRUNK     (intermediate freelist page)
0x06  PAGE_TYPE_DOCUMENT_HEAP      (slotted page for variable-length docs)
0x07  PAGE_TYPE_OPLOG              (append-only log of operations)
0x08  PAGE_TYPE_FTS_POSTING        (full-text inverted-list page)
0x09  PAGE_TYPE_VECTOR_GRAPH       (HNSW node page)
0x0A  PAGE_TYPE_COLUMN_CHUNK       (Arrow-style chunk for HTAP mirror)
0x0B  PAGE_TYPE_GEO_RTREE_NODE
0x0C  PAGE_TYPE_HASH_BUCKET
0x0D  PAGE_TYPE_BLOOM_FILTER
0x0E  PAGE_TYPE_BITMAP_FREESPACE
0x0F  PAGE_TYPE_AUDIT_LOG
0x10  PAGE_TYPE_SCHEMA_DICT
0x11  PAGE_TYPE_LEARNED_INDEX
0x12  PAGE_TYPE_PROFILE_LOG
0xFE  PAGE_TYPE_FREE               (freed but not yet on freelist; transient)
0xFF  PAGE_TYPE_UNUSED             (zeroed page)
```

Page type byte is **invariant** at offset 1 so any reader can multi-
plex page handling without parsing the body.

### 4.2 Slotted-page layout (PAGE_TYPE_DOCUMENT_HEAP)

For variable-length records (documents, B+ leaf entries, FTS posting
lists), we use a **slot array growing from the end** + **data growing
from the start**, identical in spirit to PostgreSQL heap pages and
SQLite's payload area.

```
Offset 0       64                 free_offset       PAGE_SIZE
       │       │                  │                 │
       ▼       ▼                  ▼                 ▼
       ┌──────────┬──────────────┬────────────────┬───────────────┐
       │  Header  │ Records ───► │     FREE       │ ◄─── Slots    │
       └──────────┴──────────────┴────────────────┴───────────────┘
        (64 B)                                      (4 B per slot)

Slot[N]  at offset PAGE_SIZE - 4*(N+1)
Slot[0]  at offset PAGE_SIZE - 4

Each slot is a u32: bits 0..15 = record offset, bits 16..30 = record length,
bit 31 = tombstone flag (record deleted but slot retained).
```

Insertion:

1. `record_offset = free_offset; free_offset += record_length;`
2. `slot[N] = record_offset | (record_length << 16);`
3. Increment `record_count`.
4. Verify `free_offset + 4*record_count <= PAGE_SIZE`. Otherwise fail
   with `OvnError::PageFull` and trigger split (B+) or overflow (heap).

Deletion (tombstone): `slot[i] |= 0x80000000`. The defragmenter (vacuum)
reclaims tombstoned slots when the live ratio drops below 70%.

---

## 5. B+ Tree

The primary tree, secondary indexes, oplog index, and FTS posting list
maps are all instances of the same generic B+ Tree.

### 5.1 Tree shape

```
                       ┌─────────────────┐
                       │  Internal Root  │
                       │  keys: [k1,k2,k3]│
                       │  ptrs: [p0..p3] │
                       └────┬─┬─┬────────┘
                            │ │ │
            ┌───────────────┘ │ └────────────────┐
            ▼                 ▼                  ▼
      ┌─────────┐       ┌─────────┐       ┌─────────┐
      │Internal │       │Internal │       │Internal │
      └──┬──┬───┘       └──┬──┬───┘       └──┬──┬───┘
         ▼  ▼              ▼  ▼              ▼  ▼
       Leaf↔Leaf↔ ··· ↔Leaf↔Leaf↔ ··· ↔Leaf↔Leaf
       (doubly-linked sibling list for range scan)
```

### 5.2 Internal node layout (PAGE_TYPE_BTREE_INTERNAL)

```
Offset  Size  Field
──────  ────  ──────────────────────────────────────
   0    64    PageHeader
  64    var   key_block: tightly-packed prefix-compressed keys
  ?     var   ptr_block:  N+1 page_id (u64) entries
  ?     var   slot_array (grows backward from PAGE_SIZE)
PAGE_SIZE - 4   record_count_check (== record_count in header)
```

For internal nodes, slot[i] points to the start of key_i, and
`ptr_block[i]` is the child page that holds keys < key_{i+1}. The
classic B+ invariant: `N` keys → `N+1` children.

### 5.3 Leaf node layout (PAGE_TYPE_BTREE_LEAF)

Leaves use the slotted-page layout from §4.2. Each record is

```
Offset  Size  Field
──────  ────  ──────────────────────────────────────
  0      2    key_length
  2     var   key_bytes
  ?      8    payload_pointer  (page_id of doc heap; for index-organized
                                tables this is overflow/inline only)
  ?      4    inline_payload_length (or 0xFFFFFFFF if overflow chain)
  ?     var   inline_payload (if not overflow)
```

Sibling pointers (`prev_page` / `next_page` in the page header) are
maintained for O(1) range-scan traversal.

### 5.4 Insertion algorithm (pseudocode)

```text
insert(tree, key, value):
    leaf = traverse_to_leaf(tree.root, key)
    if has_room(leaf, key_size + value_size):
        insert_in_leaf(leaf, key, value)
        return Ok
    else:
        right = split_leaf(leaf)
        if key <= max_key(leaf): insert_in_leaf(leaf, key, value)
        else: insert_in_leaf(right, key, value)
        promote_key = first_key(right)
        return propagate_split(parent_of(leaf), promote_key, right)

split_leaf(L):
    R = allocate_page(LEAF)
    move_half_records(L, R)            # Right half by sort order
    R.next = L.next; R.prev = L; L.next = R
    if R.next != 0: page(R.next).prev = R
    return R

propagate_split(parent, key, right_child):
    if has_room(parent, key_size + 8):
        insert_internal(parent, key, right_child)
        return Ok
    else:
        new_right = split_internal(parent)
        promote = median_key(parent, new_right)
        if parent == tree.root:
            new_root = allocate_page(INTERNAL)
            new_root.keys = [promote]
            new_root.ptrs = [parent, new_right]
            tree.root = new_root
        else:
            propagate_split(parent_of(parent), promote, new_right)
```

### 5.5 Deletion algorithm

```
delete(tree, key):
    leaf = traverse_to_leaf(tree.root, key)
    remove_from_leaf(leaf, key)
    if leaf.live_ratio() < MERGE_THRESHOLD (= 0.40):
        try_redistribute_with_sibling(leaf)
            or merge_with_sibling(leaf)
        propagate_merge_or_redistribute_upward(parent_of(leaf))
```

Merge threshold 0.40 is empirical: triggering merges below 40% live load
yields the best long-term shape; lower thresholds (e.g. 0.25) allow
fragmentation, higher thresholds (≥ 0.50) cause merge thrashing on
balanced workloads.

### 5.6 Right-most append optimization

For `ObjectID`-keyed inserts (always increasing), the engine detects an
ascending key pattern and skips the binary search inside the right-most
leaf path: an `append_hint` cached on each tree caches the previously
written leaf id and verifies the new key is `> max_key_in_leaf` before
insertion. Hit rate for primary key inserts ≥ 99% in benchmarks; saves
~5% latency.

### 5.7 Fill factor

- Insert-time fill factor: 75% — leaf splits at 75% utilization on
  ascending keys, 50% on random keys, mirroring SQLite's `pgno_split`
  tuning.
- Configurable per-collection via `pragma fill_factor = 80`.

### 5.8 Latch coupling (crabbing) for concurrent access

Concurrent reads/writes use **lock coupling** ("crabbing"):

- **Read path:** acquire shared latch on parent → acquire shared latch
  on child → release parent.
- **Write path (insert/delete):** start with optimistic shared latches.
  If split/merge becomes possible (page fill ≥ 80% for insert, ≤ 50%
  for delete), restart the descent with **exclusive** latches and
  release ancestors only when the child is provably safe.

See `[[FILE-10]]` §3 for full latch protocol.

---

## 6. Buffer Pool

### 6.1 Purpose

In-memory cache of pages, keyed by `page_id`. The unit of caching is one
page (`PAGE_SIZE` bytes). Capacity in bytes controlled by
`pragma buffer_pool_max_bytes`.

### 6.2 Eviction policy: ARC

We use the **Adaptive Replacement Cache** (Megiddo & Modha 2003) with
two real lists (T1 = recently-used, T2 = frequently-used) and two ghost
lists (B1, B2) totalling capacity `c`. ARC outperforms LRU-K by 8-12%
hit rate on mixed workloads (their paper Table III, our reproduction
on the candidate workload yields 9.7% improvement at 256 MB pool, 10 M
docs).

```rust
pub struct Arc {
    p: usize,                 // adaptation parameter, 0..=c
    c: usize,                 // total capacity in pages
    t1: Lru<PageId, BufferFrame>,  // recent
    t2: Lru<PageId, BufferFrame>,  // frequent
    b1: Lru<PageId, ()>,           // ghost recent
    b2: Lru<PageId, ()>,           // ghost frequent
}
```

#### Algorithm (page_id requested)

```
case 1: page_id ∈ T1 ∪ T2
        move to MRU of T2; return
case 2: page_id ∈ B1 (ghost, recent)
        p = min(p + max(|B2|/|B1|, 1), c)
        evict_to_match()
        load page; insert at MRU of T2
case 3: page_id ∈ B2 (ghost, frequent)
        p = max(p - max(|B1|/|B2|, 1), 0)
        evict_to_match()
        load page; insert at MRU of T2
case 4: miss (not in any list)
        if |T1| + |B1| == c:
            if |T1| < c: drop LRU of B1; evict_to_match()
            else:        drop LRU of T1
        else if |T1| + |T2| + |B1| + |B2| >= c:
            if total == 2c: drop LRU of B2
            evict_to_match()
        load page; insert at MRU of T1
```

`evict_to_match()` chooses T1 or T2 based on `p`; evicted dirty pages
are flushed via the WAL writer.

### 6.3 Pin/unpin contract

```
fn pin(page_id: u64) -> PinnedPage<'_>;
fn unpin(page_id: u64, dirty: bool);
```

A `PinnedPage` is a RAII guard. While pinned, the buffer pool will not
evict the frame. Unpinning with `dirty = true` marks the frame for
eventual flush. Pin counts are atomic; over-pinning panics in debug.

```rust
pub struct PinnedPage<'a> {
    frame: &'a BufferFrame,
    _guard: PinGuard,
}
impl Drop for PinnedPage<'_> {
    fn drop(&mut self) { self.frame.decrement_pin(); }
}
```

### 6.4 Dirty-page tracking

Every frame has:

```
struct BufferFrame {
    pub page_id: u64,
    pub data: [u8; PAGE_SIZE],
    pin_count: AtomicU32,
    is_dirty: AtomicBool,
    last_lsn: AtomicU64,         // WAL LSN of last write
    flush_pending: AtomicBool,   // currently being flushed by writer thread
}
```

A page **must not** be flushed before its `last_lsn` is durable in the
WAL — this is the **WAL rule**: log writes precede page writes. The
flusher checks `page.last_lsn <= wal.durable_lsn` before issuing the
page write.

### 6.5 Flush daemon

A dedicated background thread (`flusher`) runs every
`pragma flush_interval_ms` (default 50 ms):

```
loop:
    sleep(50ms)
    durable_lsn = wal.durable_lsn()
    candidates = pool.dirty_pages_with_lsn_le(durable_lsn).take(64)
    for page in candidates:
        page.flush_pending = true
        io.write_page(page)            # async; may batch
        page.is_dirty = false
        page.flush_pending = false
```

Flush batching: contiguous page ids are coalesced into a single
`pwritev`; up to 16 contiguous pages → 128 KB write, the NVMe sweet spot.

### 6.6 Buffer pool sizing heuristic

Default: `min(physical_RAM / 8, 256 MiB)`. The auto-tuner (v0.7+) raises
the cap by 25% when the cache hit ratio drops below 90% for a 5-minute
window.

---

## 7. Free Page Management

Two-level structure: **freelist** for steady-state reclaim and **bitmap**
for vacuum / shrink operations.

### 7.1 Freelist

Linked list of free pages, head pointer in file header. Each freelist
trunk page holds up to `(PAGE_SIZE - 64) / 8 - 1` free page ids and a
`next_trunk` pointer.

```
+--------+--------+-----+--------+----------+
| trunk  | leaf 1 | ... | leaf N | trunk →  |
+--------+--------+-----+--------+----------+
```

Allocate: pop from head (O(1)). Free: push to head (O(1)).

### 7.2 Free-space bitmap

For very large databases (> 1 TB), the freelist becomes O(n) at boot
because we scan to count entries. We supplement with a **bitmap page**
every 32768 pages (256 MB region for 8 KB pages). Bitmap pages have type
`PAGE_TYPE_BITMAP_FREESPACE`.

The bitmap is **advisory**, not authoritative: the freelist is the
source of truth, the bitmap is rebuilt lazily by vacuum.

### 7.3 Page allocation API

```rust
fn allocate_page(kind: PageType) -> Result<u64, OvnError>;
fn free_page(id: u64) -> Result<(), OvnError>;
fn shrink_to_fit() -> Result<u64, OvnError>;  // vacuum entry point
```

Allocation policy:

1. Pop from freelist if non-empty.
2. Otherwise grow the file: `fallocate(file, FALLOC_FL_KEEP_SIZE, ...)`
   in 16-page (128 KB) chunks to amortize syscalls.
3. Update `total_pages` in the file header on the next checkpoint.

---

## 8. Overflow Pages

When a record (document, leaf entry, posting list) exceeds the inline
threshold (`INLINE_THRESHOLD = PAGE_PAYLOAD_SIZE / 4` = 2032 bytes for
8 KB pages), the value is split across an **overflow chain**:

```
inline pointer  ───►  Overflow page 1  ───►  Overflow page 2  ───►  ...
                      (next_page link)         (next_page link)
```

Overflow page layout:

```
Offset  Size  Field
──────  ────  ───────────────────────────
  0     64    PageHeader (page_type=OVERFLOW)
 64     4     overflow_chunk_length
 68     var   overflow_chunk_data
last 4  4     chunk_checksum (CRC-32C)
```

`next_page` in the page header is the next overflow page (0 = end of
chain). The inline pointer in the parent record holds the **first**
overflow page id.

Reads stream the chain into a coalesced buffer; writes allocate new
overflow pages and atomically swap pointers (old chain becomes garbage,
freed by the next vacuum).

---

## 9. Storage Tiering

Three tiers, configurable per collection:

| Tier  | Backing               | Access path           | When chosen          |
|-------|-----------------------|-----------------------|----------------------|
| HOT   | Buffer pool + mmap    | direct memcpy         | Random reads, < 64 KB|
| WARM  | Buffered I/O (read())  | OS page cache         | Default              |
| COLD  | Direct I/O (O_DIRECT)  | bypass OS cache       | Bulk scans, archive  |

`mmap` mode is enabled when:

- `pragma mmap_threshold_mb` (default 2048) ≥ database size, **and**
- `cfg(target_pointer_width = "64")`, **and**
- the OS supports `mmap` (excludes WASM).

Even in `mmap` mode, writes go through the WAL and the buffer pool (not
mmap), so memory mapping is read-only for the data region.

`O_DIRECT` is enabled for sequential bulk operations (`COPY`, `EXPORT`,
vacuum) to avoid evicting hot pages from the OS page cache.

---

## 10. Hybrid Columnar Mode (HTAP)

Configurable per collection. When enabled, every write also produces a
**column chunk** in `PAGE_TYPE_COLUMN_CHUNK` pages. Columnar mirrors are:

- Append-only (no in-place update; updates write a new chunk and mark
  the old one tombstoned).
- Compressed with the columnar codecs in `[[FILE-11]]` §4 (FOR + bit-
  packing for ints, dictionary + LZ4 for strings, Gorilla for floats).
- Aligned to **Apache Arrow IPC** layout for zero-copy export.

Promotion rule: a collection switches to columnar mode automatically
when:

```
analytical_score(c) > 0.7
analytical_score = α·(group_by_count / total_query_count)
                 + β·(scan_size_avg / collection_size)
                 + γ·(field_uniqueness_avg)
where α=0.5, β=0.3, γ=0.2 (tunable via pragma analytical_weights = "α,β,γ").
```

---

## 11. Compression Pipeline

Per-page LZ4 / Zstd, with a **magic byte** at byte 64 of the page header
discriminating the codec. See `[[FILE-11]]` for full details.

**Decision rule**: only compress if the resulting page is at least
`COMPRESSION_RATIO_THRESHOLD` (default 1.10) smaller than uncompressed.
Otherwise the page is stored raw — saves CPU on incompressible payloads
(images, already-encrypted blobs).

Pipeline:

```
write(page):
    raw = serialize(page)            # logical → bytes
    compressed = compress(raw)
    if len(compressed) <= 0.91 * len(raw):
        flags |= FLAG_COMPRESSED
        out = header || codec_byte || compressed
    else:
        flags &= !FLAG_COMPRESSED
        out = header || raw
    encrypt_in_place(out)            # if encryption enabled
    crc = crc32c(out)
    out[checksum_offset] = crc
    pwrite(out, page_id * PAGE_SIZE)
```

The `codec_byte` (1 byte at the start of the payload region) is:

```
0x00  uncompressed
0x01  LZ4
0x02  Zstd-3
0x03  Zstd-19
0x04  Zstd-dict (collection-trained)
```

---

## 12. Endianness and Cross-Platform

All multi-byte integers in the on-disk format are **little-endian** —
this matches every platform we target (x86, ARM little-endian profile,
RISC-V LE) at zero conversion cost.

The Rust serialization layer uses `byteorder::LittleEndian` (`u16::to_le_bytes`,
etc.) explicitly even on LE platforms to make the contract auditable.

Big-endian platforms (rare embedded sparc64 / PowerPC BE) are **not
supported** in v1.0. The page-header magic byte `0x6F` is asymmetric, so
a BE reader sees `0x6F00` and aborts with `OvnError::EndianMismatch`.

---

## 13. Slotted Document Heap (PAGE_TYPE_DOCUMENT_HEAP)

Used when documents share a page (small documents, ~10-30 per page).
Layout per §4.2 with the additional invariant that record offsets are
sorted by *insert order*, not key order — keys are managed by the
primary key index (a separate B+ Tree referencing heap pages).

Compaction (defrag): triggered when slot tombstone density > 30%. The
compactor copies live records to a new page, updates the primary key
index pointers atomically (single WAL record), and frees the old page.

---

## 14. Concurrency Notes

- The buffer pool is a single global structure (per-database). Internal
  sharding across 64 stripes (selected by `page_id mod 64`) eliminates
  most lock contention.
- Each frame has its own latch (`parking_lot::RwLock`). The page-id-to-
  frame map is a `DashMap` (`HashMap<u64, &Frame>` with sharded mutexes).
- The flusher thread acquires shared latches; the writer (insert/update)
  acquires exclusive latches per page.
- See `[[FILE-10]]` for the full threading model.

---

## 15. Recovery Hooks

The storage engine exposes `recover()` callbacks invoked from
`[[FILE-02]]` §7 during WAL replay:

```rust
pub trait StorageRecoveryHook {
    fn redo_page_write(&self, page_id: u64, image: &[u8]) -> Result<(), OvnError>;
    fn redo_page_free(&self, page_id: u64) -> Result<(), OvnError>;
    fn redo_split(&self, parent: u64, left: u64, right: u64,
                  promoted_key: &[u8]) -> Result<(), OvnError>;
    fn redo_merge(&self, kept: u64, removed: u64) -> Result<(), OvnError>;
}
```

These four primitives are sufficient to reconstruct any B+ Tree state:
the WAL log records full page images for non-Btree pages, and structural
operations (split / merge) for Btree pages, choosing whichever is
smaller.

---

## 16. Tradeoffs and Alternatives Considered

| Choice                    | Picked        | Considered alternatives          | Why we picked       |
|---------------------------|---------------|----------------------------------|---------------------|
| Page size                 | 8 KB          | 4 KB, 16 KB, 32 KB              | Best fanout/atomicity tradeoff (§2). |
| Eviction policy           | ARC           | LRU, LRU-K, CLOCK-Pro            | 8-12% better hit rate (§6.2). |
| Free-space management     | Freelist+bitmap | bitmap-only, free-tree           | O(1) alloc, lazy bitmap refresh. |
| Latch protocol            | crabbing      | fully optimistic, B-link         | Concurrency without B-link complexity. |
| Slotted page layout       | yes           | fixed-size record pages          | Variable-length docs. |
| Endianness                | LE            | BE, abstracted                   | All targets are LE; conversion is wasted CPU. |
| `mmap` mode               | optional      | mandatory                        | Doesn't fit WASM/embedded. |
| Per-collection columnar   | optional      | always, never                    | Auto-promote on analytical score. |
| Overflow chain            | next_page     | dedicated overflow B-tree        | Simpler, sufficient for ≤ 16 MB blobs. |
| File header CRC + backup  | both          | header only                      | Survives torn header writes. |

---

## 17. Open Questions

1. **Atomic 16 KB writes on consumer NVMe.** Need to validate via
   `nvme id-ctrl` AWUN/AWUPF fields at startup; surface a warning if
   the drive does not promise 8 KB atomicity.
2. **Buffer pool NUMA awareness.** On servers, allocating frames on
   the local NUMA node yields ~7% throughput. v0.6 stretch goal.
3. **Compression on the read side.** Decompression cost on hot pages
   (LZ4 at ~500 MB/s) is below NVMe bandwidth, so this is a CPU win
   net positive — but for small payloads (< 256 B) the page header
   dominates, and we should consider a "tiny page" mode with
   collapsed headers.

---

## 18. Compatibility Notes

- Format version `0x0001` is the v0.1 format. We promise byte-for-byte
  read compatibility for the same `format_version`. A bump to `0x0002`
  signals a breaking on-disk change and ships with a one-shot
  migration tool.
- Page type bytes `0x00..0x7F` are reserved for the engine; `0x80..0xFD`
  are reserved for plugins (each plugin registers a unique byte at
  load time; conflicts are rejected); `0xFE..0xFF` are reserved.

---

*End of `01-STORAGE-ENGINE.md` — 818 lines.*
