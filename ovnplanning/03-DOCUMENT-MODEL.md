# 03 — DOCUMENT MODEL

> Binary format ("OBE" — Oblivinx Binary Encoding), document type system,
> ObjectID generation, projection, diff, and schema inference for the
> Oblivinx3x document layer.
> Cross-references: `[[FILE-01]]` (page format), `[[FILE-02]]` (WAL doc
> records), `[[FILE-04]]` (indexes), `[[FILE-05]]` (query operators),
> `[[FILE-08]]` (FTS tokenization).

---

## 1. Purpose

Every collection stores its records in OBE encoding. OBE is a BSON-
inspired but **more compact** and more **scan-friendly** binary format
optimized for:

- 10-30% smaller payload than BSON on equivalent input.
- Sorted object keys with **binary-searchable** key block.
- **Zero-copy** field access via offset table (no full
  deserialization for projection).
- **Forward-compatible** type tags: unknown tags ≥ 0x10 are skipped.
- **SIMD-friendly** scalar runs (AVX-512 / NEON; see `[[FILE-11]]` §4).

OBE is the wire format for stored documents and the in-memory
representation of in-flight documents. Application bindings can choose
to expose JSON, BSON, or OBE depending on language idiom (see
`[[FILE-13]]`).

---

## 2. Type Tag Catalog

Each value starts with a 1-byte type tag:

```
0x00  END                  (object terminator)
0x01  NULL                 (no payload)
0x02  BOOL_FALSE           (no payload)
0x03  BOOL_TRUE            (no payload)
0x04  INT_VARINT           (LEB128 signed varint)
0x05  INT32                (4 bytes LE)
0x06  INT64                (8 bytes LE)
0x07  UINT32               (4 bytes LE; bindings may map differently)
0x08  UINT64               (8 bytes LE)
0x09  FLOAT32              (4 bytes IEEE-754)
0x0A  FLOAT64              (8 bytes IEEE-754)
0x0B  DECIMAL128           (16 bytes IEEE-754 decimal)
0x0C  STRING               (varint length || UTF-8 bytes; no terminator)
0x0D  STRING_DICT          (varint dict_id; collection-level dictionary)
0x0E  BINARY               (varint length || subtype:1 || bytes)
0x0F  ARRAY                (varint length_in_bytes || OBE values || END)
0x10  OBJECT               (varint length_in_bytes || sorted KV pairs || END)
0x11  DATE                 (8 bytes; ms since Unix epoch, signed)
0x12  TIMESTAMP            (8 bytes; HLC: 48 bits ms || 16 bits logical)
0x13  OBJECT_ID            (12 bytes; see §3)
0x14  REGEX                (varint pattern_len || pattern || varint flags_len || flags)
0x15  CODE                 (varint length || UTF-8 source text)
0x16  CODE_WITH_SCOPE      (CODE || OBJECT)
0x17  MIN_KEY              (no payload; sorts before everything)
0x18  MAX_KEY              (no payload; sorts after everything)
0x19  REF                  (12-byte ObjectID || varint coll_name_len || coll_name)
0x1A  ENCRYPTED            (envelope; see [[FILE-07]] §3)
0x1B  VECTOR_F32           (varint dim || dim×float32)
0x1C  VECTOR_F16           (varint dim || dim×float16)
0x1D  VECTOR_INT8          (varint dim || dim×int8)
0x1E  GEO_POINT            (float64 lon || float64 lat)
0x1F  GEO_POLYGON          (varint vertex_count || vertex_count×{f64,f64})
0x20..0x7F   reserved engine future
0x80..0xEF   reserved plugin (1-byte plugin_id || payload)
0xF0..0xFE   reserved
0xFF  TYPE_RAW             (debug; varint length || raw bytes)
```

**Forward-compatibility rule:** A reader encountering an unknown tag
≥ 0x20 skips by reading the varint length that **must** follow (every
plugin and reserved tag carries a varint length first). If no length is
defined for the tag (older readers, malformed data), the document is
rejected with `OvnError::UnknownType`.

### 2.1 LEB128 varint encoding

Both signed and unsigned variants:

