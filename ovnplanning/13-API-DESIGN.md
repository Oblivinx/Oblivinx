# 13 — API DESIGN

> **Audience:** Public API surface implementers (Rust, C/C++, Node.js, Python, REST/gRPC), SDK authors.
> **Status:** Specification (Rust + Node.js v0.1, C/C++ v0.3, REST v0.4, Python v0.5).
> **Cross refs:** `[[FILE-03]]` document model, `[[FILE-05]]` query engine, `[[FILE-06]]` MVCC, `[[FILE-07]]` security, `[[FILE-09]]` replication, `[[FILE-12]]` observability, `[[FILE-15]]` OQL.

---

## 1. Purpose

Oblivinx3x exposes the same engine through several surfaces. This document defines them all, ensuring:

1. **Semantic uniformity** — `find` means the same thing in Rust, C, REST.
2. **Type safety where the host allows** — strong types in Rust/Python, C error codes, JSON Schemas in REST.
3. **Predictable error mapping** — every `OvnError` variant has a defined representation per surface.
4. **Forward-compatibility** — APIs admit additive change without breaking existing callers.

Surfaces:

| Surface           | Status  | Build target                       |
| ----------------- | ------- | ---------------------------------- |
| Rust              | Stable  | crate `oblivinx3x`                 |
| Node.js (Neon)    | Stable  | npm `oblivinx3x`                   |
| C ABI             | Planned | `liboblivinx.{so,dylib,dll}`       |
| C++ wrapper       | Planned | header-only `oblivinx.hpp`         |
| Python (PyO3)     | Planned | PyPI `oblivinx3x`                  |
| REST (HTTP/JSON)  | Planned | optional sidecar `ovnsd`           |
| gRPC              | Planned | optional sidecar `ovnsd`           |
| WebSocket (watch) | Planned | optional sidecar `ovnsd`           |

---

## 2. Design principles

* **Async by default** in host languages that support it (Rust, Node.js, Python). Synchronous wrappers exist but cost a thread.
* **Builder pattern** for option-heavy operations (`Find::new(coll).filter(...).limit(50).await`).
* **Immutable handles** for resources (`Database`, `Collection`, `Cursor`); cloning is cheap (Arc).
* **Explicit transactions** — implicit auto-commit only at the lowest level; users opt-in to explicit txns.
* **No hidden network I/O** in embedded mode — everything in-process.
* **Errors are values**, not exceptions, in Rust/C; exceptions in JS/Python.
* **Tracing context propagation** — every entry point accepts an optional `Context`.

---

## 3. Rust API (the canonical surface)

### 3.1 Top-level types

```rust
pub struct Engine { /* opaque */ }
pub struct Database { /* opaque, Arc<Inner> */ }
pub struct Collection { /* opaque, Arc<Inner> */ }
pub struct Index { /* opaque */ }
pub struct Transaction { /* opaque */ }
pub struct Cursor<'tx, T> { /* opaque */ }
```

### 3.2 Engine

```rust
impl Engine {
    pub fn open(path: impl AsRef<Path>, opts: EngineOptions) -> Result<Self, OvnError>;
    pub async fn open_async(path: impl AsRef<Path>, opts: EngineOptions) -> Result<Self, OvnError>;

    pub fn database(&self, name: &str) -> Result<Database, OvnError>;
    pub fn list_databases(&self) -> Result<Vec<String>, OvnError>;
    pub fn drop_database(&self, name: &str) -> Result<(), OvnError>;

    pub fn stats(&self) -> EngineStats;
    pub fn metrics_snapshot(&self) -> MetricsSnapshot;

    pub fn shutdown(self) -> Result<(), OvnError>;
}
```

`EngineOptions` is a `#[non_exhaustive]` struct with `..Default::default()` extension pattern.

### 3.3 Database

```rust
impl Database {
    pub fn name(&self) -> &str;
    pub fn collection(&self, name: &str) -> Result<Collection, OvnError>;
    pub fn create_collection(&self, name: &str, opts: CollectionOptions) -> Result<Collection, OvnError>;
    pub fn drop_collection(&self, name: &str) -> Result<(), OvnError>;
    pub fn list_collections(&self) -> Result<Vec<String>, OvnError>;

    pub async fn begin_transaction(&self, opts: TxOptions) -> Result<Transaction, OvnError>;

    pub async fn run_aggregate(&self, pipeline: Pipeline) -> Result<Cursor<'_, Document>, OvnError>;
}
```

