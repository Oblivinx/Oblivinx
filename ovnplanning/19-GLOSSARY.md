# 19 — GLOSSARY

> **Audience:** Anyone reading the rest of `ovnplanning/`. Defines every non-trivial term that appears across the corpus.
> **Status:** Living document; new terms added as they enter specs.
> **Cross refs:** entries link to the file(s) where each term is most extensively defined.

---

> Convention: bold term, em-dash, single-paragraph definition. **A→Z** ordering, case-insensitive.

---

**ABAC (Attribute-Based Access Control)** — Authorization model where allow/deny decisions are derived from attributes of the user, the resource, and the request context (time, IP, etc.), evaluated against a policy. Complements RBAC. See `[[FILE-07]]` §6–§7.

**Acquire / Release / SeqCst** — C11/Rust memory orderings used in atomic operations. Acquire prevents subsequent reads from being reordered before; Release prevents prior writes from being reordered after; SeqCst gives total order across all SeqCst ops. See `[[FILE-10]]` §10.

**Active Tx Table** — In-memory structure listing all currently-running transactions and their snapshots. Used by MVCC visibility checks. See `[[FILE-06]]` §3.

**ADR (Architecture Decision Record)** — A short document capturing the context, decision, and consequences of an architectural choice. Stored under `ovnplanning/20-ADR/`.

**AHIT (Adaptive Hybrid Index Tree)** — Index variant where hot keys live in an in-memory B+ Tree and cold keys in disk-backed BTreeMap, with promotion based on rolling-window access frequency. See `[[FILE-04]]`.

**ANN (Approximate Nearest Neighbor)** — A search that returns near-best vector matches with bounded recall, trading exactness for speed. Implemented via HNSW. See `[[FILE-04]]` §6, `[[FILE-08]]` §9.

**ARC (Adaptive Replacement Cache)** — Buffer pool eviction policy that adapts between recency (LRU) and frequency (LFU) by maintaining four lists T1/T2/B1/B2. See `[[FILE-01]]` §6.

**Audit log** — Append-only record of security-relevant events (login, permission grant, key rotation), with HMAC chaining so any tampering breaks the chain. See `[[FILE-07]]` §10.

**B+ Tree** — Balanced tree with all data in leaves and an ordered linked list across leaves. Used for primary IOT and most secondary indexes. See `[[FILE-01]]`, `[[FILE-04]]` §3.

**Backpressure** — Signal sent upstream when a consumer cannot keep up. The engine returns `WriteBackpressure` when WAL backlog exceeds a high-water mark. See `[[FILE-10]]` §7.3.

**BM25 (Best Matching 25)** — Probabilistic relevance ranking used in full-text search; tuned via `k₁` and `b` constants. See `[[FILE-08]]` §7.

**Bloom filter** — Probabilistic membership filter (no false negatives, tunable false-positive rate); used as sidecar for negative lookups on SST and B-tree. See `[[FILE-04]]` §7.

**Buffer pool** — In-memory cache of disk pages with pin/unpin protocol and an eviction policy (ARC). See `[[FILE-01]]` §6, `[[FILE-10]]` §6.

**Causal stability** — In a CRDT system, the timestamp before which all peers have acknowledged; tombstones older than this can be garbage-collected. See `[[FILE-09]]` §6.5.

**Checkpoint** — Operation that flushes the dirty buffer pool and memtable to durable storage and truncates the WAL. Modes: PASSIVE, FULL, RESTART, TRUNCATE. See `[[FILE-02]]` §4.

**Chunked / Group commit** — WAL flusher pattern where multiple in-flight transactions share a single fsync, amortizing syscall cost. See `[[FILE-02]]` §3, `[[FILE-10]]` §7.2.

**Codec** — Compression algorithm. Engine codec IDs include `lz4`, `lz4hc`, `zstd-1..19`, `dict-zstd`, `for`, `dict`, `gorilla`, `bitpack`. See `[[FILE-11]]` §2.

**Collection** — Named container of documents, akin to a SQL table. Each collection has its own indexes, schema validator, and codec policy.

**Compaction** — Background merge of LSM SST files (or B-tree pages) to remove deleted entries, reclaim space, and reduce read amplification. See `[[FILE-01]]` §8.