```
unsigned LEB128:
    while v >= 0x80:
        emit (v & 0x7F) | 0x80
        v >>= 7
    emit v

signed LEB128 (zig-zag for compactness on small negatives):
    z = (v << 1) ^ (v >> 63)        # zig-zag transform
    encode_unsigned(z)
```

Storage cost:

| Range                    | Bytes  |
|--------------------------|-------:|
| 0..127                   |    1   |
| 128..16383               |    2   |
| 16384..2097151           |    3   |
| 2097152..268435455       |    4   |
| 268435456..34359738367   |    5   |
| above                    |  6-10  |

For document field-name lengths (typically < 128 chars), this is
1 byte vs BSON's 4 bytes — the major space win.

---

## 3. ObjectID Format

12 bytes, monotonic across processes thanks to a per-process counter:

```
+----+----+----+----+----+----+----+----+----+----+----+----+
|  ts seconds (BE)  |     random (5 B)        |  counter (BE) |
| 0       3 bytes   | 4              8        | 9     11      |
+----+----+----+----+----+----+----+----+----+----+----+----+
```

- **Bytes 0..3:** Unix timestamp, big-endian seconds. Big-endian so
  ObjectIDs sort lexicographically by time.
- **Bytes 4..8:** Per-process random salt, generated once at startup
  via `getrandom(2)` / `BCryptGenRandom`. Stable for process lifetime.
- **Bytes 9..11:** 24-bit counter, big-endian, atomic per process.
  Wraps every 16,777,216 inserts/s — implementations must throw
  `OvnError::ObjectIdOverflow` if exhausted within the same second.

Collisions: two processes generating IDs in the same second collide
only if their 5-byte salts collide AND counters collide → probability
≈ 2⁻⁴⁰ per second; acceptable.

```rust
#[repr(C)]
pub struct ObjectId {
    bytes: [u8; 12],
}
impl ObjectId {
    pub fn generate() -> Self {
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as u32;
        let counter = COUNTER.fetch_add(1, Ordering::SeqCst) & 0x00FF_FFFF;
        let mut b = [0u8; 12];
        b[0..4].copy_from_slice(&now.to_be_bytes());
        b[4..9].copy_from_slice(&PROCESS_SALT);
        b[9..12].copy_from_slice(&counter.to_be_bytes()[1..]);
        ObjectId { bytes: b }
    }
}
```

Hex string representation: 24 lowercase hex chars (`507f1f77bcf86cd799439011`).

---

## 4. Document Layout in a Page

A document is stored in a slotted page (`PAGE_TYPE_DOCUMENT_HEAP` per
`[[FILE-01]]` §13) with a slot pointing at the document's start byte:

```
+----------------+------+--------+-----------+----------------+
| Page header    |Doc 1 | Doc 2  |   ...     | Slot table ◄── |
+----------------+------+--------+-----------+----------------+
       64 B       OBE2   OBE2                  growing leftward
```

A **single document** has its own internal layout:

```
Offset    Size      Field
────────  ────────  ─────────────────────────────────
   0      varint    doc_total_len (bytes from after this varint to END)
   ?       1 byte   flags (bit0=schema_dict_present, bit1=encrypted_fields,
                          bit2=compressed_fields, bit3=has_offset_table,
                          bit4=is_columnar_stub, bit5-7=reserved)
   ?      varint    schema_id (if flag bit0; else absent)
   ?      varint    field_count
   ?    field_count× field_offset (varint, relative to start of fields region)
   ?     fields
   end     1 byte   END (0x00)
```

The **offset table** at the front gives a zero-copy reader the offset
of each field in O(1). For projection (`SELECT a.b.c`), the reader can
jump directly to the field without parsing earlier fields.

If `flags & has_offset_table = 0` (the default for **small** docs to
save space), the reader scans linearly. The encoder picks a threshold
of 8 fields: above that, an offset table is emitted (saves time on
projection-heavy workloads).

### 4.1 Object key sorting

Object keys are stored **lexicographically sorted** within each object.
This enables:

- **Binary search** for known-name field access (O(log n)).
- **Deterministic encoding** — equal documents produce equal byte
  sequences, simplifying hashing for diff/dedup.

