# 12 — OBSERVABILITY

> **Audience:** Engine implementers, operators, SREs running Oblivinx3x in production.
> **Status:** Specification (target v0.3 metrics, v0.4 traces, v0.5 profiler).
> **Cross refs:** All other files (every subsystem emits metrics defined here).

---

## 1. Purpose

Observability is the operator's only window into a running database. The goals:

1. **Black-box health** — Is it up? Is it serving? Is it slow?
2. **Capacity planning** — Are we close to a resource ceiling?
3. **Failure forensics** — When something broke, what was happening?
4. **Performance debugging** — Where are the µs going? Which query is hot?

This document defines:

* The **metric registry** with stable names, types, and units.
* The **slow query log** format and triggers.
* The **per-query profiler** output.
* **OpenTelemetry** integration (metrics + traces + logs).
* **Operator dashboards** (suggested PromQL/Grafana panels).

Stable names matter: dashboards and alerts depend on them. The registry below is **versioned**; renames require a major-version deprecation cycle.

---

## 2. Metric naming conventions

* Prefix: `obx_` (from "OBlivinX").
* Words separated by `_`.
* Suffix encodes unit:
  * `_bytes` — bytes
  * `_seconds` — seconds (float for histograms)
  * `_us` — microseconds (gauges/counters)
  * `_total` — counter
  * `_count` — gauge of objects
  * `_ratio` — gauge in [0,1]
  * (no suffix) — gauge in domain unit (e.g., `obx_buffer_pool_pages`)

* Labels are lowercase snake_case; common labels: `db`, `collection`, `index_name`, `op`, `result`, `source` (`primary`/`replica`), `peer`.

This matches Prometheus best practices and OpenTelemetry semantic conventions where they overlap.

---

## 3. Metric registry

### 3.1 Engine-wide

| Name                            | Type      | Unit      | Labels                  | Description                                  |
| ------------------------------- | --------- | --------- | ----------------------- | -------------------------------------------- |
| `obx_build_info`                | gauge=1   | —         | `version,git_sha,rust`  | One per process, identifies build            |
| `obx_uptime_seconds`            | counter   | s         | —                       | Seconds since `Engine::open`                 |
| `obx_open_databases`            | gauge     | count     | —                       | Number of open `.ovn2` files                 |
| `obx_threads_active`            | gauge     | count     | `pool`                  | Threads in each pool (read, write, io, …)    |
| `obx_pending_queue_depth`       | gauge     | count     | `pool`                  | Items queued for each pool                   |
| `obx_panic_total`               | counter   | count     | `where`                 | Recovered panics in background workers       |
| `obx_shutdown_state`            | gauge     | enum      | —                       | 0=running 1=draining 2=stopped 3=read-only   |

### 3.2 Storage / pages

| Name                                 | Type      | Unit  | Labels                | Description                              |
| ------------------------------------ | --------- | ----- | --------------------- | ---------------------------------------- |
| `obx_db_size_bytes`                  | gauge     | B     | `db`                  | On-disk size                             |
| `obx_page_count`                     | gauge     | count | `db,page_type`        | Pages by type                            |
| `obx_page_read_total`                | counter   | count | `db,source`           | Page reads (source=disk/cache)           |
| `obx_page_write_total`               | counter   | count | `db`                  | Page writes                              |
| `obx_page_alloc_total`               | counter   | count | `db,page_type`        | New page allocations                     |
| `obx_page_free_total`                | counter   | count | `db,page_type`        | Pages freed                              |
| `obx_overflow_chain_length_buckets`  | histogram | count | `db,collection`       | Distribution of overflow chains          |
| `obx_freelist_size`                  | gauge     | count | `db`                  | Pages on freelist                        |

### 3.3 Buffer pool

