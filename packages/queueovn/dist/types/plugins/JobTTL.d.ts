import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import type { IClock } from '../utils/clock.js';
export type TTLExpireCallback = (job: Job<JobPayload>) => void;
/**
 * JobTTL plugin — auto-expires stale pending jobs after a configured TTL.
 * On expiry: calls the registered callback (which emits 'expired' event on the queue).
 */
export declare class JobTTL implements IPlugin {
    readonly name = "JobTTL";
    private readonly timers;
    private readonly clock;
    private expireCallback?;
    constructor(clock?: IClock);
    /** Register callback invoked when a job TTL expires */
    onExpireCallback(cb: TTLExpireCallback): void;
    onEnqueue<T extends JobPayload>(job: Job<T>): void;
    onComplete<T extends JobPayload>(job: Job<T>): void;
    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void;
    /** Cancel a TTL timer (job was processed before expiry) */
    cancel(jobId: string): void;
    /** Number of active TTL timers */
    get size(): number;
    /** Clear all timers on shutdown */
    clear(): void;
}