**Composite key** — Multi-field key used by an index, encoded as concatenated sortable byte representations separated by `0xFF`. See `[[FILE-04]]` §4.3.

**Conformance test** — Test that locks down a wire/format byte layout via a golden file, breaking CI on any drift. See `[[FILE-17]]` §8.

**Coverable index** — Index whose entries contain enough fields to satisfy a query without consulting the base table. See `[[FILE-04]]` §4.10.

**CRDT (Conflict-free Replicated Data Type)** — Data structure where concurrent replicas can be merged deterministically without coordination. Types: LWWRegister, ORSet, PNCounter, etc. See `[[FILE-09]]` §6.

**Cursor** — Stateful handle for pull-based iteration over query results; held by client across batches. See `[[FILE-13]]` §7.5.

**Decimal128** — IEEE 754-2008 128-bit decimal floating-point type used for financial values (stored in OBE tag `0x13`). See `[[FILE-03]]` §2.

**Direct I/O** — File access bypassing the OS page cache (`O_DIRECT` / `F_NOCACHE` / `FILE_FLAG_NO_BUFFERING`). Optional per platform. See `[[FILE-01]]`, `[[FILE-16]]` §4.

**Dictionary compression** — Codec mode where a precomputed dictionary (trained from sample data) seeds the compressor, gaining 30–60% over codeword-only Zstd on small JSON-ish payloads. See `[[FILE-11]]` §6.

**EBNF (Extended Backus-Naur Form)** — Notation used to define OQL grammar. See `[[FILE-15]]` §2.

**EBP (Equi-Depth Buckets)** — Histogram representation where each bucket holds the same count of values; used for selectivity estimation. See `[[FILE-04]]` §11.

**Encrypted-at-rest** — Pages on disk are AES-256-GCM-SIV encrypted with sub-keys derived via HKDF. See `[[FILE-07]]` §3.

**Engine (OvnEngine)** — Top-level handle in the Rust API; owns one or more `.ovn2` files. See `[[FILE-13]]` §3.2.

**Epoch interruption** — Wasmtime mechanism for bounded plugin call duration via incrementing epoch counter. See `[[FILE-14]]` §7.1.

**Eventual consistency** — Replicas converge given no new writes. Default for multi-master CRDT collections. See `[[FILE-09]]` §2.4.

**EXPLAIN** — Statement returning the query plan; with `ANALYZE`, also actual row counts and timings. See `[[FILE-12]]` §6, `[[FILE-15]]` §13.

**FDC (Field-level deterministic cipher)** — Encryption mode where the same plaintext + key always produce same ciphertext, enabling equality search on encrypted fields. See `[[FILE-07]]` §5.

**FLE (Field-Level Encryption)** — Encrypting individual fields rather than entire pages, used for sensitive columns alongside otherwise-plain documents. See `[[FILE-07]]` §5.

**Frame (buffer pool)** — Slot in the buffer pool that holds one page in memory. Has a pin count, dirty bit, and version counter. See `[[FILE-01]]` §6.

**FTS (Full-Text Search)** — Inverted-index based text search with tokenization, stemming, BM25, phrase / boolean / wildcard / fuzzy queries. See `[[FILE-08]]`.

**Fuel (wasmtime)** — Cost counter consumed by each WASM op; enforces per-call CPU budget. See `[[FILE-14]]` §7.1.

**Galloping search** — Skip-list traversal pattern where the iterator doubles its stride until overshooting. Used in posting list `skip_to`. See `[[FILE-08]]` §6.2.

**Gorilla compression** — Time-series codec by Facebook (2015) using XOR + leading/trailing-zero bit-packing. See `[[FILE-11]]` §7.3.

**Group commit** — See **chunked commit**.

**Hazard pointer** — Lock-free reclamation pattern where a thread publishes the pointer it is about to read so freers can defer. See `[[FILE-10]]` §6.3.

**HLC (Hybrid Logical Clock)** — 64-bit timestamp combining wall-clock and a logical counter to provide causal ordering across nodes with bounded skew. See `[[FILE-06]]` §13.

