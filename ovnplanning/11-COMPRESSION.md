# 11 — COMPRESSION

> **Audience:** Engine implementers touching storage encoding, columnar layout, network transmission.
> **Status:** Specification (target v0.2 LZ4, v0.3 Zstd, v0.5 columnar codecs).
> **Cross refs:** `[[FILE-01]]` storage engine, `[[FILE-02]]` WAL, `[[FILE-03]]` document model, `[[FILE-09]]` replication, `[[FILE-20]]/008` ADR compression choice.

---

## 1. Purpose

Compression in Oblivinx3x serves three orthogonal goals:

1. **Reduce storage footprint** — pages on disk, oplog segments, backups.
2. **Reduce I/O bandwidth** — fewer bytes per page read = more pages per second.
3. **Reduce network transfer** — replication, sync, snapshots.

This document defines codec choices, where each codec applies, dictionary management, the wire formats, and the cost/benefit model that drives default settings.

---

## 2. Codec catalog

| Codec     | Class       | Compression ratio (typical JSON-ish) | Compress speed | Decompress speed | License    |
| --------- | ----------- | ------------------------------------ | -------------- | ---------------- | ---------- |
| `none`    | passthrough | 1.00×                                | n/a            | n/a              | n/a        |
| `lz4`     | block       | 2.0–2.4×                             | ~500 MB/s      | ~3–4 GB/s        | BSD        |
| `lz4hc`   | block (HC)  | 2.4–2.8×                             | ~50 MB/s       | ~3–4 GB/s        | BSD        |
| `zstd-1`  | block       | 2.8–3.2×                             | ~400 MB/s      | ~1.2 GB/s        | BSD        |
| `zstd-3`  | block       | 3.0–3.5×                             | ~250 MB/s      | ~1.2 GB/s        | BSD        |
| `zstd-9`  | block       | 3.4–3.9×                             | ~80 MB/s       | ~1.2 GB/s        | BSD        |
| `zstd-19` | block (HC)  | 3.6–4.2×                             | ~10 MB/s       | ~1.2 GB/s        | BSD        |
| `for`     | columnar int| up to 8× on dense ints               | ~1 GB/s        | ~3 GB/s          | n/a (impl) |
| `dict`    | columnar str| up to 20× on low-cardinality         | ~600 MB/s      | ~2 GB/s          | n/a (impl) |
| `gorilla` | columnar f64| 5–12× on time-series                 | ~1 GB/s        | ~2 GB/s          | Apache (impl)|
| `bitpack` | columnar bitmap | up to 32× on sparse           | ~2 GB/s        | ~3 GB/s          | n/a        |

Numbers above are order-of-magnitude based on standard corpora (Silesia, en.wiki, internal sample) on a Skylake desktop. Actual numbers depend on CPU, data shape, and dictionary quality.

---

## 3. Where compression applies

### 3.1 Page level (disk pages)

Each data page (B-tree leaf, overflow chain, SST data block) carries a 1-byte **codec tag** in its header `[[FILE-01]]` §4:

```
+0   u8  codec_id          0=NONE 1=LZ4 2=LZ4HC 3=ZSTD-1 4=ZSTD-3 5=ZSTD-9 6=ZSTD-19
                           7=DICT-LZ4  8=DICT-ZSTD  9..15 reserved
```

Compressed bytes are wrapped:

```
┌─────────────────────────────────────┐
│ 64-byte common page header          │  (uncompressed, includes codec_id)
├─────────────────────────────────────┤
│ u32 compressed_len                  │
│ u32 uncompressed_len                │
│ bytes compressed_payload            │
└─────────────────────────────────────┘
```

If `codec_id == 0`, the `compressed_len/uncompressed_len` fields are omitted and payload is used directly.

### 3.2 WAL records

WAL records compress at the **batch** level (see §6). Per-record compression is rejected because:

* Tiny records (most WAL records < 256 B) compress poorly.
* Per-record codec overhead (header, dictionary) hurts more than it helps.

### 3.3 Oplog segments

Oplog batches use the same batch compression as WAL. In replication transit, additionally a session-level Zstd stream may be enabled (see `[[FILE-09]]` §4).

