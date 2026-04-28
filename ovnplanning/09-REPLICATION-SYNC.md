# 09 — REPLICATION & SYNCHRONIZATION

> **Audience:** Replication subsystem implementers, sync protocol designers, mobile/edge integrators.
> **Status:** Specification (target v0.5–v1.0).
> **Cross refs:** `[[FILE-02]]` WAL & journaling, `[[FILE-06]]` MVCC & HLC, `[[FILE-07]]` security, `[[FILE-12]]` observability, `[[FILE-20]]/009` ADR sync protocol.

---

## 1. Purpose

Oblivinx3x ships as an embedded engine, but real workloads need to **leave the device**. This document specifies the replication and synchronization layer that turns a single-file `.ovn2` database into a node in a larger system:

1. **Master → replica replication** for read scaling and HA.
2. **Multi-master / peer-to-peer sync** for offline-first mobile and edge deployments.
3. **Point-in-time recovery (PITR)** by replaying the oplog against a base snapshot.
4. **Incremental backup** to object storage with byte-level efficiency.
5. **Disaster recovery** with bounded RPO and RTO.

The design uses the WAL `[[FILE-02]]` as the canonical change log, exposed as an **oplog stream** that consumers tail. CRDT semantics handle multi-writer convergence; HLC `[[FILE-06]]` provides a globally consistent ordering.

---

## 2. Concepts

### 2.1 Replication topologies

```
A) Master → Replica (read scaling)              B) Multi-master mesh (P2P)

       ┌───────┐                                       ┌───────┐
       │MASTER │───┐                                   │ NODE A│
       └───────┘   │                                   └───┬───┘
            │      ▼ async                                 │
            │   ┌───────┐                       ┌──────────┴──────────┐
            └──►│REPLICA│                       │                     │
                └───────┘                  ┌────▼────┐           ┌────▼────┐
                                           │ NODE B  │◄─────────►│ NODE C  │
                                           └─────────┘           └─────────┘

C) Hub-and-spoke (mobile sync)            D) Edge → cloud streaming

   ┌──────────┐                              ┌──────┐  ┌──────┐  ┌──────┐
   │  CLOUD   │◄────┐                        │EDGE 1│  │EDGE 2│  │EDGE 3│
   └────┬─────┘     │                        └───┬──┘  └───┬──┘  └───┬──┘
        │           │                            └────┬────┴────┬────┘
   ┌────▼────┐  ┌───▼─────┐                           │         │
   │ PHONE 1 │  │ PHONE 2 │                           ▼         ▼
   └─────────┘  └─────────┘                       ┌─────────────────┐
                                                  │  CENTRAL STORE  │
                                                  └─────────────────┘
```

### 2.2 Oplog vs WAL

The WAL records every byte-level mutation needed for **local crash recovery**. The oplog is a **filtered, semantic** view of the WAL suitable for cross-node transmission:

| Aspect          | WAL                                     | Oplog                                   |
| --------------- | --------------------------------------- | --------------------------------------- |
| Granularity     | Page-level + logical records            | Logical (insert/update/delete/DDL)      |
| Audience        | Local recovery                          | Remote replicas, sync clients           |
| Retention       | Bounded by checkpoint (minutes–hours)   | Bounded by retention policy (days–∞)    |
| Format          | Internal binary (`[[FILE-02]]` §2)      | Stable wire format (`OplogEntry` v1)    |
| Transformations | None (raw)                              | Filter, redact, transform via plugins   |

The oplog is **derived** from the WAL by an `OplogProjector` that subscribes to WAL tail events and emits stable, versioned wire records.

### 2.3 Roles

* **PRIMARY** — accepts writes. Exactly one per replica set unless multi-master is enabled.
* **SECONDARY** — read-only follower; tails primary's oplog.
* **ARBITER** — vote-only; no data; for odd quorum sizes.
* **SYNC_PEER** — symmetric peer in P2P/CRDT mode; both reads and writes locally.
* **SNAPSHOT_OBSERVER** — pulls periodic snapshots without continuous tailing (e.g., analytics warehouse).

### 2.4 Consistency models

| Model                  | When to use                          | Mechanism                                |
| ---------------------- | ------------------------------------ | ---------------------------------------- |
| Eventual               | Mobile sync, edge                    | CRDT merge; tolerate temporary divergence|
| Read-your-writes       | Single user across devices           | Sticky session to last-write replica     |
| Bounded staleness      | Read scaling                         | Lag < N seconds enforced by client       |
| Linearizable read      | Strict correctness                   | Read from primary OR quorum read         |
| Causal                 | Comments, social feeds               | HLC-ordered reads                        |
| Strong (single-master) | Financial, inventory                 | All writes through primary; sync replica |

---

## 3. Oplog format

