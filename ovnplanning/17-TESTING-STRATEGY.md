# 17 — TESTING STRATEGY

> **Audience:** Engine maintainers, QA, contributors adding tests.
> **Status:** Specification (target v0.1 baseline → v1.0 mature suite).
> **Cross refs:** `[[FILE-01]]`–`[[FILE-15]]` (subsystem invariants tested here), `[[FILE-16]]` build/CI.

---

## 1. Purpose

A database is judged by what it does **on the bad day**: power loss mid-fsync, a malicious oplog, a subtle race that costs an account balance. This document defines:

1. The **test pyramid** for Oblivinx3x.
2. **Required test categories**: unit, property, fuzz, integration, conformance, crash, concurrency, performance, chaos.
3. **Coverage targets** and **stop-the-merge** policy.
4. **How to add a new test** (rituals & fixtures).
5. **Test data corpora** and sources.

Testing is not a separate phase — every PR ships tests.

---

## 2. Test pyramid

```
                ▲   chaos  + soak  (rare, multi-hour)
              ◢━━━◣
            ◢ chaos ◣
          ◢━━━━━━━━━◣
         ◢  perf    ◣  performance & regression (nightly)
       ◢━━━━━━━━━━━◣
      ◢   crash    ◣   crash recovery (per PR for storage)
    ◢━━━━━━━━━━━━━◣
   ◢   concurrency ◣  TSan / ASan, multi-thread torture
 ◢━━━━━━━━━━━━━━━━◣
◢   integration   ◣   end-to-end across language bindings
━━━━━━━━━━━━━━━━━━━
◢   conformance   ◣   wire/protocol stability
━━━━━━━━━━━━━━━━━━━
◢   property/fuzz ◣   invariants under random inputs
━━━━━━━━━━━━━━━━━━━
◢                 ◣
◢      unit       ◣   per-module, fast, large numbers
━━━━━━━━━━━━━━━━━━━
```

Heuristic counts (target by v1.0):

| Layer        | Count | Run time per PR |
| ------------ | ----- | --------------- |
| Unit         | 4000+ | < 4 min         |
| Property     | 200+  | < 3 min         |
| Fuzz         | 30+   | < 4 min (CI smoke) |
| Integration  | 200+  | < 5 min         |
| Conformance  | 60+   | < 1 min         |
| Crash        | 80+   | < 6 min         |
| Concurrency  | 50+   | < 5 min         |
| Performance  | 30+   | < 8 min         |
| Chaos        | 10+   | nightly only    |

PR budget: ≤ 25 min per platform. Anything heavier moves to nightly.

---

## 3. Coverage targets

| Crate              | Line cov | Branch cov |
| ------------------ | -------- | ---------- |
| `ovn-format`       | 95%      | 90%        |
| `ovn-storage`      | 90%      | 80%        |
| `ovn-mvcc`         | 90%      | 80%        |
| `ovn-replication`  | 85%      | 75%        |
| `ovn-security`     | 90%      | 85%        |
| `ovn-query`        | 85%      | 75%        |
| `ovn-index`        | 85%      | 75%        |
| `ovn-fts`          | 80%      | 70%        |
| `ovn-vector`       | 80%      | 70%        |
| `ovn-oql`          | 90%      | 80%        |
| `ovn-plugin`       | 80%      | 70%        |
| (everything else)  | 75%      | 65%        |

PRs that drop a crate below its threshold by > 1% are blocked unless explicitly justified.

---

## 4. Unit tests

### 4.1 Conventions

* Name: `mod tests` inside the same file, OR sibling `tests.rs`.
* Test names follow `it_<does_something>` or `<api>_<scenario>_<expected>` style.
* Use `#[rstest]` for parametrized inputs.
* Fixtures live in `crates/ovn-test`; never re-implement.

### 4.2 Required categories per module

| Module surface  | Must test                                       |
| --------------- | ----------------------------------------------- |
| Public API      | Happy path + every documented error variant     |
| Pure decoders   | Round-trip + truncated input + corrupted bytes  |
| State machines  | Valid transitions + each invalid transition     |
| Math / hashing  | Determinism + boundary values                   |
| Comparators     | Reflexivity, antisymmetry, transitivity         |

