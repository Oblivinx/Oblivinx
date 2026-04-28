import { systemClock } from '../utils/clock.js';
/**
 * JobTTL plugin — auto-expires stale pending jobs after a configured TTL.
 * On expiry: calls the registered callback (which emits 'expired' event on the queue).
 */
export class JobTTL {
    name = 'JobTTL';
    timers = new Map();
    clock;
    expireCallback;
    constructor(clock = systemClock) {
        this.clock = clock;
    }
    /** Register callback invoked when a job TTL expires */
    onExpireCallback(cb) {
        this.expireCallback = cb;
    }
    onEnqueue(job) {
        if (job.ttl === undefined || job.ttl <= 0)
            return;
        const delay = job.expiresAt !== undefined
            ? Math.max(0, job.expiresAt - this.clock.now())
            : job.ttl;
        const timerId = setTimeout(() => {
            this.timers.delete(job.id);
            if (this.expireCallback) {
                this.expireCallback(job);
            }
        }, delay);
        this.timers.set(job.id, timerId);
    }
    onComplete(job) {
        this.cancel(job.id);
    }
    onFail(job, _error) {
        this.cancel(job.id);
    }
    /** Cancel a TTL timer (job was processed before expiry) */
    cancel(jobId) {
        const id = this.timers.get(jobId);
        if (id !== undefined) {
            clearTimeout(id);
            this.timers.delete(jobId);
        }
    }
    /** Number of active TTL timers */
    get size() {
        return this.timers.size;
    }
    /** Clear all timers on shutdown */
    clear() {
        for (const id of this.timers.values())
            clearTimeout(id);
        this.timers.clear();
    }
}
