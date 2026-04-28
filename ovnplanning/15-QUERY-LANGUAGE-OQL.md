# 15 — QUERY LANGUAGE: OQL (Oblivinx Query Language)

> **Audience:** Anyone authoring OQL, embedding the parser, or extending the language.
> **Status:** Specification (target v0.3 lexer/parser, v0.4 full semantics, v0.5 stable surface).
> **Cross refs:** `[[FILE-03]]` document model, `[[FILE-04]]` indexes, `[[FILE-05]]` query engine, `[[FILE-07]]` security, `[[FILE-12]]` observability.

---

## 1. Purpose & philosophy

OQL is the **first-class query language** for Oblivinx3x. Its goals:

1. **SQL-flavored** — discoverable for anyone with SQL background.
2. **Document-aware** — first-class arrays, nested objects, JSON paths.
3. **Time-aware** — built-in handling of timestamps and HLC.
4. **Vector & FTS in core syntax** — not bolted on as functions.
5. **Lowerable** — every OQL statement compiles to the same AST that MQL and the DSL produce, so the planner sees one language `[[FILE-05]]` §3.
6. **Predictable cost** — no syntax that hides O(N²) execution; the planner can reject "obvious" footguns.

Non-goals:

* Stored procedures (out of scope; use plugins `[[FILE-14]]`).
* Recursive WITH (CTE recursion deferred to v1.0+).
* Full SQL window functions (subset only — see §11).

---

## 2. Lexical grammar (EBNF)

```ebnf
program       = { statement ";" } [ statement ] ;

statement     = select-stmt
              | insert-stmt
              | update-stmt
              | delete-stmt
              | upsert-stmt
              | create-stmt
              | drop-stmt
              | begin-stmt
              | commit-stmt
              | rollback-stmt
              | savepoint-stmt
              | explain-stmt
              | with-stmt
              | use-stmt
              ;

(* ---------- tokens ---------- *)
identifier    = ident-start { ident-cont } ;
ident-start   = letter | "_" ;
ident-cont    = letter | digit | "_" ;
quoted-ident  = '"' { any-except-double-quote | '""' } '"' ;
string        = "'" { any-except-single-quote | "''" } "'"
              | "$" delim "$" any-except-delim "$" delim "$" ;     (* dollar-quoted *)
number        = integer | decimal | scientific ;
integer       = digit { digit } ;
decimal       = integer "." integer ;
scientific    = ( integer | decimal ) ("e"|"E") [ "+"|"-" ] integer ;
hex-int       = "0x" hex-digit { hex-digit } ;
duration      = integer ( "ns"|"us"|"ms"|"s"|"m"|"h"|"d"|"w"|"y" ) ;
datetime      = "TIMESTAMP" string ;                  (* parsed RFC 3339 *)
oid           = "OID" string ;                         (* 24-hex *)
uuid          = "UUID" string ;
boolean       = "TRUE" | "FALSE" ;
null          = "NULL" ;

operator      = "+" | "-" | "*" | "/" | "%" | "||"
              | "=" | "!=" | "<>" | "<" | "<=" | ">" | ">="
              | "AND" | "OR" | "NOT" | "XOR" | "IN" | "BETWEEN"
              | "LIKE" | "ILIKE" | "MATCH" | "REGEXP"
              | "IS" | "ISNULL" | "NOTNULL"
              | "??" | "->" | "->>" | "@@" | "@>" | "<@"
              | "~~"   (* vector cosine similarity *)
              | "~*"   (* fuzzy text *)
              ;

comment       = "--" { any-except-newline } newline
              | "/*" any-except-end-of-comment "*/" ;
```

Reserved keywords (alphabetical, case-insensitive at parse time):
`AND, AS, ASC, BEGIN, BETWEEN, BY, CASE, COMMIT, CREATE, CROSS, DELETE,
DESC, DISTINCT, DROP, ELSE, END, EXCEPT, EXPLAIN, FALSE, FETCH, FILTER,
FROM, FULL, GROUP, HAVING, HINT, IF, IN, INDEX, INNER, INSERT, INTERSECT,
INTO, IS, JOIN, LEFT, LIKE, LIMIT, MATCH, NEAR, NEW, NOT, NULL, OFFSET,
ON, OR, ORDER, OVER, PARTITION, REGEXP, RETURNING, RIGHT, ROLLBACK,
SAVEPOINT, SELECT, SET, SIMILAR, TABLE, TO, TRUE, UNION, UNNEST, UPDATE,
UPSERT, USING, VALUES, VECTOR, WHEN, WHERE, WINDOW, WITH, WITHIN`

