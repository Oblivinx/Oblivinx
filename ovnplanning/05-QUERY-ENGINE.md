# 05 — QUERY ENGINE

> Lexer, parser, semantic analyzer, cost-based planner, and executor for
> OQL/MQL queries in Oblivinx3x. The full grammar (EBNF) is in
> `[[FILE-15]]`. For index usage see `[[FILE-04]]`; for MVCC visibility
> rules see `[[FILE-06]]`.

---

## 1. Purpose

The query engine accepts queries in three surface syntaxes, all of which
lower to the same internal AST and execution plan:

1. **MQL** (Mongo-style document predicates and aggregation pipelines).
2. **OQL** (Oblivinx Query Language — declarative, SQL-flavored, see
   `[[FILE-15]]`).
3. **DSL** (programmatic query builder via SDK; e.g. `coll.find({...}).sort()`).

Pipeline:

```
   surface text          surface JSON          builder calls
        │                     │                     │
        ▼                     ▼                     ▼
   ┌──────────┐         ┌──────────┐          ┌──────────┐
   │ OQL Lex  │         │ MQL JSON │          │ DSL→AST  │
   │ + Parse  │         │  Parser  │          │ Adapter  │
   └────┬─────┘         └────┬─────┘          └────┬─────┘
        ▼                    ▼                     ▼
        ───────────► Logical AST ◄─────────────────
                          │
                          ▼
                  Semantic Analysis
                  (type, index, schema check)
                          │
                          ▼
                    Logical Plan
                          │
                          ▼     rewrite rules
                  Optimized Logical Plan
                          │
                          ▼     cost model + index pick
                    Physical Plan
                          │
                          ▼     codegen / interpret
                Executor (Volcano + vectorized hybrid)
                          │
                          ▼
                     Result rows
```

---

## 2. Lexer

### 2.1 Token kinds

```
Identifier         [A-Za-z_][A-Za-z0-9_]*
QuotedIdent        backtick (`...`) — allows reserved words as names
Integer            [0-9]+   (parsed as i64)
Float              [0-9]+ "." [0-9]+ (e[+-]?[0-9]+)?
StringLit          '...' or "..." with backslash escapes
JsonObjectLit      starts with '{' — sub-parsed as JSON
RegexLit           '/.../' with flags
Punctuation        ( ) [ ] { } , ; : .
Operator           + - * / % == != < <= > >= && || ! & | ^ ~ << >>
Keyword            FIND IN WHERE GROUP BY ORDER LIMIT OFFSET PROJECT
                   INSERT UPDATE DELETE WATCH AGGREGATE BEGIN COMMIT
                   ROLLBACK EXPLAIN PRAGMA INDEX CREATE DROP UNIQUE
                   PARTIAL TTL VECTOR FULLTEXT GEO HNSW MATCH ON
                   AS WITH RECURSIVE LATERAL JOIN LEFT INNER ON
                   IF EXISTS NOT DISTINCT ALL ANY SOME UNION
EOF
```

### 2.2 Operator precedence (highest → lowest)

```
1.  unary  ! ~ -
2.  *  /  %
3.  +  -
4.  <<  >>
5.  &
6.  ^
7.  |
8.  <  <=  >  >=
9.  ==  !=  IS  IS NOT  LIKE  IN  NIN
10. AND  &&
11. OR   ||
12. ternary ? :
```

### 2.3 Lexer implementation

Hand-written DFA in `crates/ovn-core/src/query/lex.rs`. Properties:

- Single-pass, O(n).
- Returns `Vec<Token>` with span (`(line, col, byte_offset)`).
- UTF-8 aware identifiers (ICU XID_Continue subset).
- Errors carry source span for IDE-friendly diagnostics.

---

## 3. Parser

Recursive-descent, predictive (LL(1) for most rules; LL(2) for
expression context). Lives in `crates/ovn-core/src/query/parse.rs`.

### 3.1 AST node types

