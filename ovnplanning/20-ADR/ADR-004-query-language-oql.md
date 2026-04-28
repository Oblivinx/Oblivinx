# ADR-004 — OQL as the First-Class Query Language (with MQL aliasing)

**Status:** Accepted, 2026-04
**Owners:** Query / OQL parser
**Cross refs:** `[[FILE-05]]`, `[[FILE-15]]`

---

## Context

A document database needs a query surface that is:

1. Discoverable (low learning curve for the most users).
2. Expressive enough for joins, aggregations, window functions, vector + FTS.
3. Suitable for tooling (parsers, formatters, EXPLAIN dashboards).
4. Compatible (somehow) with existing MongoDB-style operators many users know.

Options:

* **Pure MQL** (MongoDB Query Language) — JSON-shaped, familiar to many; weak for complex analytical queries; awkward grammar to extend.
* **Pure SQL** — universal language; harder to fit document/array semantics natively; verbose for simple finds.
* **N1QL / SQL++ (Couchbase)** — SQL with document extensions; close to ideal but not identical to ours.
* **Custom DSL** — maximum freedom; maximum cost in tooling and adoption.

## Decision

Adopt **OQL** — a SQL-flavored language with first-class document, vector, and FTS support — as the canonical query language. Maintain **MQL** as a parallel surface that lowers to the same AST, so existing MongoDB-style code can keep working.

OQL is documented in `[[FILE-15]]`; key positions:

* SQL-like keywords (SELECT/FROM/WHERE/GROUP BY/ORDER BY/JOIN).
* Document path access via `.`, `->`, `->>`, `#>`.
* Vector search and FTS as **table functions** in FROM, composing naturally with JOIN/CTE.
* `HINT(...)` clause for index control.
* Bind parameters mandatory for values (no inline literal SQL injection vector).

The parser is hand-written (Pratt for expressions, recursive descent for statements) rather than generated, to give precise diagnostics.

## Consequences

**Positive**

* Familiar surface for the largest population of developers.
* Composable: vector + FTS in same query; CTEs and window functions for analytics.
* Tooling-friendly EBNF; deterministic AST stable across versions.

**Negative**

* Two surfaces (OQL + MQL) means more conformance tests and clearer documentation.
* Hand-written parser ↔ continued investment as syntax grows.

## Alternatives considered

* **MQL only** — rejected: insufficient for analytical workloads and unfriendly for hybrid search.
* **SQL only** — rejected: poor ergonomics for nested-doc patterns dev community already uses.
* **Cypher-like graph syntax** — deferred (post-1.0).

## Open questions

* Recursive CTE support timing (deferred to v1.x).
* Window-function frame semantics: should we support `GROUPS` frames (currently no)?

*End of ADR-004.*