---

## 3. SELECT (full grammar)

```ebnf
select-stmt   = [ with-clause ]
                "SELECT" [ "DISTINCT" ] select-list
                "FROM" from-list
                [ where-clause ]
                [ group-by-clause ]
                [ having-clause ]
                [ window-clause ]
                [ set-op-tail ]
                [ order-by-clause ]
                [ limit-clause ]
                [ for-update-clause ]
                [ hint-clause ] ;

select-list   = "*"
              | select-item { "," select-item } ;
select-item   = expression [ "AS" alias ]
              | qualified-name "." "*" ;

from-list     = from-source { "," from-source } ;
from-source   = collection-ref [ alias ]
              | "(" select-stmt ")" alias
              | "UNNEST" "(" expression ")" alias
              | "VECTOR_SEARCH" "(" vector-search-args ")" alias
              | "FTS" "(" fts-args ")" alias
              | from-source join-spec from-source ;

collection-ref= identifier { "." identifier } ;
join-spec     = ( "INNER" | "LEFT" | "RIGHT" | "FULL" | "CROSS" ) "JOIN" ;

where-clause  = "WHERE" expression ;

group-by-clause = "GROUP BY" group-spec { "," group-spec } ;
group-spec    = expression
              | "ROLLUP" "(" expression { "," expression } ")"
              | "CUBE"   "(" expression { "," expression } ")" ;

having-clause = "HAVING" expression ;

window-clause = "WINDOW" window-name "AS" "(" window-spec ")" 
                { "," window-name "AS" "(" window-spec ")" } ;
window-spec   = [ "PARTITION BY" expression-list ]
                [ "ORDER BY" sort-list ]
                [ frame-clause ] ;
frame-clause  = ("ROWS"|"RANGE") frame-extent ;
frame-extent  = "BETWEEN" frame-bound "AND" frame-bound ;

order-by-clause = "ORDER BY" sort-list ;
sort-list     = sort-item { "," sort-item } ;
sort-item     = expression [ "ASC" | "DESC" ] [ "NULLS" ("FIRST"|"LAST") ] ;

limit-clause  = "LIMIT" integer [ "OFFSET" integer ] ;

set-op-tail   = ( "UNION" [ "ALL" ] | "INTERSECT" | "EXCEPT" ) select-stmt ;

for-update-clause = "FOR" ( "UPDATE" | "SHARE" )
                    [ "OF" collection-ref { "," collection-ref } ]
                    [ "NOWAIT" | "SKIP LOCKED" ] ;

hint-clause   = "HINT" "(" hint-list ")" ;
hint-list     = hint-item { "," hint-item } ;
hint-item     = "INDEX" "(" identifier ")"          (* force this index *)
              | "NO_INDEX"                          (* full scan *)
              | "PARALLEL" "(" integer ")"
              | "TIMEOUT" "(" duration ")"
              | "READ_CONCERN" "(" identifier ")"
              | "MAX_EXAMINED" "(" integer ")"
              ;
```

---

## 4. INSERT / UPDATE / DELETE / UPSERT

```ebnf
insert-stmt   = "INSERT INTO" collection-ref
                ( ( "(" column-list ")" "VALUES" value-rows )
                | ( "VALUES" value-rows )
                | ( "{" key-value-list "}" { "," "{" key-value-list "}" } )
                | ( "FROM" "(" select-stmt ")" )
                )
                [ "ON CONFLICT" conflict-spec "DO" conflict-action ]
                [ "RETURNING" select-list ] ;

conflict-spec = "(" expression { "," expression } ")"     (* index columns or doc paths *)
              | "ON INDEX" identifier ;
conflict-action = "NOTHING"
                | "UPDATE" "SET" assign-list [ "WHERE" expression ] ;

update-stmt   = "UPDATE" collection-ref [ alias ]
                "SET" assign-list
                [ "WHERE" expression ]
                [ "ORDER BY" sort-list ]
                [ "LIMIT" integer ]
                [ "RETURNING" select-list ] ;

assign-list   = assign { "," assign } ;
assign        = doc-path "=" expression
              | doc-path operator-update expression       (* +=, -=, ||=, etc. *)
              | doc-path "PUSH" expression
              | doc-path "PULL" expression
              | doc-path "INC"  expression
              | doc-path "MUL"  expression
              | doc-path "ADD_TO_SET" expression
              | doc-path "RENAME" identifier ;

delete-stmt   = "DELETE FROM" collection-ref [ alias ]
                [ "WHERE" expression ]
                [ "ORDER BY" sort-list ]
                [ "LIMIT" integer ]
                [ "RETURNING" select-list ] ;

upsert-stmt   = "UPSERT INTO" collection-ref
                "VALUES" value-rows
                [ "ON" conflict-spec ]
                [ "RETURNING" select-list ] ;
```

