# 04 — INDEX ENGINE

> All index types supported by Oblivinx3x: B+ Tree (single & composite),
> sparse, partial, TTL, JSON path, hash, full-text (FTS), vector (HNSW),
> and geospatial (R-tree). For storage layout primitives see
> `[[FILE-01]]`; for query planner usage see `[[FILE-05]]`.

---

## 1. Purpose

An **index** is a data structure that maps an extracted **key** (one or
more values from a document) to one or more **document references**
(ObjectIDs / page pointers), allowing the query engine to skip
collection scans.

Every collection has at least the **primary index** on `_id`. Secondary
indexes are explicit (`createIndex({field: 1})`) and tracked in
collection metadata.

---

## 2. Index Catalog (metadata)

Per database, index metadata lives in a B+ Tree under
`root_meta_page` (file header field; see `[[FILE-01]]` §3.2). Each
entry:

```rust
pub struct IndexDescriptor {
    pub index_id: u32,
    pub name: String,
    pub collection_id: u32,
    pub kind: IndexKind,            // B+, Hash, FTS, HNSW, RTree, ...
    pub spec: Vec<IndexedField>,    // ordered list of (path, direction)
    pub options: IndexOptions,      // unique, sparse, partial, ttl, ...
    pub root_page: u64,             // root page of this index
    pub stats_page: u64,            // page holding histograms
    pub created_at_ns: i64,
    pub schema_version_at_create: u32,
}

pub struct IndexedField {
    pub path: Vec<String>,          // e.g. ["address","city"]
    pub direction: i8,              // +1 ascending, -1 descending
    pub coercion: TypeCoercion,     // numeric promotion, lowercase, etc.
}

pub struct IndexOptions {
    pub unique: bool,
    pub sparse: bool,
    pub partial_filter: Option<MQLFilter>,
    pub ttl_seconds: Option<u32>,
    pub collation: Option<CollationSpec>,
    pub fts: Option<FTSOptions>,
    pub hnsw: Option<HNSWOptions>,
    pub rtree: Option<RTreeOptions>,
    pub hash_buckets_log2: Option<u8>,
}
```

---

## 3. Key Encoding (B+ Tree indexes)

Index keys are derived from documents and must be:

- **Sortable as bytes** — concatenation of typed prefix + value.
- **Reversible** when the planner needs to reconstruct value bounds.
- **Compactly comparable** — no copy/parse needed in the comparator.

### 3.1 Key prefix table

```
0x00  type tag for the value (1 byte; subset of OBE tags from [[FILE-03]])
        - Reusing OBE tag space ensures cross-type ordering matches §10
          of [[FILE-03]] and queries produce expected ordering.
0x01  encoded value bytes (length depends on type; see §3.2)
```

For composite indexes, the key is the concatenation of all field key
fragments in spec order, separated by a 1-byte field separator
`0xFF` (chosen because it cannot appear in valid varint leading bytes).

### 3.2 Per-type encoding

| Type      | Encoding for index key                                   | Sortable? |
|-----------|----------------------------------------------------------|----------:|
| Null      | tag only (0x01)                                          | ✓         |
| Bool      | tag only (0x02 false / 0x03 true)                       | ✓         |
| Int       | tag (0x04) + 8-byte big-endian zigzag(i64)              | ✓         |
| Float64   | tag (0x0A) + 8-byte big-endian "sortable f64" (sign-aware) | ✓     |
| String    | tag (0x0C) + UTF-8 bytes + 0x00 sentinel                 | ✓         |
| ObjectId  | tag (0x13) + 12 bytes verbatim                            | ✓         |
| Date/TS   | tag (0x11/0x12) + 8 bytes big-endian                      | ✓         |
| Array     | tag (0x0F) + repeated per-element keys (multi-key index)  | ✓ (multi) |
| Object    | tag (0x10) + recursive sorted-key-value bytes             | ✓         |

#### Sortable f64 transformation