| Name                              | Type      | Unit  | Labels       | Description                                     |
| --------------------------------- | --------- | ----- | ------------ | ----------------------------------------------- |
| `obx_buffer_pool_pages`           | gauge     | count | —            | Pages resident                                  |
| `obx_buffer_pool_bytes`           | gauge     | B     | —            | Bytes resident                                  |
| `obx_buffer_pool_hit_total`       | counter   | count | —            | Hits                                            |
| `obx_buffer_pool_miss_total`      | counter   | count | —            | Misses                                          |
| `obx_buffer_pool_hit_ratio`       | gauge     | ratio | —            | Recent hit ratio (EWMA over 60 s)               |
| `obx_buffer_pool_evictions_total` | counter   | count | `reason`     | reason=arc/clock/manual                         |
| `obx_buffer_pool_pin_total`       | counter   | count | —            | Pin operations                                  |
| `obx_buffer_pool_pin_seconds`     | histogram | s     | —            | Time pages stayed pinned                        |
| `obx_buffer_pool_dirty_pages`     | gauge     | count | —            | Currently dirty                                 |
| `obx_buffer_pool_partition_load`  | gauge     | ratio | `partition`  | Per-partition occupancy                         |

### 3.4 WAL & checkpoint

| Name                                 | Type      | Unit  | Labels        | Description                                   |
| ------------------------------------ | --------- | ----- | ------------- | --------------------------------------------- |
| `obx_wal_bytes_written_total`        | counter   | B     | —             | Total bytes appended                          |
| `obx_wal_records_total`              | counter   | count | `record_type` | Records by type                               |
| `obx_wal_fsync_total`                | counter   | count | —             | fsyncs issued                                 |
| `obx_wal_fsync_seconds`              | histogram | s     | —             | fsync latency                                 |
| `obx_wal_group_commit_size_buckets`  | histogram | count | —             | Txns per fsync                                |
| `obx_wal_lag_bytes`                  | gauge     | B     | —             | Bytes between last_lsn and durable_lsn        |
| `obx_wal_segment_count`              | gauge     | count | —             | Segments on disk                              |
| `obx_wal_truncate_total`             | counter   | count | —             | Truncate events                               |
| `obx_checkpoint_total`               | counter   | count | `kind,result` | kind=passive/full/restart, result=ok/fail     |
| `obx_checkpoint_seconds`             | histogram | s     | `kind`        | Checkpoint duration                           |
| `obx_checkpoint_pages_flushed`       | histogram | count | —             | Pages flushed per checkpoint                  |
| `obx_recovery_seconds`               | histogram | s     | —             | Last recovery duration on open                |

### 3.5 MVCC / transactions

| Name                              | Type      | Unit  | Labels         | Description                              |
| --------------------------------- | --------- | ----- | -------------- | ---------------------------------------- |
| `obx_tx_started_total`            | counter   | count | `iso`          | Transactions started by isolation level  |
| `obx_tx_committed_total`          | counter   | count | `iso`          | Successful commits                       |
| `obx_tx_aborted_total`            | counter   | count | `iso,reason`   | Aborts (conflict, timeout, user)         |
| `obx_tx_active`                   | gauge     | count | —              | Currently active txns                    |
| `obx_tx_duration_seconds`         | histogram | s     | `iso`          | Begin-to-commit duration                 |
| `obx_tx_conflict_total`           | counter   | count | `kind`         | kind=ww/rw/skew                          |
| `obx_mvcc_versions`               | gauge     | count | `collection`   | Live version count per collection        |
| `obx_mvcc_horizon_seconds`        | gauge     | s     | —              | Age of oldest live snapshot              |
| `obx_vacuum_seconds`              | histogram | s     | —              | Vacuum runtime                           |
| `obx_vacuum_versions_collected`   | counter   | count | `collection`   | Versions reclaimed                       |

### 3.6 Query engine

