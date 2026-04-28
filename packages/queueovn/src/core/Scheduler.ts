import type { Job, JobPayload } from '../types/job.types.js';
import type { IClock } from '../utils/clock.js';
import { sleep } from '../utils/sleep.js';
import { systemClock } from '../utils/clock.js';

export type SchedulerCallback<T extends JobPayload = JobPayload> = (job: Job<T>) => void;

interface ScheduledEntry {
    job: Job<JobPayload>;
    runAt: number;
    timerId: ReturnType<typeof setTimeout>;
}

/**
 * Scheduler — manages delayed and future job dispatch.
 * Uses clock-based timers so they can be controlled in tests with vi.useFakeTimers().
 */
export class Scheduler {
    private readonly entries = new Map<string, ScheduledEntry>();
    private readonly callbacks: SchedulerCallback[] = [];
    private readonly clock: IClock;

    constructor(clock: IClock = systemClock) {
        this.clock = clock;
    }

    /**
     * Register a callback called when a scheduled job is due.
     */
    onReady(cb: SchedulerCallback): void {
        this.callbacks.push(cb);
    }

    /**
     * Schedule a job to fire at a specific timestamp (ms since epoch).
     */
    schedule<T extends JobPayload>(job: Job<T>, runAt: number): void {
        const delay = Math.max(0, runAt - this.clock.now());
        const timerId = setTimeout(() => {
            this.entries.delete(job.id);
            for (const cb of this.callbacks) cb(job as Job<JobPayload>);
        }, delay);
        this.entries.set(job.id, { job: job as Job<JobPayload>, runAt, timerId });
    }

    /**
     * Cancel a scheduled job.
     */
    cancel(jobId: string): void {
        const entry = this.entries.get(jobId);
        if (entry) {
            clearTimeout(entry.timerId);
            this.entries.delete(jobId);
        }
    }

    /**
     * Number of currently scheduled (pending-delayed) jobs.
     */
    get size(): number {
        return this.entries.size;
    }

    /**
     * Returns all scheduled jobs (for persistence/recovery).
     */
    scheduledJobs(): Job<JobPayload>[] {
        return Array.from(this.entries.values()).map((e) => e.job);
    }

    /**
     * Cancel all scheduled jobs.
     */
    clear(): void {
        for (const entry of this.entries.values()) {
            clearTimeout(entry.timerId);
        }
        this.entries.clear();
    }
}

// Keep sleep in scope so tree-shaking doesn't pull it out across boundaries
void sleep;