**HNSW (Hierarchical Navigable Small World)** — Layered graph data structure for approximate nearest-neighbor search. Parameters M, ef_construction, ef_search. See `[[FILE-04]]` §6.

**HKDF (HMAC-based Key Derivation Function)** — Standard for deriving sub-keys from a master key using a salt and info string. See `[[FILE-07]]` §4.3.

**Idempotent** — An operation that, applied multiple times, has the same effect as applying it once. Required for replica oplog application. See `[[FILE-09]]` §5.1.

**Index hint** — Caller directive to the planner to use (or avoid) a specific index. See `[[FILE-15]]` §3 (HINT clause), `[[FILE-04]]` §11.

**Initial sync** — Replica bootstrap: stream a base snapshot, then tail the oplog from that LSN. See `[[FILE-09]]` §4.4.

**IOT (Index-Organized Table)** — Table whose rows are stored within the primary index leaf pages (no separate heap). Default for Oblivinx3x. See `[[FILE-04]]` §3.

**Isolation level** — Specifies which concurrency anomalies a transaction is shielded from. Levels: read-committed, repeatable-read, snapshot, serializable, strict-serializable. See `[[FILE-06]]` §5.

**Jepsen** — Tool & methodology for testing distributed system safety under faults. Adapted for replication & sync conformance. See `[[FILE-17]]` §12.1.

**JSON Pointer** — RFC 6901 syntax for addressing inside JSON, used by OBE patch ops and OQL `#>` operator. See `[[FILE-03]]` §10, `[[FILE-15]]` §7.

**KMS (Key Management Service)** — External system holding root encryption keys (AWS KMS, GCP KMS, Azure Key Vault, HashiCorp Vault). See `[[FILE-07]]` §4.5.

**Latch** — Lightweight RwLock on a buffer pool frame or B-tree node; held only while the structure is touched in memory. See `[[FILE-10]]` §4.

**Latch coupling** — B-tree descent technique that holds parent's latch only until child's latch is acquired. See `[[FILE-10]]` §5.2.

**LEB128 / Varint** — Variable-length integer encoding, used in OBE and posting lists. Zigzag variant for signed integers. See `[[FILE-03]]` §3.

**Linearizability** — Strongest consistency: every operation appears to take effect at a single instant between its invocation and response, consistent with a real-time order.

**Loom** — Rust crate for exhaustively testing concurrent code by exploring all valid memory-ordering interleavings. See `[[FILE-17]]` §10.2.

**LRU (Least Recently Used)** — Simple eviction policy used in v0.1 buffer pool before ARC.

**LSM (Log-Structured Merge tree)** — Storage architecture where writes go to an in-memory memtable, periodically flushed to immutable SST files that are later compacted. Used as part of the hybrid B+/LSM model. See `[[FILE-01]]` §1.

**LSN (Log Sequence Number)** — Monotonic byte-offset position in the WAL. Used to identify durability and replication progress. See `[[FILE-02]]` §2.

**LTS (Long-Term Support)** — A release line guaranteed to receive backports for an extended period. v1.0 is the first LTS. See `[[FILE-18]]` §1.

**LWW (Last-Writer-Wins)** — CRDT semantic where the most-recent timestamp wins ties. Default field merge for non-CRDT fields under multi-master. See `[[FILE-09]]` §6.

**Memtable** — In-memory write buffer (skiplist or B-tree variant) flushed to an SST when full. See `[[FILE-01]]`, `[[FILE-02]]`.

**MGL (Multi-Granularity Locks)** — Lock-mode hierarchy IS / IX / S / SIX / X used to coordinate intentions with row/page locks. See `[[FILE-06]]` §7.

**MQL (Mongo Query Language)** — JSON-shaped operator surface (`{$gt}`, `$set`, etc.) supported alongside OQL by lowering to the same AST. See `[[FILE-05]]` §3.

**Multi-master** — Topology where multiple nodes accept writes; conflicts resolved via CRDT or LWW. See `[[FILE-09]]` §6.

**MVCC (Multi-Version Concurrency Control)** — Each row stores multiple versions tagged with `xmin_lsn`/`xmax_lsn`; readers see a consistent snapshot without blocking writers. See `[[FILE-06]]`.