| Name                              | Type      | Unit  | Labels                    | Description                                   |
| --------------------------------- | --------- | ----- | ------------------------- | --------------------------------------------- |
| `obx_query_total`                 | counter   | count | `db,collection,op,result` | op=find/insert/update/delete/aggregate        |
| `obx_query_duration_seconds`      | histogram | s     | `db,collection,op`        | End-to-end latency                            |
| `obx_query_planning_seconds`      | histogram | s     | `db,collection`           | Planner cost                                  |
| `obx_query_plan_cache_hits_total` | counter   | count | `db,collection`           | Plan cache hits                               |
| `obx_query_plan_cache_size`       | gauge     | count | —                         | Current plan cache size                       |
| `obx_query_rows_returned`         | histogram | count | `db,collection`           | Result row count                              |
| `obx_query_rows_examined`         | histogram | count | `db,collection`           | Rows scanned                                  |
| `obx_query_pages_read`            | histogram | count | `db,collection`           | Pages touched                                 |
| `obx_query_index_used_total`      | counter   | count | `db,collection,index`     | Each query attributes one index               |
| `obx_query_full_scan_total`       | counter   | count | `db,collection`           | Queries that fell back to scan                |
| `obx_query_aggregation_stage_seconds` | histogram | s | `stage`                   | Per pipeline stage                            |
| `obx_query_kill_total`            | counter   | count | `reason`                  | Killed by timeout / admin                     |

### 3.7 Indexes

| Name                                 | Type      | Unit  | Labels                  | Description                              |
| ------------------------------------ | --------- | ----- | ----------------------- | ---------------------------------------- |
| `obx_index_size_bytes`               | gauge     | B     | `db,collection,index`   | On-disk size                             |
| `obx_index_entries`                  | gauge     | count | `db,collection,index`   | Live entries                             |
| `obx_index_lookup_total`             | counter   | count | `db,collection,index`   | Lookups by index                         |
| `obx_index_lookup_seconds`           | histogram | s     | `db,collection,index`   | Lookup latency                           |
| `obx_index_build_seconds`            | histogram | s     | `db,collection,index`   | Build duration                           |
| `obx_index_build_progress_ratio`    | gauge     | ratio | `db,collection,index`   | 0..1 during builds                       |
| `obx_index_split_total`              | counter   | count | `db,collection,index`   | B-tree splits                            |
| `obx_index_merge_total`              | counter   | count | `db,collection,index`   | B-tree merges                            |
| `obx_fts_inverted_size_bytes`        | gauge     | B     | `db,collection,index`   | Inverted index size                      |
| `obx_fts_postings_per_term_buckets`  | histogram | count | `db,collection`         | Postings list length distribution        |
| `obx_vector_hnsw_layers`             | gauge     | count | `db,collection,index`   | HNSW layer count                         |
| `obx_vector_recall_at_10`            | gauge     | ratio | `db,collection,index`   | Periodic ground-truth eval               |

### 3.8 Compression

| Name                              | Type      | Unit  | Labels       | Description                              |
| --------------------------------- | --------- | ----- | ------------ | ---------------------------------------- |
| `obx_compress_ratio`              | histogram | ratio | `codec`      | uncompressed/compressed                  |
| `obx_compress_us`                 | histogram | µs    | `codec`      | Per-page compress cost                   |
| `obx_decompress_us`               | histogram | µs    | `codec`      | Per-page decompress cost                 |
| `obx_compress_dict_count`         | gauge     | count | —            | Dictionaries loaded                      |
| `obx_compress_dict_bytes`         | gauge     | B     | —            | Total dict memory                        |

### 3.9 Concurrency

| Name                                 | Type      | Unit  | Labels                    | Description                              |
| ------------------------------------ | --------- | ----- | ------------------------- | ---------------------------------------- |
| `obx_latch_wait_us`                  | histogram | µs    | `kind`                    | kind=page/index/buffer                    |
| `obx_latch_contention_total`         | counter   | count | `kind`                    | Times latch was already held              |
| `obx_lock_wait_us`                   | histogram | µs    | `mode`                    | mode=S/X/IS/IX/SIX                        |
| `obx_deadlock_detected_total`        | counter   | count | —                         | Deadlocks resolved by detector            |
| `obx_writer_backpressure_total`      | counter   | count | —                         | Times writers got `BUSY`                  |

### 3.10 Replication