### 3.4 Collection (CRUD)

```rust
impl Collection {
    // Insert
    pub async fn insert_one(&self, doc: Document) -> Result<InsertOneResult, OvnError>;
    pub async fn insert_many(&self, docs: Vec<Document>) -> Result<InsertManyResult, OvnError>;
    pub async fn insert_one_in(&self, tx: &Transaction, doc: Document) -> Result<InsertOneResult, OvnError>;

    // Find
    pub fn find(&self, filter: Filter) -> FindBuilder<'_>;        // builder; not awaited yet
    pub async fn find_one(&self, filter: Filter) -> Result<Option<Document>, OvnError>;
    pub async fn find_by_id(&self, id: ObjectId) -> Result<Option<Document>, OvnError>;
    pub async fn count(&self, filter: Filter) -> Result<u64, OvnError>;

    // Update
    pub async fn update_one(&self, filter: Filter, update: Update) -> Result<UpdateResult, OvnError>;
    pub async fn update_many(&self, filter: Filter, update: Update) -> Result<UpdateResult, OvnError>;
    pub async fn replace_one(&self, filter: Filter, doc: Document) -> Result<UpdateResult, OvnError>;

    // Delete
    pub async fn delete_one(&self, filter: Filter) -> Result<DeleteResult, OvnError>;
    pub async fn delete_many(&self, filter: Filter) -> Result<DeleteResult, OvnError>;

    // Upsert
    pub async fn upsert(&self, filter: Filter, update: Update) -> Result<UpsertResult, OvnError>;

    // Bulk
    pub async fn bulk_write(&self, ops: Vec<BulkOp>, opts: BulkOptions) -> Result<BulkResult, OvnError>;

    // Distinct / aggregate
    pub async fn distinct(&self, field: &str, filter: Filter) -> Result<Vec<Value>, OvnError>;
    pub async fn aggregate(&self, pipeline: Pipeline) -> Result<Cursor<'_, Document>, OvnError>;

    // Watch (change streams)
    pub fn watch(&self, opts: WatchOptions) -> ChangeStream<'_>;

    // Indexes
    pub async fn create_index(&self, spec: IndexSpec) -> Result<String, OvnError>;
    pub async fn drop_index(&self, name: &str) -> Result<(), OvnError>;
    pub async fn list_indexes(&self) -> Result<Vec<IndexInfo>, OvnError>;
}
```

### 3.5 FindBuilder

```rust
impl<'c> FindBuilder<'c> {
    pub fn limit(mut self, n: i64) -> Self;
    pub fn skip(mut self, n: u64) -> Self;
    pub fn sort(mut self, key: impl Into<Sort>) -> Self;
    pub fn project(mut self, projection: Projection) -> Self;
    pub fn batch_size(mut self, n: u32) -> Self;
    pub fn timeout(mut self, dur: Duration) -> Self;
    pub fn hint(mut self, index: &str) -> Self;
    pub fn read_concern(mut self, rc: ReadConcern) -> Self;
    pub fn in_tx(mut self, tx: &'c Transaction) -> Self;

    pub async fn execute(self) -> Result<Cursor<'c, Document>, OvnError>;
    pub async fn collect(self) -> Result<Vec<Document>, OvnError>;
    pub async fn explain(self) -> Result<ExplainPlan, OvnError>;
}
```

### 3.6 Transactions

```rust
impl Transaction {
    pub fn id(&self) -> TxId;
    pub fn isolation(&self) -> IsolationLevel;
    pub async fn savepoint(&self, name: &str) -> Result<(), OvnError>;
    pub async fn rollback_to(&self, name: &str) -> Result<(), OvnError>;
    pub async fn commit(self) -> Result<CommitInfo, OvnError>;
    pub async fn rollback(self) -> Result<(), OvnError>;
}

impl Drop for Transaction {
    fn drop(&mut self) {
        // Auto-rollback if not committed; logged at warn
    }
}
```

Convenience helper:

```rust
pub async fn run_in_transaction<F, T>(db: &Database, opts: TxOptions, body: F) -> Result<T, OvnError>
where
    F: AsyncFnOnce(&Transaction) -> Result<T, OvnError>;
```