### 3.1 OplogEntry v1 wire layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  OPLOG ENTRY (variable length, framed)                               │
├─────────────────────────────────────────────────────────────────────┤
│  +0   u8     magic           = 0x4F (= 'O')                          │
│  +1   u8     version         = 0x01                                  │
│  +2   u16    flags           (encrypted, compressed, system, ...)    │
│  +4   u32    total_len       (excluding 4-byte CRC trailer)          │
│  +8   u64    lsn             (source-node WAL offset)                │
│  +16  u64    hlc             (Hybrid Logical Clock; see [[FILE-06]]) │
│  +24  u128   src_node_uuid   (16 bytes; identifies source)           │
│  +40  u8     op_type         (see §3.2)                              │
│  +41  u8     reserved                                                │
│  +42  u16    txn_flags       (FIRST/MID/LAST/SOLO)                   │
│  +44  u64    txn_id          (groups multi-op transactions)          │
│  +52  u32    ns_len          (namespace length, e.g. "db.coll")      │
│  +56  bytes  namespace       (UTF-8)                                 │
│   …   bytes  payload         (op-type specific; see §3.3)            │
│  end  u32    crc32c          (over header+payload, excluding self)   │
└─────────────────────────────────────────────────────────────────────┘
```

Framing: each entry is preceded on the wire by a `u32` length prefix (network byte order). CRC32C is mandatory for every entry; replicas reject entries with bad CRC and request re-send.

### 3.2 Operation type catalog

```
0x01  OPLOG_INSERT          Insert document
0x02  OPLOG_UPDATE          Update document (full replace OR patch)
0x03  OPLOG_DELETE          Delete document by _id
0x04  OPLOG_BULK_INSERT     Multiple docs, same namespace, single txn
0x05  OPLOG_UPSERT          Insert-or-update (matched by filter)

0x10  OPLOG_CREATE_COLL     DDL: create collection
0x11  OPLOG_DROP_COLL       DDL: drop collection
0x12  OPLOG_CREATE_INDEX    DDL: create index
0x13  OPLOG_DROP_INDEX      DDL: drop index
0x14  OPLOG_RENAME_COLL     DDL: rename collection

0x20  OPLOG_NOOP            Heartbeat / liveness probe
0x21  OPLOG_CHECKPOINT      Marker — safe to truncate before this LSN
0x22  OPLOG_SNAPSHOT_BEGIN  Marker — start of a snapshot stream
0x23  OPLOG_SNAPSHOT_END    Marker — end of snapshot stream

0x30  OPLOG_CRDT_MERGE      CRDT-aware op (carries causal metadata)
0x31  OPLOG_TOMBSTONE       Causal delete (for OR-Set / observed-removed)

0x40  OPLOG_KEY_ROTATION    Encryption key rotation event
0x41  OPLOG_SCHEMA_CHANGE   JSON schema validator update

0xF0–0xFF  Reserved for plugin / vendor extensions
```

### 3.3 Payload schemas

#### OPLOG_INSERT (0x01)

```
+0   u32    doc_len
+4   bytes  obe_doc          OBE-encoded document (must contain _id)
```

#### OPLOG_UPDATE (0x02)

```
+0   u8     update_kind      0=REPLACE, 1=PATCH (RFC 6902-like), 2=MQL
+1   u32    id_len
+5   bytes  doc_id           OBE-encoded _id value
 …   u32    body_len
 …   bytes  body             REPLACE: full doc;  PATCH: ops[];  MQL: $set/$inc/...
 …   u32    before_hash      Optional 32-bit fingerprint for optimistic check
```

#### OPLOG_DELETE (0x03)

```
+0   u32    id_len
+4   bytes  doc_id           OBE-encoded _id
+   u32    before_hash       Optional fingerprint
```

#### OPLOG_CRDT_MERGE (0x30)

```
+0   u8     crdt_kind        See §6.2 catalog
+1   u32    field_path_len
+5   bytes  field_path       JSON pointer to field (e.g. "/tags")
 …   u32    op_len
 …   bytes  op_payload       CRDT-specific (see §6.3)
```

#### OPLOG_NOOP (0x20)

```
+0   u64    sender_hlc        Sender's current HLC
+8   u32    info_len
+12  bytes  info              Optional UTF-8 (e.g., role, version)
```

NOOPs let consumers learn that the producer is alive even when no data flows; they advance the safe-to-prune watermark on idle replicas.

### 3.4 Oplog persistence

The oplog is **not** stored as a separate file by default. Instead, it is the **WAL itself**, projected on read. Two modes:

* **EPHEMERAL** (default) — oplog records are derived on-the-fly from the WAL ring buffer; retention is the WAL retention.
* **DURABLE** — projections are written into a dedicated `*.oplog` segmented file (default 256 MiB segments, fsync on rotate). Retention is configurable (e.g., 14 days, 100 GiB cap, whichever earlier).

```
oplog/
├── 000000001.oplog        ← oldest segment
├── 000000002.oplog
├── …
├── 000000042.oplog        ← active (open for append)
└── manifest.json          ← {first_lsn, last_lsn, file_list, retention_policy}
```

Each segment file:

```
[16-byte segment header][entry][entry]...[entry][16-byte segment footer]