| Name                                 | Type      | Unit  | Labels       | Description                                   |
| ------------------------------------ | --------- | ----- | ------------ | --------------------------------------------- |
| `obx_repl_state`                     | gauge     | enum  | `peer`       | 0=green 1=yellow 2=red 3=detached             |
| `obx_repl_role`                      | gauge     | enum  | —            | 0=primary 1=secondary 2=arbiter 3=peer        |
| `obx_repl_lag_seconds`               | gauge     | s     | `peer`       | clock-lag                                     |
| `obx_repl_lag_lsn`                   | gauge     | B     | `peer`       | LSN gap                                       |
| `obx_repl_oplog_apply_seconds`       | histogram | s     | `peer`       | Per-batch apply time                          |
| `obx_repl_bytes_sent_total`          | counter   | B     | `peer`       | Outbound bytes                                |
| `obx_repl_bytes_recv_total`          | counter   | B     | `peer`       | Inbound bytes                                 |
| `obx_repl_resync_total`              | counter   | count | `peer,reason`| Full resyncs                                  |
| `obx_repl_election_total`            | counter   | count | `result`     | Elections                                     |
| `obx_repl_failover_total`            | counter   | count | —            | Primary changes                               |

### 3.11 Security

| Name                              | Type      | Unit  | Labels         | Description                              |
| --------------------------------- | --------- | ----- | -------------- | ---------------------------------------- |
| `obx_auth_attempts_total`         | counter   | count | `result`       | result=ok/fail                           |
| `obx_authz_deny_total`            | counter   | count | `reason`       | Denied requests                          |
| `obx_audit_records_total`         | counter   | count | `kind`         | Audit entries written                    |
| `obx_kms_call_total`              | counter   | count | `op,result`    | KMS interactions                         |
| `obx_kms_call_seconds`            | histogram | s     | `op`           | KMS latency                              |
| `obx_key_rotation_total`          | counter   | count | `key`          | Master/sub-key rotations                 |
| `obx_rate_limit_drop_total`       | counter   | count | `bucket`       | Requests dropped by rate limiter         |

### 3.12 Plugins

| Name                              | Type      | Unit  | Labels                  | Description                          |
| --------------------------------- | --------- | ----- | ----------------------- | ------------------------------------ |
| `obx_plugin_loaded`               | gauge     | count | `name,version`          | Loaded plugins                       |
| `obx_plugin_call_total`           | counter   | count | `name,fn,result`        | Calls into plugin                    |
| `obx_plugin_call_seconds`         | histogram | s     | `name,fn`               | Call latency                         |
| `obx_plugin_memory_bytes`         | gauge     | B     | `name`                  | Wasm linear-mem usage                |
| `obx_plugin_oom_total`            | counter   | count | `name`                  | Plugin hit memory cap                |
| `obx_plugin_timeout_total`        | counter   | count | `name`                  | Plugin hit time cap                  |

### 3.13 OS / process (best-effort)

| Name                              | Type      | Unit  | Labels    | Description                              |
| --------------------------------- | --------- | ----- | --------- | ---------------------------------------- |
| `obx_proc_rss_bytes`              | gauge     | B     | —         | Resident set size                        |
| `obx_proc_open_fds`               | gauge     | count | —         | Open file descriptors                    |
| `obx_proc_cpu_seconds_total`      | counter   | s     | —         | CPU time                                 |
| `obx_proc_user_threads`           | gauge     | count | —         | Threads visible to OS                    |
| `obx_proc_alloc_bytes_total`      | counter   | B     | —         | Allocator-reported total                 |

---

## 4. Histogram bucket conventions

Latency histograms (in seconds) use a Prometheus-friendly bucket set:

```
[ 0.000_005, 0.000_010, 0.000_025, 0.000_050,
  0.000_100, 0.000_250, 0.000_500,
  0.001, 0.0025, 0.005, 0.010, 0.025, 0.050,
  0.1, 0.25, 0.5, 1, 2.5, 5, 10, +Inf ]
```

Size histograms (bytes) use a power-of-two ladder from 64 B to 1 GiB.

Engine internally maintains these as **HDR-histograms** to support quantile queries with bounded error (3 significant digits, range 1 µs–10 s).

---

## 5. Slow query log

### 5.1 Trigger conditions

A query is slow-logged if **any** of:

* `duration_us > slow_query_threshold_us` (default 100 ms).
* `pages_read > pages_threshold` (default 10,000).
* `result == 'error'` and error class ≠ `Cancelled`.
* `marked_slow=true` by EXPLAIN-ANALYZE or admin override.