Retries on serialization conflicts up to `TxOptions::max_retries` (default 3) with exponential backoff.

### 3.7 Watch / change streams

```rust
pub struct ChangeStream<'c> { /* opaque */ }

#[derive(Debug, Clone)]
pub struct ChangeEvent {
    pub op:        ChangeOp,         // Insert | Update | Delete | Drop
    pub _id:       ObjectId,
    pub doc_before:Option<Document>, // depends on options
    pub doc_after: Option<Document>,
    pub patch:     Option<Vec<JsonPatchOp>>,
    pub hlc:       u64,
    pub txn_id:    TxId,
}

impl<'c> Stream for ChangeStream<'c> {
    type Item = Result<ChangeEvent, OvnError>;
    /* tokio Stream */
}
```

Backed by oplog tailing `[[FILE-09]]` §3.

### 3.8 Document & Value

```rust
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Double(f64),
    Str(String),
    Bytes(Bytes),
    Array(Vec<Value>),
    Object(Document),
    ObjectId(ObjectId),
    DateTime(i64),
    Decimal128(Decimal),
    UUID([u8; 16]),
    Vector(Vec<f32>),
    GeoPoint { lat: f64, lng: f64 },
    Encrypted(Vec<u8>),
}

pub type Document = OrderedMap<String, Value>;

impl Document {
    pub fn from_json(s: &str) -> Result<Self, OvnError>;
    pub fn to_json(&self) -> String;
    pub fn get(&self, key: &str) -> Option<&Value>;
    pub fn get_path(&self, json_pointer: &str) -> Option<&Value>;
    pub fn set(&mut self, key: &str, val: Value);
    pub fn set_path(&mut self, json_pointer: &str, val: Value);
    pub fn deep_clone(&self) -> Self;
}

// Macro
let doc = doc! {
    "name":   "Ada",
    "age":    37,
    "tags":   ["admin", "math"],
    "active": true
};
```

### 3.9 Result types

```rust
pub struct InsertOneResult  { pub inserted_id: ObjectId, pub hlc: u64 }
pub struct InsertManyResult { pub inserted_ids: Vec<ObjectId>, pub hlc: u64 }
pub struct UpdateResult     { pub matched: u64, pub modified: u64, pub upserted_id: Option<ObjectId> }
pub struct UpsertResult     { pub upserted_id: ObjectId, pub created: bool }
pub struct DeleteResult     { pub deleted: u64 }
pub struct CommitInfo       { pub commit_lsn: u64, pub hlc: u64 }
pub struct ExplainPlan      { /* serializable to JSON; see [[FILE-12]] §6 */ }
```

---

## 4. Node.js / TypeScript API

Mirror of Rust API; promises instead of futures; `Buffer`/`Uint8Array` for bytes.

### 4.1 Index file (`lib/index.d.ts` excerpt)

```typescript
export class Engine {
  static open(path: string, opts?: EngineOptions): Promise<Engine>;
  database(name: string): Database;
  listDatabases(): Promise<string[]>;
  dropDatabase(name: string): Promise<void>;
  stats(): EngineStats;
  shutdown(): Promise<void>;
}

export class Collection {
  insertOne(doc: Document): Promise<InsertOneResult>;
  insertMany(docs: Document[]): Promise<InsertManyResult>;
  find(filter?: Filter): FindCursor<Document>;
  findOne(filter?: Filter): Promise<Document | null>;
  findById(id: ObjectId | string): Promise<Document | null>;
  count(filter?: Filter): Promise<number>;
  updateOne(filter: Filter, update: Update): Promise<UpdateResult>;
  updateMany(filter: Filter, update: Update): Promise<UpdateResult>;
  replaceOne(filter: Filter, doc: Document): Promise<UpdateResult>;
  deleteOne(filter: Filter): Promise<DeleteResult>;
  deleteMany(filter: Filter): Promise<DeleteResult>;
  upsert(filter: Filter, update: Update): Promise<UpsertResult>;
  bulkWrite(ops: BulkOp[], opts?: BulkOptions): Promise<BulkResult>;
  aggregate(pipeline: PipelineStage[]): AggregationCursor<Document>;
  distinct(field: string, filter?: Filter): Promise<Value[]>;
  watch(opts?: WatchOptions): ChangeStream;
  createIndex(spec: IndexSpec): Promise<string>;
  listIndexes(): Promise<IndexInfo[]>;
}

export interface FindCursor<T> extends AsyncIterable<T> {
  limit(n: number): this;
  skip(n: number): this;
  sort(key: SortSpec): this;
  project(p: Projection): this;
  batchSize(n: number): this;
  timeout(ms: number): this;
  hint(index: string): this;
  toArray(): Promise<T[]>;
  next(): Promise<T | null>;
  close(): Promise<void>;
  explain(verbosity?: 'plain' | 'full' | 'profile'): Promise<ExplainPlan>;
}
```

