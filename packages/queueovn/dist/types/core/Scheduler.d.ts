import type { Job, JobPayload } from '../types/job.types.js';
import type { IClock } from '../utils/clock.js';
export type SchedulerCallback<T extends JobPayload = JobPayload> = (job: Job<T>) => void;
/**
 * Scheduler — manages delayed and future job dispatch.
 * Uses clock-based timers so they can be controlled in tests with vi.useFakeTimers().
 */
export declare class Scheduler {
    private readonly entries;
    private readonly callbacks;
    private readonly clock;
    constructor(clock?: IClock);
    /**
     * Register a callback called when a scheduled job is due.
     */
    onReady(cb: SchedulerCallback): void;
    /**
     * Schedule a job to fire at a specific timestamp (ms since epoch).
     */
    schedule<T extends JobPayload>(job: Job<T>, runAt: number): void;
    /**
     * Cancel a scheduled job.
     */
    cancel(jobId: string): void;
    /**
     * Number of currently scheduled (pending-delayed) jobs.
     */
    get size(): number;
    /**
     * Returns all scheduled jobs (for persistence/recovery).
     */
    scheduledJobs(): Job<JobPayload>[];
    /**
     * Cancel all scheduled jobs.
     */
    clear(): void;
}