Encoder cost: one extra sort per encode (n log n on n fields). For
typical documents (n ≤ 16), the constant factor is small.

### 4.2 String dictionary

Collections may opt into a **schema dictionary** that maps frequent
strings (field names, repeated values) to small integer ids. Dictionary
lives in a `PAGE_TYPE_SCHEMA_DICT` page indexed by `schema_id`.

```
struct SchemaDictEntry {
    id:          u32,    // dict id used by 0x0D STRING_DICT
    bytes_len:   u16,
    bytes:       [u8; bytes_len],
}
```

When encoding a document, the encoder substitutes any string ≤ 64 bytes
that appears in the dict with `0x0D varint(id)` (1-3 bytes vs original
length). Trains on the first 1000 documents per collection.

### 4.3 Maximum nested depth

**32 levels.** The encoder tracks depth and refuses deeper nesting with
`OvnError::DepthExceeded`. Decoder uses a stack-based traversal,
preallocated to 32 frames, eliminating recursive stack overflow risk.

```rust
pub const MAX_DEPTH: usize = 32;
```

### 4.4 Maximum document size

**16 MiB** by default, configurable via `pragma max_doc_size_bytes`
(min 4 KiB, max 64 MiB). Workaround for larger documents:

- Split into chunks across multiple documents linked by a primary key.
- Store the bulk payload as a `BINARY` field with an external blob
  pointer (planned for v0.5; emits a streaming I/O API).

---

## 5. Type System

### 5.1 Numeric types

| Type        | Range                    | Notes                              |
|-------------|--------------------------|------------------------------------|
| INT_VARINT  | i64                      | Default for integer literals.      |
| INT32       | i32                      | Explicit fixed width.              |
| INT64       | i64                      | Explicit fixed width.              |
| UINT32/64   | u32 / u64                | Bindings may map to bigint.        |
| FLOAT32     | f32                      | Required for some embeddings.      |
| FLOAT64     | f64                      | Default float.                     |
| DECIMAL128  | IEEE-754 dec128          | Financial; lossless rounding.      |

Comparison rules across numeric types: promotion to f64 for mixed-type
comparisons unless both sides are integer; in that case bignum-style
i128 is used to avoid overflow.

### 5.2 Date / Timestamp

- **DATE (0x11):** signed 64-bit milliseconds since Unix epoch.
  Range ≈ ±292 million years.
- **TIMESTAMP (0x12):** Hybrid Logical Clock — 48-bit physical (ms) +
  16-bit logical counter for total ordering across replicas (see
  `[[FILE-09]]`).

### 5.3 Strings

UTF-8, no null terminator. Length-prefixed varint. Validation: encoder
verifies UTF-8 well-formedness; decoder is `unsafe { from_utf8_unchecked }`
for performance after a CRC-protected round trip.

### 5.4 Binary

Subtype byte indicates payload semantics:

```
0x00  generic
0x01  function (deprecated, kept for BSON compat)
0x02  binary (BSON old subtype)
0x03  uuid
0x04  md5
0x05  sha-256
0x06  encrypted    (envelope content; see [[FILE-07]] §3)
0x07  compressed   (zstd-deflated payload; for large blobs)
0x08  vector_f32   (legacy mapping to 0x1B)
0x80..0xFF  user-defined
```

### 5.5 Vectors

Native vector types (0x1B/1C/1D) sidestep the BSON workaround of
storing as `array<float>`. They are densely packed and consumed
directly by the HNSW index without re-allocating.

### 5.6 Geo

`GEO_POINT` is `(longitude, latitude)` in degrees on WGS-84.
`GEO_POLYGON` is closed counter-clockwise, last vertex == first vertex.
The R-tree index normalizes input; `[[FILE-04]]` §11.

### 5.7 References

`REF (0x19)` carries a foreign collection name + ObjectID, enabling
`$lookup` to traverse without manual collection name pinning. Readers
verify the referenced collection still exists (lazy, at lookup time).

### 5.8 Encrypted (FLE)

`ENCRYPTED (0x1A)` envelopes another OBE value:

```
ENCRYPTED   ::= varint key_id || nonce(12 B) || tag(16 B) ||
                varint original_type_tag || ciphertext_len(varint) || ciphertext
```