### 4.2 Errors

`OvnError` mapped to a JS `class OvnError extends Error` with:

```typescript
class OvnError extends Error {
  code: string;          // e.g. "TX_CONFLICT", "VALIDATION", "WRITE_CONFLICT"
  category: string;      // "transient" | "permanent" | "config"
  cause?: Error;
  hlc?: number;
  context?: Record<string, unknown>;
  isRetryable(): boolean;
}
```

### 4.3 Streams as async iterables

```typescript
for await (const doc of coll.find({ status: "active" }).batchSize(500)) {
  process(doc);
}
```

### 4.4 ChangeStream

```typescript
const stream = coll.watch({ fullDocument: 'updateLookup' });
stream.on('change', evt => emit(evt));
stream.on('error', err => alert(err));
await stream.close();
```

---

## 5. C ABI

Goal: language-agnostic ABI usable from Go, Swift, Java (JNI), .NET, Zig.

### 5.1 Conventions

* `extern "C"`, no Rust panics across boundary.
* All handles are opaque pointers.
* Strings are UTF-8 length-prefixed (`const uint8_t*`, `size_t len`); never NUL-relied.
* Errors reported via return code + thread-local last-error string.

### 5.2 Selected functions (40+ in full)

```c
typedef struct ovn_engine ovn_engine_t;
typedef struct ovn_database ovn_database_t;
typedef struct ovn_collection ovn_collection_t;
typedef struct ovn_cursor ovn_cursor_t;
typedef struct ovn_tx ovn_tx_t;

typedef int32_t ovn_status_t;       /* 0 = OK */

/* Engine lifecycle */
ovn_status_t ovn_open(const char* path, const ovn_open_opts_t* opts, ovn_engine_t** out);
ovn_status_t ovn_close(ovn_engine_t* eng);

/* Database */
ovn_status_t ovn_database_get(ovn_engine_t* eng, const char* name, ovn_database_t** out);
ovn_status_t ovn_database_drop(ovn_engine_t* eng, const char* name);
ovn_status_t ovn_database_list(ovn_engine_t* eng, ovn_string_array_t** out); /* free with ovn_string_array_free */

/* Collection */
ovn_status_t ovn_collection_get(ovn_database_t* db, const char* name, ovn_collection_t** out);
ovn_status_t ovn_collection_create(ovn_database_t* db, const char* name, const ovn_coll_opts_t* opts, ovn_collection_t** out);
ovn_status_t ovn_collection_drop(ovn_database_t* db, const char* name);

/* CRUD */
ovn_status_t ovn_insert_one(ovn_collection_t* coll, const uint8_t* obe, size_t obe_len, ovn_object_id_t* out_id);
ovn_status_t ovn_insert_many(ovn_collection_t* coll, const uint8_t* obe_array, size_t obe_array_len, uint32_t doc_count, ovn_object_id_array_t** out);
ovn_status_t ovn_find(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, const ovn_find_opts_t* opts, ovn_cursor_t** out);
ovn_status_t ovn_find_one(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, ovn_buf_t* out_doc /* nullable */);
ovn_status_t ovn_count(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, uint64_t* out);
ovn_status_t ovn_update_one(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, const uint8_t* update, size_t update_len, ovn_update_result_t* out);
ovn_status_t ovn_update_many(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, const uint8_t* update, size_t update_len, ovn_update_result_t* out);
ovn_status_t ovn_replace_one(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, const uint8_t* doc, size_t doc_len, ovn_update_result_t* out);
ovn_status_t ovn_delete_one(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, ovn_delete_result_t* out);
ovn_status_t ovn_delete_many(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, ovn_delete_result_t* out);
ovn_status_t ovn_upsert(ovn_collection_t* coll, const uint8_t* filter, size_t filter_len, const uint8_t* update, size_t update_len, ovn_upsert_result_t* out);

/* Cursor */
ovn_status_t ovn_cursor_next(ovn_cursor_t* cur, ovn_buf_t* out_doc /* set len=0 when EOF */);
ovn_status_t ovn_cursor_batch(ovn_cursor_t* cur, ovn_buf_array_t** out_batch);
ovn_status_t ovn_cursor_close(ovn_cursor_t* cur);

/* Transactions */
ovn_status_t ovn_tx_begin(ovn_database_t* db, const ovn_tx_opts_t* opts, ovn_tx_t** out);
ovn_status_t ovn_tx_commit(ovn_tx_t* tx, ovn_commit_info_t* out /* nullable */);
ovn_status_t ovn_tx_rollback(ovn_tx_t* tx);
ovn_status_t ovn_tx_savepoint(ovn_tx_t* tx, const char* name);
ovn_status_t ovn_tx_rollback_to(ovn_tx_t* tx, const char* name);

/* Aggregation */
ovn_status_t ovn_aggregate(ovn_collection_t* coll, const uint8_t* pipeline, size_t pipeline_len, ovn_cursor_t** out);

/* Indexes */
ovn_status_t ovn_index_create(ovn_collection_t* coll, const uint8_t* spec, size_t spec_len, char** out_name);
ovn_status_t ovn_index_drop(ovn_collection_t* coll, const char* name);
ovn_status_t ovn_index_list(ovn_collection_t* coll, ovn_index_array_t** out);

/* Watch */
ovn_status_t ovn_watch(ovn_collection_t* coll, const ovn_watch_opts_t* opts, ovn_change_stream_t** out);
ovn_status_t ovn_change_stream_next(ovn_change_stream_t* cs, ovn_change_event_t* out, int32_t timeout_ms);
ovn_status_t ovn_change_stream_close(ovn_change_stream_t* cs);

/* Errors */
const char* ovn_last_error(void);            /* thread-local; valid until next ovn_* call */
const char* ovn_status_string(ovn_status_t); /* static string for status code */

/* Memory management */
void ovn_buf_free(ovn_buf_t* buf);
void ovn_string_array_free(ovn_string_array_t* arr);
void ovn_object_id_array_free(ovn_object_id_array_t* arr);
void ovn_index_array_free(ovn_index_array_t* arr);
void ovn_buf_array_free(ovn_buf_array_t* arr);

/* Versioning */
const char* ovn_version_string(void);
uint32_t    ovn_abi_version(void);     /* monotonic; bumped on breaking change */
```