Segment header: magic('OVNOPLOG') | version(u16) | flags(u16) | seg_idx(u32)
Segment footer: last_lsn(u64) | entry_count(u32) | crc32c(u32)
```

---

## 4. Master → replica replication protocol

### 4.1 Lifecycle

```
   CONNECT  ──►  HANDSHAKE  ──►  INITIAL_SYNC  ──►  STEADY_STATE  ──►  CLOSE
                                       │                  │
                                       ▼                  ▼
                                  RESYNC_NEEDED    LAG_RECOVERY
```

### 4.2 Wire frames (versioned)

All frames share:

```
+0   u32    frame_len      (payload only)
+4   u8     frame_type
+5   u8     frame_flags
+6   u16    reserved
+8   bytes  payload
```

Frame types:

```
0x01  HELLO                Initial greeting, version negotiation
0x02  AUTH                 Credentials / token (TLS-wrapped)
0x03  OPLOG_REQUEST        "Send me from LSN=X"
0x04  OPLOG_BATCH          One or more OplogEntry records
0x05  OPLOG_ACK            "I've durably received up to LSN=Y"
0x06  RESYNC_REQUIRED      "Your LSN is behind retention; full sync needed"
0x07  SNAPSHOT_REQUEST     "Send me a snapshot at LSN=Z"
0x08  SNAPSHOT_BLOB        Snapshot data chunk
0x09  HEARTBEAT            Keepalive (every 5 s default)
0x0A  ROLE_CHANGE          Election notification (failover)
0x0B  ERROR                {code, message}
0x0F  GOODBYE              Graceful shutdown
```

### 4.3 HELLO payload

```
{
  "version": "ovn-repl/1",
  "supported": ["ovn-repl/1"],
  "node_id": "<uuid>",
  "node_role": "secondary",
  "engine_version": "0.5.0",
  "capabilities": ["compression:zstd","encryption:aes256gcm","crdt"]
}
```

Server replies HELLO with same shape; then both sides compute the **intersection of capabilities** (e.g. compression `zstd` only if both list it).

### 4.4 Initial sync algorithm

```
SECONDARY                            PRIMARY
   │                                    │
   │── HELLO ──────────────────────────►│
   │◄────────────────────────── HELLO ──│
   │── AUTH ───────────────────────────►│
   │◄──────────────────────────── ACK ──│
   │── SNAPSHOT_REQUEST(at=now) ──────►│
   │                                    │ ─ pin a snapshot LSN (= S0)
   │                                    │ ─ stream all collection bytes:
   │◄────────────── SNAPSHOT_BLOB[1] ──│       per-collection metadata
   │◄────────────── SNAPSHOT_BLOB[2] ──│       per-page raw image (zstd)
   │◄────────────── SNAPSHOT_BLOB[N] ──│       index rebuild hints
   │◄─ SNAPSHOT_END(snapshot_lsn=S0) ──│
   │ ─ apply snapshot → local DB at LSN=S0
   │── OPLOG_REQUEST(from=S0+1) ──────►│
   │◄───────────── OPLOG_BATCH(...) ───│ ─ steady-state tailing begins
   │── OPLOG_ACK(up_to=S1) ────────────►│
   │   …