### 3.4 Backups

Backups always Zstd-compress the page payloads at level 9 (CPU at backup time is not the bottleneck; storage is).

### 3.5 Columnar storage

Columnar data segments — used by hybrid columnar mode `[[FILE-01]]` §10 — apply per-column codecs (see §7). Multiple codecs per column are allowed (chained).

---

## 4. Default codec policy

| Workload signature                  | Codec                         | Rationale                                  |
| ----------------------------------- | ----------------------------- | ------------------------------------------ |
| Mostly read, small DB (<10 GiB)     | `lz4`                         | Decompress dominates; speed > ratio        |
| Read-heavy, larger DB               | `zstd-3`                      | Good ratio, decompression still cheap      |
| Write-heavy, throughput-bound       | `lz4`                         | Compress speed matters                     |
| Cold archival                       | `zstd-19`                     | One-shot; ratio is everything              |
| Time-series                         | `gorilla` (data) + `bitpack`  | Domain-specific 10× win                    |
| Strings with low cardinality        | `dict-zstd`                   | 20× possible                               |
| Embedded mobile                     | `lz4`                         | Battery-friendly                           |
| WASM browser                        | `none` or `lz4`               | Decoder size matters; Zstd WASM is +250 KB |

Defaults are per-collection; user overridable via `collection.set_codec("zstd-3")`. The engine probes data on first 100 pages and emits an info-level log if the policy is sub-optimal (e.g., LZ4 selected but data is highly compressible).

---

## 5. Block compression — LZ4 / Zstd integration

### 5.1 Page write path

```rust
fn write_page(page: &Page) -> Result<(), OvnError> {
    let raw = page.serialize();                        // ≤ page_size bytes
    let codec = page.codec_id();
    let compressed = match codec {
        Codec::None      => raw.into(),
        Codec::Lz4       => lz4::compress(&raw, /*acc=*/1),
        Codec::Lz4Hc     => lz4::compress_hc(&raw, /*level=*/9),
        Codec::Zstd(lvl) => zstd::compress(&raw, lvl),
        Codec::DictLz4(d)| Codec::DictZstd(d) =>
            with_dict(d, &raw, codec)?,
    };
    if compressed.len() + COMPRESS_HEADER >= raw.len() - COMPRESS_MIN_SAVING {
        // not worth it; store raw
        return write_page_raw(page, &raw);
    }
    let frame = build_frame(page.id(), codec, &compressed, raw.len());
    io.write(file_offset_for(page.id()), frame)?;
    Ok(())
}
```

`COMPRESS_MIN_SAVING` defaults to 64 bytes — below that, the I/O alignment penalty (page sizes are aligned to physical sector size) negates the win.

### 5.2 Page read path

```rust
fn read_page(page_id: PageId) -> Result<Page, OvnError> {
    let bytes = io.read(file_offset_for(page_id), page_size)?;
    let header = parse_common_header(&bytes)?;
    let payload = match header.codec_id {
        0 => bytes[64..].into(),
        1 => lz4::decompress(&bytes[72..], header.uncompressed_len as usize)?,
        3..=6 => zstd::decompress(&bytes[72..], header.uncompressed_len as usize)?,
        7|8 => with_dict(header.dict_id, &bytes[72..], header.codec_id)?,
        _ => return Err(OvnError::UnknownCodec(header.codec_id)),
    };
    Ok(Page::deserialize(payload))
}
```

The buffer pool caches **uncompressed** pages by default. A future "compressed cache tier" may store compressed pages between buffer pool and disk to multiply effective memory.

### 5.3 SIMD acceleration

When built on platforms with SIMD:

* LZ4 uses the official streaming SSE2 path (`lz4_x86_64`).
* Zstd uses upstream BMI2/AVX2 paths.
* Custom checksum (xxh3) uses SSE4.2/AVX2 when available.

Detection happens at engine init; chosen functions are stored in vtables to avoid per-call dispatch.

---

## 6. Dictionary compression

### 6.1 Why dictionaries

