import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import type { IClock } from '../utils/clock.js';
import { systemClock } from '../utils/clock.js';

export type TTLExpireCallback = (job: Job<JobPayload>) => void;

/**
 * JobTTL plugin — auto-expires stale pending jobs after a configured TTL.
 * On expiry: calls the registered callback (which emits 'expired' event on the queue).
 */
export class JobTTL implements IPlugin {
    readonly name = 'JobTTL';
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly clock: IClock;
    private expireCallback?: TTLExpireCallback;

    constructor(clock: IClock = systemClock) {
        this.clock = clock;
    }

    /** Register callback invoked when a job TTL expires */
    onExpireCallback(cb: TTLExpireCallback): void {
        this.expireCallback = cb;
    }

    onEnqueue<T extends JobPayload>(job: Job<T>): void {
        if (job.ttl === undefined || job.ttl <= 0) return;
        const delay = job.expiresAt !== undefined
            ? Math.max(0, job.expiresAt - this.clock.now())
            : job.ttl;

        const timerId = setTimeout(() => {
            this.timers.delete(job.id);
            if (this.expireCallback) {
                this.expireCallback(job as Job<JobPayload>);
            }
        }, delay);
        this.timers.set(job.id, timerId);
    }

    onComplete<T extends JobPayload>(job: Job<T>): void {
        this.cancel(job.id);
    }

    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void {
        this.cancel(job.id);
    }

    /** Cancel a TTL timer (job was processed before expiry) */
    cancel(jobId: string): void {
        const id = this.timers.get(jobId);
        if (id !== undefined) {
            clearTimeout(id);
            this.timers.delete(jobId);
        }
    }

    /** Number of active TTL timers */
    get size(): number {
        return this.timers.size;
    }

    /** Clear all timers on shutdown */
    clear(): void {
        for (const id of this.timers.values()) clearTimeout(id);
        this.timers.clear();
    }
}
