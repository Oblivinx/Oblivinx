<div align="center">
  <img height="1000" src="https://i.pinimg.com/736x/0c/a5/38/0ca5385762a719d9b78df1cef92f6a5f.jpg"  />
</div>

# ovnqueue

> **Enterprise-grade, framework-agnostic Job Queue for Node.js — No Redis required.**

[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org) [![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue)](https://www.typescriptlang.org) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`ovnqueue` is a highly-scalable, multi-process-ready job queue built for demanding Node.js applications. It requires zero infrastructure — no Redis, no Kafka, no external broker. It ships with a full plugin ecosystem, flexible retry policies, built-in crash recovery, and a first-class multi-process sharding architecture designed for running hundreds of independent bots or workers in parallel.

---

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
  - [JobQueue](#jobqueue)
  - [Storage Adapters](#storage-adapters)
  - [Job Lifecycle](#job-lifecycle)
  - [JobBuilder](#jobbuilder)
- [Configuration Reference](#configuration-reference)
- [Plugins](#plugins)
  - [RateLimiter](#ratelimiter)
  - [Throttle](#throttle)
  - [Deduplicator](#deduplicator)
  - [Debounce](#debounce)
  - [JobTTL](#jobttl)
  - [DeadLetterQueue](#deadletterqueue)
  - [Metrics](#metrics)
  - [JobTracePlugin](#jobtraceplugin)
- [Retry Policies](#retry-policies)
  - [ExponentialBackoff](#exponentialbackoff)
  - [LinearBackoff](#linearbackoff)
  - [NoRetry](#noretry)
  - [CustomRetry](#customretry)
- [Flow Control](#flow-control)
  - [Chains (A → B → C)](#chains)
  - [DAG (Directed Acyclic Graphs)](#dag)
- [Multi-Process Sharding (IPC)](#multi-process-sharding-ipc)
  - [IpcRouter (Main Process)](#ipcrouter-main-process)
  - [IpcWorker (Child Process)](#ipcworker-child-process)
  - [Benchmark Script](#benchmark-script)
- [Events](#events)
- [Persistence & Crash Recovery](#persistence--crash-recovery)
- [Utilities](#utilities)
  - [CircuitBreaker](#circuitbreaker)
  - [Logger](#logger)
  - [JobBatch](#jobbatch)
- [WhatsApp Extensions](#whatsapp-extensions)
  - [WaBotContext (Central Access)](#wabotcontext)
  - [KvStore (Key-Value Store)](#kvstore)
    - [Core Operations](#core-operations)
    - [Counter Operations](#counter-operations)
    - [Hash Operations](#hash-operations)
    - [List Operations](#list-operations)
    - [Bot Helpers](#bot-helpers)
  - [SortedSet (Leaderboards)](#sortedset)
    - [Global Leaderboard](#global-leaderboard)
  - [PubSub (Event Bus)](#pubsub)
    - [TypedPubSub](#typedpubsub)
    - [IpcPubSubBridge](#ipcpubsubbridge)
  - [SessionStore (Conversation State)](#sessionstore)
  - [CronScheduler (Recurring Jobs)](#cronscheduler)
  - [WhatsApp Plugins](#whatsapp-plugins)
    - [AntiSpamPlugin](#antispamplugin)
    - [WaRateLimiterPlugin](#waratelimiterplugin)
    - [MessageBufferPlugin](#messagebufferplugin)
    - [CommandCooldownPlugin](#commandcooldownplugin)
- [Error Reference](#error-reference)
- [TypeScript Types Reference](#typescript-types-reference)
- [API Reference](#api-reference)

---

## Features

| Feature | Description |
|---|---|
| 🚫 **No Redis Required** | Uses `oblivinx3x` (optional) or in-memory heap — zero infra cost |
| ⚡ **Priority Queue** | O(log n) binary heap — higher-priority jobs always run first |
| 🔀 **Multi-Process Sharding** | Built-in `IpcRouter` + `IpcWorker` for routing jobs to child processes |
| 🔌 **Plugin Ecosystem** | `RateLimiter`, `Throttle`, `Deduplicator`, `Debounce`, `JobTTL`, `DeadLetterQueue`, `Metrics`, `JobTracePlugin` |
| 🔁 **Retry Policies** | `ExponentialBackoff`, `LinearBackoff`, `CustomRetry`, `NoRetry` |
| 🔗 **Flow Control** | Sequential Chains and complex DAGs with dependency resolution |
| 💾 **Crash Recovery** | WAL + Snapshot persistence, auto-recovered on restart |
| 🔒 **100% TypeScript** | Full generic type safety from enqueue to handler |
| 📈 **Auto-Scaling Workers** | Worker pool scales up/down based on queue depth |
| ⚡ **Backpressure** | Per-shard IPC concurrency limiting prevents channel flooding |
| 🗄️ **KvStore** | In-memory key-value store with TTL, Hash, List, rate-check, cooldown |
| 🏆 **SortedSet** | Redis ZSET-compatible leaderboards with global aggregation |
| 📡 **PubSub** | In-process event bus with pattern matching + `TypedPubSub<T>` |
| 💬 **SessionStore** | Multi-step conversation state management for chatbots |
| ⏰ **CronScheduler** | Persistent recurring job scheduler with cron + interval support |
| 🤖 **WA Plugins** | Anti-spam, rate limiter, message buffer, command cooldown |
| 🎯 **WaBotContext** | Central helper class providing unified access to all stores |

---

## Installation

```bash
npm install ovnqueue
```

**Optional:** Install `oblivinx3x` if you need persistent storage and crash recovery:

```bash
npm install oblivinx3x
```

**Requirements:** Node.js `>= 18.0.0`

---

## Quick Start

```typescript
import { JobQueue } from 'ovnqueue';

// 1. Create a queue (in-memory by default)
const queue = new JobQueue({ name: 'main' });

// 2. Register a handler for a job type
queue.register('send-email', async (payload, ctx) => {
    console.log(`[attempt ${ctx.attempt}] Sending email to ${payload.to}`);
    await sendEmail(payload);
    return { sent: true };
});

// 3. Initialize (runs recovery, starts workers)
await queue.initialize();

// 4. Enqueue a job
const jobId = await queue.enqueue({
    type: 'send-email',
    payload: { to: 'user@example.com', subject: 'Hello' },
});

console.log('Enqueued job:', jobId);
```

---

## Core Concepts

### JobQueue

`JobQueue` is the main orchestrator. It manages the worker pool, plugin lifecycle, retry logic, and persistence.

```typescript
import { JobQueue, MemoryAdapter } from 'ovnqueue';

const queue = new JobQueue({
    name: 'my-queue',
    adapter: new MemoryAdapter(),
    workers: { min: 2, max: 10 },
    defaultMaxAttempts: 3,
    defaultMaxDuration: 30_000, // ms
    defaultPriority: 5,
});

queue.register('my-job', async (payload, ctx) => {
    // payload: the job's data
    // ctx.jobId: unique job ID
    // ctx.attempt: current attempt number (starts at 1)
    // ctx.signal: AbortSignal — check for cancellation
    if (ctx.signal?.aborted) throw new Error('Cancelled');
    return 'result';
});

await queue.initialize();

// Lifecycle
queue.pause();           // stop picking up new jobs
queue.resume();          // resume processing
await queue.drain();     // wait for all active jobs to finish
await queue.shutdown();  // graceful shutdown
```

### Storage Adapters

Three built-in adapters are available. All implement `IStorageAdapter`.

#### MemoryAdapter (default)

Zero dependencies. Jobs are lost on process restart. Best for development and testing.

```typescript
import { MemoryAdapter } from 'ovnqueue';

const adapter = new MemoryAdapter();
const queue = new JobQueue({ name: 'q', adapter });
```

#### OvnDbAdapter

Persistent storage using `oblivinx3x` with MVCC and ACID transactions. Requires `npm install oblivinx3x`.

```typescript
import { OvnDbAdapter } from 'ovnqueue';

const adapter = new OvnDbAdapter({ path: './jobs.ovn' });
await adapter.initialize(); // must be called before use

const queue = new JobQueue({ name: 'q', adapter });
```

> Each bot/worker should use a **separate database file** to avoid lock contention errors.

#### FileAdapter

JSON flat-file adapter. Suitable for development, CLIs, and low-concurrency use cases.

```typescript
import { FileAdapter } from 'ovnqueue';

const adapter = new FileAdapter({ filePath: './jobs.json' });
await adapter.initialize();

const queue = new JobQueue({ name: 'q', adapter });
```

> ⚠️ **Not recommended for high-concurrency production use.**

### Job Lifecycle

Every job progresses through these states:

```
pending → active → done
                 ↘ failed → retrying → active (if retry available)
                          ↘ dlq (if maxAttempts exhausted + DLQ plugin)
pending → expired (if TTL exceeded before processing)
```

| State | Meaning |
|---|---|
| `pending` | Waiting in queue, not yet picked up |
| `active` | Currently being processed by a worker |
| `done` | Completed successfully |
| `failed` | Failed, may retry |
| `retrying` | Scheduled for a retry attempt |
| `expired` | TTL elapsed before job was processed |
| `dlq` | Moved to Dead Letter Queue after exhausting retries |
| `paused` | Paused by flow dependency resolution |

### JobBuilder

Fluent API for creating jobs with all options:

```typescript
import { JobBuilder, ExponentialBackoff } from 'ovnqueue';

const job = new JobBuilder<{ userId: string }>()
    .type('process-user')
    .payload({ userId: 'abc-123' })
    .priority(3)               // 1 = highest, 10 = lowest
    .delay(5_000)              // wait 5s before becoming eligible
    .maxAttempts(5)
    .maxDuration(10_000)       // job timeout in ms
    .ttl(60_000)               // expire if not started within 60s
    .retry(new ExponentialBackoff({ maxAttempts: 5 }))
    .build();

const jobId = await queue.enqueue(job);
```

Or use the inline options form directly in `enqueue()`:

```typescript
const jobId = await queue.enqueue({
    type: 'process-user',
    payload: { userId: 'abc-123' },
    priority: 3,
    delay: 5_000,
    maxAttempts: 5,
    maxDuration: 10_000,
    ttl: 60_000,
    retryPolicy: new ExponentialBackoff({ maxAttempts: 5 }),
});
```

---

## Configuration Reference

```typescript
interface QueueConfig {
    /** Required: unique queue name */
    name: string;

    /** Storage adapter. Default: MemoryAdapter */
    adapter?: IStorageAdapter;

    /** Worker pool configuration */
    workers?: {
        min?: number;               // Default: 1
        max?: number;               // Default: 10
        scaleUpThreshold?: number;  // Queue depth to trigger scale-up. Default: 5
        scaleDownThreshold?: number;// Queue depth to trigger scale-down. Default: 2
        scaleUpStep?: number;       // Workers to add per scale event. Default: 2
        monitorIntervalMs?: number; // Scaling check interval. Default: 1000
    };

    /** Persistence / WAL crash-recovery */
    persistence?: {
        enabled?: boolean;              // Default: false
        walPath?: string;               // Default: './wa-queue.wal'
        snapshotPath?: string;          // Default: './wa-queue.snapshot.json'
        snapshotIntervalMs?: number;    // Default: 60_000
    };

    /** Plugins to activate */
    plugins?: IPlugin[];

    /** Defaults applied to all jobs unless overridden */
    defaultPriority?: number;       // Default: 5
    defaultMaxAttempts?: number;    // Default: 3
    defaultMaxDuration?: number;    // Default: 30_000 (ms)
}
```

---

## Plugins

Plugins hook into the job lifecycle. Pass them in `plugins: [...]` when creating the queue.

### RateLimiter

Token-bucket rate limiting per job type (or custom key). Throws `RateLimitError` when limit is exceeded.

```typescript
import { RateLimiter } from 'ovnqueue';

new RateLimiter({
    limit: 10,          // max 10 jobs
    windowMs: 1_000,    // per 1 second window

    // Optional: custom key function (default: job.type)
    keyFn: (job) => job.payload.userId as string,
})
```

| Option | Type | Description |
|---|---|---|
| `limit` | `number` | Max jobs allowed per window |
| `windowMs` | `number` | Window duration in milliseconds |
| `keyFn` | `(job) => string` | Key extractor — defaults to `job.type` |

### Throttle

Hard global concurrency cap. Throws `RateLimitError` when `maxConcurrent` active jobs are reached.

```typescript
import { Throttle } from 'ovnqueue';

new Throttle({ maxConcurrent: 5 })
```

> **Throttle vs RateLimiter:** Throttle limits *simultaneous* active jobs. RateLimiter limits *requests per time window*.

### Deduplicator

Prevents duplicate job IDs from entering the queue. The ID is released after the job completes or fails (allowing re-enqueue).

```typescript
import { Deduplicator } from 'ovnqueue';

const dedup = new Deduplicator();

// Access current size
console.log(dedup.size); // number of tracked active jobs
```

To trigger deduplication, enqueue jobs with an explicit deterministic ID:

```typescript
import { createJob } from 'ovnqueue';

const job = createJob({ type: 'sync', payload: { userId: '42' } });
// job.id is auto-generated (ULID). For dedup, generate a stable ID:
const stableId = `sync-${userId}`;
```

### Debounce

Last-write-wins per debounce key. When multiple jobs share the same key within `windowMs`, only the **last** one runs — earlier ones are silently discarded.

```typescript
import { Debounce } from 'ovnqueue';

new Debounce({
    windowMs: 500,  // 500ms debounce window

    // Optional: key extractor (default: job.type)
    keyFn: (job) => `${job.type}:${job.payload.userId}`,
})
```

```typescript
// Only the last enqueue within 500ms will actually run:
await queue.enqueue({ type: 'sync-user', payload: { userId: '42' } });
await queue.enqueue({ type: 'sync-user', payload: { userId: '42' } }); // ← this one wins
```

### JobTTL

Auto-expires jobs that remain pending beyond a configured TTL. Emits `expired` event.

```typescript
import { JobTTL } from 'ovnqueue';

const queue = new JobQueue({
    name: 'q',
    plugins: [new JobTTL()],
});

// Set TTL per-job at enqueue time:
await queue.enqueue({
    type: 'critical-task',
    payload: { ... },
    ttl: 30_000, // expire if not started within 30 seconds
});
```

Listen for expirations:

```typescript
queue.on('expired', (job) => {
    console.log(`Job ${job.id} expired after ${job.ttl}ms`);
});
```

### DeadLetterQueue

Captures permanently failed jobs (exhausted all retry attempts). Provides inspect, retry, and purge APIs.

```typescript
import { DeadLetterQueue } from 'ovnqueue';

const dlq = new DeadLetterQueue();

const queue = new JobQueue({
    name: 'q',
    plugins: [dlq],
});

// Listen for jobs entering DLQ
queue.on('dead-letter', (job, error) => {
    console.error(`Job ${job.id} permanently failed:`, error.message);
});

// --- DLQ Management API ---

dlq.list();              // DLQEntry[] — all captured entries
dlq.get(jobId);          // DLQEntry | undefined
dlq.has(jobId);          // boolean
dlq.size;                // number of entries

await dlq.retry(jobId);  // re-enqueue job back into the queue
dlq.delete(jobId);       // remove entry without re-enqueuing
dlq.purge();             // clear all DLQ entries
```

### Metrics

Tracks processing stats and latency. Access via `metrics.snapshot()`.

```typescript
import { Metrics } from 'ovnqueue';

const metrics = new Metrics();

const queue = new JobQueue({
    name: 'q',
    plugins: [metrics],
});

// Get a snapshot of current stats
const snap = metrics.snapshot(await adapter.size());
// {
//   processed: 1402,
//   failed: 3,
//   retried: 8,
//   expired: 1,
//   depth: 47,          // current queue depth (injected)
//   avgLatencyMs: 124,
//   activeWorkers: 5,
// }

metrics.reset(); // reset all counters
```

### JobTracePlugin

Provides out-of-the-box structured JSON logging for the entire job lifecycle.

```typescript
import { JobTracePlugin } from 'ovnqueue';

const queue = new JobQueue({
    name: 'q',
    plugins: [new JobTracePlugin()],
});
```

---

## Retry Policies

All retry policies implement `IRetryPolicy`. The queue-level default is `ExponentialBackoff`. Override per-job using `retryPolicy`.

### ExponentialBackoff

Exponential backoff with full jitter. Default retry policy.

```typescript
import { ExponentialBackoff } from 'ovnqueue';

new ExponentialBackoff({
    maxAttempts: 5,     // total attempts including first
    base: 1_000,        // base delay in ms (default: 1000)
    cap: 60_000,        // max delay cap in ms (default: 60000)
})

// Delay formula: random(0, min(cap, base * 2^attempt))
// attempt 1 → 0–2s
// attempt 2 → 0–4s
// attempt 3 → 0–8s  ... capped at cap
```

### LinearBackoff

Fixed-interval delay between every retry attempt.

```typescript
import { LinearBackoff } from 'ovnqueue';

new LinearBackoff({
    maxAttempts: 3,
    interval: 2_000, // wait 2s before each retry (default: 1000)
})
```

### NoRetry

Disables retries entirely. Job fails immediately on first error.

```typescript
import { NoRetry } from 'ovnqueue';

new NoRetry()
```

### CustomRetry

Full control via a predicate and delay function.

```typescript
import { CustomRetry } from 'ovnqueue';

new CustomRetry({
    // Retry only on transient errors, max 4 times
    predicate: (attempt, err) =>
        attempt < 4 && (err.message.includes('EAGAIN') || err.message.includes('timeout')),

    // Progressive delay: 500ms, 1000ms, 1500ms...
    delay: (attempt) => attempt * 500,
})
```

#### Per-job retry override

```typescript
await queue.enqueue({
    type: 'my-job',
    payload: { ... },
    retryPolicy: new LinearBackoff({ maxAttempts: 10, interval: 500 }),
});
```

---

## Flow Control

`FlowController` enables sequential Chains and complex DAGs. Both are managed internally by `JobQueue` — use the methods on the queue instance.

### Chains

Ordered sequence: job A runs, then B, then C. If any step fails, the chain is cancelled.

```typescript
const flowId = await queue.chain([
    { type: 'download-file',  payload: { url: 'https://...' } },
    { type: 'process-file',   payload: { format: 'mp4' } },
    { type: 'upload-result',  payload: { bucket: 'my-bucket' } },
]);

queue.on('flow:completed', (id) => {
    if (id === flowId) console.log('Pipeline complete!');
});

queue.on('flow:failed', (id, error) => {
    if (id === flowId) console.error('Pipeline failed:', error.message);
});
```

### DAG

Directed Acyclic Graph — jobs with explicit `dependsOn` edges. All dependencies must complete before a node starts.

```typescript
const flowId = await queue.dag({
    nodes: {
        'fetch-data': {
            type: 'fetch',
            payload: { source: 'api' },
        },
        'transform-a': {
            type: 'transform',
            payload: { mode: 'normalize' },
            dependsOn: ['fetch-data'],       // waits for fetch-data
        },
        'transform-b': {
            type: 'transform',
            payload: { mode: 'enrich' },
            dependsOn: ['fetch-data'],       // waits for fetch-data
        },
        'merge': {
            type: 'merge',
            payload: {},
            dependsOn: ['transform-a', 'transform-b'], // waits for both
        },
        'notify': {
            type: 'notify',
            payload: { channel: 'slack' },
            dependsOn: ['merge'],
        },
    },
});
```

```
fetch-data
    ├── transform-a ──┐
    └── transform-b ──┴── merge ── notify
```

> **Cycle detection:** The DAG engine uses Kahn's topological sort algorithm and throws `CyclicDependencyError` if a cycle is detected.

---

## Multi-Process Sharding (IPC)

For applications running many isolated workers (e.g. 120 WhatsApp bots), `ovnqueue` provides a built-in sharding layer using Node.js `cluster` IPC.

**Architecture:**

```
MAIN PROCESS
  └── IpcRouter
        ├── registerShard('bot-001', childProcess1) ──→ WORKER PROCESS 1 (IpcWorker + JobQueue)
        ├── registerShard('bot-002', childProcess2) ──→ WORKER PROCESS 2 (IpcWorker + JobQueue)
        └── registerShard('bot-N',   childProcessN) ──→ WORKER PROCESS N (IpcWorker + JobQueue)
```

Each child process owns its own `JobQueue` and (optionally) its own Oblivinx3x database, eliminating all lock contention.

### IpcRouter (Main Process)

```typescript
import { IpcRouter } from 'ovnqueue';
import cluster from 'node:cluster';

const router = new IpcRouter({
    maxConcurrentPerShard: 64,  // max in-flight IPC requests per shard (default: 64)
    requestTimeoutMs: 10_000,   // IPC response timeout in ms (default: 10000)
});

// Register each worker process as a shard
const worker = cluster.fork({ SHARD_KEY: 'bot-001' });
router.registerShard('bot-001', worker.process);

// Enqueue a job — will be routed to the 'bot-001' shard
await router.enqueue({
    shardKey: 'bot-001',
    type: 'send-message',
    payload: { text: 'Hello!', to: '+628...' },
});

// Control all shards
router.pause();   // broadcast pause to all connected shards
router.resume();  // broadcast resume to all connected shards
await router.shutdown(); // graceful shutdown of all shards

// Explicit shard removal (e.g. after planned shutdown of a bot)
router.deregisterShard('bot-001');
```

#### IpcRouter Options

| Option | Type | Default | Description |
|---|---|---|---|
| `maxConcurrentPerShard` | `number` | `64` | Max in-flight IPC requests per shard. Excess requests are queued locally to prevent IPC channel flooding. |
| `requestTimeoutMs` | `number` | `10000` | Milliseconds before an unacknowledged IPC request is rejected with a timeout error. |

#### IpcRouter API

| Method | Returns | Description |
|---|---|---|
| `registerShard(key, child)` | `void` | Register a child process for a shard key |
| `deregisterShard(key)` | `void` | Deregister and reject all pending requests for this shard |
| `enqueue(options)` | `Promise<string>` | Route a job to the correct shard |
| `pause()` | `void` | Send pause to all connected shards |
| `resume()` | `void` | Send resume to all connected shards |
| `shutdown()` | `Promise<void>` | Gracefully shut down all shards |

### IpcWorker (Child Process)

```typescript
import { IpcWorker, JobQueue, OvnDbAdapter } from 'ovnqueue';

const shardKey = process.env.SHARD_KEY!; // e.g. 'bot-001'

// Each shard gets its own isolated database
const adapter = new OvnDbAdapter({ path: `./jobs_${shardKey}.ovn` });
await adapter.initialize();

const queue = new JobQueue({
    name: `shard-${shardKey}`,
    adapter,
    workers: { min: 2, max: 4 },
});

queue.register('send-message', async (payload, ctx) => {
    // handle job...
});

await queue.initialize();

// Start listening for IPC commands from the main process
const worker = new IpcWorker(queue);
worker.start();

// Notify main process we're ready
process.send?.({ ready: true });
```

### Benchmark Script

A ready-to-run benchmark is included at `scripts/benchmark-sharded.mjs`:

```bash
node scripts/benchmark-sharded.mjs
```

It spawns up to 4 worker processes and routes 10,000 jobs with a configurable concurrency semaphore, measuring end-to-end throughput.

---

## Events

Listen to queue events using the standard `on` / `once` / `off` pattern:

```typescript
queue.on('enqueued',       (job) => { });
queue.on('active',         (job) => { });
queue.on('completed',      (job, result) => { });
queue.on('failed',         (job, error) => { });
queue.on('retrying',       (job, attempt) => { });
queue.on('expired',        (job) => { });
queue.on('dead-letter',    (job, error) => { });
queue.on('flow:completed', (flowId) => { });
queue.on('flow:failed',    (flowId, error) => { });
queue.on('worker:scaled-up',   (count) => { });
queue.on('worker:scaled-down', (count) => { });
queue.on('worker:error',       (error) => { });
queue.on('error',              (error) => { });
```

All event names are available as constants via `QueueEvent`:

```typescript
import { QueueEvent } from 'ovnqueue';

queue.on(QueueEvent.COMPLETED, (job, result) => { /* ... */ });
queue.on(QueueEvent.DEAD_LETTER, (job, error) => { /* ... */ });
```

| Event | Payload | Fired when |
|---|---|---|
| `enqueued` | `(job)` | Job added to queue |
| `active` | `(job)` | Worker picks up a job |
| `completed` | `(job, result)` | Job handler returns successfully |
| `failed` | `(job, error)` | Job fails (may still retry) |
| `retrying` | `(job, attempt)` | Job scheduled for retry |
| `expired` | `(job)` | Job TTL elapsed |
| `dead-letter` | `(job, error)` | Job exhausted all retries |
| `flow:completed` | `(flowId)` | All jobs in a chain/DAG finished |
| `flow:failed` | `(flowId, error)` | A step in a chain/DAG failed |
| `worker:scaled-up` | `(count)` | Worker pool grew |
| `worker:scaled-down` | `(count)` | Worker pool shrank |
| `worker:error` | `(error)` | Unhandled worker error |
| `error` | `(error)` | General queue error |

---

## Persistence & Crash Recovery

Enable WAL-based persistence to survive process crashes:

```typescript
const queue = new JobQueue({
    name: 'prod-queue',
    adapter: new OvnDbAdapter({ path: './jobs.ovn' }),
    persistence: {
        enabled: true,
        walPath: './prod-queue.wal',
        snapshotPath: './prod-queue.snapshot.json',
        snapshotIntervalMs: 30_000, // snapshot every 30s
    },
});

await queue.initialize(); // ← automatically replays WAL on startup
```

**How it works:**

1. Every `enqueue`, `complete`, and `fail` event is appended to the WAL file.
2. Periodically, a full snapshot is written to the snapshot file and the WAL is truncated.
3. On `initialize()`, the recovery module reads the snapshot (if present), then replays any WAL entries to reconstruct in-flight jobs.

> **Per-shard persistence:** In multi-process mode, each child process should use its own WAL/snapshot path and adapter path to avoid file lock conflicts.

---

## Utilities

### CircuitBreaker

Prevents cascading failures by blocking calls after consecutive errors.

```typescript
import { CircuitBreaker } from 'ovnqueue';

const breaker = new CircuitBreaker({
    failureThreshold: 5,      // open after 5 consecutive failures
    recoveryTimeMs: 30_000,   // wait 30s before probing (HALF_OPEN)
});

try {
    const result = await breaker.execute(() => callExternalApi());
} catch (err) {
    if (err.message.includes('Circuit is OPEN')) {
        // fail fast, don't hit the external service
    }
}

breaker.currentState;   // 'CLOSED' | 'OPEN' | 'HALF_OPEN'
breaker.isOpen;         // boolean shorthand
breaker.reset();        // manually reset to CLOSED
```

**State machine:**

```
CLOSED ──(N failures)──→ OPEN ──(recoveryTimeMs)──→ HALF_OPEN
  ↑                                                      │
  └──────────────── (probe success) ────────────────────┘
                     (probe failure) → OPEN
```

### Logger

Two built-in logger implementations. Inject via `ConsoleLogger` or `NullLogger`, or implement `ILogger`.

```typescript
import { ConsoleLogger, NullLogger, defaultLogger } from 'ovnqueue';

// Enable console logging (stdout + stderr)
const logger = new ConsoleLogger();

// Silent logger (useful for tests)
const nullLogger = new NullLogger();
```

```typescript
// Implement your own:
import type { ILogger } from 'ovnqueue';

class PinoLogger implements ILogger {
    info(msg: string, meta?: Record<string, unknown>) { pino.info(meta, msg); }
    warn(msg: string, meta?: Record<string, unknown>) { pino.warn(meta, msg); }
    error(msg: string, meta?: Record<string, unknown>) { pino.error(meta, msg); }
    debug(msg: string, meta?: Record<string, unknown>) { pino.debug(meta, msg); }
}
```

### JobBatch

Group jobs and await completion using all/any semantics.

```typescript
import { JobBatch } from 'ovnqueue';

const batch = new JobBatch();
for (const id of jobIds) batch.track(id);

// Wait for ALL jobs in the batch to settle
const results = await batch.awaitAll();

// Or wait for the FIRST job to complete successfully
const first = await batch.awaitAny();
```

---

## WhatsApp Extensions

`ovnqueue` ships with a complete suite of **in-memory data structures and utilities** designed for WhatsApp bot development. All stores are Redis-API compatible but require **zero external infrastructure** — everything runs in-process with optional file-based persistence.

```
┌────────────────────────────────────────────────┐
│                  WaBotContext                   │ ← Central access point
│  ┌──────────┐  ┌──────────┐  ┌──────────────┐  │
│  │  KvStore  │  │ SortedSet│  │   PubSub     │  │
│  │  (cache,  │  │  (leader │  │  (events,    │  │
│  │  cooldown │  │   boards)│  │   patterns)  │  │
│  │  hash,    │  │          │  │              │  │
│  │  list)    │  │          │  │  TypedPubSub │  │
│  └──────────┘  └──────────┘  └──────────────┘  │
│  ┌──────────────┐  ┌────────────────────────┐  │
│  │ SessionStore  │  │    CronScheduler       │  │
│  │ (multi-step   │  │    (recurring jobs,    │  │
│  │  conversation)│  │     cron + intervals)  │  │
│  └──────────────┘  └────────────────────────┘  │
└────────────────────────────────────────────────┘
```

### WaBotContext

Central helper class that wires all stores together. Use this instead of passing individual stores to every handler.

```typescript
import {
    WaBotContext, KvStore, SortedSet, PubSub, SessionStore, CronScheduler
} from 'ovnqueue';

const kv = new KvStore({ persistPath: './data/kv.json' });
const ss = new SortedSet({ persistPath: './data/ss.json' });
const pubsub = new PubSub();
const sessions = new SessionStore({ kv, pubsub });
const cron = new CronScheduler(
    { persistPath: './data/cron.json' },
    (opts) => queue.enqueue(opts),
);

const ctx = new WaBotContext({ kv, ss, pubsub, sessions, cron });
await ctx.initialize();

// ── Shorthand methods ──
ctx.cooldown(userJid, 'daily', 86_400_000);          // set cooldown
ctx.rateCheck(userJid, groupJid, 5, 10_000);          // sliding window
ctx.lock(groupJid, 'game', 30_000);                    // mutex
ctx.unlock(groupJid, 'game');                           // release
ctx.award('quiz', groupJid, userJid, 10);              // leaderboard
ctx.leaderboard('quiz', groupJid, 10);                 // top 10
ctx.emit('game:start', { userJid, groupJid, gameType: 'quiz' });
ctx.on('game:answer', async (data) => { /* ... */ });
ctx.startSession(userJid, groupJid, 'register', { step: 1 });
ctx.endSession(userJid, groupJid);
ctx.schedule('daily-reset', '0 0 * * *', 'reset-stats', {});

// ── Graceful shutdown ──
process.on('SIGINT', () => ctx.shutdown());
```

| Method | Returns | Description |
|---|---|---|
| `initialize()` | `Promise<void>` | Initialize cron scheduler |
| `shutdown()` | `Promise<void>` | Save all snapshots, stop timers |
| `cooldown(jid, cmd, ttlMs)` | `boolean` | Set per-user per-command cooldown |
| `rateCheck(jid, group, limit, windowMs)` | `{ allowed, count, resetIn }` | Sliding window rate check |
| `lock(group, resource, ttlMs)` | `boolean` | Mutex lock |
| `unlock(group, resource)` | `void` | Release lock |
| `isLocked(group, resource)` | `boolean` | Check lock status |
| `award(gameType, group, jid, points)` | `{ newScore, rank }` | Award leaderboard points |
| `leaderboard(gameType, group, limit)` | `Array<{ rank, member, score }>` | Get leaderboard |
| `emit(channel, payload)` | `number` | Publish event |
| `on(channel, handler)` | `Subscription` | Subscribe to event |
| `session(jid, group)` | `SessionData \| null` | Get active session |
| `startSession(jid, group, step, data)` | `SessionData` | Start new session |
| `endSession(jid, group)` | `boolean` | End session |
| `schedule(id, cron, jobType, payload)` | `void` | Add scheduled job |

---

### KvStore

In-memory key-value store with Redis-compatible API. Supports TTL, atomic operations, Hash and List data structures, and file-based persistence.

```typescript
import { KvStore } from 'ovnqueue';

const kv = new KvStore({
    persistPath: './data/kv.json',      // optional file persistence
    snapshotIntervalMs: 30_000,          // auto-save every 30s
    maxKeys: 50_000,                     // evict oldest when full
});
```

#### Core Operations

```typescript
// SET / GET / DEL
kv.set('afk:628xxx', 'sleeping', { ttlMs: 3600_000 });
const reason = kv.get<string>('afk:628xxx');          // 'sleeping' or null
kv.del('afk:628xxx');                                  // 1

// TTL management
kv.expire('key', 60_000);    // set TTL
kv.persist('key');            // remove TTL
kv.ttl('key');                // remaining ms, -1 = no TTL, -2 = not found
kv.exists('key1', 'key2');   // count of existing keys

// Batch
kv.mset([{ key: 'a', value: 1 }, { key: 'b', value: 2, ttlMs: 5000 }]);
const [a, b] = kv.mget<number>('a', 'b');

// Key enumeration
kv.keys('cooldown:*');                      // glob pattern matching
kv.scan(0, 'session:*', 100);              // cursor-based iteration
kv.dbsize();                                // live key count
kv.flush();                                 // delete all
```

#### Counter Operations

```typescript
// Atomic increment/decrement (creates key at 0 if not exists)
const count = kv.incr('spam:628xxx', 1, 10_000);   // sliding window TTL reset
kv.decr('balance:628xxx', 100);

// Get-and-set atomically
const prev = kv.getset<number>('counter', 0);
```

#### Hash Operations

Store structured data per key. TTL applies to the whole hash, not individual fields.

```typescript
// HSET / HGET
kv.hset('user:628xxx', 'name', 'Budi');
kv.hset('user:628xxx', 'level', 5);
const name = kv.hget<string>('user:628xxx', 'name');   // 'Budi'

// HDEL / HGETALL / HKEYS / HLEN / HEXISTS
kv.hdel('user:628xxx', 'tempField');                     // 1
const profile = kv.hgetall('user:628xxx');                // { name: 'Budi', level: 5 }
kv.hkeys('user:628xxx');                                  // ['name', 'level']
kv.hlen('user:628xxx');                                   // 2
kv.hexists('user:628xxx', 'name');                        // true

// HINCRBY — atomic field increment
kv.hincrby('user:628xxx', 'level', 1);                   // 6
```

#### List Operations

Double-ended queue with optional `maxLen` trimming.

```typescript
// LPUSH / RPUSH
kv.lpush('history:628xxx', 'cmd1', 'cmd2');              // prepend, returns length
kv.rpush('queue:628xxx', 'item1');                        // append, returns length

// With maxLen — auto-trims from the opposite end
kv.lpush('recent:628xxx', 'latest', { maxLen: 100 });

// LPOP / RPOP
const first = kv.lpop<string>('queue:628xxx');
const last = kv.rpop<string>('history:628xxx');

// LRANGE (negative indexes supported: -1 = last)
kv.lrange<string>('history:628xxx', 0, -1);              // all items
kv.lrange<string>('history:628xxx', 0, 4);               // first 5

// LLEN
kv.llen('queue:628xxx');                                  // 3
```

#### Bot Helpers

```typescript
// SETNX — mutex lock
if (!kv.setnx(`lock:game:${groupJid}`, 1, 30_000)) {
    return 'Game already running!';
}

// Sliding-window rate check
const r = kv.rateCheck(`spam:${jid}:${groupJid}`, 5, 10_000);
if (!r.allowed) warn(jid, `Slow down! Try again in ${r.resetIn}ms`);

// Simple cooldown
if (!kv.cooldown(`cmd:daily:${jid}`, 86_400_000)) {
    return `Daily sudah diklaim! Coba lagi dalam ${kv.ttl('cmd:daily:' + jid)}ms`;
}
```

| Method | Returns | Description |
|---|---|---|
| `set(key, value, opts?)` | `boolean` | Set value with optional TTL, NX, XX |
| `get<T>(key)` | `T \| null` | Get value or null |
| `del(...keys)` | `number` | Delete keys, returns count |
| `incr(key, by?, resetTtlMs?)` | `number` | Atomic increment |
| `hset(key, field, value)` | `void` | Set hash field |
| `hget<T>(key, field)` | `T \| null` | Get hash field |
| `hgetall(key)` | `Record \| null` | Get all hash fields |
| `hincrby(key, field, by)` | `number` | Increment hash field |
| `lpush(key, ...values)` | `number` | Prepend to list |
| `rpush(key, ...values)` | `number` | Append to list |
| `lpop<T>(key)` | `T \| null` | Pop from front |
| `rpop<T>(key)` | `T \| null` | Pop from back |
| `lrange<T>(key, start, stop)` | `T[]` | Get range |
| `rateCheck(key, limit, windowMs)` | `{ allowed, count, resetIn }` | Rate limit check |
| `cooldown(key, ttlMs)` | `boolean` | Set cooldown, false if active |
| `shutdown()` | `Promise<void>` | Save snapshot, stop timers |

---

### SortedSet

Redis ZSET-compatible sorted set for leaderboards and rankings.

```typescript
import { SortedSet } from 'ovnqueue';

const ss = new SortedSet({ persistPath: './data/ss.json' });

// Basic operations
ss.zadd('lb:quiz:group1', 10, 'user1');      // 1 (new member)
ss.zincrby('lb:quiz:group1', 5, 'user1');    // 15 (new score)
ss.zscore('lb:quiz:group1', 'user1');        // 15
ss.zrank('lb:quiz:group1', 'user1');         // 0-based ascending rank
ss.zrevrank('lb:quiz:group1', 'user1');      // 0-based descending rank
ss.zcard('lb:quiz:group1');                  // member count

// Range queries
ss.zrange('lb:quiz:group1', 0, 9);              // string[] top 10 ASC
ss.zrange('lb:quiz:group1', 0, 9, true);         // ZMember[] with scores
ss.zrevrange('lb:quiz:group1', 0, 9, true);      // ZMember[] DESC (leaderboard)
ss.zrangebyscore('lb:quiz:group1', 50, 100);     // members in score range

// Bot helpers
const { newScore, rank } = ss.award('quiz', groupJid, userJid, 10);
const top10 = ss.leaderboard('quiz', groupJid, 10);
// [{ rank: 1, member: 'jid1', score: 980 }, ...]
ss.resetLeaderboard('quiz', groupJid);
```

#### Global Leaderboard

Aggregate scores across all groups for a game type:

```typescript
// Sum scores per user across every lb:quiz:* set
const global = ss.globalLeaderboard('quiz', 10);
// [{ rank: 1, member: 'jid1', score: 2450, groups: 3 }, ...]
```

---

### PubSub

In-process publish-subscribe event bus with Redis-compatible API and pattern matching.

```typescript
import { PubSub } from 'ovnqueue';

const pubsub = new PubSub({ maxListeners: 100 });

// Exact channel subscription
const sub = pubsub.subscribe('group:join', async ({ jid, groupJid }) => {
    await sendWelcome(jid, groupJid);
});

// Pattern subscription (glob)
pubsub.psubscribe('game:*', (data, channel) => {
    console.log(`Event on ${channel}:`, data);
});

// Publish event (triggers exact + pattern subscribers)
pubsub.publish('group:join', { jid, groupJid, timestamp: Date.now() });

// Subscribe once (auto-unsubscribes after first message)
pubsub.subscribeOnce('game:end', (result) => announceWinner(result));

// Await next message with timeout
const reply = await pubsub.waitFor('reply:628xxx', 30_000);
if (!reply) return 'Waktu habis!';

// Unsubscribe
sub.unsubscribe();
pubsub.unsubscribe('group:join');             // remove all handlers
pubsub.punsubscribe('game:*', myHandler);     // remove specific pattern handler

// Info
pubsub.activeChannels('group:*');             // list matching channels
pubsub.numSub('group:join', 'group:leave');   // subscriber counts
```

#### TypedPubSub

Type-safe pub/sub wrapper using an event map. All channels and payloads are fully typed.

```typescript
import { TypedPubSub } from 'ovnqueue';
import type { WaBotEvents } from 'ovnqueue';

const typed = new TypedPubSub<WaBotEvents>();

// ✅ Fully typed — IDE autocomplete for channel names and payload shapes
typed.subscribe('group:join', ({ jid, groupJid, name, timestamp }) => {
    // jid: string, groupJid: string, name: string, timestamp: number
});

typed.publish('group:join', {
    jid: '628xxx@s.whatsapp.net',
    groupJid: '120363xxx@g.us',
    name: 'Budi',
    timestamp: Date.now(),
});

// ❌ TypeScript error — 'invalid:event' not in WaBotEvents
typed.publish('invalid:event', {});

// Access raw PubSub for pattern subscriptions
typed.raw.psubscribe('game:*', handler);
```

**`WaBotEvents` — built-in event map:**

| Channel | Payload |
|---|---|
| `group:join` | `{ jid, groupJid, name, timestamp }` |
| `group:leave` | `{ jid, groupJid, timestamp }` |
| `message:delete` | `{ messageId, groupJid, senderJid, content }` |
| `message:incoming` | `{ jid, groupJid, text, type, messageId }` |
| `spam:detected` | `{ userJid, groupJid, count, action, muteDuration? }` |
| `game:start` | `{ userJid, groupJid, gameType }` |
| `game:answer` | `{ userJid, groupJid, gameType, correct, points }` |
| `game:end` | `{ groupJid, gameType, winner, finalScore }` |
| `level:up` | `{ userJid, groupJid, oldLevel, newLevel }` |
| `economy:reward` | `{ userJid, type, amount, balance }` |
| `moderation:action` | `{ userJid, groupJid, action, executorJid, reason }` |
| `session:start` | `{ userJid, groupJid, step }` |
| `session:advance` | `{ userJid, groupJid, prevStep, nextStep }` |
| `session:end` | `{ userJid, groupJid }` |

#### IpcPubSubBridge

Bridges pub/sub across IPC processes (multi-shard bots):

```typescript
import { IpcPubSubBridge } from 'ovnqueue';

// Main process — forward events to all shards
const bridge = new IpcPubSubBridge(router, pubsub, () => allShardKeys);

// Child processes — deliver forwarded events
worker.register('__pubsub:deliver__', IpcPubSubBridge.deliverHandler(pubsub));
```

---

### SessionStore

Multi-step conversation state for chatbots. Backed by KvStore — no external DB needed.

```typescript
import { SessionStore, KvStore, PubSub } from 'ovnqueue';

const sessions = new SessionStore({
    kv: kv,                  // shared KvStore (optional, creates its own)
    pubsub: pubsub,          // publishes session events (optional)
    defaultTtlMs: 5 * 60_000, // sessions expire after 5 minutes of inactivity
});

// ── Start a session ──
sessions.start(userJid, groupJid, 'quiz', { questionIndex: 0 });

// ── Get current session ──
const session = sessions.get(userJid, groupJid);
if (session?.step === 'quiz') { /* handle quiz answer */ }

// ── Advance to next step (resets TTL) ──
sessions.advance(userJid, groupJid, 'awaiting-confirm', { answer: 'yes' });

// ── Patch data without changing step ──
sessions.patch(userJid, groupJid, { score: 42 });

// ── Step-gated helper — runs fn only if on expected step ──
await sessions.ifStep(userJid, groupJid, 'awaiting-name', 'awaiting-age', async (session) => {
    return { name: messageText };  // auto-advances to 'awaiting-age'
});

// ── End session ──
sessions.end(userJid, groupJid);

// ── Queries ──
sessions.has(userJid, groupJid);             // boolean
sessions.ttl(userJid, groupJid);             // remaining ms
sessions.touch(userJid, groupJid);           // extend TTL (keepalive)
sessions.count();                             // all active sessions
sessions.forGroup(groupJid);                 // sessions in a group
sessions.clearGroup(groupJid);               // end all sessions in group
sessions.listAll();                           // ALL active sessions
sessions.endAll();                            // end everything (shutdown)
```

| Method | Returns | Description |
|---|---|---|
| `start(jid, group, step, data?, ttlMs?)` | `SessionData` | Create/overwrite session |
| `get(jid, group)` | `SessionData \| null` | Get current session |
| `advance(jid, group, nextStep, dataPatch?)` | `SessionData \| null` | Move to next step |
| `patch(jid, group, dataPatch)` | `SessionData \| null` | Update data only |
| `end(jid, group)` | `boolean` | End session |
| `ifStep(jid, group, expected, next, fn)` | `{ matched, session }` | Conditional step handler |
| `listAll()` | `SessionData[]` | All active sessions |
| `endAll()` | `number` | End all sessions |

---

### CronScheduler

Persistent scheduler for recurring jobs, integrated with `ovnqueue`. Survives bot restarts.

```typescript
import { CronScheduler } from 'ovnqueue';

const cron = new CronScheduler(
    { persistPath: './data/cron.json', tickMs: 1_000 },
    (opts) => queue.enqueue(opts),   // enqueue function
);

await cron.initialize();

// ── Standard 5-field cron ──
cron.add({ id: 'daily-reset',  schedule: '0 0 * * *',  jobType: 'reset-stats', payload: {} });
cron.add({ id: 'sunday-report', schedule: '0 20 * * 0', jobType: 'weekly-report', payload: {} });

// ── Human-readable intervals ──
cron.add({ id: 'cleanup', schedule: 'every 1 hour', jobType: 'db-cleanup', payload: {} });
cron.add({ id: 'flush',   schedule: 'every 10 minutes', jobType: 'flush-stats', payload: {} });

// ── Interval shorthand (ms) ──
cron.addInterval('heartbeat', 30_000, 'health-check', {});
cron.addInterval('temp-task', 5 * 60_000, 'process', {}, 10);  // max 10 runs

// ── Management ──
cron.remove('daily-reset');
cron.setEnabled('cleanup', false);         // disable without removing
cron.list({ enabled: true });              // list enabled schedules
cron.get('daily-reset');                   // get by ID
await cron.runNow('daily-reset');          // force immediate fire

// ── Global pause/resume ──
cron.pause();       // stop all firing
cron.resume();      // resume firing
cron.isPaused;      // boolean

// ── Shutdown ──
await cron.shutdown();
```

**Supported cron formats:**

| Format | Example | Description |
|---|---|---|
| Standard 5-field | `0 0 * * *` | Midnight daily |
| Standard 5-field | `*/15 * * * *` | Every 15 minutes |
| Standard 5-field | `0 8 1 * *` | 8 AM on 1st of month |
| Shorthand | `every 30 seconds` | Every 30 seconds |
| Shorthand | `every 5 minutes` | Every 5 minutes |
| Shorthand | `every 2 hours` | Every 2 hours |
| Numeric (ms) | `60_000` | Every 60 seconds |

---

### WhatsApp Plugins

Four specialized plugins for WhatsApp bot job queues. All implement the `IPlugin` interface and hook into `onEnqueue`.

#### AntiSpamPlugin

Detects message floods using a sliding window counter:

```typescript
import { AntiSpamPlugin } from 'ovnqueue';

const antiSpam = new AntiSpamPlugin({
    maxMessages: 5,                           // max 5 messages
    windowMs: 10_000,                          // in 10 seconds
    action: { action: 'mute', muteDuration: 5 * 60_000 },
    kv,                                        // shared KvStore
    pubsub,                                    // emits 'spam:detected'
    whitelist: ['admin@s.whatsapp.net'],       // exempt users
    trackTypes: ['send-message'],              // job types to track
});

const queue = new JobQueue({ name: 'msg', plugins: [antiSpam] });
```

Jobs must have `payload.userJid` and `payload.groupJid`.

#### WaRateLimiterPlugin

Enforces WhatsApp's unofficial per-second and per-minute send limits:

```typescript
import { WaRateLimiterPlugin } from 'ovnqueue';

const waRate = new WaRateLimiterPlugin({
    maxPerSecond: 1,           // ~1 msg/sec sustained
    maxPerMinute: 20,          // burst cap
    sendTypes: ['send-message', 'send-reply', 'send-media', 'broadcast'],
    botKey: 'bot-001',         // namespace for multi-bot setups
    kv,
    pubsub,                    // emits 'wa-rate:throttled'
});
```

#### MessageBufferPlugin

Coalesces rapid-fire sends to the same target into a single merged message:

```typescript
import { MessageBufferPlugin } from 'ovnqueue';

const buffer = new MessageBufferPlugin({
    bufferMs: 300,             // wait 300ms before flushing
    maxBuffer: 5,              // force flush at 5 messages
    jobType: 'send-message',
});

// Register flush callback
buffer.onFlush(async (target, messages) => {
    await waClient.sendMessage(target, messages.join('\n'));
});

// Cleanup on shutdown
buffer.shutdown();
```

#### CommandCooldownPlugin

Per-user, per-command cooldowns without a database:

```typescript
import { CommandCooldownPlugin } from 'ovnqueue';

const cooldown = new CommandCooldownPlugin({
    defaultCooldownMs: 5_000,
    commandCooldowns: {
        daily:  86_400_000,       // 24 hours
        weekly: 7 * 86_400_000,
        game:   30_000,
        quiz:   10_000,
    },
    commandField: 'command',      // payload field for command name
    userField: 'userJid',         // payload field for user JID
    adminJids: ['6281xxx@s.whatsapp.net'],
    kv,
});

// Manual management
cooldown.clear('628xxx@s.whatsapp.net', 'daily');
cooldown.remaining('628xxx@s.whatsapp.net', 'daily');   // ms remaining
cooldown.activeCooldowns('628xxx@s.whatsapp.net');       // { daily: 82000, game: 5000 }
```

---

## Error Reference

All errors extend `QueueError` (which extends `Error`).

| Error Class | Thrown when |
|---|---|
| `QueueError` | Base error for all queue errors |
| `JobTimeoutError` | Job exceeded `maxDuration` |
| `AdapterError` | Storage adapter operation failed |
| `RateLimitError` | `RateLimiter` or `Throttle` limit exceeded |
| `DiscardJobError` | Plugin signals the job should be silently dropped (e.g. `Debounce`) |
| `DependencyError` | DAG dependency error (missing or failed dependency) |
| `CyclicDependencyError` | DAG contains a cycle |
| `UnknownJobTypeError` | No handler registered for job type |

```typescript
import {
    QueueError,
    JobTimeoutError,
    AdapterError,
    RateLimitError,
    DiscardJobError,
    DependencyError,
    CyclicDependencyError,
} from 'ovnqueue';

queue.on('failed', (job, error) => {
    if (error instanceof JobTimeoutError) {
        // job ran too long
    } else if (error instanceof RateLimitError) {
        // rate limit or concurrency cap hit
    }
});
```

---

## TypeScript Types Reference

```typescript
import type {
    // Job types
    Job,
    JobPayload,
    JobOptions,
    JobResult,
    JobSuccess,
    JobFailure,
    JobContext,
    JobHandler,
    JobState,

    // Configuration
    QueueConfig,
    ResolvedQueueConfig,
    WorkerConfig,
    PersistenceConfig,
    MetricsSnapshot,

    // Adapter & Plugin
    IStorageAdapter,
    IPlugin,

    // Retry
    IRetryPolicy,

    // Flow
    FlowNode,
    DAGConfig,
    DAGNode,
    ChainStep,

    // Utility
    IClock,
    ILogger,

    // Plugin options
    RateLimiterOptions,
    ThrottleOptions,
    DebounceOptions,

    // ── WhatsApp Extensions ──
    // KvStore
    KvEntry,
    KvStoreOptions,
    KvSetOptions,
    KvScanResult,

    // SortedSet
    ZMember,
    SortedSetOptions,

    // PubSub
    PubSubHandler,
    PubSubOptions,
    Subscription,

    // Session
    SessionData,
    SessionStoreOptions,

    // Scheduler
    ScheduleEntry,
    CronSchedulerOptions,

    // WhatsApp plugins
    AntiSpamOptions,
    AntiSpamAction,
    WaRateLimiterOptions,
    MessageBufferOptions,
    CommandCooldownOptions,

    // WA types
    WaBotEvents,
    WaBotContextOptions,
    ListPushOptions,
} from 'ovnqueue';
```

---

## API Reference

### `JobQueue`

| Method | Signature | Description |
|---|---|---|
| `register` | `(type: string, handler: JobHandler) => void` | Register a handler for a job type |
| `initialize` | `() => Promise<void>` | Start recovery and workers |
| `enqueue` | `(options: JobOptions) => Promise<string>` | Add a job, returns job ID |
| `chain` | `(steps: ChainStep[]) => Promise<string>` | Create a sequential flow, returns flowId |
| `dag` | `(config: DAGConfig) => Promise<string>` | Create a DAG flow, returns flowId |
| `pause` | `() => void` | Pause processing |
| `resume` | `() => void` | Resume processing |
| `drain` | `() => Promise<void>` | Wait for all active jobs to complete |
| `shutdown` | `() => Promise<void>` | Graceful shutdown |
| `runInProcess` | `(type, payload, options?) => Promise<R>` | Run a job handler directly in-process |
| `on` | `(event, listener) => this` | Subscribe to an event |
| `once` | `(event, listener) => this` | Subscribe once |
| `off` | `(event, listener) => this` | Unsubscribe |

### `IpcRouter`

| Method | Signature | Description |
|---|---|---|
| `registerShard` | `(key: string, child: ChildProcess) => void` | Register a worker process |
| `deregisterShard` | `(key: string) => void` | Remove a shard |
| `enqueue` | `(options: JobOptions) => Promise<string>` | Route a job to the shard |
| `pause` / `resume` | `() => void` | Broadcast to all shards |
| `shutdown` | `() => Promise<void>` | Graceful shutdown all shards |

### `KvStore`

| Method | Signature | Description |
|---|---|---|
| `set` | `(key, value, opts?) => boolean` | Set with TTL/NX/XX |
| `get<T>` | `(key) => T \| null` | Get value |
| `del` | `(...keys) => number` | Delete keys |
| `exists` | `(...keys) => number` | Count existing keys |
| `incr` / `decr` | `(key, by?, resetTtlMs?) => number` | Atomic counter |
| `hset` / `hget` / `hdel` | Hash operations | Redis HSET/HGET/HDEL |
| `hgetall` / `hkeys` / `hlen` / `hexists` | Hash queries | Hash introspection |
| `hincrby` | `(key, field, by) => number` | Atomic hash field increment |
| `lpush` / `rpush` | `(key, ...values) => number` | List push |
| `lpop` / `rpop` | `(key) => T \| null` | List pop |
| `lrange` | `(key, start, stop) => T[]` | List range |
| `llen` | `(key) => number` | List length |
| `keys` / `scan` | Pattern/cursor iteration | Key enumeration |
| `rateCheck` | `(key, limit, windowMs)` | Sliding window rate check |
| `cooldown` / `setnx` | Atomic helpers | Bot convenience methods |
| `shutdown` | `() => Promise<void>` | Save and stop |

### `SortedSet`

| Method | Signature | Description |
|---|---|---|
| `zadd` | `(key, score, member) => 0 \| 1` | Add/update member |
| `zincrby` | `(key, by, member) => number` | Increment score |
| `zrem` | `(key, ...members) => number` | Remove members |
| `zscore` / `zrank` / `zrevrank` | Score and rank queries | Member lookup |
| `zrange` / `zrevrange` | `(key, start, stop, withScores?) => string[] \| ZMember[]` | Range queries |
| `leaderboard` | `(gameType, groupJid, limit?) => Array` | Group leaderboard |
| `globalLeaderboard` | `(gameType, limit?) => Array` | Cross-group leaderboard |
| `award` | `(gameType, groupJid, userJid, points) => { newScore, rank }` | Award points |
| `shutdown` | `() => Promise<void>` | Save and stop |

### `PubSub` / `TypedPubSub<T>`

| Method | Signature | Description |
|---|---|---|
| `subscribe` | `(channel, handler) => Subscription` | Subscribe to channel |
| `psubscribe` | `(pattern, handler) => Subscription` | Pattern subscription |
| `subscribeOnce` | `(channel, handler) => Subscription` | One-shot subscribe |
| `publish` | `(channel, message) => number` | Publish to subscribers |
| `unsubscribe` / `punsubscribe` | Remove handlers | Unsubscribe |
| `waitFor` | `(channel, timeoutMs?) => Promise<T \| null>` | Await next message |
| `activeChannels` / `numSub` | Channel info | Introspection |

### `SessionStore`

| Method | Signature | Description |
|---|---|---|
| `start` | `(jid, group, step, data?, ttlMs?) => SessionData` | Start session |
| `get` / `has` | Lookup | Get/check session |
| `advance` | `(jid, group, nextStep, dataPatch?) => SessionData \| null` | Move to next step |
| `patch` | `(jid, group, dataPatch) => SessionData \| null` | Update data only |
| `end` | `(jid, group) => boolean` | End session |
| `ifStep` | `(jid, group, expected, next, fn) => Promise` | Conditional step handler |
| `listAll` / `endAll` | Bulk ops | List/end all sessions |
| `forGroup` / `clearGroup` | Group ops | Group-scoped operations |
| `touch` / `ttl` / `count` | Management | Keepalive, TTL, count |

### `CronScheduler`

| Method | Signature | Description |
|---|---|---|
| `initialize` | `() => Promise<void>` | Load schedules and start ticking |
| `add` | `(entry) => ScheduleEntry` | Add/replace a schedule |
| `addInterval` | `(id, ms, jobType, payload, maxRuns?) => ScheduleEntry` | Interval shorthand |
| `remove` | `(id) => boolean` | Remove schedule |
| `setEnabled` | `(id, enabled) => boolean` | Enable/disable |
| `list` / `get` | Query schedules | List/get by ID |
| `runNow` | `(id) => Promise<string \| null>` | Force immediate fire |
| `pause` / `resume` | Global control | Pause/resume all firing |
| `isPaused` | `boolean` | Pause state getter |
| `shutdown` | `() => Promise<void>` | Save and stop |

### `WaBotContext`

| Method | Signature | Description |
|---|---|---|
| `initialize` | `() => Promise<void>` | Initialize cron |
| `shutdown` | `() => Promise<void>` | Save all, stop all |
| `cooldown` | `(jid, cmd, ttlMs) => boolean` | Per-user cooldown |
| `rateCheck` | `(jid, group, limit, windowMs) => { allowed, count, resetIn }` | Rate limit |
| `lock` / `unlock` / `isLocked` | Mutex ops | Resource locking |
| `award` / `leaderboard` | Leaderboard ops | Score management |
| `emit` / `on` | PubSub ops | Event pub/sub |
| `session` / `startSession` / `endSession` | Session ops | Conversation state |
| `schedule` | `(id, cron, jobType, payload) => void` | Add scheduled job |

---

## License

[MIT](LICENSE)

---

*Built for WhatsApp automation at scale — but general enough for any multi-process Node.js job processing workload.*

