# ADR-009 — Custom Binary Replication Protocol over WAL Projection

**Status:** Accepted, 2026-04
**Owners:** Replication
**Cross refs:** `[[FILE-02]]`, `[[FILE-09]]`

---

## Context

Replication needs a wire protocol that:

1. Streams continuous changes with low latency.
2. Supports both initial (snapshot) and steady-state (oplog tailing) phases.
3. Carries CRDT semantics for multi-master scenarios.
4. Works over TLS in WAN scenarios.
5. Survives version skew (rolling upgrades).
6. Performs adequately on mobile/edge networks.

Options:

* **gRPC** with bidirectional streaming.
* **PostgreSQL-style logical replication slots** — model is good; protocol bytes not reusable as-is.
* **Custom binary** with frames over TCP/TLS (HTTP-upgrade-compatible).
* **AMQP/Kafka-style brokered** — rejected: requires external infra.

## Decision

Use a **custom binary protocol over TLS 1.3** (with HTTP upgrade so it can pass through proxies). The protocol:

* Frames typed (HELLO/AUTH/OPLOG_REQUEST/OPLOG_BATCH/OPLOG_ACK/SNAPSHOT_*/HEARTBEAT/ROLE_CHANGE/ERROR/GOODBYE).
* Versioned: `ovn-repl/N` integer; current N=1; N±1 supported during rolling upgrades.
* Oplog projected from WAL with stable `OplogEntry` v1 layout (LSN, HLC, src_node_uuid, op_type, payload, CRC32C).
* CRDT ops carry causal metadata in dedicated `OPLOG_CRDT_MERGE` payload type.
* Acknowledgement levels: none/replica/quorum/all.
* TLS mandatory for inter-node; certificate pinning by default.

Mobile sync uses **WebSocket** transport with the same `OplogEntry` byte format inside.

## Consequences

**Positive**

* Single source of truth: WAL → oplog projection → wire.
* Versioned wire allows rolling upgrades without flag day.
* Custom binary keeps tail-latency low; no JSON marshalling on hot path.
* CRC + TLS provides defense in depth against corruption and tampering.

**Negative**

* New protocol means new tooling (no off-the-shelf gRPC reflection).
* Two transports (raw TLS for server, WebSocket for browser/mobile) — duplicate framing.

## Alternatives considered

* **gRPC** — rejected: HTTP/2 hop-by-hop semantics complicate oplog ack model; protobuf changes are version-fragile.
* **Postgres logical replication wire** — rejected: licensing-fine but not designed for browsers/mobile.

## Open questions

* Should we adopt MQTT-style retained "last value" topics for the watch surface?
* Compression negotiation (Zstd dictionaries shared across cluster) — likely v0.6 enhancement.

*End of ADR-009.*
