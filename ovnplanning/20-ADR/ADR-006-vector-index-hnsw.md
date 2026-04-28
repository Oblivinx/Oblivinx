# ADR-006 — HNSW for the Vector Index

**Status:** Accepted, 2026-04
**Owners:** Vector / index subsystem
**Cross refs:** `[[FILE-04]]` §6, `[[FILE-08]]` §9

---

## Context

The engine needs an approximate-nearest-neighbor (ANN) index that:

1. Achieves recall ≥ 0.95 at top-10 on standard benchmarks (SIFT-1M, GIST-1M).
2. Supports incremental insert and delete (delete handled via tombstones + periodic rebuild).
3. Works well with hybrid filtered search (filters that drop ≥ 99% of corpus).
4. Has a manageable memory footprint with quantization options.
5. Lives in the same `.ovn2` file (no external service).

Candidates:

* **HNSW (Malkov & Yashunin 2016)** — graph-based; widely deployed; great recall vs latency.
* **IVF / IVF-PQ (FAISS)** — partition-based; tunable; weaker on small datasets.
* **NSG (Navigating Spreading-out Graph)** — variant of HNSW with similar tradeoffs.
* **DiskANN** — graph + on-disk; for very large indexes; immature in Rust ecosystem.
* **ScaNN** — research-leading recall; limited Rust availability.

## Decision

Adopt **HNSW** as the primary vector index. Parameters (defaults):

* `M` = 16, `M_max0` = 32 at layer 0.
* `ef_construction` = 200; `ef_search` tunable per query (default 64).
* Distance: cosine similarity (default), L2, dot product.
* Quantization tiers: None (f32), Float16, INT8 (uniform per-vector), RaBitQ (1-bit per dim) — selectable per-collection.

Index pages live in the same file as everything else; HNSW edges encoded as page-local arrays plus overflow pages for high-degree nodes.

Filtered ANN strategy:

* If filter selectivity > 1%: post-filter (search ANN, then drop non-matches).
* If filter selectivity ≤ 1%: pre-filter then exact search over the small set.
* Threshold tunable; planner picks based on stats.

## Consequences

**Positive**

* Best recall/latency tradeoff for the most workloads.
* Mature literature; Rust crates and reference implementations to study.
* Quantization tiers let memory scale from "all in RAM" to "fits a small partition".

**Negative**

* Build cost is O(N · ef · log N).
* Deletes are tombstone-based; periodic rebuild needed to reclaim graph quality.
* Memory overhead = neighbor pointers (~64 bytes/vec at M=16).

## Alternatives considered

* **IVF-PQ** — better for very large static corpora; rejected as primary because incremental updates are awkward.
* **DiskANN** — promising for huge cold indexes; revisit post-1.0 as a complementary index type.

## Open questions

* Should we expose `M`/`ef` as collection-level config or per-query override?
* GPU-accelerated build path (CUDA/Metal) — post-1.0.

*End of ADR-006.*