### 5.2 Format (JSON-lines, append-only)

```jsonc
{
  "ts":          "2026-04-28T22:13:01.234567Z",
  "hlc":         18420391284820,
  "db":          "app",
  "collection":  "orders",
  "op":          "find",
  "duration_us": 142_318,
  "rows":        { "examined": 412_010, "returned": 24 },
  "pages":       { "read": 9_823, "from_cache": 1_204, "from_disk": 8_619 },
  "plan_summary":"COLL_SCAN(orders) → SORT(created_at DESC) → LIMIT(24)",
  "client":      { "user": "svc.checkout", "addr": "10.1.4.7" },
  "txn":         { "id": 19287342, "iso": "snapshot" },
  "explain":     { /* abbreviated; full available via /admin/queries/<id> */ }
}
```

File: `slow-queries.jsonl`, rotated daily, gzipped after rotation, retained `slow_query_retention_days` (default 14).

### 5.3 Sampling

Beyond hard thresholds, the engine samples 1% of all queries (configurable) into a **sampled query log** for distribution analysis without I/O blow-up.

---

## 6. Per-query profiler

`EXPLAIN(verbosity="full")` returns:

```jsonc
{
  "plan": {
    "node": "PROJECT",
    "fields": ["_id","total"],
    "child": {
      "node": "LIMIT", "n": 50,
      "child": {
        "node": "SORT", "key": "created_at DESC",
        "child": {
          "node": "INDEX_SCAN", "index": "by_status",
          "predicate": "status == 'pending'",
          "est_rows": 24_201
        }
      }
    }
  },
  "actuals": {
    "INDEX_SCAN":  { "rows": 24_503, "us": 3_182, "pages": 412 },
    "SORT":        { "rows": 24_503, "us":  912 },
    "LIMIT":       { "rows":     50, "us":    1 },
    "PROJECT":     { "rows":     50, "us":   12 }
  },
  "totals": { "us": 4_111, "pages": 412 }
}
```

`EXPLAIN(verbosity="profile")` adds per-node CPU samples gathered by a low-frequency sampler (frame-pointer-walk, 99 Hz).

---

## 7. Tracing (OpenTelemetry)

### 7.1 Spans

Every public API call opens a root span:

* `obx.engine.open`
* `obx.collection.find`
* `obx.collection.insert_many`
* `obx.aggregate`
* `obx.tx.begin`, `obx.tx.commit`

Internal child spans:

* `obx.plan` (planning)
* `obx.exec.<operator>` (per pipeline node)
* `obx.io.read_page`, `obx.io.write_page`, `obx.io.fsync`
* `obx.wal.append`
* `obx.checkpoint`
* `obx.repl.send_batch`, `obx.repl.apply_batch`

### 7.2 Standard attributes

| Attribute            | Type   | Source                                   |
| -------------------- | ------ | ---------------------------------------- |
| `db.system`          | string | always `"oblivinx"`                      |
| `db.name`            | string | database name                            |
| `db.collection`      | string | collection name                          |
| `db.operation`       | string | find/update/...                          |
| `db.statement`       | string | OQL/MQL text (subject to redaction)      |
| `db.rows_returned`   | int    | from query result                        |
| `db.rows_examined`   | int    | from profiler                            |
| `obx.plan_hash`      | string | plan-cache key                           |
| `obx.txn.id`         | int    | active txn                               |
| `obx.txn.iso`        | string | isolation level                          |
| `obx.codec`          | string | for io.read_page/write_page              |
| `obx.peer`           | string | for replication spans                    |

### 7.3 Exporters

* OTLP (gRPC) — preferred.
* OTLP (HTTP/JSON) — for browsers and locked-down environments.
* stdout — `OVN_OTEL=stdout`.

Spans/traces are off by default; enable via `OVN_OTEL=otlp+http://collector:4318` or programmatically.

### 7.4 Statement redaction

`db.statement` may contain user data. Two modes:

* **strict** (default in production) — replace literals with `?`; preserve operator structure.
* **plain** (dev/staging) — full statement.

---

## 8. Logging

### 8.1 Log format

Structured JSON, one event per line, fields:

| Field      | Description                                  |
| ---------- | -------------------------------------------- |
| `ts`       | ISO-8601 UTC, microseconds                   |
| `lvl`      | trace/debug/info/warn/error/fatal            |
| `where`    | module path                                  |
| `tid`      | OS thread id                                 |
| `span_id`  | current OTel span (if any)                   |
| `trace_id` | current OTel trace (if any)                  |
| `msg`      | human-readable message                       |
| `…`        | additional structured fields (snake_case)    |

### 8.2 Levels

| Level   | When to use                                                      |
| ------- | ---------------------------------------------------------------- |
| `trace` | Per-page, per-record granularity (off in production)             |
| `debug` | Per-query, per-checkpoint                                        |
| `info`  | Lifecycle (open, close, role change, key rotation)               |
| `warn`  | Recoverable anomaly (retry, backpressure, slow fsync)            |
| `error` | Failed operation (query error, replica detached)                 |
| `fatal` | Engine cannot continue (corrupted file, OOM, invariant violated) |

### 8.3 Sinks

* stderr (default)
* file (rotation by size and age)
* syslog (Unix)
* Windows Event Log
* OpenTelemetry Logs (OTLP)

---

## 9. Health endpoints

When running with the optional REST front-end (`[[FILE-13]]`):

```
GET /health/live       → 200 if process alive
GET /health/ready      → 200 if engine accepting requests
GET /health/replica    → 200 if replica state ∈ {GREEN,YELLOW}
GET /metrics           → Prometheus exposition format
GET /admin/queries     → list active queries (auth required)
GET /admin/queries/:id → details + cancel button (auth required)
GET /admin/dashboard   → minimal HTML dashboard (auth required)
```

Liveness vs readiness:

* `live` checks: process responds, no fatal latch leak detected.
* `ready` checks: WAL is writable AND buffer pool initialized AND not in `READ_ONLY` mode (unless intended).

---

## 10. Suggested dashboards

Queries below assume Prometheus + Grafana. Provided as a starting point; the `dashboards/` folder will ship JSON definitions in v0.4.

### 10.1 SLO dashboard

```promql
# P50/P95/P99 query latency
histogram_quantile(0.5,  rate(obx_query_duration_seconds_bucket[5m]))
histogram_quantile(0.95, rate(obx_query_duration_seconds_bucket[5m]))
histogram_quantile(0.99, rate(obx_query_duration_seconds_bucket[5m]))

# Error ratio
sum(rate(obx_query_total{result="error"}[5m]))
  /
sum(rate(obx_query_total[5m]))
```

### 10.2 Resource dashboard

```promql
# Buffer pool hit ratio
obx_buffer_pool_hit_ratio

# Page reads from disk per second
rate(obx_page_read_total{source="disk"}[5m])

# WAL fsync P99
histogram_quantile(0.99, rate(obx_wal_fsync_seconds_bucket[5m]))

# Disk size growth
deriv(obx_db_size_bytes[1h])
```

### 10.3 Replication dashboard

```promql
# Lag
obx_repl_lag_seconds
obx_repl_lag_lsn / (1024*1024)            # in MiB

# Apply throughput
rate(obx_repl_oplog_apply_seconds_count[5m])

# Resyncs (always alarming if frequent)
increase(obx_repl_resync_total[1h])
```

---

## 11. Alerts (suggested)

| Alert                         | Condition                                                       | Severity |
| ----------------------------- | --------------------------------------------------------------- | -------- |
| EngineDown                    | `up{job="oblivinx"} == 0` for 2 m                               | critical |
| QueryErrorRateHigh            | error ratio > 5% for 5 m                                        | high     |
| ReadLatencyP99High            | P99 > 200 ms for 10 m                                           | high     |
| WALFsyncSlow                  | P99 fsync > 50 ms for 5 m                                       | warning  |
| BufferPoolHitRatioLow         | hit ratio < 0.85 for 30 m                                       | warning  |
| ReplicaLagging                | `obx_repl_lag_seconds > 30` for 5 m                             | high     |
| ReplicaDetached               | `obx_repl_state == 3`                                           | critical |
| DiskGrowthAnomalous           | DB grew > 5 GiB in 1 h unexpectedly                             | warning  |
| KeyRotationOverdue            | hours since last rotation > rotation_period_h                   | warning  |
| AuditLogStalled               | `rate(obx_audit_records_total[5m]) == 0` while traffic present  | high     |