Most documents in a collection share many small strings (field names, enum values, hostnames). A trained Zstd dictionary lets the codec reference those without re-emitting them, gaining 30–60% on top of dictionaryless Zstd for small documents (< 4 KiB).

### 6.2 Training

Triggered when:

* Collection has > 10,000 documents AND no dictionary, OR
* Sampled compression ratio improves > 20% with a fresh dictionary (background re-evaluation every 24h).

Training algorithm:

```rust
fn train_dict(coll: &Collection) -> Result<Dictionary, OvnError> {
    let samples = coll.sample(N_SAMPLES);              // default 1000 docs
    let raw_blobs: Vec<Vec<u8>> = samples.iter()
        .map(|d| d.encode_obe()).collect();
    let dict_size = pick_dict_size(samples.len());     // 16 KiB to 256 KiB
    let dict = zstd::dict::from_samples(&raw_blobs, dict_size)?;
    Ok(Dictionary { id: next_dict_id(), bytes: dict })
}
```

`pick_dict_size`:

| Avg doc size | Dict size  |
| ------------ | ---------- |
| < 256 B      | 16 KiB     |
| 256 B–1 KiB  | 32 KiB     |
| 1–4 KiB      | 64 KiB     |
| 4–16 KiB     | 128 KiB    |
| > 16 KiB     | 256 KiB    |

### 6.3 Dictionary storage

Dictionaries live in a **system collection** `_ovn_dicts`:

```jsonc
{
  "_id":       "<u64 dict_id>",
  "kind":      "zstd-trained",
  "trained_at":"<hlc>",
  "size":      131072,
  "checksum":  "<xxh3-128>",
  "bytes":     "<binary blob>"
}
```

Page headers carry an 8-bit `dict_id` (0 = no dict). Engine maintains an in-memory `HashMap<DictId, Arc<Dictionary>>`.

### 6.4 Dictionary lifecycle

* **Active** — used for new writes.
* **Decoder-only** — old pages still need it for reads, but writes use a newer dict.
* **Garbage** — no live page references it; eligible for delete (verified by full-scan reference count, run during vacuum).

A page references its decoder dict via `dict_id` in the header. When a page is rewritten, it adopts the active dict. Background compaction `[[FILE-01]]` §8 will, if `compact_dict_rewrite=true`, re-pack pages using the active dict to allow garbage collection of old dicts.

### 6.5 Dictionary versioning

```
DictHeader {
    dict_id:    u64,
    version:    u32,             // bumped on retrain
    parent:     Option<u64>,     // previous dict_id (for chain pruning)
    created_at: u64 (HLC),
}
```

Replicas pull dictionaries by `dict_id`; if missing, request from peer before applying any oplog entries that reference them.

---

## 7. Columnar codecs

Hybrid columnar mode `[[FILE-01]]` §10 stores cold partitions as columns. Per-column codecs:

### 7.1 Frame-of-Reference (FOR)

For integer columns with bounded local range:

```
ColumnFOR {
    base:   i64,           // min value in segment
    bits:   u8,            // log2(range) rounded up
    bytes:  Vec<u8>,       // bit-packed (val - base)
}
```

Encoding cost: O(N). Decoding: SIMD bit-unpack at ~3 GB/s.

### 7.2 Dictionary encoding

For string/enum columns with low cardinality:

```
ColumnDict {
    dict:   Vec<String>,        // unique values, sorted
    codes:  Vec<u32_or_u16>,    // index into dict
}
```

Index width chosen by `ceil(log2(|dict|))` rounded up to 8/16/32 bits. If `|dict| > sqrt(N)`, fall back to plain Zstd (dictionary compression buys nothing).

### 7.3 Gorilla (Facebook 2015)

For floating-point time-series. Each value is XOR'd with the previous; leading/trailing zero counts are bit-packed:

```
encode(prev, cur):
    xor = prev ^ cur
    if xor == 0: emit '0'
    else:
        leading  = clz(xor)
        trailing = ctz(xor)
        if "in same window as previous": emit '10' + meaningful bits
        else:                            emit '11' + leading(5) + len(6) + bits
```

Compression: typical 1.6 bits/sample on smooth metrics.