### 4.3 Example skeleton

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rstest::rstest;
    use ovn_test::{tmp_engine, sample_doc};

    #[test]
    fn lwwregister_keeps_greatest_hlc() { /* ... */ }

    #[rstest]
    #[case::empty(b"")]
    #[case::truncated(b"OVN\x00")]
    #[case::garbage(&[0xff; 64])]
    fn obe_decode_rejects(#[case] input: &[u8]) {
        assert!(decode(input).is_err());
    }

    #[tokio::test]
    async fn insert_then_find_by_id_returns_doc() {
        let eng = tmp_engine().await;
        let coll = eng.database("t").unwrap().collection("c").unwrap();
        let id   = coll.insert_one(sample_doc()).await.unwrap().inserted_id;
        let got  = coll.find_by_id(id).await.unwrap().unwrap();
        assert_eq!(got, sample_doc().with_id(id));
    }
}
```

---

## 5. Property-based tests (proptest)

### 5.1 What to encode as properties

Anything that has a **mathematical invariant**:

* `decode(encode(x)) == x` for every codec / format.
* B-tree: `iterate_in_order(insert_sequence(perm)) == sort(perm)`.
* MVCC visibility: monotonic across snapshots.
* CRDT merge: associative, commutative, idempotent.
* Compression: `decompress(compress(x)) == x`.
* Plan equivalence: `output_set(plan(stmt)) == output_set(simple_eval(stmt))` over small sample DBs.

### 5.2 Strategies & shrinking

```rust
proptest! {
    #![proptest_config(ProptestConfig {
        cases: 256,
        max_shrink_iters: 10_000,
        .. ProptestConfig::default()
    })]

    #[test]
    fn obe_round_trip(doc in arb_document(8)) {
        let bytes = encode(&doc);
        let back  = decode(&bytes).unwrap();
        prop_assert_eq!(doc, back);
    }
}
```

`arb_document(depth)`, `arb_filter()`, `arb_pipeline()`, `arb_index_key()` are part of `ovn-test::strategies`.

### 5.3 Regression seeds

When a property fails, the failing seed is committed under `tests/regressions/<bug-id>.seed`. Future runs reload these explicitly (catches re-introductions).

---

## 6. Fuzz tests (cargo-fuzz)

Fuzz targets enumerated in `[[FILE-16]]` §7. Each target:

* Lives at `crates/<crate>/fuzz/fuzz_targets/<target>.rs`.
* Uses libFuzzer + AFL++ via `cargo-fuzz`.
* Has a starter corpus in `crates/<crate>/fuzz/corpus/<target>/`.
* Records crashes in `crates/<crate>/fuzz/artifacts/<target>/`.

Required behaviours under fuzz:

* No panics from valid public API entry points except documented error cases.
* No memory unsafety (sanitizer must stay clean).
* No infinite loops (fuzzer enforces timeout = 30 s).

OSS-Fuzz integration target: v0.6.

---

## 7. Integration tests

Cover **API boundaries** end-to-end.

### 7.1 Rust integration

`tests/integration/<scenario>.rs` (top-level, not crate-local). Example:

```rust
#[tokio::test]
async fn restore_from_snapshot_then_replay_oplog() {
    let primary = open_temp_engine();
    let coll    = primary.collection("orders");
    coll.insert_many(seed_docs(1000)).await.unwrap();
    let snap_path = primary.snapshot("snap.ovnsnap").await.unwrap();

    coll.insert_many(seed_docs(50)).await.unwrap();
    let oplog_path = primary.export_oplog("oplog.bin").await.unwrap();

    // Drop and restore
    let restored = restore(snap_path, oplog_path).await.unwrap();
    let count = restored.collection("orders").count(filter!{}).await.unwrap();
    assert_eq!(count, 1050);
}
```

### 7.2 Cross-language (Node.js)

`tests/integration/engine.test.js`:

```javascript
import { Engine } from "oblivinx3x";
import { tmpdir } from "os";
import { join } from "path";