### 5.3 ABI versioning

`ovn_abi_version()` returns a `uint32_t`. Callers compare to a compile-time constant:

```c
#define OVN_ABI_REQUIRED 0x00010000
if (ovn_abi_version() < OVN_ABI_REQUIRED) { /* refuse to load */ }
```

ABI breaking changes bump the major component; additions bump minor.

---

## 6. C++ wrapper

Header-only `oblivinx.hpp`, requires C++17. RAII over the C ABI:

```cpp
namespace ovn {
  class Engine {
  public:
    static std::unique_ptr<Engine> open(std::string_view path, OpenOptions = {});
    Database database(std::string_view name);
    void shutdown();
  };

  class Collection {
  public:
    ObjectId insertOne(const Document&);
    std::vector<ObjectId> insertMany(std::span<const Document>);
    Cursor find(const Filter&, FindOptions = {});
    std::optional<Document> findOne(const Filter&);
    UpdateResult updateOne(const Filter&, const Update&);
    /* ... all mirror Rust API ... */
  };

  class Cursor {
  public:
    bool next(Document& out);
    std::vector<Document> toVector();
    ~Cursor() noexcept;
  };
}
```

Errors thrown as `ovn::OvnException` (subclass of `std::runtime_error`) with `code()` returning `OvnError` enum.

---

## 7. REST API

Optional sidecar `ovnsd` exposes HTTP/JSON. Versioned URLs (`/v1/...`).

### 7.1 Authentication

* Bearer JWT (`Authorization: Bearer <token>`).
* mTLS optional.
* API keys (`X-OVN-Key`) for service accounts.