### 7.4 Bitpack / RLE for nullable bitmaps

Nullable column carries a parallel bitmap. Storage:

* If null_count == 0: omit bitmap.
* If null_count < N/16: store run-length encoded.
* Otherwise: pack 1 bit/value.

### 7.5 Codec chaining

Columnar segments may chain multiple codecs:

```
raw → [FOR] → [zstd-1] → bytes
```

Each codec is a TLV in the column descriptor:

```
ColumnCodecChain {
    codecs: Vec<{
        kind: CodecKind,
        params: Vec<u8>,         // codec-specific tuning
    }>,
}
```

Common chains:

| Data shape       | Chain                      |
| ---------------- | -------------------------- |
| Dense integer    | `FOR`                      |
| Sparse integer   | `RLE → zstd-1`             |
| String enum      | `Dict`                     |
| Free-text string | `zstd-3` with dict         |
| Float metric     | `Gorilla`                  |
| Bool             | `Bitpack`                  |

---

## 8. Wire compression (replication & API)

### 8.1 Oplog batch

Frame flag bit 0 marks a batch as Zstd-compressed:

```
+0  u8   frame_type = 0x04 (OPLOG_BATCH)
+1  u8   frame_flags = bit0 (compressed) | bit1 (encrypted)
+2  ...
```

If compressed, payload:

```
+0  u32  uncompressed_len
+4  u8   codec_id (1=lz4, 3=zstd-3, ...)
+5  u8   dict_id_len
+6  u32  uncompressed_dict_id (if dict)
+...    compressed bytes
```

### 8.2 REST / gRPC payloads

* HTTP: respect `Accept-Encoding`; default `zstd, gzip` advertised.
* gRPC: use built-in `grpc-encoding: zstd` (since gRPC 1.43+).

### 8.3 WebSocket sync