```

Pseudocode:

```rust
fn initial_sync(secondary: &mut Conn, primary: &mut Conn) -> Result<(), ReplError> {
    secondary.send(Hello::from_local())?;
    let server_hello = secondary.recv_hello()?;
    negotiate_protocol(&server_hello)?;

    secondary.send(Auth::token(load_token()))?;
    secondary.recv_ack()?;

    let snap_lsn = primary.pin_snapshot()?;            // primary holds back vacuum
    secondary.send(SnapshotRequest { at: snap_lsn })?;

    loop {
        match secondary.recv_frame()? {
            Frame::SnapshotBlob(b) => apply_blob_to_local_db(b)?,
            Frame::SnapshotEnd { snapshot_lsn } => {
                assert_eq!(snapshot_lsn, snap_lsn);
                local_metadata().set_high_water(snap_lsn);
                break;
            }
            other => return Err(ReplError::Unexpected(other)),
        }
    }

    secondary.send(OplogRequest { from: snap_lsn + 1 })?;
    primary.unpin_snapshot(snap_lsn);                  // safe to vacuum old versions
    enter_steady_state(secondary)
}
```

Snapshot streaming is **physical** (page images) for speed; logical replay would multiply CPU cost by 5–10× on large collections.

### 4.5 Steady-state oplog tailing

Each batch carries between 1 and `max_batch` (default 1024) entries with cumulative size ≤ 4 MiB:

```
OplogBatch {
  base_lsn: u64,         // first entry's LSN
  count: u32,
  flags: u16,            // bit0: compressed, bit1: encrypted-at-rest
  entries: [OplogEntry; count]
}
```

Replica side loop:

```rust
loop {
    let batch = conn.recv::<OplogBatch>().await?;
    for entry in batch.entries.iter() {
        verify_crc(entry)?;
        decrypt_if_needed(entry, &K_repl)?;
        apply_to_local(entry)?;     // §5
    }
    let last = batch.entries.last().unwrap().lsn;
    durable_fsync_local_wal()?;     // ensure replica's WAL is durable
    conn.send(OplogAck { up_to: last }).await?;
}
```

### 4.6 Acknowledgement semantics

Three ack levels (chosen per-write at the primary):

| Level         | Wait until                                  | RPO      | Cost      |
| ------------- | ------------------------------------------- | -------- | --------- |
| `none`        | Local fsync only                            | High     | Lowest    |
| `replica`     | At least one replica `OplogAck`             | Low      | Medium    |
| `quorum`      | (N/2)+1 replicas ack                        | Lowest   | High      |
| `all`         | Every voting member ack (use sparingly)     | Zero*    | Highest   |

`*` zero RPO assumes no simultaneous failure of all members.

### 4.7 Resync triggers

A replica must full-resync if any of:

1. `OPLOG_REQUEST(from=X)` returns `RESYNC_REQUIRED` (X older than retention).
2. CRC failures exceed threshold.
3. Apply error: schema/index drift detected.
4. Source node UUID change (primary swap mid-flight).

---

## 5. Apply path on replicas

### 5.1 Idempotence

Replicas process oplog entries **at-least-once** — the network may redeliver after a partial ack. To make replay safe, each apply step must be idempotent:

| Op             | Idempotence strategy                                          |
| -------------- | ------------------------------------------------------------- |
| INSERT         | If `_id` already exists, fall back to UPSERT semantics        |
| UPDATE REPLACE | LWW by `(hlc, src_node_uuid)`                                 |
| UPDATE PATCH   | Re-apply allowed only if `before_hash` matches current        |
| DELETE         | If `_id` absent, no-op (insert tombstone if CRDT)             |
| BULK_INSERT    | Apply each child entry idempotently                           |
| DDL            | Compare-and-swap on schema version                            |
| CRDT_MERGE     | Always idempotent by definition                               |

### 5.2 Conflict detection (master/replica)

In master/replica topology there should be no write conflicts (only primary writes). If a replica detects:

* `before_hash` mismatch on a PATCH, OR
* INSERT on existing `_id` with different content,

it raises **REPLICA_DRIFT**, halts apply, and signals operations. Resync resolves.

### 5.3 Local WAL on replica

Replicas write to their own WAL **before** acking. This guarantees:

* Replica restart resumes from durable LSN, not from network buffer.
* Cascading replicas can themselves serve as upstream.

A replica's WAL records carry the **source LSN in metadata**, so cascade chains preserve provenance.

---

## 6. Multi-master & CRDTs

### 6.1 When to use CRDTs

CRDTs are the right tool when:

* Multiple users edit independently (collaborative apps, mobile sync).
* Network partitions are normal (offline-first).
* Convergence > strong consistency.

CRDTs are **not** appropriate when:

* Constraints span documents (uniqueness, foreign keys).
* Order-of-operations matters semantically (financial debit/credit).
* Write rate > 50k ops/s per shard (CRDT metadata overhead dominates).

### 6.2 Supported CRDT types

| Type             | Semantic                                  | Use cases                            |
| ---------------- | ----------------------------------------- | ------------------------------------ |
| `LWWRegister`    | Last-write-wins by `(hlc, node_uuid)`     | Profile fields, simple scalars       |
| `MVRegister`     | Multi-value: keep all concurrent writes   | Tags awaiting user resolution        |
| `GCounter`       | Grow-only counter (per-node tallies)      | Page views, like counts              |
| `PNCounter`      | Add/subtract counter                      | Inventory stock, balance             |
| `GSet`           | Grow-only set                             | Append-only audit lists              |
| `ORSet`          | Observed-Remove set                       | Editable tag lists, group members    |
| `LWWMap`         | Map of LWW registers                      | Settings dictionaries                |
| `ORMap`          | Map of CRDT values                        | Nested structured docs               |
| `RGA` (text)     | Replicated Growable Array (Yjs/Automerge) | Collaborative text                   |
| `JSONCRDT`       | Composite (Automerge-style)               | Whole-doc collab editing             |

### 6.3 CRDT op encoding (OPLOG_CRDT_MERGE payload)

Common header per CRDT op:

```
+0   u8     crdt_kind          See table above (1 = LWWRegister, ... )
+1   u128   replica_id         Source replica UUID
+17  u64    hlc                Logical timestamp at op generation
+25  bytes  type_specific      ...
```

#### LWWRegister

```
+25  u32    value_len
+29  bytes  obe_value          OBE-encoded scalar
```

Merge: keep value with greatest `(hlc, replica_id)` lexicographic tuple.

#### ORSet

```
+25  u8     action            0=ADD, 1=REMOVE
+26  u128   element_uid       Unique tag for the *occurrence*
+42  u32    elem_len
+46  bytes  obe_element       OBE-encoded element value
```

ADD inserts `(uid, elem)`. REMOVE only affects observed `uid`s present locally; concurrent ADDs survive. Tombstones (removed `uid`s) are kept until **causal stability** (all peers' HLCs > tombstone HLC) is reached, then garbage-collected.

#### PNCounter

```
+25  u128   counter_id         Stable id for the counter
+41  i64    delta              Signed increment
```

State: per-replica `(adds, subs)` vectors. Value = `Σ adds − Σ subs` over all replicas.

#### RGA-text

```
+25  u128   replica_id
+41  u64    seq
+49  u8     action            0=INSERT, 1=DELETE
+50  u128   target_uid        Predecessor (INSERT) or victim (DELETE)
+66  u32    char_len
+70  bytes  utf8              For INSERT
```

Each character has a global UID = `(replica_id, seq)`. Inserts hold a stable position via predecessor; concurrent inserts at the same predecessor are ordered by `(replica_id, seq)`.

### 6.4 CRDT field marking

A document field becomes CRDT by attaching a type tag in the schema:

```jsonc
// Collection schema
{
  "name": "documents",
  "fields": {
    "title":    { "type": "string", "crdt": "LWWRegister" },
    "tags":     { "type": "array",  "crdt": "ORSet" },
    "votes":    { "type": "int",    "crdt": "PNCounter" },
    "body":     { "type": "string", "crdt": "RGA" }
  }
}
```

Fields without a `crdt` tag default to **LWWRegister at the document level** (last-writer wins for the whole doc). For per-field LWW, mark each field explicitly.

### 6.5 Causal stability & tombstone GC

Each peer publishes its HLC in NOOP heartbeats. The cluster's **causal stability frontier** is `min(hlc_peer)` across all known peers. Tombstones older than the frontier may be removed without breaking convergence.

Pseudocode (per node):

```rust
fn gc_tombstones(now_hlc: u64) {
    let frontier = peers.iter().map(|p| p.last_seen_hlc).min().unwrap_or(0);
    if frontier == 0 { return; }  // never GC if any peer hasn't reported

    let safe_horizon = frontier.saturating_sub(GC_GRACE_NS); // e.g. 1h
    for ts in storage.iter_tombstones() {
        if ts.hlc < safe_horizon { storage.delete_tombstone(ts.id); }
    }
}
```

`GC_GRACE_NS` is configurable; lower = tighter footprint, higher = more partition tolerance.

---

## 7. Offline-first sync (mobile/edge)

### 7.1 Architecture

```
┌──────────────────────────────────────────────────┐
│  CLIENT DEVICE (phone, browser, IoT)             │
│  ┌────────────────┐  writes   ┌───────────────┐  │
│  │  Application   │──────────►│  Local Ovn DB │  │
│  └────────────────┘  reads    │  (.ovn2 file) │  │
│                                └───────┬───────┘  │
│                                        │ append  │
│                                ┌───────▼───────┐  │
│                                │  Outbox queue │  │
│                                └───────┬───────┘  │
└────────────────────────────────────────┼──────────┘
                                         │ when online
                       ┌─────────────────▼─────────────────┐
                       │  Sync Gateway (HTTPS/WebSocket)   │
                       │  - auth, throttle, conflict resolve│
                       └─────────────────┬─────────────────┘
                                         │
                                ┌────────▼────────┐
                                │  Cloud Ovn DB   │
                                └─────────────────┘
