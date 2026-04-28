# ADR-001 — Hybrid B+ Tree / LSM Storage Engine

**Status:** Accepted, 2026-04
**Owners:** Storage subsystem
**Cross refs:** `[[FILE-01]]`, `[[FILE-02]]`, `[[FILE-04]]`

---

## Context

Oblivinx3x must serve mixed workloads on a single embedded file: predictable point reads (LMDB-style), high write throughput (LSM-style), and rich secondary-index queries. The targets:

* Sustained 25k inserts/s sync, 1M cached reads/s.
* `.ovn2` is a single addressable file (not a directory of LSM segments) for embedded deployment ergonomics.
* Mobile/edge: handle long-offline writes, small footprint.
* Server: scale to multi-TB cold + GB hot.

Three baseline architectures considered:

1. **Pure B+ Tree (LMDB / SQLite)** — excellent reads, low write amplification on small txns, but writes scale poorly to high throughput; copy-on-write requires file growth or rewrite.
2. **Pure LSM (RocksDB / WiredTiger LSM)** — excellent writes, but read amplification grows with levels; also organizes as multiple SST files which fights the single-file requirement.
3. **Hybrid B+ / LSM (this ADR)** — primary IOT in B+ Tree; in-flight writes batched in an in-memory memtable, periodically flushed and incorporated into the B-tree via background compaction; secondary indexes live in B+ Trees inside the same file.

## Decision

Adopt the **hybrid B+ / LSM model** within a single `.ovn2` file:

* **Primary index** = clustered B+ Tree (IOT), 8 KiB pages.
* **Write path**: append to WAL, then to in-memory memtable. Flush converts memtable into a pending SST-like region, then merges into the B+ Tree by background compaction.
* **Read path**: query merges memtable + B+ Tree; bloom filter sidecar accelerates negative lookups.
* **Single file**: SST-equivalent regions and B-tree pages share the same `.ovn2` file via a unified page allocator with freelist + bitmap.

## Consequences

**Positive**

* Read latency stays B-tree-class on point lookups.
* Write throughput benefits from sequential WAL + memtable batching.
* Single-file deployment matches embedded-DB UX.
* Compaction can adapt: full B-tree merge for slow-churn workloads, hold-as-LSM-region for write-heavy bursts.

**Negative**

* Implementation complexity higher than pure designs.
* Compaction tuning becomes a long-term operability concern.
* Background memory for memtable + bloom + buffer pool must be budgeted explicitly.

## Alternatives considered

* **Multi-file LSM** (RocksDB-style) — rejected: complicates atomic snapshot/backup and embedded distribution.
* **Pure copy-on-write B+ Tree (LMDB)** — rejected: write throughput too low for v0.5 replication targets and write-heavy mobile sync.
* **Append-only log + secondary indexes** (WiscKey-style key-value separation) — interesting; revisit post-1.0 for very large blobs.

## Open questions

* When does pure B-tree mode (no memtable) become the right default for read-only workloads?
* Should memtable be a skiplist or B+ variant in v0.3?

*End of ADR-001.*