**NaN canonicalization** — Wasmtime option that normalizes all floating-point NaN bit patterns; required for cross-platform plugin determinism. See `[[FILE-14]]` §7.4.

**OBE (Oblivinx Binary Encoding)** — BSON-inspired binary document format with sorted keys and varint lengths. See `[[FILE-03]]`.

**OCC (Optimistic Concurrency Control)** — Transactions read freely; conflicts detected at commit-time via comparing read sets to subsequently-committed writes. See `[[FILE-06]]` §6, `[[FILE-10]]` §5.4.

**ObjectId (OID)** — 12-byte identifier: 4-byte big-endian timestamp, 5-byte randomness, 3-byte big-endian counter. Sortable. See `[[FILE-03]]` §4.

**Oplog** — Logical, stable view of WAL records suitable for cross-node replication. See `[[FILE-09]]` §3.

**OPFS (Origin Private File System)** — Browser API providing per-origin private filesystem with async I/O; Oblivinx3x WASM target uses it. See `[[FILE-16]]` §4.

**OQL (Oblivinx Query Language)** — SQL-flavored, document-aware first-class query language. See `[[FILE-15]]`.

**OvnError** — Top-level error enum for the Rust API; mapped consistently across all surfaces. See `[[FILE-13]]` §10.

**Page** — Fixed-size unit of storage and I/O (default 8 KiB). Each page has a 64-byte common header, type-specific layout, and codec tag. See `[[FILE-01]]` §3–§5.

**Page LSN** — Last LSN that modified a page; used to enforce WAL-before-page rule and detect changed pages for backups.

**PASETO / JWT** — Token formats considered for sessions; Oblivinx3x uses JWT with RS256 by default. See `[[FILE-07]]` §6.

**Pin / Unpin** — Reference-count protocol on a buffer pool frame; pinned frames cannot be evicted. See `[[FILE-10]]` §6.2.

**PITR (Point-in-Time Recovery)** — Restore the database to its exact state at a specific time, by combining a base snapshot with oplog replay up to that timestamp. See `[[FILE-09]]` §9.

**Plan cache** — Cache mapping (statement template + parameter types) to compiled physical plan. See `[[FILE-12]]` §3.6.

**Plan-stable bind** — Property that re-binding the same statement template with new parameter values reuses the same cached plan.

**Posting list** — Sorted list of (doc-id, position) pairs maintained per term in a full-text inverted index. See `[[FILE-08]]` §5.

**Quorum** — Majority of voting members. Replication can require quorum acks before considering a write durable. See `[[FILE-09]]` §4.6.

**RBAC (Role-Based Access Control)** — Authorization model where users get roles, roles get permissions. Built-in roles: admin, dbAdmin, write, read, audit. See `[[FILE-07]]` §6.

**RCU (Read-Copy-Update)** — Pattern where readers are wait-free; writers atomically swap the entire structure. Used for the schema catalog via `arc-swap`. See `[[FILE-10]]` §9.3.

**Reactive query** — Query whose result set live-updates as underlying data changes. Implemented via WAL tail + DBSP-style differential computation. See `[[FILE-05]]` §10.

**Replica lag** — Difference (in time, LSN, or ops) between primary and a secondary. See `[[FILE-09]]` §8.1.

**RLS (Row-Level Security)** — Per-row authorization filter applied transparently to queries. See `[[FILE-07]]` §7.

**Routing key** — Field used to shard data; in v1.0 sharding is single-node only.

**RPO / RTO** — Recovery Point Objective (max acceptable data loss) / Recovery Time Objective (max acceptable downtime). See `[[FILE-09]]` §1.

**RRF (Reciprocal Rank Fusion)** — Hybrid search scoring: `score = Σ 1/(k + rank_i)` over result lists. Default `k=60`. See `[[FILE-08]]` §10.

**Savepoint** — Named position inside a transaction to which `ROLLBACK TO SAVEPOINT` can return without aborting the whole txn. See `[[FILE-06]]`, `[[FILE-15]]` §6.

**Schema dictionary** — Compact integer-keyed catalog of repeated field names (and optionally values) used to shrink OBE documents. See `[[FILE-03]]` §6.