Per-message Zstd is enabled when both ends advertise the `permessage-zstd` extension (custom; spec'd as draft mirror of permessage-deflate). Falls back to permessage-deflate, then plain.

---

## 9. Transparent decompression

Decompression must remain transparent to higher layers:

```rust
fn fetch_page(page_id: PageId) -> Result<PinnedPage<'_>, OvnError> {
    let frame = buffer_pool.pin(page_id)?;
    if frame.is_compressed_in_memory() {
        // optional compressed cache tier
        let raw = decompress(frame.bytes())?;
        frame.materialize(raw);                 // upgrade in place
    }
    Ok(frame.into_pinned())
}
```

Higher-level code (B-tree, query engine) sees only fully-decompressed bytes.

### 9.1 Avoiding double-decompress

Buffer pool caches uncompressed pages by default, so repeated reads hit cache. The optional **compressed-tier cache** keeps an additional N MiB of compressed pages between disk and the uncompressed tier, increasing effective cache hit rate at the cost of one decompress per second-tier hit.

---

## 10. Performance envelope

### 10.1 Cost model used by the planner

The cost-based optimizer `[[FILE-05]]` §6 includes a decompression cost when estimating page reads:

```
read_cost(page) = io_cost + decompress_cost(codec, page_size)

decompress_cost (per 8 KiB):
    none      :   0 µs
    lz4       :   2 µs
    zstd-3    :   7 µs
    zstd-19   :   8 µs   (decompress speed independent of compression level)
    dict-zstd :   8 µs
```

### 10.2 Memory & CPU budget

| Codec        | Per-thread state  | Init cost      | Notes                              |
| ------------ | ----------------- | -------------- | ---------------------------------- |
| LZ4          | 64 KiB            | trivial        | Stateless API in practice           |
| Zstd         | 1–8 MiB (CCtx)    | 50 µs          | Use thread-local context cache     |
| Zstd dict    | + dict size       | dict load 1 ms | Cache loaded dicts in Arc          |
| FOR/Bitpack  | 0                 | 0              | SIMD intrinsics                     |

Engine pre-warms thread-local Zstd contexts at first use; idle contexts trimmed after `idle_compress_ttl_s` (default 60s).

### 10.3 Pathological cases

| Scenario                              | Mitigation                                       |
| ------------------------------------- | ------------------------------------------------ |
| Already-compressed payload (e.g. JPG) | Detected by ratio < 1.05; codec switched to none |
| Tiny pages (< 256 B)                  | Skip compression                                 |
| Random/encrypted-already data         | Same as above                                    |
| Highly compressible (> 10×)           | Zstd-9 worth the CPU; auto-suggested             |

---

## 11. Compression vs encryption

Encryption (random output) is incompressible. Therefore **compression must run before encryption**:

```
raw → compress → (auth-encrypt with K_data) → on-disk frame
```

Failing to do this not only wastes CPU but also breaks ratio. The page-write code path enforces this order; encryption layer refuses to compress its own output.

CRIME-style attacks (compress-then-encrypt of attacker-influenced plaintext) are not relevant here because the engine compresses internal page bytes that the attacker cannot adaptively interleave. Field-level encryption explicitly disables compression on encrypted fields (see `[[FILE-07]]` §5).

---

## 12. Validation & tooling

### 12.1 `ovn admin compress-info`

Per-collection report:

```
Collection: orders
  Codec: zstd-3 (default)
  Dict: dict_id=42 (size=64KiB, version=3, used by 84% of pages)
  Compression ratio (sampled 1000 pages):
    avg=3.2×  p50=3.1×  p95=3.8×  p99=4.4×
  CPU cost:
    write avg: 22 µs/page
    read avg:  6  µs/page
  Recommendation: keep
```

### 12.2 `ovn admin compress-rewrite`

Re-encodes all pages in a collection with a new codec or fresh dict. Streams in background, throttled by `--max-pages-per-second`.

### 12.3 Built-in benchmark

`engine.benchmark_codec(sample_size=10MiB)` returns measured throughput for each available codec on the host CPU. Can be invoked at install time to choose defaults.

---

## 13. Tradeoffs

| Decision                              | Chosen                  | Alternative              | Why                                |
| ------------------------------------- | ----------------------- | ------------------------ | ---------------------------------- |
| Block (page) vs streaming             | Block                   | Streaming                | Random page reads need block       |
| LZ4 default for embedded              | Yes                     | Zstd-1                   | Battery, install size, decoder    |
| Dictionaries                          | Trained per collection  | Static / global          | Per-collection ratio gains         |
| Compressed cache tier                 | Optional                | Always on                | Memory pressure varies             |
| Codec stored per page                 | Yes (tag in header)     | Per-collection only      | Allows mixed codecs during migration|
| Columnar codec chains                 | Allowed                 | Single codec per column  | Better ratios on structured data   |
| WASM Zstd                             | Optional download       | Bundled                  | 250 KiB cost not always worth it   |

---

## 14. Compatibility & versioning

* Codec IDs 0–15 reserved for built-ins; > 15 for plugins (mapped via `_ovn_codecs` system collection).
* Adding a new codec is **backward compatible** for newer readers; older readers reject pages with unknown `codec_id` and pin them as `READ_REQUIRES_UPGRADE`.
* Removing a codec requires a major version bump and a migration sweep that re-encodes affected pages.

---

## 15. Open questions & future

* **Hardware compression** — Intel QAT, IAA accelerators; useful for cloud deployments.
* **Adaptive per-page codec** — switch at runtime based on observed ratio.
* **Cross-collection dictionaries** — share dict across collections with similar shape (auto-clustering).
* **Zstd long-range mode** — for very large blobs (`--long=27`).
* **Cost-aware compaction** — re-pack pages with different codec only if expected savings × access frequency > rewrite cost.

---

## 16. Cross-references

* `[[FILE-01]]` §4, §6, §10 — page header, buffer pool, columnar mode.
* `[[FILE-02]]` §3 — WAL batch compression.
* `[[FILE-03]]` §1 — OBE encoding (input to compression).
* `[[FILE-07]]` §5 — encryption order.
* `[[FILE-09]]` §4 — wire compression in replication.
* `[[FILE-12]]` — `obx_compress_ratio`, `obx_compress_us`.
* `[[FILE-20]]/008` — ADR for codec selection.

*End of `11-COMPRESSION.md` — 470 lines.*