```rust
pub enum Stmt {
    Find(FindStmt),
    Insert(InsertStmt),
    Update(UpdateStmt),
    Delete(DeleteStmt),
    Aggregate(AggregateStmt),
    Watch(WatchStmt),
    Pragma(PragmaStmt),
    CreateIndex(CreateIndexStmt),
    DropIndex(DropIndexStmt),
    Begin(BeginStmt),
    Commit(CommitStmt),
    Rollback(RollbackStmt),
    Savepoint(SavepointStmt),
    Explain(Box<Stmt>),
}

pub struct FindStmt {
    pub collection: Ident,
    pub filter: Option<Expr>,
    pub projection: Option<Projection>,
    pub sort: Option<Vec<SortKey>>,
    pub limit: Option<u64>,
    pub skip: Option<u64>,
    pub hint: Option<IndexHint>,
}

pub enum Expr {
    Path(PathExpr),                 // a.b.c
    Literal(LiteralValue),
    Compare(Box<Expr>, CmpOp, Box<Expr>),
    Logical(LogicalOp, Vec<Expr>),  // and/or/nor over N children
    Element(ElementOp, PathExpr),   // exists / type
    Array(ArrayOp, PathExpr, Box<Expr>),
    Text(TextOp, String, TextOpts),
    Regex(PathExpr, RegexLit),
    Geo(GeoOp, PathExpr, GeoArg),
    Bitwise(BitOp, PathExpr, u64),
    InList(PathExpr, Vec<LiteralValue>),
    Subquery(Box<Stmt>),
    UpdateOp(UpdateOp, PathExpr, Box<Expr>),
    Function(FunctionCall),
    Vector(VectorOp, PathExpr, VectorArg),
}

pub struct AggregateStmt {
    pub collection: Ident,
    pub stages: Vec<PipelineStage>,
}

pub enum PipelineStage {
    Match(Expr),
    Project(Projection),
    AddFields(BTreeMap<String, Expr>),
    Group { id: GroupKey, accumulators: Vec<Accumulator> },
    Sort(Vec<SortKey>),
    Limit(u64),
    Skip(u64),
    Unwind(UnwindSpec),
    Lookup(LookupSpec),
    Count(String),
    Bucket(BucketSpec),
    Facet(BTreeMap<String, Vec<PipelineStage>>),
    ReplaceRoot(Expr),
    Out(String),
    Merge(MergeSpec),
}
```

### 3.2 Parsing strategy

Top level dispatches on first keyword (`FIND`, `INSERT`, etc.).
Expressions parsed via Pratt parser with precedence table from §2.2.

Path expressions (`a.b.c`) handled specially — dots can be field
separator or float literal; the lexer already disambiguates numeric
tokens.

### 3.3 Error recovery

On a parse error, the parser:

1. Records the error with source span.
2. Skips to the next statement-level synchronization token (`;` or
   end-of-input).
3. Continues parsing remaining statements (batch resilience).

---

## 4. Semantic Analysis

Performed on the AST before planning. Checks:

1. **Collection exists** — looked up in metadata catalog.
2. **Field path types** — compared against schema histogram (best
   effort; missing fields warn but allow).
3. **Operator type compatibility** — e.g. `$inc` requires numeric.
4. **Index hints** — verify hinted index covers the spec.
5. **Aggregation stage ordering** — `$out`/`$merge` only at end;
   `$lookup`'s `from` collection must exist.
6. **Permissions** — RBAC roles permit operation on collection
   (`[[FILE-07]]` §5).

Returns a `SemanticError` with span; otherwise emits a
`LogicalPlan` decorated with type info.

---

## 5. Logical Plan and Rewrite Rules

A logical plan is a tree of operators:

```
Scan(collection)
Filter(pred)
Project(fields)
Sort(keys)
Limit(n)
HashAgg(group_keys, aggs)
StreamAgg(group_keys, aggs)
NestedLoopJoin(left, right, on)
HashJoin(left, right, on)
MergeJoin(left, right, on)
Lookup(left, foreign_coll, foreign_field, local_field)
Unwind(path, options)
TopK(sort_keys, n)
Window(partition, order, frame, agg)
SubqueryScalar(subq)
Watch(predicate)
```

### 5.1 Rewrite rules (applied repeatedly until fixed-point)

| Rule                          | Description                                       |
|-------------------------------|---------------------------------------------------|
| Constant folding              | `Filter(2 + 3 == 5)` → `Filter(true)` → drop.    |
| Predicate pushdown            | Move `Filter` below `Project`/`Lookup`.          |
| Limit pushdown                | `Limit(N) ∘ Sort(K)` → `TopK(N,K)` (priority queue). |
| Dead-code elimination         | Drop `Project` with same fields as parent.       |
| Lookup-to-join                | `$lookup` with equality on indexed field → HashJoin. |
| Unwind-fold                   | `Unwind` over array followed by `$match` on element → `$match` first when index. |
| `$elemMatch` flattening       | Reduce to nested ANDs when single-pred.          |
| Common subexpression          | Extract repeated sub-expressions to scalar vars. |
| `$or` → IndexUnion            | If each branch hits an index, plan as union.     |
| `$or` → IndexIntersect        | If predicate is `$and`, intersect index hits.    |
| Distinct sort elimination     | `DISTINCT` over already-sorted index → no sort.  |