const path = join(tmpdir(), `it-${Date.now()}.ovn2`);
const eng  = await Engine.open(path);

const users = eng.database("t").collection("users");
await users.insertOne({ name: "Ada" });
const got = await users.findOne({ name: "Ada" });
console.assert(got?.name === "Ada");

await eng.shutdown();
```

Run via `node --test`.

### 7.3 REST integration

Brought up in CI by `scripts/ci/start-ovnsd.sh`; tests under `tests/integration/rest/` use `reqwest` + `ovn-test::http_helpers`.

---

## 8. Conformance tests

Locked-down golden outputs for **wire/format stability**:

| Suite                   | What it validates                                  |
| ----------------------- | -------------------------------------------------- |
| `obe_golden`            | OBE bytes for canonical doc shapes                 |
| `wal_record_golden`     | Each WAL record type byte layout                   |
| `oplog_entry_golden`    | OplogEntry layout                                  |
| `index_key_golden`      | Composite key encoding                             |
| `oql_parse_golden`      | AST JSON for canonical OQL strings                 |
| `explain_golden`        | EXPLAIN JSON shape                                 |
| `plugin_abi_golden`     | Exported function signatures + ABI version         |

Golden files live in `tests/golden/`. Mismatches break CI; fixing requires:

1. Inspecting the diff (intentional vs accidental).
2. Updating the golden file with the change.
3. Bumping the format/wire version per `[[FILE-13]]` §11.

---

## 9. Crash recovery tests

The engine must survive **arbitrary** crash points. Strategy:

### 9.1 Fault injection points

`ovn_storage::test_hooks` exposes deterministic injection (only enabled with `--features="test-hooks"`):

```rust
pub fn fail_after(operation: FailOp, after_n: usize);
pub fn fail_with_torn_write(bytes_to_write: usize);  // simulates partial write
pub fn fail_fsync_with(error_code: i32);
```

### 9.2 Test recipe

```rust
#[test]
fn recovery_after_torn_write_in_wal() {
    let dir = tempdir();
    let mut e1 = Engine::open(dir.path(), opts()).unwrap();
    e1.collection("t").insert_one(doc!{"x": 1}).unwrap();

    test_hooks::fail_with_torn_write(64);
    let r = e1.collection("t").insert_one(doc!{"x": 2});
    assert!(r.is_err());
    drop(e1);                       // simulate crash

    let e2 = Engine::open(dir.path(), opts()).unwrap();
    let docs = e2.collection("t").find(filter!{}).collect().unwrap();
    // Either both docs present (commit succeeded before tear)
    //  or only the first (commit aborted by tear)
    // Never an in-between state
    assert!(matches!(docs.len(), 1 | 2));
    assert!(docs.iter().any(|d| d.get_int("x") == Some(1)));
}
```

### 9.3 Required scenarios

* Torn write of: page 0, B-tree leaf, B-tree internal, WAL header, WAL record, oplog segment.
* Crash mid-checkpoint (passive, full).
* Crash mid-flush (memtable → SST).
* Crash mid-compaction.
* Crash during MVCC vacuum.
* Crash during index build.
* Crash during plugin migration.
* Crash with WAL beyond retention.
* Crash with replication snapshot in flight.

Each scenario asserts: open succeeds OR fails with `OvnError::Corruption` (never silent data loss).

### 9.4 Hardware-accurate fault injection (optional)

`scripts/test/dm-flakey.sh` (Linux): wraps the test data dir in a `dm-flakey` device that drops writes per schedule. Run nightly to exercise real kernel-path failures.

---

## 10. Concurrency / race tests

### 10.1 ThreadSanitizer

Required green for:

* `ovn-storage` (buffer pool, WAL group commit)
* `ovn-mvcc` (visibility, vacuum)
* `ovn-replication` (peer state machines)
* `ovn-plugin` (instance pool)

CI invokes via `RUSTFLAGS="-Zsanitizer=thread" cargo +nightly test --target x86_64-unknown-linux-gnu`.

### 10.2 Loom tests

`loom` exhaustively explores interleavings for tiny critical sections.

```rust
#[cfg(loom)]
mod loom_tests {
    use loom::thread;
    use loom::sync::atomic::{AtomicU64, Ordering::*};

