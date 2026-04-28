# ADR-008 — LZ4 Default for Embedded, Zstd-3 for Server

**Status:** Accepted, 2026-04
**Owners:** Storage / compression
**Cross refs:** `[[FILE-11]]`

---

## Context

Pages, oplog batches, and backups can all be compressed. The choice of default codec affects:

1. **Latency** — decompress time on cache miss (read path).
2. **Throughput** — compress time on write path.
3. **Storage / bandwidth** — compression ratio.
4. **Footprint** — decoder library size (matters for WASM, mobile).
5. **CPU budget** — battery/thermals on mobile.

Codec families:

* **LZ4** — ~500 MB/s compress, ~3–4 GB/s decompress, ratio 2.0–2.4× on JSON.
* **Zstd-3** — ~250 MB/s, ~1.2 GB/s, ratio 3.0–3.5×.
* **Zstd-9 / -19** — much slower compress, same decompress speed, ratio 3.4–4.2×.
* **Specialty (Gorilla, FOR, Dict)** — column-specific, applied in hybrid columnar mode.

## Decision

Use **per-workload defaults**:

* Embedded / mobile / WASM → **LZ4**. Battery and decoder size win.
* Server / general → **Zstd-3**. Best balance of ratio and decompress cost.
* Cold archival / backups → **Zstd-9 or -19** (depending on time budget at backup).
* Time-series / numeric columns in columnar mode → **Gorilla/FOR/Dict** chains.

Engine probes data on first 100 pages and emits an info-level recommendation if a different codec would substantially improve ratio at acceptable CPU cost. Per-collection codec is user-overridable.

Dictionaries (Zstd-trained per collection) are auto-trained when collection size > 10k docs and projected gain > 20%. Page header carries 8-bit `dict_id` for forward/backward decode.

## Consequences

**Positive**

* Sensible default per profile; no manual tuning required for the common case.
* Page-header `codec_id` allows mixed codecs in the same collection during migration.
* Dictionary compression yields large gains on small JSON-ish docs without user effort.

**Negative**

* Two codec libraries shipped → larger binary.
* WASM bundles can opt out of Zstd (saves ~250 KiB).

## Alternatives considered

* **Zstd default everywhere** — rejected for embedded due to decoder size and decompress cost on cache miss.
* **Snappy** — rejected: lower ratio than LZ4, slower than LZ4 at similar ratios; less ecosystem traction.
* **Brotli** — rejected: too slow on decode for hot path.

## Open questions

* Hardware compression (Intel QAT/IAA) integration — v1.x candidate for cloud deployments.
* Per-page adaptive codec selection (rather than per-collection) — future research.

*End of ADR-008.*