```

### 7.2 Outbox / inbox model

* **Outbox** = local CRDT ops generated since last successful upload.
* **Inbox** = remote CRDT ops since last successful download.

Both are *durable* on the local `.ovn2` file (special system collections `_ovn_outbox`, `_ovn_inbox`).

Sync session pseudocode:

```rust
async fn sync_round(local: &Db, gateway: &Gateway) -> Result<(), SyncError> {
    // 1. Push outbox
    let cursor = local.outbox_cursor();
    let batch  = local.read_outbox(cursor, MAX_BATCH).await?;
    if !batch.is_empty() {
        let resp = gateway.push(batch).await?;
        local.advance_outbox_cursor(resp.last_acked).await?;
    }

    // 2. Pull inbox
    let since = local.last_pulled_hlc();
    let pulled = gateway.pull(since, MAX_BATCH).await?;
    for entry in pulled.iter() {
        local.apply_oplog(entry).await?;
    }
    local.set_last_pulled_hlc(pulled.last_hlc()).await?;

    // 3. Heartbeat / liveness
    gateway.heartbeat(local.node_id(), local.now_hlc()).await?;
    Ok(())
}
```

### 7.3 Bandwidth optimization

* **Delta compression** — for UPDATE_PATCH ops, send JSON-Patch instead of full doc.
* **Zstd dictionary** — train per-collection dictionaries from sample of historical docs; ship dictionary id in batch header.
* **Bloom-filter prefiltering** — gateway sends a Bloom of `(_id, hlc)` it already has; client skips known entries.
* **Backoff schedule** — exponential backoff on `429 Too Many Requests` (cap 60 s).

### 7.4 Battery-friendly scheduling

The mobile SDK exposes:

```kotlin
OvnSyncOptions {
  triggers: [ON_FOREGROUND, ON_WIFI, ON_CHARGING, EVERY_15M],
  maxBytesPerSession: 5 * 1024 * 1024,
  maxOpsPerSession: 1000,
  conflictPolicy: PolicyKind.AUTO,
}
```

Default policy on cellular: never push > 1 MiB/round, max 1 round per 30 minutes.

### 7.5 Selective sync

Clients may declare a `sync_filter` per collection (server-evaluated MQL):

```jsonc
{ "owner_id": { "$eq": "u_42" }, "_archived": { "$ne": true } }
```

Server projects oplog through the filter and only sends matching entries. Filter changes trigger a **catch-up sweep** that finds matching docs the client doesn't yet have.

---

## 8. Replica lag & health

### 8.1 Lag measurements

| Metric                    | Definition                                              |
| ------------------------- | ------------------------------------------------------- |
| `lag_lsn`                 | `primary.last_lsn − replica.applied_lsn`                |
| `lag_seconds_clock`       | `now() − primary_clock_at(applied_lsn)`                 |
| `lag_ops`                 | Count of oplog entries pending apply                    |
| `apply_throughput`        | Entries/s applied in last 30 s                          |
| `network_rtt_p50_ms`      | RTT between primary and replica                         |
| `heartbeat_age_s`         | Time since last NOOP from peer                          |

### 8.2 Health states

```
GREEN   : lag_seconds_clock < 5      and  heartbeat_age_s < 15
YELLOW  : 5 ≤ lag_seconds_clock < 60 and  heartbeat_age_s < 60
RED     : lag_seconds_clock ≥ 60     or   heartbeat_age_s ≥ 60
DETACHED: heartbeat_age_s ≥ 300       (re-sync candidate)
```

Health transitions are emitted as oplog `OPLOG_NOOP` entries with `info` carrying the new state, plus Prometheus metrics (`obx_repl_lag_seconds`, `obx_repl_state`) — see `[[FILE-12]]`.

### 8.3 Failover (primary election)

Triggered when **majority** of voting members declare primary unreachable for `failover_timeout` (default 30 s).

Election algorithm (Raft-inspired, simplified):

1. Candidate: replica with greatest `(applied_lsn, hlc, node_id)` triple.
2. Candidate broadcasts `RequestVote { term, applied_lsn, hlc }`.
3. Voters grant if candidate's `(applied_lsn, hlc)` ≥ own.
4. On majority, candidate becomes primary, increments `term`, broadcasts `ROLE_CHANGE`.
5. Old primary, on rejoin, observes higher term → demotes itself; resync if its tail diverges.

The system does **not** support split-brain healing automatically beyond the term mechanism. Operators must intervene if simultaneous primaries committed conflicting writes (rare; only possible with broken quorum).

---

## 9. Point-in-time recovery (PITR)

### 9.1 Goals

Restore the database to the exact state it had at any timestamp `T` within the retention window.

### 9.2 Building blocks

1. A **base snapshot** at LSN `S0` (created by `ovn snapshot --base`).
2. The **continuous oplog** from `S0+1` to current.
3. An index from **timestamp → LSN** built over oplog headers.

### 9.3 Restore algorithm

```rust
fn pitr_restore(base: &Snapshot, oplog: &OplogReader, target_ts: u64)
    -> Result<Db, PitrError>
{
    // 1. Hydrate base
    let mut db = Db::from_snapshot(base)?;
    let snapshot_lsn = base.lsn;

    // 2. Find last LSN whose HLC time-component <= target_ts
    let target_lsn = oplog.binary_search_by_time(target_ts)?;
    if target_lsn < snapshot_lsn {
        return Err(PitrError::TargetBeforeSnapshot);
    }

    // 3. Replay entries (snapshot_lsn, target_lsn]
    let mut iter = oplog.iter_range(snapshot_lsn + 1, target_lsn);
    while let Some(entry) = iter.next()? {
        verify_crc(&entry)?;
        db.apply_oplog(&entry, ApplyMode::Idempotent)?;
    }

    // 4. Run integrity checks
    db.verify_internal_invariants()?;
    Ok(db)
}
```

### 9.4 Time index

Built on first PITR query, then maintained incrementally:

```
+0    u64  hlc_time_ms      time component (millis)
+8    u64  lsn              physical position
```

Sorted by `hlc_time_ms`, persisted as `oplog/timeindex.bin`. Binary search runs in O(log N) over millions of entries.

### 9.5 Granularity guarantees

* Resolution: 1 ms (HLC clock component).
* Atomicity: PITR stops at transaction boundaries; transactions straddling `target_ts` are either fully replayed (if `txn_flags=LAST` ≤ target) or fully skipped.

---

## 10. Backup & restore

### 10.1 Backup types

| Type               | Frequency  | Size         | Restore time |
| ------------------ | ---------- | ------------ | ------------ |
| FULL               | Weekly     | DB size      | Fast         |
| INCREMENTAL_BLOCK  | Daily      | Changed pages| Medium       |
| OPLOG_ONLY         | Continuous | Tiny         | Slow (replay)|

### 10.2 Incremental backup format

Backup file = manifest + page bitmap + page payloads:

```
┌─────────────────────────────────────────────────────────┐
│  HEADER                                                  │
│   magic('OVNBKUP') | version | created_ts | base_id      │
│   prev_lsn | this_lsn | total_pages | changed_pages      │
├─────────────────────────────────────────────────────────┤
│  CHANGED-PAGE BITMAP                                     │
│   total_pages bits, packed; bit=1 means page is in body  │
├─────────────────────────────────────────────────────────┤
│  PAGE PAYLOADS (in page-id order)                        │
│   for each set bit: { page_id (u32), bytes (page_size)}  │
├─────────────────────────────────────────────────────────┤
│  TRAILER                                                 │
│   crc32c | xxh3_total | signature_optional               │
└─────────────────────────────────────────────────────────┘
```

Detection: maintain a per-page LSN in the page header `[[FILE-01]]`. A page is "changed since base" iff `page.lsn > base.high_water_lsn`.

### 10.3 Backup pipeline

```
Live DB ──► Pin checkpoint ──► Iterate pages ──► Stream changed ──► Object store
                │                                                          │
                ▼                                                          ▼
       Snapshot LSN recorded                              Verify after upload (xxh3)