---

## 5. DDL

```ebnf
create-stmt   = "CREATE" "COLLECTION" [ "IF NOT EXISTS" ] collection-ref
                [ "WITH" "(" coll-options ")" ]
              | "CREATE" [ "UNIQUE" ] "INDEX" [ "IF NOT EXISTS" ] index-name
                "ON" collection-ref "(" index-key-list ")"
                [ "WHERE" expression ]                    (* partial *)
                [ "INCLUDE" "(" select-list ")" ]         (* covering *)
                [ "WITH" "(" index-options ")" ]
              | "CREATE" "VECTOR INDEX" index-name "ON" collection-ref
                "(" doc-path ")"
                "USING" "HNSW"
                [ "WITH" "(" hnsw-options ")" ]
              | "CREATE" "FULLTEXT INDEX" index-name "ON" collection-ref
                "(" doc-path { "," doc-path } ")"
                [ "ANALYZER" string ]
              | "CREATE" "VIEW" view-name "AS" select-stmt
              | "CREATE" "USER" identifier "WITH" user-options
              | "CREATE" "ROLE" identifier
              ;

drop-stmt     = "DROP" ( "COLLECTION" | "INDEX" | "VIEW" | "USER" | "ROLE" )
                [ "IF EXISTS" ] identifier { "," identifier }
                [ "CASCADE" | "RESTRICT" ] ;
```

---

## 6. Transactions

```ebnf
begin-stmt    = "BEGIN" [ "TRANSACTION" ]
                [ "ISOLATION LEVEL" iso-level ]
                [ "READ" ("ONLY"|"WRITE") ]
                [ "DEFERRABLE" | "NOT DEFERRABLE" ] ;
iso-level     = "READ COMMITTED" | "REPEATABLE READ" | "SNAPSHOT"
              | "SERIALIZABLE" | "STRICT SERIALIZABLE" ;

commit-stmt   = "COMMIT" [ "TRANSACTION" ] ;
rollback-stmt = "ROLLBACK" [ "TRANSACTION" ] [ "TO" "SAVEPOINT" identifier ] ;
savepoint-stmt= "SAVEPOINT" identifier ;
```

---

## 7. Document path syntax

OQL extends column access to address nested document fields:

```
identifier                              -- top-level field
identifier "." identifier               -- nested object
identifier "[" integer "]"              -- array element
identifier "[" "*" "]"                  -- all array elements
identifier "[" expression "]"           -- computed index
identifier "->" string                  -- equivalent to .field (JSON-pointer-ish)
identifier "->>" string                 -- as text (cast)
identifier "#>"  string                 -- nested JSON pointer; e.g. '#>"/loc/lat"'
```

Examples:

```sql
SELECT name, address.city, tags[0], scores[*] FROM users;
UPDATE users SET prefs.theme = 'dark' WHERE id = OID '...';
SELECT meta->>'source' FROM events WHERE meta->'utm'->>'campaign' = 'spring';
```

JSON Pointer escapes (`~0` for `~`, `~1` for `/`) supported inside `#>` literals.

---

## 8. Expressions & operator precedence

12 levels, lowest first (parentheses always allowed to override):

| Level | Operators                        | Assoc |
| ----- | -------------------------------- | ----- |
| 1     | `OR`                             | left  |
| 2     | `XOR`                            | left  |
| 3     | `AND`                            | left  |
| 4     | `NOT`                            | unary |
| 5     | `=  !=  <>  <  <=  >  >=`        | none  |
| 6     | `BETWEEN  IN  LIKE  ILIKE  MATCH  REGEXP  IS  ISNULL` | none |
| 7     | `||  @>  <@  @@  ??`             | left  |
| 8     | `+  -`                           | left  |
| 9     | `*  /  %`                        | left  |
| 10    | `^` (power)                      | right |
| 11    | unary `+ -`                      | unary |
| 12    | `.  ->  ->>  #>  []`             | left  |