### 7.2 Endpoint catalog

```
POST   /v1/databases/{db}/collections/{coll}              create collection
GET    /v1/databases/{db}/collections                     list collections
DELETE /v1/databases/{db}/collections/{coll}              drop collection

POST   /v1/databases/{db}/collections/{coll}/docs         insert (one or many)
GET    /v1/databases/{db}/collections/{coll}/docs/{id}    find by id
POST   /v1/databases/{db}/collections/{coll}/find         find (filter in body)
POST   /v1/databases/{db}/collections/{coll}/aggregate    aggregate pipeline
POST   /v1/databases/{db}/collections/{coll}/update       update (filter + update)
POST   /v1/databases/{db}/collections/{coll}/delete       delete (filter)
POST   /v1/databases/{db}/collections/{coll}/upsert       upsert
POST   /v1/databases/{db}/collections/{coll}/bulk         bulk write
POST   /v1/databases/{db}/collections/{coll}/distinct     distinct
POST   /v1/databases/{db}/collections/{coll}/count        count

POST   /v1/databases/{db}/collections/{coll}/indexes      create index
GET    /v1/databases/{db}/collections/{coll}/indexes      list indexes
DELETE /v1/databases/{db}/collections/{coll}/indexes/{n}  drop index

POST   /v1/databases/{db}/transactions                    begin tx → returns tx id
POST   /v1/databases/{db}/transactions/{txid}/commit
POST   /v1/databases/{db}/transactions/{txid}/rollback
POST   /v1/databases/{db}/transactions/{txid}/savepoint
POST   /v1/databases/{db}/transactions/{txid}/rollback_to

GET    /v1/admin/status                                   summary
GET    /v1/admin/queries                                  active queries
POST   /v1/admin/queries/{id}/cancel
GET    /v1/admin/replication                              replica state
GET    /v1/health/live
GET    /v1/health/ready
GET    /v1/metrics                                        Prometheus
```

### 7.3 Request/response shapes (JSON Schema sketch)

`POST /v1/databases/{db}/collections/{coll}/find`:

```jsonc
// Request
{
  "filter":     { "status": "active" },
  "projection": { "_id": 1, "name": 1 },
  "sort":       { "created_at": -1 },
  "limit":      50,
  "skip":       0,
  "hint":       "by_status",
  "txn":        "tx_18421",          // optional
  "readConcern":"snapshot"           // optional
}

// Response
{
  "docs":   [ /* documents */ ],
  "cursor": {
    "id":   "cur_84210",            // present if more results
    "ns":   "app.orders",
    "next": "/v1/databases/app/cursors/cur_84210/next"
  },
  "stats":  {
    "duration_us": 4111,
    "rows_examined": 24503,
    "rows_returned": 50
  }
}
```

### 7.4 Error envelope

```jsonc
{
  "error": {
    "code":     "TX_CONFLICT",
    "message":  "Serialization conflict; retry advised.",
    "category": "transient",
    "retryAfterMs": 25,
    "details":  { /* op-specific */ }
  },
  "requestId": "req_a1b2c3d4",
  "hlc":       18420391284820
}
```

HTTP status codes:

| Code | Meaning                                |
| ---- | -------------------------------------- |
| 200  | OK                                     |
| 201  | Created (insert)                       |
| 400  | Validation / bad request               |
| 401  | Unauthenticated                        |
| 403  | Authorized but forbidden               |
| 404  | Not found                              |
| 409  | Conflict (transient — retry)           |
| 423  | Locked (write backpressure)            |
| 429  | Rate limited                           |
| 500  | Internal                               |
| 503  | Engine starting / shutting down        |
| 507  | Insufficient storage                   |

### 7.5 Cursor lifecycle

`/v1/databases/{db}/cursors/{id}/next` returns next batch; `DELETE` closes; idle cursors expire after `cursor_idle_ttl_s` (default 600).

---

## 8. WebSocket watch

`GET /v1/databases/{db}/collections/{coll}/watch` upgrades to WebSocket. Frames:

```jsonc
// Server → client
{
  "evt":       "change",
  "op":        "update",
  "_id":       "65f1a2…",
  "fullDocument": { /* if requested */ },
  "patch":     [ { "op": "replace", "path": "/status", "value": "shipped" } ],
  "hlc":       18420391284820
}

{ "evt": "heartbeat", "hlc": 18420391284820 }

{ "evt": "error", "code": "INVALID_TOKEN", "message": "..." }
```