The `original_type_tag` is encrypted as part of the ciphertext, so
type information leaks only as a **size** signal. Range queries on
encrypted fields require deterministic mode (`[[FILE-07]]` §4).

---

## 6. Encoding / Decoding Algorithm

### 6.1 Encode (recursive, depth-bounded)

```text
encode(value, out, depth):
    require(depth <= MAX_DEPTH)
    match value:
        Null:    out.push(0x01)
        Bool(b): out.push(0x02 | b as u8)        # 0x02 false / 0x03 true
        IntVarint(i): out.push(0x04); zigzag_leb128(i, out)
        Int32(i): out.push(0x05); out.push_le_i32(i)
        Int64(i): out.push(0x06); out.push_le_i64(i)
        Float32(f): out.push(0x09); out.push_le_f32(f)
        Float64(f): out.push(0x0A); out.push_le_f64(f)
        String(s):
            if dict.has(s) and len(s) <= 64:
                out.push(0x0D); varint(dict.id(s), out)
            else:
                out.push(0x0C); varint(len(s), out); out.extend(s)
        Array(arr):
            out.push(0x0F)
            len_pos = out.reserve_varint()
            for v in arr: encode(v, out, depth+1)
            out.push(0x00)
            patch_varint(out, len_pos, byte_count_since(len_pos))
        Object(obj):
            sorted = sort(obj.entries(), key=name)
            out.push(0x10)
            len_pos = out.reserve_varint()
            for (k, v) in sorted:
                varint(len(k), out); out.extend(k); encode(v, out, depth+1)
            out.push(0x00)
            patch_varint(out, len_pos, ...)
        ObjectId(id): out.push(0x13); out.extend(id.bytes)
        Date(ms): out.push(0x11); out.push_le_i64(ms)
        ... etc.
```

### 6.2 Decode

```text
decode(buf, depth) -> (value, bytes_consumed):
    require(depth <= MAX_DEPTH)
    tag = buf[0]
    match tag:
        0x01: return (Null, 1)
        0x02: return (Bool(false), 1)
        0x03: return (Bool(true), 1)
        0x04: i, n = zigzag_leb128(&buf[1..])
              return (IntVarint(i), 1+n)
        0x0F: # Array
              len, n = varint(&buf[1..])
              start = 1 + n
              elems = []
              cursor = start
              while buf[cursor] != 0x00:
                  v, c = decode(&buf[cursor..], depth+1)
                  elems.push(v); cursor += c
              return (Array(elems), cursor + 1)
        0x10: # Object
              len, n = varint(&buf[1..])
              start = 1 + n
              entries = []
              cursor = start
              while buf[cursor] != 0x00:
                  klen, kn = varint(&buf[cursor..])
                  cursor += kn
                  k = buf[cursor..cursor+klen]; cursor += klen
                  v, c = decode(&buf[cursor..], depth+1)
                  entries.push((k, v)); cursor += c
              return (Object(entries), cursor + 1)
        ...
```

### 6.3 Zero-copy field access

Given a decoded *handle* `&[u8]`, the reader can:

```rust
pub struct OBEDoc<'a> { bytes: &'a [u8] }

impl<'a> OBEDoc<'a> {
    pub fn get(&self, path: &[&str]) -> Option<OBEValue<'a>> {
        let mut cursor = self.fields_offset();
        let mut depth = 0;
        for segment in path {
            let entry = binary_search_object(self.bytes, cursor, segment)?;
            cursor = entry.value_offset;
            depth += 1;
            if depth == path.len() { return Some(parse_value(self.bytes, cursor)); }
            // descend into nested object
            require_tag(self.bytes[cursor], TAG_OBJECT)?;
            cursor = next_byte_after_obj_header(self.bytes, cursor);
        }
        None
    }
}
```

`binary_search_object` exploits sorted keys for O(log n) lookup. Field
names are read as `&[u8]`; UTF-8 validation deferred until conversion to
`&str`.

---

## 7. Projection Mask

A projection mask is an OBE document of `1` (include) or `0` (exclude):