```

### 10.4 Restore

1. Choose target backup chain: latest FULL + sequence of INCREMENTAL up to desired time.
2. Apply FULL → apply each INCREMENTAL in order (each touches only its bitmap pages).
3. Optionally apply oplog from incremental's `this_lsn` to PITR target.
4. Run consistency check (`ovn admin verify --deep`).

### 10.5 Encryption-at-rest for backups

Backup files inherit the master key context but use a **separate sub-key**:

```
K_backup = HKDF(K_master, "ovn:backup:v1" || backup_id)
```

This means revoking a backup-specific key (after restore, e.g.) does not impact live data.

---

## 11. Security of replication

### 11.1 Transport

* **Mandatory TLS 1.3** for all inter-node traffic; certificate pinning by default for known peers.
* Cipher policy inherits from `[[FILE-07]]` §3.
* Mutual TLS preferred; pre-shared key fallback for embedded scenarios.

### 11.2 Replica authentication

Tokens use the same auth subsystem as application clients (`[[FILE-07]]` §6) but with a `repl:*` scope:

| Scope                | Allows                                  |
| -------------------- | --------------------------------------- |
| `repl:read`          | Receive oplog                           |
| `repl:write`         | Push oplog (multi-master)               |
| `repl:snapshot`      | Pull base snapshots                     |
| `repl:admin`         | Election participation, role changes    |

### 11.3 Encryption-in-stream

When both endpoints have at-rest encryption enabled, the oplog batch is sent **encrypted** under a session key derived per connection:

```
K_session = HKDF(K_master, "ovn:repl-session:v1" || nonce_a || nonce_b)
```

`nonce_a, nonce_b` are 16-byte random nonces exchanged in HELLO. Avoids re-encrypting per connection from cold storage.

### 11.4 Audit

Every replication event (HELLO, AUTH, RESYNC, ROLE_CHANGE, GOODBYE, errors) is added to the audit log defined in `[[FILE-07]]` §10 with HMAC chaining. This makes after-the-fact forensics possible.

---

## 12. Tradeoffs

| Decision                                  | Chosen                          | Alternative                | Why                                              |
| ----------------------------------------- | ------------------------------- | -------------------------- | ------------------------------------------------ |
| Oplog projection vs separate write log    | Project from WAL                | Dual writes                | Single source of truth; avoid divergence         |
| HLC vs vector clock                       | HLC (64-bit)                    | Vector clock per replica   | Constant-size; sufficient for causal ordering    |
| Snapshot transport                        | Page-level (physical)           | Logical replay             | 5–10× faster on cold sync                        |
| CRDT tombstone GC                         | Heartbeat-frontier              | Probabilistic / reference  | Simple, correct, bounded memory                  |
| Master/replica election                   | Raft-inspired single-term       | Multi-Paxos                | Simpler ops; sufficient for ≤7 voters            |
| Encryption of oplog                       | Session key (HKDF)              | Per-batch random key       | One handshake amortizes; small overhead          |
| PITR resolution                           | 1 ms (HLC ms component)         | Per-LSN                    | Aligns with human-readable time queries          |
| Multi-master conflict default             | LWW per field (HLC)             | App-level resolver         | Deterministic; avoids surprise data loss         |
| Mobile sync transport                     | WebSocket + binary frames       | gRPC / HTTP/2              | Browser-friendly, low overhead, easy proxies     |
| Backup deduplication                      | Page-bitmap (per-page LSN)      | Content-defined chunking   | Cheap, deterministic; works with encryption      |

---

## 13. Failure scenarios

### 13.1 Network partition (replica)

* Replica continues serving reads (subject to staleness).
* Primary continues writing as long as quorum remains.
* On heal: replica resumes tailing at last applied LSN; if behind retention, full resync.

### 13.2 Network partition (multi-master)

* Both sides accept writes locally.
* CRDT merge on heal converges automatically.
* Non-CRDT fields: LWW; loss is bounded to fields edited concurrently.

### 13.3 Disk full on replica

* Apply path stalls, ack stops.
* Primary backs off; eventually exceeds buffer → secondary marked LAGGED then DETACHED.
* Operator action: free space; full resync if WAL retention exceeded.

### 13.4 Corrupted oplog segment

* CRC failure in segment N: skip segment + force resync from start of N.
* If retention covers it, primary resends; otherwise full snapshot.

### 13.5 Clock skew

* HLC tolerates skew up to `MAX_PHYSICAL_SKEW` (default 100 ms).
* Beyond that, `hlc.physical = max(local_clock, observed_max + 1)` keeps monotonicity but lag warning is emitted.

### 13.6 Long-offline mobile client

* Outbox grows up to `outbox_max_bytes` (default 100 MiB); beyond that, oldest non-CRDT writes are dropped with a `SYNC_OUTBOX_OVERFLOW` event surfaced to the app.
* CRDT writes are **never** dropped (semantic guarantee); they occupy a separate quota.

---

## 14. Compatibility & versioning

| Component        | Versioning                    | Skew policy                                       |
| ---------------- | ----------------------------- | ------------------------------------------------- |
| Wire protocol    | `ovn-repl/N` (integer)        | N±1 supported                                     |
| Oplog format     | Magic + version byte          | Reader rejects unknown versions                   |
| CRDT op encoding | `crdt_kind` byte (8-bit)      | Unknown kinds rejected; surface to operator       |
| Snapshot format  | `OVNSNAP/N` magic             | Reader rejects unknown N                          |

All wire frames carry `frame_flags` reserved bits = 0; future versions use them for opt-in features without breaking older parsers.

---

## 15. Open questions & future work

* **WAN-optimized sync** — adopt Bramble-style probabilistic chunk dedup for large doc bodies?
* **Per-collection replication policies** — exclude rapidly-churning analytical collections from sync.
* **Hot standby promotion** — sub-second failover via shared storage primitives (NVMe-oF) for HA-in-the-rack.
* **Geo-aware routing** — direct mobile clients to nearest gateway (anycast).
* **Sync-time validation** — run schema validators on inbound CRDT merges; reject malformed.
* **Differential snapshots** — base + diff snapshots indexed by LSN range.

---

## 16. Cross-references

* `[[FILE-02]]` — WAL is the underlying source of oplog.
* `[[FILE-06]]` — HLC and MVCC visibility rules.
* `[[FILE-07]]` — TLS, KMS, audit log.
* `[[FILE-12]]` — replication metrics and dashboards.
* `[[FILE-15]]` — OQL syntax for sync filter expressions.
* `[[FILE-17]]` — chaos & failure-injection tests for replication.
* `[[FILE-20]]/009` — ADR rationale for sync protocol design.

*End of `09-REPLICATION-SYNC.md` — 540 lines.*