```jsonc
// Client → server
{ "cmd": "ack", "upTo": 18420391284820 }
{ "cmd": "close" }
```

---

## 9. gRPC

Proto file `oblivinx/v1/api.proto` (sketch):

```proto
service OvnService {
  rpc Insert (InsertReq) returns (InsertResp);
  rpc Find   (FindReq)   returns (stream Document);
  rpc Update (UpdateReq) returns (UpdateResp);
  rpc Delete (DeleteReq) returns (DeleteResp);
  rpc Aggregate (AggregateReq) returns (stream Document);
  rpc Watch  (WatchReq)  returns (stream ChangeEvent);
  rpc Begin  (BeginReq)  returns (BeginResp);
  rpc Commit (CommitReq) returns (CommitResp);
  rpc Rollback (RollbackReq) returns (RollbackResp);
}
```

Bytes use `google.protobuf.BytesValue` for OBE-encoded documents to avoid double serialization. Streaming RPCs map naturally to cursors.

---

## 10. Error catalog

Stable across surfaces; each `OvnError` variant has:

| Variant                       | Code              | HTTP | Category   | Retryable |
| ----------------------------- | ----------------- | ---- | ---------- | --------- |
| `Validation`                  | `VALIDATION`      | 400  | permanent  | no        |
| `NotFound`                    | `NOT_FOUND`       | 404  | permanent  | no        |
| `DuplicateKey`                | `DUP_KEY`         | 409  | permanent  | no        |
| `WriteConflict`               | `WRITE_CONFLICT`  | 409  | transient  | yes       |
| `TxConflict`                  | `TX_CONFLICT`     | 409  | transient  | yes       |
| `WriteBackpressure(ms)`       | `BUSY`            | 423  | transient  | yes       |
| `RateLimited(ms)`             | `RATE_LIMITED`    | 429  | transient  | yes       |
| `Unauthorized`                | `UNAUTHORIZED`    | 401  | permanent  | no        |
| `Forbidden`                   | `FORBIDDEN`       | 403  | permanent  | no        |
| `Cancelled`                   | `CANCELLED`       | 499  | permanent  | no        |
| `Timeout`                     | `TIMEOUT`         | 408  | transient  | yes       |
| `IndexUnavailable`            | `INDEX_BUSY`      | 503  | transient  | yes       |
| `SchemaMismatch`              | `SCHEMA`          | 400  | permanent  | no        |
| `IoError(io::Error)`          | `IO`              | 500  | transient* | maybe     |
| `Corruption`                  | `CORRUPTION`      | 500  | permanent  | no        |
| `Internal`                    | `INTERNAL`        | 500  | permanent  | no        |
| `Shutdown`                    | `SHUTDOWN`        | 503  | transient  | yes       |
| `ReadOnly`                    | `READ_ONLY`       | 503  | permanent  | no        |
| `KmsError`                    | `KMS`             | 500  | transient  | maybe     |
| `Replication(...)`            | `REPL_*`          | 500  | varies     | varies    |

`*` IO errors are treated as transient by default but the engine may demote to permanent if persistence is broken.

---

## 11. Versioning & compatibility

* **Semantic versioning** for crates and packages.
* **Wire/REST**: path-versioned (`/v1/...`). Removing a field is breaking; adding optional fields is non-breaking.
* **C ABI**: `OVN_ABI_VERSION` constant; major bump on breaking change.
* **Document model**: see `[[FILE-03]]` §13 for forward compatibility.

Deprecation policy: 2 minor releases (≈ 6 months) of warnings before removal. Deprecations surface in:

* Rust: `#[deprecated]`.
* Node.js: `console.warn`.
* C: status code `OVN_DEPRECATED` (for entry points whose signature is stable but whose semantics will change).

---

## 12. Tracing context

Every entry point accepts an optional `Context`:

```rust
pub struct Context {
    pub trace_id: Option<[u8; 16]>,
    pub span_id:  Option<[u8; 8]>,
    pub baggage:  Option<HashMap<String, String>>,
    pub deadline: Option<Instant>,
    pub cancel:   Option<CancelToken>,
    pub user:     Option<UserHandle>,
}
```

