# Multi-Process Architecture Design (wa-job-queue)

## 1. Overview
To support highly concurrent multi-process deployments (such as running 120 independent WhatsApp bots), `wa-job-queue` adopts a **Sharded, Per-Bot Local Queue** architecture. Instead of a centralized global queue that all worker processes poll from, the main process acts purely as a router, and each child process runs its own independent `JobQueue` instance mapped to its specific shard (e.g., bot phone number).

This design ensures:
- Zero database lock contention between bots.
- Fast local processing (p-queue style).
- Minimal Inter-Process Communication (IPC) overhead.

## 2. Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│                      MAIN PROCESS                       │
│ ┌────────────────────────────────────────────────────┐ │
│ │                  IpcRouter                         │ │
│ │  - Exposes enqueue(), pause(), resume()            │ │
│ │  - Maps shardKey (botId) to ChildProcess           │ │
│ └──────────────────────┬─────────────────────────────┘ │
└────────────────────────┼───────────────────────────────┘
                         │ (IPC Messages only on enqueue)
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ CHILD PROCESS│ │ CHILD PROCESS│ │ CHILD PROCESS│
│  (Bot 1)     │ │  (Bot 2)     │ │  (Bot N)     │
│              │ │              │ │              │
│ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │
│ │IpcWorker │ │ │ │IpcWorker │ │ │ │IpcWorker │ │
│ └────┬─────┘ │ │ └────┬─────┘ │ │ └────┬─────┘ │
│      ▼       │ │      ▼       │ │      ▼       │
│ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │
│ │ JobQueue │ │ │ │ JobQueue │ │ │ │ JobQueue │ │
│ └────┬─────┘ │ │ └────┬─────┘ │ │ └────┬─────┘ │
│      ▼       │ │      ▼       │ │      ▼       │
│ ┌──────────┐ │ │ ┌──────────┐ │ │ ┌──────────┐ │
│ │ OvnDb    │ │ │ │ OvnDb    │ │ │ │ OvnDb    │ │
│ │ Adapter  │ │ │ │ Adapter  │ │ │ │ Adapter  │ │
│ └──────────┘ │ │ └──────────┘ │ │ └──────────┘ │
│Jobs_Bot1.ovn │ │Jobs_Bot2.ovn │ │Jobs_BotN.ovn │
└──────────────┘ └──────────────┘ └──────────────┘
```

## 3. Key Components

### 3.1 IpcRouter (Main Process)
- Implements a `ShardedQueue` interface.
- Keeps a registry of shard keys (`botId`) to specific IPC channels or `ChildProcess` instances.
- When `router.enqueue({ shardKey: 'bot1', type: 'sendMsg', ... })` is called, it serializes the job options and sends a minimal `process.send({ cmd: 'enqueue', job })` message to the designated child.
- **Does not execute jobs**.

### 3.2 IpcWorker (Child Process)
- Inside the child bot code, an `IpcWorker` wraps a standard `JobQueue` instance.
- It listens to `process.on('message')`. When it receives an `enqueue` command, it calls `localQueue.enqueue()`.
- Runs normal `wa-job-queue` logic, plugins, retries, and local storage.

### 3.3 Sharded Persistence
By passing a unique shard ID to the storage adapter (e.g., `new OvnDbAdapter({ path: './jobs_bot1.ovn' })`), each process is writing to a completely separate database file.
- Prevents lock contention errors.
- Provides immediate startup crash recovery scoped *per bot*.

## 4. Failure Modes & Mitigations

| Failure Scenario | Mitigation |
|------------------|------------|
| Child process crashes | Jobs are safely persisted in the child's local Oblivinx3x DB. On respawn, the new child `JobQueue` performs recovery and resumes execution. |
| IPC transmission fails | `IpcRouter.enqueue` wraps IPC `send` in a Promise. If sending fails or times out, it throws to the caller allowing safe retries on the main thread. |
| Disk space / inodes exhaustion | Since we use separated `.db` files per bot, we can implement periodic snapshotting and prune WAL logs independently per queue to manage disk usage. |

## 5. API Changes

The core `JobQueue` API remains intact. A new `shardKey` optional parameter is introduced in `JobOptions` when routing is necessary.

```typescript
// Enqueue from main process
await router.enqueue({
  shardKey: '628123456789',
  type: 'sendMessage',
  payload: { text: 'Hello' }
});
```
