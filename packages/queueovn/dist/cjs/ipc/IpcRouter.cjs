"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IpcRouter = void 0;
const QueueError_js_1 = require("../errors/QueueError.cjs");
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
class IpcRouter {
    shards = new Map();
    pendingRequests = new Map();
    reqCounter = 0;
    maxConcurrentPerShard;
    requestTimeoutMs;
    constructor(options = {}) {
        this.maxConcurrentPerShard = options.maxConcurrentPerShard ?? 64;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    }
    /** Register a child process to handle jobs for a specific shardKey. */
    registerShard(shardKey, child) {
        const entry = { child, inflight: 0, waitQueue: [] };
        this.shards.set(shardKey, entry);
        // Route inbound response messages to pending resolvers
        child.on('message', (msg) => {
            if (msg.reqId && this.pendingRequests.has(msg.reqId)) {
                const pending = this.pendingRequests.get(msg.reqId);
                clearTimeout(pending.timer);
                this.pendingRequests.delete(msg.reqId);
                if (msg.error) {
                    pending.reject(new QueueError_js_1.QueueError(`IPC Error on shard '${shardKey}': ${msg.error}`));
                }
                else {
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
    deregisterShard(shardKey) {
        this._rejectShardPending(shardKey);
        this.shards.delete(shardKey);
    }
    async enqueue(options) {
        const { shardKey } = options;
        if (!shardKey)
            throw new QueueError_js_1.QueueError('enqueue() via IpcRouter requires a shardKey');
        const entry = this.shards.get(shardKey);
        if (!entry)
            throw new QueueError_js_1.QueueError(`No shard registered for key: ${shardKey}`);
        // Wait for a concurrency slot before touching the IPC channel
        await this._acquireSlot(entry);
        return this._sendRequest(entry, shardKey, 'enqueue', options);
    }
    pause() {
        for (const entry of this.shards.values()) {
            if (entry.child.connected) {
                entry.child.send({ cmd: 'pause' });
            }
        }
    }
    resume() {
        for (const entry of this.shards.values()) {
            if (entry.child.connected) {
                entry.child.send({ cmd: 'resume' });
            }
        }
    }
    async shutdown() {
        const promises = Array.from(this.shards.entries()).map(async ([shardKey, entry]) => {
            if (!entry.child.connected)
                return;
            await this._acquireSlot(entry);
            return this._sendRequest(entry, shardKey, 'shutdown', {}).catch(() => { });
        });
        await Promise.allSettled(promises);
    }
    // ── Private helpers ───────────────────────────────────────────────────────
    /** Acquire a concurrency slot. If the shard is at capacity, wait in queue. */
    _acquireSlot(entry) {
        if (entry.inflight < this.maxConcurrentPerShard) {
            entry.inflight++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            entry.waitQueue.push(resolve);
        });
    }
    /** Release a slot and wake the next waiter, or decrement the counter. */
    _releaseSlot(entry) {
        const next = entry.waitQueue.shift();
        if (next) {
            // Transfer the slot to the next waiter (inflight count stays the same)
            next();
        }
        else {
            entry.inflight--;
        }
    }
    /**
     * Send an IPC request to a shard and return a Promise for the response.
     * Assumes the concurrency slot has already been acquired by the caller.
     */
    _sendRequest(entry, shardKey, cmd, payload) {
        return new Promise((resolve, reject) => {
            const { child } = entry;
            if (!child.connected) {
                this._releaseSlot(entry);
                return reject(new QueueError_js_1.QueueError(`IPC Channel closed for shard '${shardKey}'`));
            }
            const reqId = `${Date.now()}_${++this.reqCounter}`;
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(reqId)) {
                    this.pendingRequests.delete(reqId);
                    this._releaseSlot(entry);
                    reject(new QueueError_js_1.QueueError(`IPC Request timeout for cmd '${cmd}' on shard '${shardKey}'`));
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
    _rejectShardPending(shardKey) {
        const entry = this.shards.get(shardKey);
        const error = new QueueError_js_1.QueueError(`IPC Channel closed for shard '${shardKey}'`);
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
exports.IpcRouter = IpcRouter;