Naïve IEEE-754 bytes do not sort correctly because of sign + biased
exponent layout. We apply:

```rust
fn sortable_f64(v: f64) -> [u8; 8] {
    let bits = v.to_bits() as i64;
    let xform = if bits >= 0 { bits ^ i64::MIN } else { !bits };
    xform.to_be_bytes()
}
```

This places `-∞` < negative finites < `-0` ≤ `+0` < positive finites <
`+∞` in lexicographic byte order.

#### NULL sentinel for strings

A trailing `0x00` is appended to string bytes so `"abc"` < `"abc1"`
lexicographically (otherwise `"abc"` is a prefix and they compare equal
on the shared prefix). A literal NUL inside the string is escaped to
`0x00 0xFF`.

### 3.3 Composite key example

```
Index spec:  { "name": 1, "age": -1 }
Document:    { name: "Alice", age: 30 }

Key bytes:
  0x0C 'A' 'l' 'i' 'c' 'e' 0x00       # name (asc)
  0xFF                                  # field separator
  0x04 (zigzag(-30) BE 8 bytes)         # age, descending: invert
```

Descending fields are encoded by **bitwise NOT** of the value bytes,
preserving lexicographic comparison.

### 3.4 Unique vs non-unique indexes

- **Unique:** key alone fully identifies the row; leaf record stores
  `(key, doc_pointer)`. On insert, the engine probes for existing key;
  rejects with `OvnError::DuplicateKey` if found.
- **Non-unique:** the leaf record is `(key + doc_id, doc_pointer)` —
  the doc_id (12 bytes ObjectID) is appended to the key to ensure
  uniqueness, allowing sorted iteration over duplicates.

---

## 4. B+ Tree Index

Implemented as instances of the storage layer's B+ Tree
(`[[FILE-01]]` §5). Per-index root page is referenced from
`IndexDescriptor.root_page`.

### 4.1 Range scan

Given lower/upper bounds, the planner translates to byte ranges:

```
lo_bytes = encode_lower_bound(field, lo_value, inclusive)
hi_bytes = encode_upper_bound(field, hi_value, inclusive)
```

Iterator walks B+ leaves in order, yielding `(key, doc_pointer)` until
`key > hi_bytes`. Sibling pointers (`next_page` in the page header)
provide O(1) leaf-to-leaf traversal.

### 4.2 Index-organized table (IOT)

For the **primary index** (on `_id`), the leaf record holds the entire
document inline (or first overflow chain pointer if it exceeds inline
threshold). This avoids one indirection compared to a separate heap.

```
Leaf record (primary index):
  key:        12-byte ObjectID
  flags:      1 byte (bit0=overflow, bit1=tombstone, bit2=encrypted)
  inline_len: varint
  inline:     OBE bytes
  overflow_ptr: 8 bytes (if bit0 set)
```

Secondary indexes hold `(key, doc_id)` pairs and **dereference** to the
primary index for the actual document.

### 4.3 Multi-key (array) indexes

When an indexed field is an array, the engine emits **one key per
element**:

```
Document: { tags: ["a", "b", "c"], _id: ID1 }
Index ops: insert("a", ID1), insert("b", ID1), insert("c", ID1)
```

Multi-key indexes inflate index size by avg array length but enable
`{ tags: "b" }` queries to use the index.

The descriptor flag `IndexedField.multikey` is set automatically on
first array insertion and tracked thereafter.

---

## 5. Sparse Index

Skip documents missing the indexed field entirely. Implementation:

- The encoder emits **no key** if any path component is absent.
- Stored in metadata as `options.sparse = true`.
- Planner can use a sparse index only when the query predicate
  guarantees the field exists (e.g. `field: { $exists: true }` or any
  comparison operator).

Storage savings: roughly proportional to (`1 − presence_ratio`).

---

## 6. Partial Index

A predicate filter applied at index-write time:

```js
db.users.createIndex({ status: 1 }, { partialFilterExpression: { active: true } });
```

Implementation:

- Compile the filter to an MQL AST at index creation; persist as OBE
  in `IndexDescriptor.options.partial_filter`.
- On every insert/update, evaluate the filter; emit/remove key
  accordingly.
- Planner uses the index only when the query predicate **implies** the
  partial filter (subset relation). Subset check: AST containment via
  conservative simplification (rejected if uncertain → fall back to
  collection scan, no false matches).

---

## 7. TTL Index

A TTL (Time-To-Live) index automatically deletes documents whose
indexed date field is older than `ttl_seconds`.

### 7.1 Background reaper

A dedicated thread runs every `pragma ttl_scan_interval_s` (default
60). For each TTL index:

```text
horizon = now_ms - ttl_seconds * 1000
for (key, doc_id) in index.range_scan(MIN, encode(horizon)):
    delete_document(coll, doc_id)
    delete_index_key(idx, key)
```

The scan is **chunked**: 1024 deletions per WAL transaction, then yield
to allow other operations. Logged via `obx_ttl_deletions_total` metric.

### 7.2 Edge cases

- **Clock skew:** A backwards-jumping wall clock would prematurely
  expire docs. We use a *monotonic* clock for `now_ms` plus a
  saved `boot_realtime` to anchor — see `[[FILE-09]]` §6 for HLC.
- **Bulk insert with old timestamps:** all immediately eligible.
  Acceptable but generates a write storm; the reaper smooths via
  rate limiting (`pragma ttl_max_deletes_per_s`, default 10000).

---

## 8. JSON Path Index

Index a value at a specific JSON path (potentially nested deep):

```js
db.events.createIndex({ "payload.user.id": 1 });
```

Implementation:

- Path normalization at compile: `["payload","user","id"]`.
- During insert/update, traverse the OBE doc using the offset table
  (`[[FILE-03]]` §6.3); if path resolves to a value, encode key.
- Nested array fan-out: `events.tags.0` indexes only the first
  element; `events.tags.*` is multi-key over all elements; `events.*.id`
  fans across all sub-objects (use sparingly, can be O(n)).

### 8.1 Path syntax

```
EBNF:
path        ::= segment ("." segment)*
segment     ::= identifier | array_index | wildcard
identifier  ::= [A-Za-z_][A-Za-z0-9_]*
array_index ::= [0-9]+
wildcard    ::= "*"
```

`*` in JSON-path indexes is allowed at most one level (per perf budget);
two-level wildcards rejected at index creation time.

---

## 9. Hash Index

For point-equality queries on fields with poor sort locality (UUIDs,
random tokens), a hash index can be 2-3× faster than a B+ Tree.

### 9.1 Layout

- Bucket pages of type `PAGE_TYPE_HASH_BUCKET`. Each holds a fixed
  array of `(hash16, key_ref, doc_id)` entries plus an `overflow_page`
  pointer.
- Bucket index = `hash64(key) >> (64 - buckets_log2)`.
- Bucket directory: a B+ tree mapping bucket_no → bucket page id, so
  we can grow without rehashing the whole table.

### 9.2 Sizing

`pragma hash_buckets_log2` default 16 (= 65 536 buckets). Resize when
average chain length > 8 (doubles in place via consistent hashing).

### 9.3 Operations

- **Lookup:** O(1) amortized — fetch bucket, scan entries, follow
  overflow chain if any.
- **Range scan:** **NOT SUPPORTED.** Planner refuses to use hash
  index for range queries.
- **Sort:** also unsupported.

---

## 10. Full-Text Index (FTS)

See `[[FILE-08]]` for tokenizer / scoring detail. This section covers
the on-disk structure.

### 10.1 Inverted index layout

For each indexed field, the engine maintains:

```
Term Dictionary (B+ Tree):
    key:    UTF-8 normalized term
    value:  posting_list_root_page (u64) + df (u32) + total_freq (u64)

Posting List (PAGE_TYPE_FTS_POSTING chain):
    Each posting page holds a delta-encoded run:
        (doc_id_delta varint || freq varint || positions: varint count
         + delta-encoded positions)
```

### 10.2 Compression

- **Doc ids** within a posting list are sorted ascending; we store
  deltas with VByte (variable-byte) encoding.
- **Positions** within a doc are sorted; same VByte delta.
- Posting page payload is then page-level Zstd (level 3) compressed.

Empirical compression: for a 1 M-doc corpus with avg 200 terms, posting
storage is ~200 MiB — about 60% of the raw doc collection (very
favorable).

### 10.3 Updates

FTS updates use a small in-memory **delta MemTable** (per index) that
flushes to a fresh posting page chain on:

- Reaching `pragma fts_memtable_bytes` (default 16 MiB).
- Explicit `db.flush()`.
- Periodic compaction (every 5 min by default).

Flushed posting chains are then merged into the persistent posting list
during compaction (LSM-style for FTS only).

### 10.4 Query API

```rust
fn fts_search(field: &str, query: &str, opts: FTSOpts) -> Iter<(DocId, Score)>;
```

Internally translates to a Boolean query over the inverted index, then
ranks by BM25 (`[[FILE-08]]` §6).

---

## 11. Vector Index (HNSW)

See `[[FILE-08]]` §10 for query-time integration. This section covers
the index data structure.

### 11.1 HNSW parameters

```rust
pub struct HNSWOptions {
    pub dim: u32,
    pub metric: VectorMetric,    // Cosine / Euclidean / DotProduct
    pub m: u8,                   // edges per node per layer (default 16)
    pub ef_construction: u16,    // construction-time neighborhood size (default 200)
    pub ef_search_default: u16,  // query-time neighborhood (default 64)
    pub max_layer: u8,           // computed; not user-set
    pub quantization: VectorQuantization, // None, F16, INT8, RaBitQ
}
```

### 11.2 On-disk layout

Each HNSW node lives in `PAGE_TYPE_VECTOR_GRAPH` pages:

```
Byte offset  Field
───────────  ─────────────────────────────────
 64          node_id (u64; same as document id reference)
 72          layer_count (u8)
 73          padding (3 B)
 76          neighbors_layer0_count (u16)
 78          neighbors_layer0[]:  count × u64
 ...         neighbors_layer1_count (u16) and array, etc.
 ...         vector data (dim × f32, or quantized form)
```

Multiple nodes may share a page if they fit; otherwise one node per
page. The vector data may live **outside** the node page (large dims):
`vector_data_page` indirection pointer.

### 11.3 Insertion algorithm (Malkov & Yashunin 2016)

```text
insert(q):
    layer_max = floor(-ln(rand()) * mL)            # mL = 1 / ln(M)
    enter = entrypoint_node
    for l in (top_layer .. layer_max+1):
        enter = greedy_search_layer(q, enter, ef=1, layer=l)
    for l in (layer_max .. 0):
        candidates = beam_search_layer(q, enter, ef=ef_construction, layer=l)
        select_neighbors_heuristic(q, candidates, M)
        connect(q, neighbors)
        for n in neighbors:
            shrink_to_M(n, layer=l)
        enter = candidates
    if layer_max > top_layer:
        update_entrypoint(q)
```

### 11.4 Quantization

Three levels:

- **None:** raw f32; 4 × dim bytes/node.
- **F16:** half-precision; 2 × dim bytes/node; ~1% recall loss.
- **INT8:** uniform per-vector quantization; 1 × dim bytes/node;
  ~3-5% recall loss.
- **RaBitQ (planned v0.6):** 1 bit per dim with calibration; 0.125 ×
  dim bytes/node; ~10% recall loss but sufficient for first-stage
  filter.

### 11.5 Persistence