    #[test]
    fn pin_unpin_does_not_leak() {
        loom::model(|| {
            let pin = std::sync::Arc::new(AtomicU64::new(0));
            let p1 = pin.clone();
            let h = thread::spawn(move || { p1.fetch_add(1, AcqRel); });
            pin.fetch_sub(1, AcqRel);
            h.join().unwrap();
            // Net == 0 must hold from any interleaving
            assert_eq!(pin.load(Acquire), 0);
        });
    }
}
```

Run with: `RUSTFLAGS="--cfg loom" cargo test loom`.

### 10.3 Stress / torture suites

`tests/stress/`:

* `concurrent_writers_stress.rs` — N writers, M readers, T seconds.
* `txn_conflict_stress.rs` — intentional conflict pile-up; verify no lost commit, no phantom commit.
* `vacuum_under_load.rs` — vacuum runs while writers churn.
* `replication_chaos.rs` — random peer kill/restart with concurrent writes.

Each runs for `STRESS_DURATION` (default 30 s in CI, 30 min nightly).

---

## 11. Performance & regression tests

### 11.1 Benchmarks (Criterion)

Each crate has `benches/`:

| Bench                       | Crate          | Measures                          |
| --------------------------- | -------------- | --------------------------------- |
| `obe_encode_decode`         | ovn-format     | µs/doc                            |
| `wal_append_throughput`     | ovn-storage    | MiB/s                             |
| `btree_insert_lookup`       | ovn-storage    | ops/s                             |
| `mvcc_visibility_check`     | ovn-mvcc       | ns/check                          |
| `query_planner_select`      | ovn-query      | µs/plan                           |
| `aggregate_pipeline_stages` | ovn-query      | rows/s per stage                   |
| `fts_query_bm25`            | ovn-fts        | qps                               |
| `vector_hnsw_search`        | ovn-vector     | qps + recall@10                   |
| `compress_lz4_zstd`         | ovn-storage    | MB/s                              |

### 11.2 Regression detection

CI compares Criterion JSON to `benches/baseline.json`:

* Throughput regressions > 10%: warn.
* Throughput regressions > 25%: block PR.
* Latency P99 regressions > 25%: block.

Baseline updated on tagged release.

### 11.3 Macro benchmarks

`benches/macro/` contains realistic workloads:

* TPC-C-lite (write-heavy OLTP).
* YCSB workloads A/B/C/D/E/F (configurable read/write mix).
* Vector search w/ Wikipedia embeddings (sift-128 or local).
* FTS over Wikipedia 1M docs.

Run weekly; results published to `bench.oblivinx.dev` over time.

---

## 12. Chaos & soak tests

Run only in nightly + ad-hoc.

### 12.1 Jepsen-style (where applicable)

Linearizability checks for replication:

* Setup: 3-node cluster + Knossos client.
* Workload: single-key counter, list-append, register.
* Faults: process kill, network partition, clock skew.
* Verify: history is linearizable (or at least snapshot-isolated, depending on config).

### 12.2 Chaos toolkit

`scripts/chaos/`:

* `kill-random-node.sh`
* `partition-network.sh`
* `slow-disk.sh` (cgroups blkio throttle)
* `clock-jump.sh` (libfaketime)

Jepsen-equivalent runs scheduled monthly; each release candidate must pass.

### 12.3 Soak tests

24 h continuous-write soak with replication enabled. Pass criteria:

* No crashes.
* No memory growth beyond `+ 5%` of steady-state.
* No replication lag > 60 s for > 5 min.
* No file handle leaks.

---

## 13. Test fixtures (`ovn-test`)

Single home for shared helpers; reduces boilerplate.

```rust
pub async fn tmp_engine() -> Engine { /* tempfile + open with fast options */ }
pub async fn tmp_engine_with(opts: EngineOptions) -> Engine { ... }

pub fn sample_doc() -> Document { doc! { "name": "Ada", "age": 37 } }
pub fn many_docs(n: usize) -> Vec<Document> { (0..n).map(|i| doc! { "i": i }).collect() }

