import type { ChildProcess } from 'child_process';
import type { JobOptions, JobPayload } from '../types/job.types.js';
import type { ShardedQueue } from './types.js';
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
export declare class IpcRouter implements ShardedQueue {
    private shards;
    private pendingRequests;
    private reqCounter;
    private readonly maxConcurrentPerShard;
    private readonly requestTimeoutMs;
    constructor(options?: {
        maxConcurrentPerShard?: number;
        requestTimeoutMs?: number;
    });
    /** Register a child process to handle jobs for a specific shardKey. */
    registerShard(shardKey: string, child: ChildProcess): void;
    /**
     * Explicitly deregister a shard (e.g. after a planned shutdown).
     * Rejects any remaining pending requests for that shard.
     */
    deregisterShard(shardKey: string): void;
    enqueue<T extends JobPayload>(options: JobOptions<T>): Promise<string>;
    pause(): void;
    resume(): void;
    shutdown(): Promise<void>;
    /** Acquire a concurrency slot. If the shard is at capacity, wait in queue. */
    private _acquireSlot;
    /** Release a slot and wake the next waiter, or decrement the counter. */
    private _releaseSlot;
    /**
     * Send an IPC request to a shard and return a Promise for the response.
     * Assumes the concurrency slot has already been acquired by the caller.
     */
    private _sendRequest;
    /**
     * Reject all pending requests that belong to the given shard,
     * and drain its wait-queue so callers don't deadlock.
     */
    private _rejectShardPending;
}