Index is **incrementally** persisted: every modified node is written to
the WAL as `WAL_REC_VECTOR_INSERT`. Checkpoint flushes the in-memory
graph state to pages. We keep an in-memory mirror for O(1) graph
traversal — RAM cost ≈ `node_count × (M * 8 bytes + dim × 4 bytes)`.

For 1 M × 768-dim vectors with M=16: 128 MiB neighbors + 3 GiB vectors.
Quantize or page-out vectors to fit smaller hosts.

### 11.6 Deletion

HNSW does not support efficient deletion. Strategies:

- **Tombstone:** mark node as deleted; query filters them out. Storage
  doesn't shrink until rebuild.
- **SPFresh-style** incremental rebalancing (planned v0.6): reroute
  edges that point to deleted nodes, periodically compact.

---

## 12. Geospatial Index (R-tree)

For 2D point and polygon queries. Using R*-tree variant for better
fan-out under updates.

### 12.1 Node layout

```
struct RTreeNode {
    page_header: PageHeader (PAGE_TYPE_GEO_RTREE_NODE)
    is_leaf: u8
    entry_count: u16
    entries: [Entry; entry_count]   // (mbr: 4×f64, child: u64)
}
```

MBR = Minimum Bounding Rectangle: `(min_x, min_y, max_x, max_y)`.

### 12.2 Query types

- `$near`: k-nearest-neighbor; uses incremental MBR-distance heap.
- `$geoWithin`: containment; descends nodes whose MBR intersects query
  shape; applies precise polygon test on leaves.
- `$geoIntersects`: similar but accepts boundary touches.

### 12.3 Spherical vs planar

Default mode is **planar** (good for small regions). For global queries
(distance across continents), `pragma geo_mode = spherical` switches to
S2 cell IDs and great-circle distance on WGS-84 — more expensive but
correct over poles.

---

## 13. Bloom Filter Sidecar

For collections with high write rate and rare lookups (cold storage),
each B+ leaf may emit a Bloom filter for its key range, stored in a
companion `PAGE_TYPE_BLOOM_FILTER` page chain:

```
struct BloomFilter {
    bit_count: u32,
    hash_count: u8,
    bits: [u8; bit_count / 8],
}
```

The planner may consult the Bloom filter before fetching the leaf to
short-circuit definite-not-found queries — saving one page read.

Default: enabled when collection size > 100 K docs. Configurable via
`pragma bloom_for_btree`.

---

## 14. Covering Index Detection

A query is **covered** when all referenced fields are present in the
index key (no document fetch needed).

Detection algorithm:

```
covered(query, index):
    needed_fields = collect(query.projection ∪ query.filter ∪ query.sort)
    indexed_fields = index.spec.fields ∪ {"_id"}     # _id always included
    return needed_fields ⊆ indexed_fields
```

Covered queries emit a special operator (`CoveredIndexScan`) that skips
the document fetch step. Per-query latency improvement: 30-50% for
narrow queries.

---

## 15. Index Maintenance

### 15.1 Insert path

```
on insert(coll, doc):
    primary.insert(doc._id, doc)
    for each index in coll.indexes:
        if index.partial_filter and !index.partial_filter.matches(doc):
            continue
        if index.sparse and !path_present(doc, index.spec):
            continue
        keys = encode_keys(doc, index.spec)
        for k in keys:
            index.btree.insert(k, doc._id)
            if index.unique and key_exists: abort transaction
```

### 15.2 Update path

For unindexed-field updates: the indexes are not touched (HOT update).
For indexed-field updates:

```
old_keys = encode_keys(old_doc, index.spec)
new_keys = encode_keys(new_doc, index.spec)
for k in old_keys - new_keys: index.delete(k, _id)
for k in new_keys - old_keys: index.insert(k, _id)
```

Delta computation avoids redundant work. Empirically, ~80% of updates
in OLTP workloads touch unindexed fields (HOT path).

### 15.3 Background build