```json
{ "name": 1, "address": { "city": 1 }, "ssn": 0 }
```

The projection engine compiles this into a **projection plan** —
a vector of `(field_path, action)` tuples. At document scan time, the
engine walks the OBE bytes, copying or skipping ranges according to the
plan, into a fresh OBE buffer:

```text
project(in_doc: &[u8], plan: &Plan, out: &mut Vec<u8>) {
    write_doc_header_placeholder(out)
    for instr in plan:
        match instr:
            Include(path): copy_subtree(in_doc, path, out)
            Exclude(path): noop
            Project(sub_plan, path): project_subtree(in_doc, path, sub_plan, out)
    finalize_doc_header(out)
}
```

Because OBE keys are sorted, copying is a contiguous byte range — no
re-encoding cost. Projection on a 1 KB doc with mask of 3 fields runs in
~150 ns on x86-64 (single-thread).

---

## 8. Document Diff Algorithm

Diffs are required by:

- WAL `DOC_UPDATE` records (`[[FILE-02]]` §2.3).
- Oplog (`[[FILE-09]]` §1).
- Reactive query evaluation (`[[FILE-05]]` §10).

Diff is computed in a single pass over the **sorted-key** documents:

```text
diff(old: OBE, new: OBE) -> Vec<DiffOp>:
    ops = []
    iter_old = old.iter_fields()
    iter_new = new.iter_fields()
    while !iter_old.done() || !iter_new.done():
        match cmp(iter_old.key(), iter_new.key()):
            Less:    ops.push(Remove(iter_old.key())); iter_old.next()
            Greater: ops.push(Add(iter_new.key(), iter_new.value())); iter_new.next()
            Equal:
                if iter_old.value_bytes() != iter_new.value_bytes():
                    if both are Object:
                        sub_ops = diff(iter_old.value(), iter_new.value())
                        ops.push(Patch(key, sub_ops))
                    else:
                        ops.push(Replace(key, iter_new.value()))
                iter_old.next(); iter_new.next()
    return ops
```

Diff is encoded back to OBE for storage. Encoded diff size is typically
5-15% of full new doc for typical updates (single-field changes).

```
DiffOp ::= { op: u8, path: string, value: OBE }
```

### 8.1 Reverse application

Applying a diff is straightforward:

```
apply_diff(doc, ops):
    for op in ops:
        match op.op:
            REMOVE:  delete_field(doc, op.path)
            ADD:     insert_field(doc, op.path, op.value)
            REPLACE: replace_field(doc, op.path, op.value)
            PATCH:   apply_diff(navigate_to(doc, op.path), op.value as ops)
    return doc
```

---

## 9. Schema Inference

The engine maintains, per collection, a **probabilistic schema** derived
from sampling documents:

```rust
pub struct CollectionSchema {
    pub collection_id: u32,
    pub field_count: HashMap<FieldPath, FieldStats>,
    pub sample_count: u64,
    pub schema_dict_id: u32,
}

pub struct FieldStats {
    pub presence_count: u64,        // how many sampled docs have this field
    pub type_histogram: [u64; 32],  // count per type tag
    pub min_value: Option<OBEScalar>,
    pub max_value: Option<OBEScalar>,
    pub null_count: u64,
    pub distinct_estimate: HyperLogLog,
}
```

Updates: every Nth document (default N=64) updates schema stats.

Uses:

- **Query planner** uses presence_count and type_histogram to estimate
  selectivity (`[[FILE-05]]` §5).
- **Index recommender** suggests indexes for fields with high
  query-frequency × low presence_count.
- **Schema enforcement** (optional) — `pragma require_schema = strict`
  rejects writes that introduce a brand-new field not in the schema.

---

## 10. Comparison & Sort Order

Cross-type comparison order (lowest → highest), matching MongoDB BSON
spec for compatibility:

```
1.  MIN_KEY
2.  Null
3.  Numbers (Int, Float, Decimal — promoted)
4.  Symbol, String (lexicographic on UTF-8 bytes)
5.  Object (deep, key-by-key)
6.  Array (element-by-element, then length)
7.  BinData
8.  ObjectId
9.  Boolean (false < true)
10. Date
11. Timestamp
12. Regex
13. MAX_KEY
```