Implementation: `crates/ovn-core/src/query/rewrite.rs` — each rule is a
visitor returning `Option<LogicalPlan>` (None = no change).

---

## 6. Cost Model

The planner estimates cost in **abstract cost units**, then assigns
real-time weights at compile (configurable for hardware tuning).

### 6.1 Cost components

```rust
pub struct Cost {
    pub cpu: f64,        // per-row CPU work
    pub io: f64,         // page reads + writes
    pub memory: f64,     // peak memory in bytes
    pub network: f64,    // bytes shipped (replication / lookup)
}
```

Total cost: `cpu_weight * cpu + io_weight * io + memory_weight * mem`.
Defaults: `cpu_weight = 1.0`, `io_weight = 50.0`, `memory_weight = 0.001`.

### 6.2 Cardinality estimation

Per-stage row count estimate:

- **Scan(coll):** `coll.row_count`.
- **Filter(pred):** `input * selectivity(pred)`.
- **Sort, Limit:** `min(input, limit)` for limit; full input for sort.
- **HashAgg:** `n_distinct(group_keys)` (from histogram).
- **Join:** `(left * right) * selectivity(on)`.
- **Lookup with index:** `left * avg_match_per_key`.
- **Unwind:** `input * avg_array_length` (from schema).

Selectivity for predicates uses the histogram (see `[[FILE-04]]` §16):

```
P(field = c)        ≈ histogram_bucket(c).cumulative_freq / total
P(field <= c)       ≈ cumulative_freq_up_to(c) / total
P(field IN list)    ≈ sum_i histogram(list[i]) / total  (capped at 1)
P(A and B)          ≈ P(A) * P(B)            # independence assumption
P(A or B)           ≈ P(A) + P(B) - P(A)*P(B)
```

For string LIKE / regex: 0.10 default unless histogram provides info.

### 6.3 Index cost

```
PointLookup(idx, key):
    cost.io  = idx.depth        # tree height
    cost.cpu = idx.depth * COMPARISON_COST

RangeScan(idx, lo, hi):
    keys     = estimated_keys_in_range(idx, lo, hi)
    cost.io  = idx.depth + (keys / idx.keys_per_leaf)
    cost.cpu = keys * COMPARISON_COST

CoveredIndexScan: as RangeScan but no doc fetch
CollectionScan:   io = coll.pages, cpu = coll.row_count * FILTER_COST
```

### 6.4 Plan enumeration

For each logical plan:

1. Enumerate index combinations covering each predicate.
2. For each candidate physical plan, compute Cost.
3. Pick minimum cost.

We use **bottom-up DP** (Selinger-style) for join ordering with `n ≤ 8`
relations; greedy for larger.

---

## 7. Index Selection Algorithm

```text
choose_index(coll, predicate, projection, sort):
    candidates = list_all_indexes(coll)
    plans = []
    for idx in candidates:
        match = match_index_to_predicate(idx, predicate)
        if match is None: continue
        scan_kind = decide_scan_kind(match)   # point / range / multi
        cost = cost_index_scan(idx, scan_kind)
        if covered(query, idx): plan = CoveredIndexScan
        else: plan = IndexScan + Fetch
        plans.push(plan, cost)
    plans.push(CollectionScan, cost_full_scan(coll))
    return min_cost(plans)
```

Multi-index strategies (planned v0.6):

- **Index intersection:** `{a:1, b:1}` AND `{c:1, d:1}` for predicate
  on `a`, `c` → intersect doc-id sets.
- **Index union:** `$or` branches each on a different index.

Hint override: explicit `hint(index_name)` skips cost-based selection.

---

## 8. Execution Model

Hybrid Volcano (iterator) + vectorized batch execution.

### 8.1 Iterator interface

```rust
pub trait Operator {
    fn open(&mut self, ctx: &mut ExecCtx) -> Result<(), OvnError>;
    fn next_batch(&mut self) -> Result<Option<RowBatch>, OvnError>;
    fn close(&mut self) -> Result<(), OvnError>;
}
```

### 8.2 RowBatch

A batch is a column-oriented view of up to 1024 rows:

```rust
pub struct RowBatch {
    pub n_rows: usize,
    pub columns: Vec<ColumnVec>,   // by index in projection order
    pub validity: BitVec,          // null bitmap
    pub doc_ids: Option<Vec<ObjectId>>,
}
```