For `createIndex` on a populated collection, building synchronously
blocks writes for the duration. Instead:

- Create the index descriptor with `state = building`.
- Spawn a background task scanning the collection.
- New writes update **both** the existing indexes and the new (building)
  index optimistically.
- Once the scan completes and the build queue drains, flip state to
  `ready` and the planner becomes eligible.

### 15.4 Consistency check

`db.collection.validateIndexes()` walks every index and verifies:

- Every `(key, doc_id)` resolves to a doc that contains the key value.
- Every doc's expected keys exist in the index.
- B+ Tree invariants hold (key ordering, fill ratios, sibling pointers).

Findings are reported (mismatched / orphan keys) without auto-repair;
operator runs `db.collection.reIndex()` to rebuild.

---

## 16. Index Statistics

Per-index histograms maintained for the planner:

```rust
pub struct IndexStats {
    pub key_count: u64,
    pub leaf_pages: u64,
    pub depth: u8,
    pub n_distinct: u64,
    pub null_fraction: f32,
    pub histogram: Vec<HistogramBucket>, // 256 buckets, equi-depth
}

pub struct HistogramBucket {
    pub upper_bound: Vec<u8>,        // encoded key
    pub cumulative_freq: u64,
    pub distinct_in_bucket: u32,
}
```

Refresh on:

- Explicit `db.collection.analyze()`.
- After bulk insert exceeding `pragma analyze_threshold` (10% growth
  default).

Sample-based: sample 10 K random keys via reservoir sampling; build
equi-depth histogram in O(N log N) memory.

---

## 17. Tradeoffs and Alternatives Considered

| Choice                  | Picked          | Considered             | Why we picked     |
|-------------------------|-----------------|------------------------|-------------------|
| Default index structure | B+ Tree         | LSM, hash, ART          | Range + point + sort all good. |
| Vector index            | HNSW            | IVF-PQ, ANNoy, ScaNN    | Best recall/latency at <10M scale. |
| Geo                     | R*-tree         | quadtree, S2 only       | Polygons + range queries; S2 opt-in. |
| FTS posting compression | VByte + Zstd    | Roaring, Elias-Fano     | Simpler, near-optimal at our scale. |
| Hash index              | optional        | always primary          | B+ covers most; hash for hot kv. |
| Bloom sidecar           | optional        | always                  | Storage overhead not free; opt-in. |
| Composite encoding      | concat + 0xFF   | nested struct           | Sortable bytes + simple. |
| Multi-key arrays        | auto            | explicit syntax         | Mongo compat. |
| Index build             | online + dual-write | offline only         | No long write outage. |

---

## 18. Open Questions

1. **Learned indexes (PGM++ / RMI).** Promising for read-heavy, mostly-
   sorted workloads (10x lookups for log-shaped data). Tracked as
   `OBX-FEAT-099` for v1.1 — needs robust update path.
2. **Roaring bitmaps for sparse fields.** Could replace per-field
   tombstone bitmaps; benchmark in v0.6.
3. **R-tree splits.** Linear, quadratic, and Greene's algorithm — we
   currently use quadratic; revisit for write-heavy geo workloads.

---

## 19. Compatibility Notes

- Index file pages carry `format_version` in their header so adding new
  encoding variants (e.g. RaBitQ for vectors) doesn't break existing
  files.
- Renaming an index requires no rewrite — only catalog metadata
  updated.
- Re-creating an index with a different option (e.g. adding `unique`)
  requires a full rebuild and a brief read-only window during the
  catalog swap.

---

## 20. Cross-References

- Page primitives: `[[FILE-01]]` §4-5.
- Doc traversal: `[[FILE-03]]` §6.3.
- Planner index selection: `[[FILE-05]]` §5.
- FTS deep dive: `[[FILE-08]]`.
- Vector ADR: `[[FILE-20]]`/006.

---

*End of `04-INDEX-ENGINE.md` — 590 lines.*