For **same-type** comparisons:

- **String:** byte-wise lexicographic (UTF-8 default; `pragma collation`
  may override per index).
- **Object:** recursive on sorted keys; missing key sorts as a
  type-9 hole (less than any present value).
- **Array:** element-wise; arrays with shorter prefix sort lower.
- **Number:** promoted to common type; NaN sorts equal to NaN, less
  than any non-NaN.

---

## 11. OBE2 Extensions (planned v0.6)

OBE v2 adds three extensions activated by `format_version >= 0x0002`:

1. **SIMD-accelerated decoder.** Type tags are reordered so a SIMD
   gather over `tag[i]` produces a vector of expected lengths. Yields
   ~2.5× faster decode on AVX-512 (`[[FILE-07]]` columnar scan path).
2. **Field-id mode.** When a collection schema is locked, field names
   are replaced by 16-bit ids, saving bytes and speeding access. New
   tag `0x21 OBJECT_FIELD_ID`.
3. **Differential encoding for arrays of similar objects.** New tag
   `0x22 ARRAY_DIFF` with a base value followed by per-element diffs.

OBE v1 readers see new tags as unknown plugin tags (tag ≥ 0x20) and
skip via varint length — fully forward-compatible.

---

## 12. Tradeoffs and Alternatives Considered

| Choice                   | Picked         | Considered            | Why we picked     |
|--------------------------|----------------|-----------------------|-------------------|
| Binary doc format        | OBE            | BSON, MessagePack, CBOR, FlatBuffers | Sorted keys + zero-copy fit document DB best. |
| Field name encoding      | UTF-8 + dict   | u16 id only           | UTF-8 keeps debuggability; dict opt-in. |
| Object key order         | sorted         | insertion-order       | Binary search + deterministic hashing. |
| Max depth                | 32             | unlimited / 100       | Stack safety + practical limit. |
| Doc size cap             | 16 MiB         | 4 MiB / unlimited     | BSON parity; large blobs go external. |
| Endianness               | LE             | BE / abstracted       | All targets LE; no conversion cost. |
| Date precision           | ms             | µs / ns               | ms is sufficient + small. |
| ObjectID layout          | ts(BE) + rand + counter | sequential u64 | Lexicographic sort by time; collision-resistant. |
| Vector type              | first-class    | array<f32>            | Type-checked + SIMD-friendly + indexable. |

---

## 13. Open Questions

1. **Should we support a JSON-Schema-compatible validation profile?**
   Strict-schema collections gain query optimization but lose
   flexibility. Track for v0.7.
2. **Decimal128 implementation.** We currently use the
   `decimal-rs` crate; verify cross-platform numerical determinism
   (especially around `to_string` rounding) before exposing in
   the JS binding (which has no native decimal type).
3. **CBOR interop.** A subset of OBE can be losslessly converted to
   CBOR (RFC 8949). Useful for pushing docs through a CBOR-aware
   transport. Decision deferred to post-v1.0.

---

## 14. Compatibility Notes

- OBE v1 documents remain readable indefinitely.
- The schema dictionary (`PAGE_TYPE_SCHEMA_DICT`) is per-database; it
  is replicated to replicas as part of the initial sync (see
  `[[FILE-09]]` §2).
- Switching from string field names to field-ids (OBE v2 §11.2)
  requires a one-shot rewrite per collection. We provide a CLI
  command `obx migrate --schema-lock <coll>`.

---

## 15. Cross-References

- WAL doc records: `[[FILE-02]]` §2.3.
- Slotted page: `[[FILE-01]]` §4.2.
- Index encoding (B+ keys derived from OBE values): `[[FILE-04]]` §2.
- Aggregation projection: `[[FILE-05]]` §6 (`$project`, `$replaceRoot`).
- Tokenizer input: `[[FILE-08]]` §2 (string fields → tokens).
- Encryption envelope: `[[FILE-07]]` §3.
- ADR on document model: `[[FILE-20]]`/004 (OQL/MQL design discussed
  there reflects the document model).

---

*End of `03-DOCUMENT-MODEL.md` — 583 lines.*