For point queries, batch size collapses to 1; for full scans, 1024
(matches LLVM SIMD width × 16).

### 8.3 Operator implementations

- **Scan / IndexScan:** prefetch next page asynchronously while
  decoding current page.
- **Filter:** SIMD-vectorized predicate evaluator for simple
  comparisons; falls back to interpreter for complex.
- **HashAgg:** open-addressed hash table, spill to disk when memory
  exceeds `pragma hash_agg_memory_bytes`.
- **Sort:** introsort in memory, external merge sort if spill.
- **TopK:** binary heap of size K.
- **Join:** HashJoin builds hash on smaller side; MergeJoin requires
  both inputs sorted; NestedLoop fallback.
- **Lookup:** when foreign side has matching index → IndexNestedLoop
  with prefetch.
- **Unwind:** state machine yielding one batch per array element.

### 8.4 Memory management

Each operator declares an estimated memory budget. The executor enforces
total memory via a per-query `MemTracker`:

```rust
ctx.mem.charge(bytes)?;        // returns Err if would exceed
ctx.mem.release(bytes);        // on operator close
```

Spill triggers:

- **HashAgg:** writes overflow rows to a temp page chain via
  `PAGE_TYPE_DOCUMENT_HEAP`.
- **Sort:** writes runs to temp file, k-way merges.

Spill files are anonymous (created/deleted in the WAL region's
"scratch" zone) and never enter the WAL.

---

## 9. Aggregation Pipeline

Implementation per stage.

### 9.1 `$match`

Compiles into `Filter(pred)`. Pushed down to `Scan`/`IndexScan` when
possible.

### 9.2 `$project` / `$addFields` / `$replaceRoot`

Compile into `Project(spec)`. The OBE projection algorithm
(`[[FILE-03]]` §7) applies; `$addFields` extends the doc, `$project`
restricts, `$replaceRoot` overwrites.

### 9.3 `$sort`

Compiles into `Sort(keys)`. If preceded by `$limit`, planner rewrites
to `TopK`.

### 9.4 `$limit` / `$skip`

Trivial; pushed down toward the scan when safe.

### 9.5 `$group`

Compiles into `HashAgg(group_keys, accumulators)`. Accumulators:

```
$sum, $avg, $min, $max, $first, $last, $push, $addToSet, $count,
$stdDevPop, $stdDevSamp, $mergeObjects, $accumulator (custom),
$top, $bottom, $topN, $bottomN, $minN, $maxN
```

For `$group: { _id: null }` (single bucket), use a streaming
accumulator without hash table.

### 9.6 `$unwind`

Yields one row per array element. Supports `preserveNullAndEmptyArrays`
and `includeArrayIndex` options.

### 9.7 `$lookup`

Inner join semantics by default. Compiles to:

- `IndexNestedLoop` if foreign collection has matching index.
- `HashJoin` if no index but build-side fits memory.
- Reject otherwise (planner emits warning to add an index).

`pipeline` form (sub-pipeline lookup) compiles the sub-pipeline as a
correlated subquery.

### 9.8 `$count`

Simple counter; compiles to `HashAgg({}, [{count: $sum: 1}])` then
`Project({field_name: count})`.

### 9.9 `$facet`

Runs N sub-pipelines on the *same* input. We materialize the input once
(if from a Scan) into a temp result set, then pipe to each sub-pipeline.

### 9.10 `$bucket` / `$bucketAuto`

Maps each row to a bucket then applies accumulators per bucket. Bucket
boundaries are pre-sorted; row-to-bucket is binary search.

### 9.11 `$out` / `$merge`

Side-effect stages: write results back to a (possibly different)
collection. Requires write transaction (acquired implicitly).

---

## 10. Reactive Queries (Watch)

### 10.1 Concept

A **reactive query** subscribes to a query result; the engine pushes a
**diff** (added / changed / removed rows) when underlying data changes.

```
db.users.watch({status: "active"}, callback);
```

### 10.2 Implementation

1. **Initial materialization:** run the query, store result set with
   doc ids (memory: bounded by `pragma watch_max_rows`).
2. **WAL tail:** the watch operator subscribes to the WAL (per
   `[[FILE-02]]` §14 `WalReader::follow`) for records affecting the
   collection.
3. **Differential evaluation:** for each WAL record:
   - If a new doc matches the filter → emit `Added`.
   - If a now-matching doc no longer matches → emit `Removed`.
   - If a matching doc's projection fields changed → emit `Changed`.