Rules ship in `monitoring/alerts.yml` (target v0.5).

---

## 12. Operator commands

### 12.1 `ovn admin status`

Renders a curated subset of metrics in human-readable form:

```
Engine                : 0.4.0 (build 9f1c… on rustc 1.83)
Uptime                : 4d 12h 3m
Database              : ./data/app.ovn2 (4.2 GiB)
Buffer pool           : 1.0 GiB / 1.0 GiB resident, hit=98.3%
WAL                   : 412 MiB used, last fsync 220 µs P99
Active txns           : 14 (12 read, 2 write)
Replication           : primary; 2 secondaries (lag 0.4s, 1.2s)
Last checkpoint       : 22 s ago, 4123 pages
Slow queries (1h)     : 31
```

### 12.2 `ovn admin queries`

Lists active queries, sortable by duration:

```
ID         AGE      DB      COLLECTION  OP       USER          ROWS    PAGES
q_18421    12.3s    app     orders      find     svc.api       0       8211
q_18420    0.4s     app     users       update   svc.signup    1       12
...
```

### 12.3 `ovn admin kill <query_id>`

Marks the cancellation token; the worker observes within one batch boundary (≤ 100 µs typically).

---

## 13. Sampling and overhead

* Counters & gauges: ~5 ns increment, no contention beyond shared atomic.
* Histograms: ~25 ns per observe (HDR-hist with thread-local merging every 100 ms).
* Trace spans: ~150 ns each (Tokio tracing equivalent), with sampling.

The engine commits to **< 1% CPU overhead** for the default observability profile (metrics on, traces sampled at 1%, slow query log on). A `--observability=minimal` flag disables histograms and traces entirely (use only when extreme cost-sensitivity is required).

---

## 14. Privacy considerations

* Slow query log captures `db.statement`; redaction (§7.4) defaults to **strict** in production.
* Trace exports honor a configurable allowlist of attributes; sensitive ones (`db.user`, `client.address`) can be hashed.
* Metrics carry **no user data**; labels are bounded to identifiers (collection name, peer id) — not user-supplied strings.

---

## 15. Tradeoffs

| Decision                              | Chosen                          | Alternative                | Why                              |
| ------------------------------------- | ------------------------------- | -------------------------- | -------------------------------- |
| Metric prefix                         | `obx_` (4 chars)                | `oblivinx_` (10 chars)     | Less label-store overhead        |
| Histogram type                        | HDR-hist with Prometheus mirror | Native Prom histograms     | Better quantile fidelity         |
| Trace sampling default                | 1%                              | 100% (off)                 | Useful but cheap                 |
| Slow log format                       | JSON lines                      | Binary                     | grep / jq pipelines              |
| OTel transport                        | OTLP gRPC                       | Custom                     | Standard ecosystem               |
| Statement redaction                   | Strict in prod                  | Always plain               | Privacy default-on               |
| Health endpoint exposure              | Optional                        | Always                     | Embedded use cases differ        |

---

## 16. Open questions & future

* **eBPF integration** — surface kernel-level latency without user-space tracing overhead (Linux only).
* **Continuous profiling** — pyroscope/parca-style flame graphs.
* **Anomaly detection** — built-in baseline learner for SLO alerts.
* **Self-tuning** — feedback loop from metrics into config (e.g., adjust `GROUP_COMMIT_US`).
* **eDB explain artifacts** — store explain JSON in a system collection for query inspection.

---

## 17. Cross-references

* `[[FILE-01]]`–`[[FILE-11]]` — sources of all metrics defined here.
* `[[FILE-13]]` — health and admin REST endpoints.
* `[[FILE-15]]` — OQL EXPLAIN syntax.
* `[[FILE-17]]` — load tests verify metric stability.
* `[[FILE-20]]/010` — ADR for OTel adoption.

*End of `12-OBSERVABILITY.md` — 540 lines.*