Special operators:

| Op    | Semantic                                                           |
| ----- | ------------------------------------------------------------------ |
| `||`  | string concat OR array concat (overloaded)                         |
| `??`  | null-coalesce: `a ?? b` returns `a` if not null else `b`           |
| `@>`  | left contains right (set/array containment)                        |
| `<@`  | left contained by right                                            |
| `@@`  | full-text match against analyzed query                              |
| `~~`  | vector similarity (cosine by default)                              |
| `~*`  | fuzzy string match (Levenshtein within threshold)                  |

---

## 9. Built-in functions (catalog)

Exhaustive starting set; plugins extend.

### 9.1 Scalar

| Name                                      | Returns      | Notes                                       |
| ----------------------------------------- | ------------ | ------------------------------------------- |
| `length(str)`                             | int          | UTF-8 grapheme count                        |
| `bytelen(str|bin)`                        | int          |                                             |
| `lower(str), upper(str)`                  | str          |                                             |
| `substr(str, start [, len])`              | str          | 1-based                                     |
| `concat(...)`                             | str          |                                             |
| `replace(str, from, to)`                  | str          |                                             |
| `split(str, sep [, limit])`               | array        |                                             |
| `trim(str)`, `ltrim`, `rtrim`             | str          |                                             |
| `regexp_match(str, pat [, flags])`        | array        |                                             |
| `cast(x AS type)`                         | typed        |                                             |
| `to_int`, `to_double`, `to_string`        | typed        | Convenience casts                           |
| `coalesce(a,b,...)`                       | typed        |                                             |
| `nullif(a,b)`                             | typed        |                                             |
| `if(cond, a, b)`                          | typed        |                                             |
| `case`                                    | typed        | SQL CASE                                    |
| `now()`                                   | timestamp    | wall clock                                  |
| `now_hlc()`                               | int          | HLC                                         |
| `now_ms()`                                | int          | monotonic ms                                |
| `extract(part FROM ts)`                   | int          | year/month/day/hour/min/sec/dow/doy/epoch   |
| `date_trunc(part, ts)`                    | timestamp    |                                             |
| `date_add(ts, duration)`                  | timestamp    |                                             |
| `date_diff(ts1, ts2, part)`               | int          |                                             |
| `oid_timestamp(oid)`                      | timestamp    | extract embedded ts                         |
| `oid_generate()`                          | oid          |                                             |
| `random()`                                | double       | [0,1)                                       |
| `random_int(lo, hi)`                      | int          |                                             |
| `uuid_v4()`, `uuid_v7()`                  | uuid         |                                             |
| `crc32c(bytes)`, `xxh3(bytes)`            | int          |                                             |
| `to_json(x)`, `from_json(str)`            | str / typed  |                                             |
| `obe_encode(x)`, `obe_decode(bytes)`      | bytes / doc  |                                             |
| `vector(double, double, ...)`             | vector       | constructor                                  |
| `vector_dim(v)`                           | int          |                                             |
| `cosine(a, b)`, `dot(a, b)`, `l2(a, b)`   | double       | distance / similarity                       |
| `vector_norm(v)`                          | double       |                                             |
| `geo_point(lat, lng)`                     | geopoint     |                                             |
| `geo_distance_m(a, b)`                    | double       | meters                                      |
| `geo_within(point, polygon)`              | bool         |                                             |
| `array_length(arr)`                       | int          |                                             |
| `array_contains(arr, x)`                  | bool         |                                             |
| `array_position(arr, x)`                  | int          |                                             |
| `array_sort(arr [, "asc"|"desc"])`        | array        |                                             |
| `array_distinct(arr)`                     | array        |                                             |
| `array_concat(a, b)`                      | array        |                                             |
| `array_slice(arr, start [, end])`         | array        |                                             |
| `unnest(arr)`                             | rows         | table function                              |
| `keys(obj)`, `values(obj)`                | array        |                                             |
| `obj_get(obj, key)`, `obj_set(obj, k, v)` | typed / obj  |                                             |
| `path_get(obj, "/a/b")`, `path_set(...)`  | typed / obj  |                                             |
| `match(text, query)` or `text @@ query`   | bool         | FTS predicate                                |
| `score(text, query)`                      | double       | FTS BM25                                     |