4. **Incremental View Maintenance:** for aggregations, we use a DBSP-
   style differential computation over `$group`, `$sort`, `$limit`;
   see `[[FILE-09]]` §7 for state representation.

### 10.3 Backpressure

If the consumer is slow, the watcher buffers up to `pragma watch_buffer`
(default 1024) events. Beyond that, the watcher errors with
`WatchOverflow` and the consumer must re-materialize.

---

## 11. EXPLAIN Output

`EXPLAIN <query>` returns a JSON tree:

```json
{
  "plan": "TopK",
  "n": 10,
  "sort_keys": ["age"],
  "estimated_rows": 10,
  "estimated_cost": 124.5,
  "actual_rows": null,
  "actual_time_us": null,
  "child": {
    "plan": "IndexScan",
    "index": "users_age_1",
    "bounds": "[\"$gt\", 30]",
    "estimated_rows": 1500,
    "estimated_cost": 80.0,
    "covered": false,
    "child": null
  }
}
```

Variants:

- `EXPLAIN PLAN` — estimates only (default).
- `EXPLAIN ANALYZE` — runs the query and fills `actual_*`. Side-effects
  are still committed for `INSERT`/`UPDATE`/`DELETE`.
- `EXPLAIN VERBOSE` — adds per-operator memory and IO statistics.

---

## 12. Prepared Statements

The query engine caches parsed AST + logical plan (and optionally
physical plan) keyed by query template. Parameter placeholders use
`$1`, `$2`, … syntax.

```rust
pub struct PreparedStatement {
    pub template_hash: u64,
    pub ast: Stmt,
    pub plan: Option<PhysicalPlan>,
    pub plan_invalid_after_lsn: u64,   // re-plan if catalog mutated
}
```

LRU cache size: `pragma prepared_cache_size` default 256 entries per
session.

---

## 13. Error Handling

All query phases return `Result<_, OvnError>` per `crates/ovn-core/src/error.rs`.
Categories:

```rust
pub enum QueryError {
    LexError { msg: String, span: Span },
    ParseError { msg: String, span: Span, expected: Vec<&'static str> },
    SemanticError { msg: String, span: Option<Span> },
    PlanError { msg: String },
    ExecError { msg: String, op: &'static str },
    Cancelled,
    Timeout,
    MemoryLimit,
    Permission { user: String, action: String, resource: String },
}
```

Errors carry source span where possible for editor diagnostics.

---

## 14. Tradeoffs and Alternatives Considered

| Choice                  | Picked                | Considered            | Why we picked     |
|-------------------------|-----------------------|-----------------------|-------------------|
| Surface language        | OQL + MQL + DSL       | SQL only              | Doc model + dev ergonomics. |
| Engine model            | Volcano + vectorized  | Pure Volcano / pure vectorized | Best of both for embedded. |
| Optimizer               | Cost-based (Selinger) | Rule-only             | Joins need cost. |
| Statistics              | Equi-depth histogram  | Sampling only         | Better selectivity. |
| Plan caching            | Yes                   | Always re-plan        | Latency win for hot queries. |
| Parallel execution      | No (v1.0)             | Yes                   | Embedded; defer. |
| External LIKE           | regex2 (planned v0.6) | naive scan            | 10× faster for complex patterns. |

---

## 15. Open Questions

1. **Vectorized evaluation by default.** Currently, batch size is
   adaptive but `Filter` always falls back to interpreter for OBE
   types. A typed-column path could push to 10× throughput on large
   scans. Track for v0.6 alongside columnar storage.
2. **Adaptive query execution.** Re-plan mid-execution when cardinality
   estimate proves wrong. Difficult; defer to v1.1.
3. **Window function spill.** Currently in-memory only; large
   PARTITION BYs OOM. Add temp-file spill in v0.7.

---

## 16. Compatibility Notes

- AST nodes are versioned; serializing a plan to disk requires a
  `plan_format_version` field. We currently don't persist plans across
  process restarts (only LRU cache).
- New operators are added with `version_required` metadata; older
  versions reject queries that need newer operators.

---

## 17. Cross-References

- Grammar: `[[FILE-15]]`.
- Index selection details: `[[FILE-04]]` §17, this file §7.
- MVCC visibility in scans: `[[FILE-06]]` §3.
- Reactive query persistence: `[[FILE-09]]` §7.
- Statistics/histograms: `[[FILE-04]]` §16.

---

*End of `05-QUERY-ENGINE.md` — 593 lines.*
