import type { ChildProcess } from 'child_process';
import type { JobOptions, JobPayload } from '../types/job.types.js';
import type { ShardedQueue, IpcMessage } from './types.js';
import { QueueError } from '../errors/QueueError.js';

interface PendingRequest {
    shardKey: string;
    resolve: (val: any) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface ShardEntry {
    child: ChildProcess;
    /** Number of in-flight IPC requests for this shard */
    inflight: number;
    /** Queue of callbacks waiting for a free concurrency slot */
    waitQueue: Array<() => void>;
}

/**
 * IpcRouter — routes enqueue/control commands to registered ChildProcess shards.
 *
 * ### Fixes & performance improvements over original
 *
 * 1. **Per-shard backpressure** (`maxConcurrentPerShard`, default 64)
 *    Each shard is capped at N in-flight IPC requests. Callers beyond that limit
 *    are queued locally instead of flooding the IPC channel, which was the root
 *    cause of "IPC Channel closed for shard" errors under high load.
 *
 * 2. **Instant disconnect cleanup**
 *    When a child process disconnects or exits, every pending request for that
 *    shard is immediately rejected (previously they would hang silently for the
 *    full timeout duration). The wait-queue is also drained so callers don't
 *    deadlock.
 *
 * 3. **Shard-key attributed errors**
 *    Error messages now include the shard key and command for easier diagnosis.
 *
 * 4. **Configurable request timeout** (`requestTimeoutMs`, default 10 s).
 *
 * 5. **deregisterShard()** — explicit shard removal for planned shutdowns.
 *
 * 6. **Guard on pause()/resume()** — skip disconnected children.
 */
export class IpcRouter implements ShardedQueue {
    private shards = new Map<string, ShardEntry>();
    private pendingRequests = new Map<string, PendingRequest>();
    private reqCounter = 0;

    private readonly maxConcurrentPerShard: number;
    private readonly requestTimeoutMs: number;

    constructor(options: { maxConcurrentPerShard?: number; requestTimeoutMs?: number } = {}) {
        this.maxConcurrentPerShard = options.maxConcurrentPerShard ?? 64;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    }

    /** Register a child process to handle jobs for a specific shardKey. */
    registerShard(shardKey: string, child: ChildProcess): void {
        const entry: ShardEntry = { child, inflight: 0, waitQueue: [] };
        this.shards.set(shardKey, entry);

        // Route inbound response messages to pending resolvers
        child.on('message', (msg: IpcMessage) => {
            if (msg.reqId && this.pendingRequests.has(msg.reqId)) {
                const pending = this.pendingRequests.get(msg.reqId)!;
                clearTimeout(pending.timer);
                this.pendingRequests.delete(msg.reqId);

                if (msg.error) {
                    pending.reject(new QueueError(`IPC Error on shard '${shardKey}': ${msg.error}`));
                } else {
                    pending.resolve(msg.payload);
                }

                this._releaseSlot(entry);
            }
        });

        // Immediately reject all pending requests when the channel closes
        const onClose = () => this._rejectShardPending(shardKey);
        child.on('disconnect', onClose);
        child.on('exit', onClose);
    }

    /**
     * Explicitly deregister a shard (e.g. after a planned shutdown).
     * Rejects any remaining pending requests for that shard.
     */
    deregisterShard(shardKey: string): void {
        this._rejectShardPending(shardKey);
        this.shards.delete(shardKey);
    }

    async enqueue<T extends JobPayload>(options: JobOptions<T>): Promise<string> {
        const { shardKey } = options;
        if (!shardKey) throw new QueueError('enqueue() via IpcRouter requires a shardKey');

        const entry = this.shards.get(shardKey);
        if (!entry) throw new QueueError(`No shard registered for key: ${shardKey}`);

        // Wait for a concurrency slot before touching the IPC channel
        await this._acquireSlot(entry);

        return this._sendRequest(entry, shardKey, 'enqueue', options);
    }

    pause(): void {
        for (const entry of this.shards.values()) {
            if (entry.child.connected) {
                entry.child.send({ cmd: 'pause' });
            }
        }
    }

    resume(): void {
        for (const entry of this.shards.values()) {
            if (entry.child.connected) {
                entry.child.send({ cmd: 'resume' });
            }
        }
    }

    async shutdown(): Promise<void> {
        const promises = Array.from(this.shards.entries()).map(async ([shardKey, entry]) => {
            if (!entry.child.connected) return;
            await this._acquireSlot(entry);
            return this._sendRequest(entry, shardKey, 'shutdown', {}).catch(() => { /* best-effort */ });
        });
        await Promise.allSettled(promises);
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /** Acquire a concurrency slot. If the shard is at capacity, wait in queue. */
    private _acquireSlot(entry: ShardEntry): Promise<void> {
        if (entry.inflight < this.maxConcurrentPerShard) {
            entry.inflight++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve) => {
            entry.waitQueue.push(resolve);
        });
    }

    /** Release a slot and wake the next waiter, or decrement the counter. */
    private _releaseSlot(entry: ShardEntry): void {
        const next = entry.waitQueue.shift();
        if (next) {
            // Transfer the slot to the next waiter (inflight count stays the same)
            next();
        } else {
            entry.inflight--;
        }
    }

    /**
     * Send an IPC request to a shard and return a Promise for the response.
     * Assumes the concurrency slot has already been acquired by the caller.
     */
    private _sendRequest(entry: ShardEntry, shardKey: string, cmd: string, payload: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const { child } = entry;

            if (!child.connected) {
                this._releaseSlot(entry);
                return reject(new QueueError(`IPC Channel closed for shard '${shardKey}'`));
            }

            const reqId = `${Date.now()}_${++this.reqCounter}`;

            const timer = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this._releaseSlot(entry);
                    reject(new QueueError(`IPC Request timeout for cmd '${cmd}' on shard '${shardKey}'`));
                }
            }, this.requestTimeoutMs);

            this.pendingRequests.set(reqId, { shardKey, resolve, reject, timer });

            child.send({ cmd, reqId, payload }, (err) => {
                if (err) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(reqId);
                    this._releaseSlot(entry);
                    reject(err);
                }
            });
        });
    }

    /**
     * Reject all pending requests that belong to the given shard,
     * and drain its wait-queue so callers don't deadlock.
     */
    private _rejectShardPending(shardKey: string): void {
        const entry = this.shards.get(shardKey);
        const error = new QueueError(`IPC Channel closed for shard '${shardKey}'`);

        // Reject in-flight requests for this shard
        for (const [reqId, pending] of this.pendingRequests.entries()) {
            if (pending.shardKey === shardKey) {
                clearTimeout(pending.timer);
                pending.reject(error);
                this.pendingRequests.delete(reqId);
            }
        }

        // Drain wait-queue; they will re-check child.connected and reject themselves
        if (entry) {
            const waiters = entry.waitQueue.splice(0);
            entry.inflight = 0;
            for (const waiter of waiters) {
                waiter();
            }
        }
    }
}