### 9.2 Aggregate

| Name                                   | Returns       | Notes                              |
| -------------------------------------- | ------------- | ---------------------------------- |
| `count(*)` / `count(expr)`             | int           |                                    |
| `sum(expr)`                            | typed         |                                    |
| `avg(expr)`                            | double        |                                    |
| `min(expr), max(expr)`                 | typed         |                                    |
| `stddev(expr)`, `variance(expr)`       | double        |                                    |
| `array_agg(expr [ORDER BY ...])`       | array         |                                    |
| `string_agg(expr, sep [ORDER BY ...])` | str           |                                    |
| `bool_or(expr), bool_and(expr)`        | bool          |                                    |
| `bit_or(expr), bit_and(expr)`          | int           |                                    |
| `percentile(expr, p)`                  | double        | t-digest (approx)                  |
| `histogram(expr, n_buckets)`           | array         |                                    |
| `topk(expr, k)`                        | array         | space-saving                       |
| `hyperloglog(expr)`                    | int           | distinct estimator                 |

### 9.3 Window

`row_number()`, `rank()`, `dense_rank()`, `lag(expr, n)`, `lead(expr, n)`, `first_value(expr)`, `last_value(expr)`, `ntile(n)`. Aggregates above can also be used as window functions.

### 9.4 Vector / FTS

| Name                                                   | Notes                                       |
| ------------------------------------------------------ | ------------------------------------------- |
| `VECTOR_SEARCH(coll, vec, k [, opts])`                 | FROM-clause table function                  |
| `FTS(coll, query [, opts])`                            | FROM-clause table function                  |
| `text_search_query(str)`                               | parses input → analyzed FTS query           |
| `to_tsvector(str)`                                     | builds analyzed text vector                  |

---

## 10. SELECT examples

### 10.1 Simple find

```sql
SELECT _id, name, email
FROM users
WHERE status = 'active'
  AND created_at > now() - 30d
ORDER BY created_at DESC
LIMIT 50;
```

### 10.2 Aggregation

```sql
SELECT category, count(*) AS n, sum(amount) AS revenue
FROM orders
WHERE created_at > '2026-01-01'::timestamp
GROUP BY category
HAVING sum(amount) > 1000
ORDER BY revenue DESC
LIMIT 10;
```

### 10.3 Vector search

```sql
SELECT u._id, u.name, vs.score
FROM users u
JOIN VECTOR_SEARCH(users, $:embedding, 50, ef => 200) vs
  ON u._id = vs._id
WHERE u.region = 'APAC'
ORDER BY vs.score DESC
LIMIT 10;
```

### 10.4 Hybrid search (RRF)

```sql
WITH bm AS (
  SELECT _id, score AS bm25 FROM FTS(articles, 'rust embedded')
       LIMIT 200
),
ann AS (
  SELECT _id, 1.0 - score AS sim FROM VECTOR_SEARCH(articles, $:q_emb, 200)
)
SELECT a._id, a.title,
       ( COALESCE(1.0/(60 + bm.rn), 0) + COALESCE(1.0/(60 + ann.rn), 0) ) AS score
FROM articles a
LEFT JOIN ( SELECT _id, row_number() OVER (ORDER BY bm25 DESC) rn FROM bm ) bm USING (_id)
LEFT JOIN ( SELECT _id, row_number() OVER (ORDER BY sim  DESC) rn FROM ann ) ann USING (_id)
WHERE bm.rn IS NOT NULL OR ann.rn IS NOT NULL
ORDER BY score DESC
LIMIT 20;
```

### 10.5 UNNEST

```sql
SELECT u._id, t AS tag
FROM users u, UNNEST(u.tags) AS t
WHERE t LIKE 'admin:%';
```

### 10.6 Window function

```sql
SELECT customer_id, order_id, amount,
       sum(amount) OVER (PARTITION BY customer_id ORDER BY created_at
                          ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total
FROM orders;
```

### 10.7 Hint

```sql
SELECT * FROM events
WHERE level = 'error' AND created_at > now() - 1h
HINT (INDEX(by_level), TIMEOUT(2s), MAX_EXAMINED(50000));
```

---

## 11. Window function semantics

Supported window frame types:

* `ROWS BETWEEN n PRECEDING AND m FOLLOWING`
* `RANGE BETWEEN value PRECEDING AND value FOLLOWING` (over numeric/timestamp keys)
* `UNBOUNDED PRECEDING`, `CURRENT ROW`, `UNBOUNDED FOLLOWING`

