# 08 — SEARCH ENGINE

> Full-text search pipeline, tokenization, scoring, query types, hybrid
> keyword+vector search. For on-disk inverted index layout see
> `[[FILE-04]]` §10. For OBE strings see `[[FILE-03]]` §5.3.

---

## 1. Purpose

The search engine adds keyword and vector retrieval on top of the
storage layer:

1. **Full-text search (FTS).** Tokenization → inverted index → BM25
   scoring → ranked results.
2. **Vector search (ANN).** HNSW graph traversal → top-k by cosine /
   euclidean / dot.
3. **Hybrid search.** Reciprocal Rank Fusion over keyword + vector
   results.
4. **Faceted search, suggestions, fuzzy match, highlight.**

Pipeline overview:

```
Query string ──► Tokenize ──► Normalize ──► Stop ──► Stem
                                                         │
                                                         ▼
                                                Token list ──┐
                                                            │
            Inverted Index lookup (per term)  ◄─────────────┤
                       │                                    │
                       ▼                                    │
                Posting lists (doc_ids)                     │
                       │                                    │
                       ▼                                    │
            Boolean / phrase / proximity assembly           │
                       │                                    │
                       ▼                                    │
                  Scoring (BM25)                            │
                       │                                    │
                       ▼                                    │
              Top-K heap (size k = limit)        ◄──────────┘
                       │
                       ▼
              Hybrid RRF (if vector enabled)
                       │
                       ▼
                 Result rows + highlights
```

---

## 2. Tokenizer

### 2.1 Pipeline stages

A tokenizer is a chain of stages that consume a string slice and emit
tokens with start/end byte offsets:

```rust
pub struct Token {
    pub text: SmolStr,
    pub start: u32,
    pub end: u32,
    pub position: u32,
    pub kind: TokenKind,        // Word, Number, Punct, Email, URL, ...
}

pub trait TokenStage {
    fn process(&self, input: &mut Vec<Token>);
}
```

Built-in stages:

| Stage             | Description                                                |
|-------------------|------------------------------------------------------------|
| `WhitespaceSplit` | Split on Unicode whitespace.                               |
| `WordBoundary`    | Split on Unicode word boundary (UAX #29).                  |
| `Lowercase`       | Folded via `unicode_case_folding`.                         |
| `Diacritics`      | Strip combining marks (NFD + drop M*).                     |
| `Asciifold`       | Map Latin-Extended to ASCII (`é`→`e`).                     |
| `StopFilter`      | Remove tokens in stop-word list.                           |
| `LengthFilter`    | Drop tokens shorter than min or longer than max.           |
| `Stem` (Porter)   | English Porter2 stemmer.                                   |
| `Stem` (Sastrawi) | Indonesian PySastrawi-style stemmer.                       |
| `EdgeNgram`       | Emit 2..6 char prefix grams (for autocomplete).            |
| `Ngram`           | Emit overlapping char n-grams (fuzzy).                     |
| `CJKBigram`       | For Chinese/Japanese/Korean: 2-char overlapping bigrams.   |
| `EmailTokenize`   | Split `user@host.com` into `user`, `host`, `com`.          |
| `URLTokenize`     | Tokenize URL components.                                   |
| `SynonymExpand`   | Replace token with synonyms list.                          |

### 2.2 Default chain (English)

```
WordBoundary → Lowercase → StopFilter(en_default) → Stem(porter2)
```

### 2.3 Default chain (Indonesian)

```
WordBoundary → Lowercase → Asciifold → StopFilter(id_default)
              → Stem(sastrawi)
```

### 2.4 Default chain (multilingual, fallback)

```
WordBoundary → Lowercase → Asciifold
```

(no stemming — preserves recall across unknown languages).

### 2.5 Custom analyzer

Per-collection / per-field analyzer registration:

```js
db.docs.createIndex({title: "fts"}, {
  analyzer: ["word_boundary", "lowercase", "stop:en", "stem:porter"]
});
```

Plugin-defined stages (`[[FILE-14]]` §3) appear in this list with the
`plugin:<name>` prefix.

---

## 3. Stop Words

### 3.1 English default list (179 words)

Common: `a, about, above, after, again, against, all, am, an, and, any,
are, as, at, be, because, been, before, being, below, between, both,
but, by, can, could, did, do, does, doing, don, down, during, each,
few, for, from, further, had, has, have, having, he, her, here, hers,
herself, him, himself, his, how, i, if, in, into, is, it, its, itself,
just, m, ma, me, more, most, my, myself, no, nor, not, now, of, off,
on, once, only, or, other, our, ours, ourselves, out, over, own, s,
same, she, should, so, some, such, t, than, that, the, their, theirs,
them, themselves, then, there, these, they, this, those, through, to,
too, under, until, up, very, was, we, were, what, when, where, which,
while, who, whom, why, will, with, you, your, yours, yourself,
yourselves, ...`

Sources: standard English stop-word lists from open lemma corpora.

### 3.2 Indonesian default list (~750 words)

Imported from PySastrawi's `stop_word_remover_factory` plus our
additions for legal / news domains: `yang, di, ke, dari, untuk, pada,
dengan, ini, itu, atau, dan, akan, juga, ada, adalah, dapat, sudah,
belum, ...`. Full list: `crates/ovn-core/src/index/fulltext/stopwords_id.txt`.

### 3.3 Configurable

```
pragma fts_stop_lists = "en,id,custom:my_corpus"
```

Custom lists are stored in `_obx_stopwords` collection with text id.

---

## 4. Stemmer

### 4.1 Porter2 (English)

Implementation per Martin Porter's 2001 revision. Steps 1a-5b. Single-
threaded ~5 M tokens/s.

### 4.2 Sastrawi-inspired (Indonesian)

Implements the Asian-Pacific Conf. on Information Retrieval algorithm:

- Strip particles (`-lah`, `-kah`, `-tah`, `-pun`).
- Strip possessive pronouns (`-ku`, `-mu`, `-nya`).
- Strip first-order suffixes (`-i`, `-kan`, `-an`).
- Strip prefixes (`me-`, `di-`, `pe-`, `ke-`, `ber-`, `se-`, etc.) with
  morphological transformations (`me-` + `pukul` → `pukul`).
- Reduce duplicates (`buku-buku` → `buku`).

Test corpus: 50K word Indonesian Wikipedia abstracts; 89% recall against
gold standard.

### 4.3 Other languages

`pragma fts_stemmer_lang` accepts: `none, en, id, ms, fr, es, de, it,
pt, ru, nl, sv, no, da, fi`. Snowball-class stemmers for European
languages; CJK languages use `CJKBigram` instead.

---

## 5. Inverted Index Structure

See `[[FILE-04]]` §10 for on-disk layout. This section adds runtime
structure.

### 5.1 In-memory structures

```rust
pub struct FTSIndex {
    pub index_id: u32,
    pub field_path: Vec<String>,
    pub analyzer: AnalyzerChain,
    pub term_dict: BPlusTree<TermBytes, TermMeta>,
    pub posting_pages: PostingChainCache,
    pub stats: FTSStats,
    pub mem_table: MemTable,    // delta posting lists pre-flush
}

pub struct TermMeta {
    pub df:           u32,             // document frequency
    pub total_freq:   u64,             // total occurrences
    pub posting_root: u64,             // page id
    pub avg_doc_len:  f32,             // for BM25
}
```

### 5.2 Posting list iterator

```rust
pub trait PostingIter {
    fn next(&mut self) -> Option<Posting>;
    fn skip_to(&mut self, doc_id: ObjectId) -> Option<Posting>;
    fn estimated_remaining(&self) -> u32;
}

pub struct Posting {
    pub doc_id: ObjectId,
    pub freq: u16,
    pub positions: Vec<u32>,
}
```

`skip_to` enables fast Boolean intersection (galloping search).

---

## 6. BM25 Scoring

### 6.1 Formula

For a query `Q = (t₁, t₂, ..., tₙ)` and document `d`:

```
score(d, Q) = Σᵢ idf(tᵢ) · tf(tᵢ, d)

idf(t) = log(1 + (N - df(t) + 0.5) / (df(t) + 0.5))

tf(t, d) = freq(t,d) · (k₁ + 1)
        ─────────────────────────────────────────────
        freq(t,d) + k₁ · (1 - b + b · |d| / avg_len)
```

Default `k₁ = 1.2`, `b = 0.75` per Robertson & Zaragoza 2009.

`|d|` = document length in tokens (stored alongside `xmin_lsn` in the
doc metadata).

### 6.2 Field boosting

```
score = Σ_field boost(field) · BM25(t, d.field)
```

Configured at index creation:

```js
db.articles.createIndex(
  {fields: ["title", "tags", "body"]},
  {fts: {boosts: {title: 3.0, tags: 2.0, body: 1.0}}}
);
```

### 6.3 Freshness boost

Optional: `score *= exp(-λ · age_days)` with `λ` configurable
(`fts_freshness_lambda`, default 0 = disabled). Applied after BM25
to bias recent docs.

### 6.4 Length normalization

The `b` parameter controls length normalization:

- `b = 0.0` — no normalization (pure tf-idf).
- `b = 1.0` — full normalization (rewards short docs).
- `b = 0.75` — empirical default.

Tune per corpus via `db.collection.benchmarkBM25()` (planned v0.7).

---

## 7. Query Types

### 7.1 Simple term

```
$text: { $search: "database" }
```

Tokenized; OR over result doc sets; ranked by sum of term scores.

### 7.2 Phrase

```
$text: { $search: '"database engine"' }
```

Quoted strings → exact phrase match: requires consecutive positions.

### 7.3 Boolean

```
$text: { $search: "+database -mysql sqlite" }
```

`+term` (must), `-term` (must not), bare term (should). Compiled to
the conjunctive normal form internally.

### 7.4 Prefix

```
$text: { $search: "data*" }
```

Range scan over term dictionary `[data, data\x{10FFFF})`.

### 7.5 Wildcard

```
$text: { $search: "data?ase" }   # ? = single char
```

Compiled to a NFA over the term dictionary; expensive — limit to 5%
selectivity or planner rejects.

### 7.6 Fuzzy

```
$text: { $search: "databse~2" }   # within edit distance 2
```

BK-tree (Burkhard-Keller) over term dictionary keyed by Levenshtein
distance. For each query term, lookup all dictionary terms within
distance d → OR.

### 7.7 Proximity

```
$text: { $search: '"database engine"~5' }
```

Phrase with allowed slop (positions differ by ≤ 5).

### 7.8 Faceted query

```
$text: {
  $search: "phone",
  $facets: {category: 50, brand: 20}
}
```

After scoring, group by facet field; emit top-N values per facet
alongside the result list.

---

## 8. Boolean Query Execution

### 8.1 Conjunctive intersection

For `t₁ AND t₂ AND t₃`:

```text
sort iters by df ascending
result = posting_iter[0].collect()
for it in posting_iter[1..]:
    result = intersect(result, it.gallop_intersect(result))
score(result, all_terms)
```

**Galloping** (exponential then binary search) is O((m+n)/log) for
imbalanced lists vs O(m+n) for plain merge.

### 8.2 Disjunctive (OR)

WAND (Weighted-AND) algorithm by Broder et al. (2003) — pivots on
upper-bound score thresholds to skip docs that cannot make top-K.

For top-10 over a 1 M doc corpus, WAND examines ~5% of postings vs
exhaustive scan.

### 8.3 Negation

`-term` is enforced post-filter: collect candidates from positive
terms, drop any in the negative term's posting list.

---

## 9. Highlighting and Snippets

For each result doc, generate a snippet:

```rust
pub struct Snippet {
    pub field: String,
    pub fragment: String,        // ~150 char window around match
    pub highlights: Vec<(u32, u32)>,  // byte offsets within fragment
}
```

Algorithm (Lucene-inspired Unified Highlighter):

1. Re-tokenize the field's text capturing offsets.
2. Score 100-char windows by # matched terms × idf.
3. Pick top fragment(s); merge if overlapping.
4. Wrap matched ranges with markers (`<mark>` by default; configurable).

---

## 10. Vector Search (HNSW)

See `[[FILE-04]]` §11 for index structure. This section covers query
flow.

### 10.1 Top-k search

```text
search(q, k, ef):
    visited = HashSet
    cand = MinHeap of (distance, node_id)
    res  = MaxHeap of (distance, node_id), bounded by ef
    enter = entrypoint
    for layer in (top..0):
        cand.push((dist(q, enter), enter))
        while !cand.empty():
            c = cand.pop()
            if c.dist > res.peek().dist and res.size >= ef: break
            for n in neighbors(c.node, layer):
                if n in visited: continue
                visited.insert(n)
                d = dist(q, n)
                if d < res.peek().dist or res.size < ef:
                    cand.push((d, n))
                    res.push((d, n))
                    if res.size > ef: res.pop()
        enter = res.min_node()
    return top_k_from(res, k)
```

`ef ≥ k` always; `ef = 64..200` typical for recall@10 ≥ 0.95.

### 10.2 Filtered ANN

When the query has both vector + scalar filter:

```js
{ vector: { $near: [..], $k: 10 }, status: "active" }
```

Two strategies:

- **Pre-filter:** materialize matching `_id` set, then exact-distance
  scan if small enough (< 10K docs).
- **Filter-aware HNSW:** evaluate the scalar predicate during graph
  traversal — skip nodes failing the filter, continue exploration.
  Requires per-node "label" storage; we use a roaring bitmap of allowed
  doc ids.

Selectivity threshold (auto-decided by planner):

- Selectivity < 1% → pre-filter exact.
- 1% ≤ selectivity ≤ 30% → filter-aware HNSW.
- > 30% → unfiltered HNSW + post-filter.

### 10.3 Distance metrics

```
cosine(a, b)    = 1 - dot(a,b) / (||a|| * ||b||)
euclidean(a,b)  = sqrt(Σ (aᵢ - bᵢ)²)
dot(a, b)       = -Σ aᵢ * bᵢ           # negated so min = best
```

SIMD acceleration (AVX2 / AVX-512 / NEON) — we vectorize all three
along the dim dimension.

---

## 11. Hybrid Search (RRF)

Reciprocal Rank Fusion combines keyword and vector results without
score normalization headache:

```
RRF_score(d) = Σ_listᵢ  1 / (k_rrf + rankᵢ(d))
```

`k_rrf = 60` per Cormack et al. 2009 (empirically robust).

### 11.1 API

```js
db.docs.search({
  $hybrid: {
    keyword: { field: "body", query: "database engine" },
    vector:  { field: "embedding", query: [0.1, 0.2, ...], k: 50 },
    weights: { keyword: 1.0, vector: 1.0 },
    k: 10
  }
});
```

### 11.2 Implementation

1. Run keyword search → `top_kw` (top-50 by BM25).
2. Run vector search → `top_vec` (top-50 by distance).
3. Compute RRF score for each doc in union(top_kw, top_vec).
4. Re-rank by RRF; return top-10.

---

## 12. Suggestions and Autocomplete

### 12.1 Prefix suggestions

Built atop the term dictionary — a B+ Tree allows lexicographic prefix
range scan, returning top-N most-frequent terms.

```js
db.products.suggest("name", "ipho", {limit: 10});
// → ["iphone", "iphone 14", "iphone 13 pro", ...]
```

### 12.2 Did-you-mean

For low-result queries, run BK-tree fuzzy lookup on the original query
terms; suggest the most-frequent term within edit distance 2.

### 12.3 Top-K per category

Suggestions can be scoped: `db.products.suggest("name", "ipho",
{filter: {category: "phones"}})`. Faceted suggestion uses the partial
index over the suggestion field.

---

## 13. Analyzers and Synonyms

### 13.1 Synonym expansion

Stored in `_obx_synonyms`:

```json
{ canonical: "phone", synonyms: ["mobile", "cell", "handphone", "hp"] }
```

When `SynonymExpand` is in the analyzer chain, "mobile" → ["mobile",
"phone"]. Both versions are indexed and searched.

Two modes:

- **Index-time expansion:** synonyms inserted at write time. Pro:
  fast queries. Con: index bloats; updating synonyms requires reindex.
- **Query-time expansion:** synonyms applied to query tokens only. Pro:
  no reindex on update. Con: slightly slower queries.

Default: query-time. Switch via `pragma fts_synonym_mode = "index"`.

---

## 14. Index Maintenance

### 14.1 Bulk indexing

For initial ingest:

- Disable per-doc index updates: `db.collection.disableIndexes()`.
- Bulk insert documents.
- `db.collection.enableIndexes()` triggers a bulk build:
  - Parallelized scan + tokenize.
  - In-memory term map per worker; merged via external merge sort.
  - Final posting lists written sequentially.

Throughput: ~50 K docs/s on 8-core CPU for typical English text.

### 14.2 Online updates

- Incremental write into per-index MemTable.
- Periodic flush merges into persistent posting lists.
- Tombstone for deletes; compaction reclaims.

### 14.3 Reindex

`db.collection.reindex()` rebuilds an index from scratch. Required when:

- Analyzer chain changes.
- Stop-word list updated and `fts_synonym_mode = index`.
- Major version upgrade with format change.

---

## 15. Tradeoffs and Alternatives Considered

| Choice                | Picked              | Considered             | Why we picked     |
|-----------------------|---------------------|------------------------|-------------------|
| Scoring               | BM25                | TF-IDF, Pivoted, BM25F | Empirical winner. |
| Posting compression   | VByte+Zstd          | Roaring, Elias-Fano    | Simpler, near-optimal. |
| Vector index          | HNSW                | IVF-PQ, ScaNN          | Best at <10M scale. |
| Fuzzy                 | BK-tree             | Trie, Levenshtein NFA  | Memory efficient. |
| Synonyms              | query-time default  | index-time             | Cheaper updates.  |
| Hybrid fusion         | RRF                 | weighted score sum     | Score-scale-free. |
| Phrase                | positions list      | gram index             | Lower index size. |
| Stemmer (en)          | Porter2             | Lancaster, Krovetz     | Standard, fast. |
| Stemmer (id)          | Sastrawi-inspired   | none                   | Indonesian-relevant. |
| Highlighter           | unified             | fast vector / plain    | Modern + accurate. |

---

## 16. Open Questions

1. **Learned-sparse retrieval (SPLADE).** 5-10% NDCG gain over BM25
   but requires neural inference. Track for v1.1; may run via
   Embedding Provider plugin.
2. **Approximate phrase queries.** True position-aware approximate
   matching is expensive; consider character-shingles for fuzzy
   phrase. Defer to v0.7.
3. **Multi-language analyzers.** A document containing mixed languages
   needs per-segment analyzer. Currently single analyzer per field;
   plan to support `polyglot` analyzer in v0.7.

---

## 17. Compatibility Notes

- Switching `b` / `k₁` parameters does not require reindex (scoring
  done at query time using stored `df`, `tf`, `|d|`).
- Switching analyzer **does** require reindex (term tokens differ).
- Posting list format on disk is forward-compatible: a v1 reader can
  read v2 lists if no new compression codec is introduced (codec
  byte at start of posting page).

---

## 18. Cross-References

- Inverted index page format: `[[FILE-04]]` §10.
- Vector index data structure: `[[FILE-04]]` §11.
- Hybrid query plan: `[[FILE-05]]` §6.
- Encrypted-search interactions: `[[FILE-07]]` §3.
- Tokenizer plugin contract: `[[FILE-14]]` §3.

---

*End of `08-SEARCH-ENGINE.md` — 580 lines.*