**SeqLock** — Lock-free read pattern using a sequence counter; used for tiny mutable structs like `EngineStats`. See `[[FILE-10]]` §9.4.

**Serializable / Strict serializable** — Top isolation levels: serializable forbids all concurrency anomalies; strict serializable adds real-time ordering. See `[[FILE-06]]` §5.

**Shadow page** — Pre-write copy of a critical page (e.g., page 0) used to recover from torn writes. See `[[FILE-01]]` §3, `[[FILE-02]]` §6.

**Snapshot** — Consistent point-in-time view of the database; in MVCC, captured by recording the active tx set. See `[[FILE-06]]` §3.

**SST (Sorted String Table)** — Immutable sorted file containing memtable contents; merged via compaction. See `[[FILE-01]]`, `[[FILE-02]]`.

**Sustained write throughput** — Throughput maintained over multi-minute windows, dominated by WAL fsync + flush capacity, not in-memory burst.

**Tombstone** — Marker indicating a deleted entry. Required by CRDT ORSet for causal ordering. See `[[FILE-09]]` §6.

**Torn write** — Partial write of a page caused by power loss; a page may end up half old / half new. Detected via CRC and recovered via shadow page or WAL replay. See `[[FILE-02]]` §6.

**TPC-C / YCSB** — Standard OLTP benchmark suites used in macro benches. See `[[FILE-17]]` §11.3.

**Trigger** — Plugin function invoked before or after CRUD ops. See `[[FILE-14]]` §11.

**TSan / ASan / MSan / LSan** — ThreadSanitizer / AddressSanitizer / MemorySanitizer / LeakSanitizer; used in nightly CI. See `[[FILE-16]]` §6.2.

**TLS 1.3** — Minimum transport security; cipher suite policy in `[[FILE-07]]` §3.

**UDF (User-Defined Function)** — Plugin-supplied scalar or aggregate function callable from OQL. See `[[FILE-14]]` §3, `[[FILE-15]]` §9.

**UPSERT** — Insert if no match, otherwise update. See `[[FILE-15]]` §4.

**Vacuum** — Background MVCC garbage collection that reclaims versions invisible to all live snapshots. See `[[FILE-06]]` §9.

**Vector** — First-class document type holding `f32[]`; usable in vector search. See `[[FILE-03]]` §2, `[[FILE-04]]` §6.

**Volcano model** — Iterator-based query execution where each operator pulls tuples from its child via `next()`. Combined with vectorized batches in Oblivinx3x. See `[[FILE-05]]` §7.

**WAL (Write-Ahead Log)** — Durable, append-only log of changes; the engine's source of truth for crash recovery. See `[[FILE-02]]`.

**WAND (Weak AND)** — FTS query algorithm that skips documents that cannot enter the top-k. See `[[FILE-08]]` §7.

**Wasmtime** — WebAssembly runtime used to host plugins safely. See `[[FILE-14]]`.

**Watch / Change stream** — Streaming subscription to changes in a collection. See `[[FILE-13]]` §3.7, `[[FILE-13]]` §8.

**WiredTiger** — MongoDB's default storage engine; cited for design comparisons (e.g., row-store + column-store hybrid lessons).

**WRITE_THROUGH** — Windows file flag forcing the OS to bypass write cache; pairs with `FlushFileBuffers` for durability. See `[[FILE-01]]` §11, `[[FILE-16]]` §4.

**XID / TxId** — 64-bit transaction identifier, monotonic per process. Tagged into MVCC version metadata. See `[[FILE-06]]` §3.

**Xmin / Xmax** — MVCC version metadata: `xmin_lsn` is the LSN that created the version; `xmax_lsn` is the LSN that obsoleted it. See `[[FILE-06]]` §4.

**Zigzag varint** — Signed-integer varint encoding mapping `n → (n << 1) ^ (n >> 63)`; pairs with LEB128. See `[[FILE-03]]` §3.

**Zstd / LZ4** — Block compression codecs. LZ4 = fast; Zstd = better ratio. See `[[FILE-11]]`.

---

*End of `19-GLOSSARY.md` — 320 lines.*