Default context derives from current task-local (Tokio) or thread-local. REST surface accepts:

* `Traceparent` header (W3C Trace Context).
* `X-OVN-Deadline-Ms` header.
* `X-OVN-Request-Id` header (echoed in response).

---

## 13. Examples

### 13.1 Rust

```rust
use oblivinx3x::{Engine, EngineOptions, doc, Filter, Update};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let engine = Engine::open_async("./data/app.ovn2", EngineOptions::default()).await?;
    let db    = engine.database("app")?;
    let users = db.collection("users")?;

    users.insert_one(doc! { "name": "Ada", "age": 37 }).await?;

    let cursor = users
        .find(Filter::expr("age > 30"))
        .sort("age desc")
        .limit(10)
        .execute().await?;

    let docs = cursor.collect().await?;
    println!("{} docs", docs.len());
    Ok(())
}
```

### 13.2 Node.js

```javascript
import { Engine } from "oblivinx3x";

const engine = await Engine.open("./data/app.ovn2");
const users  = engine.database("app").collection("users");

await users.insertOne({ name: "Ada", age: 37 });

for await (const doc of users.find({ age: { $gt: 30 } }).sort({ age: -1 }).limit(10)) {
  console.log(doc.name);
}

await engine.shutdown();
```

### 13.3 C

```c
#include "oblivinx.h"

int main(void) {
  ovn_engine_t* eng;
  if (ovn_open("./data/app.ovn2", NULL, &eng) != 0) { fputs(ovn_last_error(), stderr); return 1; }

  ovn_database_t* db;   ovn_database_get(eng, "app", &db);
  ovn_collection_t* c;  ovn_collection_get(db, "users", &c);

  /* insert: build OBE inline (sample helper) */
  uint8_t obe[256]; size_t obe_len = ovn_obe_doc(obe, sizeof obe, "{\"name\":\"Ada\",\"age\":37}");
  ovn_object_id_t id;
  ovn_insert_one(c, obe, obe_len, &id);

  ovn_close(eng);
  return 0;
}
```

### 13.4 REST

```bash
curl -X POST https://api.example.com/v1/databases/app/collections/users/find \
     -H 'Authorization: Bearer eyJ...' \
     -H 'Content-Type: application/json' \
     -d '{"filter":{"age":{"$gt":30}},"sort":{"age":-1},"limit":10}'
```

---

## 14. Tradeoffs

| Decision                       | Chosen                              | Alternative              | Why                              |
| ------------------------------ | ----------------------------------- | ------------------------ | -------------------------------- |
| Builder vs option struct       | Builder for find; struct for engine | All struct               | Reads more naturally for queries |
| Errors as values (Rust)        | `Result<_, OvnError>`               | Exceptions               | Idiomatic, no panics across FFI  |
| Cursor model                   | Pull-based                          | Push (callbacks)         | Simpler backpressure             |
| Bulk write atomicity           | Per-shard atomic                    | Globally atomic          | Avoids cross-shard coordination  |
| REST URL versioning            | `/v1/`                              | Header-based             | Visible in logs and curl        |
| C string encoding              | UTF-8 + length                      | NUL-terminated only      | Tolerates embedded NULs          |
| Tx auto-rollback on drop       | Yes (with warn log)                 | Panic                    | Safer default                    |
| Watch transport (in-process)   | `Stream<Item=ChangeEvent>`          | Callback                 | Plays with async runtimes        |

---

## 15. Open questions

* **GraphQL** front-end (likely a community plugin, not core).
* **WebTransport** for low-latency mobile.
* **Query language plugin** — let frameworks expose their own DSL.
* **Multi-document atomic bulk** across collections (would require global txn coordination).

---

## 16. Cross-references

* `[[FILE-03]]` — document model used in all surfaces.
* `[[FILE-05]]` — query semantics that the API must implement.
* `[[FILE-06]]` — transactions exposed via API.
* `[[FILE-07]]` — auth attached to API requests.
* `[[FILE-09]]` — replication endpoints under `/v1/admin/replication`.
* `[[FILE-12]]` — observability endpoints.
* `[[FILE-15]]` — OQL accepted in `Filter`.
* `[[FILE-20]]/010` — ADR for API design choices.

*End of `13-API-DESIGN.md` — 690 lines.*