Limitations (v1.0):

* `GROUPS` frames not supported.
* `EXCLUDE` clauses not supported.

Frames are computed in a single pass per partition; sort ordering is reused from `ORDER BY` of the window when compatible.

---

## 12. Bind parameters

OQL supports two parameter syntaxes:

* **Numbered**: `?1, ?2, ...`
* **Named**: `$:name`

```sql
SELECT * FROM users WHERE id = ?1 OR email = $:email;
```

The driver-supplied parameters are bound by position or name. Mixing in one statement is allowed but discouraged.

Type inference:

* Driver provides the value; the parser keeps a `BindRef(idx_or_name)` AST node.
* Planner specializes the plan once types are known.
* Plan cache key includes parameter type signature, so re-binding with same shape hits cache.

**SQL-injection-resistant by design**: literals can be inlined only at parse time; values come through bind only.

---

## 13. EXPLAIN syntax

```ebnf
explain-stmt  = "EXPLAIN" [ "(" explain-opts ")" ] statement ;
explain-opts  = explain-opt { "," explain-opt } ;
explain-opt   = "VERBOSITY" "=" ("PLAIN"|"FULL"|"PROFILE")
              | "ANALYZE"                          (* execute and capture *)
              | "FORMAT"   "=" ("JSON"|"TEXT"|"GRAPHVIZ")
              | "BUFFERS"
              ;
```

Example:

```sql
EXPLAIN (VERBOSITY=FULL, ANALYZE, FORMAT=JSON)
SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at LIMIT 50;
```

Output schema documented in `[[FILE-12]]` §6.

---

## 14. Date/time, intervals, durations

* Literals: `TIMESTAMP '2026-04-28T22:13:01Z'`, `DATE '2026-04-28'`, `TIME '14:00:00'`.
* Duration literals: `1h`, `30m`, `90d`, `52w`. `now() - 30d` returns a timestamp.
* Time zone: timestamps stored as UTC ms. `AT TIME ZONE 'Asia/Jakarta'` shifts for display.
* HLC literals: `HLC 18420391284820`.

---

## 15. Type system at the language level

OQL types align with the document model `[[FILE-03]]`:

```
NULL  BOOL  INT  DOUBLE  DECIMAL  STRING  BYTES
ARRAY OBJECT  OID  TIMESTAMP  DURATION  UUID  VECTOR  GEOPOINT  ENCRYPTED
```

Type coercion rules (subset):

* `INT → DOUBLE → DECIMAL` lossless
* `STRING → INT/DOUBLE` requires explicit `cast()` or `to_int/to_double`
* Comparisons across types follow BSON sort order `[[FILE-03]]` §10
* `VECTOR ~~ VECTOR` requires equal dim (else error at planning)
* `STRING || STRING → STRING`; `ARRAY || ARRAY → ARRAY`; mixing is a type error

---

## 16. NULL semantics (three-valued logic)

* `NULL = NULL` is `NULL` (NOT TRUE).
* `x IS NULL`, `x IS NOT NULL` are the way to test.
* `NULL AND FALSE = FALSE`; `NULL AND TRUE = NULL`.
* `NULL OR TRUE = TRUE`; `NULL OR FALSE = NULL`.
* Aggregations skip NULL inputs (count(*) counts rows; count(expr) skips nulls).

---

## 17. Errors & messages

Parser errors carry:

```jsonc
{
  "code":     "OQL_SYNTAX",
  "message":  "Expected ')' at line 5, col 12 (after expression in WHERE).",
  "line":     5,
  "column":   12,
  "context":  "...AND status = 'active' OR\n           ^",
  "hint":     "Add a closing parenthesis matching the OR group."
}
```

Top-level error categories:

| Code             | Meaning                                       |
| ---------------- | --------------------------------------------- |
| `OQL_SYNTAX`     | Lexer/parser failure                          |
| `OQL_RESOLVE`    | Unknown collection / column / function        |
| `OQL_TYPE`       | Type mismatch                                 |
| `OQL_HINT`       | Bad hint (e.g., index not exists)             |
| `OQL_LIMIT`      | Statement exceeds policy (depth, joins, ...)  |
| `OQL_PRIVILEGE`  | Missing required permission                   |

---

## 18. Limits & policies