pub mod strategies {
    pub fn arb_value(depth: u32) -> impl Strategy<Value = Value>;
    pub fn arb_document(depth: u32) -> impl Strategy<Value = Document>;
    pub fn arb_filter() -> impl Strategy<Value = Filter>;
    pub fn arb_pipeline() -> impl Strategy<Value = Pipeline>;
    pub fn arb_oplog_entry() -> impl Strategy<Value = OplogEntry>;
}

pub mod golden {
    pub fn assert_matches(name: &str, actual: &impl Serialize) -> Result<(), GoldenError>;
    /* re-bless via OVN_BLESS=1 cargo test */
}

pub mod hooks {
    pub fn fail_after(...);
    pub fn deterministic_clock(start_ms: u64);
}
```

---

## 14. Test data corpora

| Corpus                  | Size      | Source                                     | Used by                    |
| ----------------------- | --------- | ------------------------------------------ | -------------------------- |
| `corpus/wiki-1m.jsonl`  | ~2 GiB    | en.wiki dump excerpt                       | FTS bench, fuzz seeds      |
| `corpus/sift-128`       | 1M vec    | TEXMEX SIFT                                | vector bench               |
| `corpus/yelp-reviews`   | ~5 GiB    | Yelp Open Dataset                          | aggregation bench          |
| `corpus/openalex`       | optional  | OpenAlex API                               | hybrid search bench        |
| `corpus/randomized`     | n/a       | proptest strategies                        | unit / fuzz                |

Corpora are NOT committed; downloaded by `scripts/test/fetch-corpora.sh`. CI mounts them from a cache.

---

## 15. CI integration

Per `[[FILE-16]]` §8:

* PR: unit + property + 60s/target fuzz + integration + conformance + critical crash + TSan smoke + regression baseline.
* Nightly: full fuzz (1 h/target) + sanitizers (ASan, MSan, TSan, LSan, LeakSan) + coverage + soak (1 h) + chaos.
* Weekly: 24 h soak + Jepsen.
* Pre-release: full chaos suite + macro benches + reproducible build verification.

Failures block merge / release as defined.

---

## 16. Tradeoffs

| Decision                                  | Chosen                          | Alternative              | Why                              |
| ----------------------------------------- | ------------------------------- | ------------------------ | -------------------------------- |
| Property tests vs full enumeration        | Proptest (random + shrinking)   | hypothesis-style                          | Mature crate, great UX           |
| Fault injection in test build only        | `--features test-hooks`         | always present           | No prod overhead                  |
| Loom for explicit interleaving            | Yes, narrow scope               | TSan only                | Loom finds rare orderings        |
| Criterion as bench tool                   | Yes                             | iai (callgrind)          | More flexible, HTML reports      |
| Golden snapshot bless workflow            | `OVN_BLESS=1`                   | manual                   | Catches accidental drift          |
| Jepsen-style external                     | Adapted                         | Build from scratch       | Ecosystem & precedent            |

---

## 17. Open questions & future

* **Differential testing** vs SQLite/Mongo for MQL semantics overlap.
* **Symbolic execution** (KLEE-style) for serialization paths.
* **Continuous fuzzing infra** beyond OSS-Fuzz (e.g., per-PR fuzz time budgets via Mayhem).
* **Auto-generated OQL test suites** from grammar.
* **"Ten-thousand-PR shadow"** — replay random PRs from a public corpus as integration smoke.

---

## 18. Cross-references

* `[[FILE-01]]` invariants ↔ §9 crash tests.
* `[[FILE-02]]` WAL ↔ §9.3 torn-write recipes.
* `[[FILE-06]]` MVCC ↔ §10.2 loom tests.
* `[[FILE-09]]` replication ↔ §12.1 Jepsen.
* `[[FILE-13]]` API ↔ §7 integration.
* `[[FILE-15]]` OQL ↔ §8 conformance for parser.
* `[[FILE-16]]` CI matrix is consumer of this strategy.

*End of `17-TESTING-STRATEGY.md` — 460 lines.*
