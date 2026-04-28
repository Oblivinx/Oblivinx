import { DiscardJobError } from '../errors/DiscardJobError.js';
/**
 * Debounce plugin — last-write-wins per debounce key.
 *
 * When multiple jobs with the same debounce key are enqueued within `windowMs`,
 * only the **last** one will actually be processed; all earlier jobs are
 * silently discarded (via DiscardJobError) when a worker picks them up.
 *
 * This is useful for "flush-on-idle" patterns: e.g. only send the final
 * "user is typing" message after the user stops typing for 500ms.
 *
 * @example
 * const queue = new JobQueue({
 *   name: 'main',
 *   plugins: [new Debounce({ windowMs: 500 })],
 * });
 * await queue.enqueue({ type: 'syncUser', payload: { userId: '42' } });
 * await queue.enqueue({ type: 'syncUser', payload: { userId: '42' } }); // supersedes the first
 * // Only the second job will run
 */
export class Debounce {
    name = 'Debounce';
    windowMs;
    keyFn;
    /**
     * Maps debounce key → latest entry.
     * Old entries are lazily cleaned up when a new job arrives.
     */
    pending = new Map();
    /**
     * Set of job IDs that have been superseded.
     * These will be discarded when a worker picks them up.
     */
    superseded = new Set();
    constructor({ windowMs, keyFn }) {
        this.windowMs = windowMs;
        this.keyFn = keyFn ?? ((job) => job.type);
    }
    onEnqueue(job) {
        const key = this.keyFn(job);
        const now = Date.now();
        const existing = this.pending.get(key);
        if (existing) {
            // Supersede the previous job if still within the window
            if (now - existing.createdAt < this.windowMs) {
                this.superseded.add(existing.latestId);
            }
        }
        this.pending.set(key, { latestId: job.id, createdAt: now });
    }
    onProcess(job) {
        if (this.superseded.has(job.id)) {
            this.superseded.delete(job.id);
            throw new DiscardJobError(`Job "${job.id}" (type: "${job.type}") was superseded by a newer debounced job`);
        }
    }
    onComplete(job, _result) {
        this._cleanup(job);
    }
    onFail(job, _error) {
        this._cleanup(job);
    }
    onExpire(job) {
        this._cleanup(job);
    }
    // ─── Inspection ─────────────────────────────────────────────────────────────
    /** Number of keys currently tracked */
    get pendingCount() {
        return this.pending.size;
    }
    /** Number of jobs waiting to be discarded */
    get supersededCount() {
        return this.superseded.size;
    }
    // ─── Internal ───────────────────────────────────────────────────────────────
    _cleanup(job) {
        const key = this.keyFn(job);
        const entry = this.pending.get(key);
        if (entry?.latestId === job.id) {
            this.pending.delete(key);
        }
        this.superseded.delete(job.id);
    }
}