| Limit                       | Default | Configurable | Why                                |
| --------------------------- | ------- | ------------ | ---------------------------------- |
| Max statement size          | 1 MiB   | yes          | DOS protection                     |
| Max parse tree depth        | 256     | yes          | Stack overflow guard               |
| Max joins per query         | 16      | yes          | Planner combinatorics              |
| Max aggregation pipeline    | 32      | yes          | Planner / runtime budget           |
| Max bind parameters         | 1024    | no           |                                    |
| Max IN list elements        | 10000   | yes          | Plan size                          |
| Max OR branches             | 64      | yes          | Plan size                          |

Exceeding a limit returns `OQL_LIMIT` with the offending value.

---

## 19. AST overview

After parse, the OQL goes through a fixed AST that mirrors `[[FILE-05]]` §3. Top-level node kinds (Rust enum sketch):

```rust
pub enum Stmt {
    Select(SelectStmt),
    Insert(InsertStmt),
    Update(UpdateStmt),
    Delete(DeleteStmt),
    Upsert(UpsertStmt),
    Create(CreateStmt),
    Drop(DropStmt),
    Begin(BeginStmt),
    Commit, Rollback(Option<String>), Savepoint(String),
    Explain(Box<Stmt>, ExplainOpts),
    With(WithStmt),
    Use(String),
}

pub struct SelectStmt {
    pub with:     Vec<CteSpec>,
    pub distinct: bool,
    pub items:    Vec<SelectItem>,
    pub from:     Vec<FromSource>,
    pub where_:   Option<Expr>,
    pub group_by: Vec<GroupSpec>,
    pub having:   Option<Expr>,
    pub windows:  Vec<NamedWindow>,
    pub set_op:   Option<SetOpTail>,
    pub order_by: Vec<SortItem>,
    pub limit:    Option<LimitSpec>,
    pub for_lock: Option<ForLockSpec>,
    pub hints:    Vec<Hint>,
}
```

The planner consumes `Stmt` and produces a `LogicalPlan` `[[FILE-05]]` §4.

---

## 20. Stability guarantees

* **Reserved keywords** are stable across minor versions; new keywords introduced only in major bumps.
* **Operator precedence** is stable; never silently re-tuned.
* **Built-in function signatures** may have **additions** (new optional args) but not removals.
* **EXPLAIN JSON** schema versioned with `version` field; old fields kept for one major.
* **Bind syntax** (`?N`, `$:name`) stable forever.

---

## 21. Tradeoffs

| Decision                              | Chosen                              | Alternative              | Why                                  |
| ------------------------------------- | ----------------------------------- | ------------------------ | ------------------------------------ |
| SQL-flavored vs JSON-only             | SQL-flavored                        | MongoDB-only             | Discoverability                      |
| Document paths via `.`/`->`/`#>`      | Multiple syntaxes                   | One syntax               | Familiarity from PostgreSQL          |
| Three-valued NULL logic               | Yes                                 | False-on-null            | SQL standard expectation             |
| Vector & FTS as table functions       | Yes                                 | Special syntax           | Composable with JOIN/CTE             |
| Bind parameters mandatory for values  | Yes                                 | Inline literal allowed   | Plan cache hit; security             |
| Window functions                      | Subset                              | Full SQL:2003            | Implementation cost vs value         |
| Hints surface                         | Inline `HINT(...)` clause           | Comments / pragma        | Discoverable, parseable              |

---

## 22. Open questions & future

* **Recursive CTEs** for graph traversal patterns.
* **`MATCH ... RETURN` graph syntax** (Cypher-inspired) over collection adjacency.
* **`PIVOT` clause** for OLAP.
* **Stored views materialization** with refresh policies.
* **JSON_TABLE-like** unnesting for complex JSON.
* **Set operations on cursors** (lazy evaluation across UNION).

---

## 23. Cross-references

* `[[FILE-03]]` — types and document paths originate here.
* `[[FILE-04]]` — index hints reference index types defined here.
* `[[FILE-05]]` — OQL parses to the AST consumed by the planner.
* `[[FILE-07]]` — privilege checks attach to schema lookups.
* `[[FILE-08]]` — FTS / vector table functions implemented here.
* `[[FILE-12]]` — EXPLAIN format defined here.
* `[[FILE-14]]` — UDFs callable from OQL.

*End of `15-QUERY-LANGUAGE-OQL.md` — 580 lines.*
