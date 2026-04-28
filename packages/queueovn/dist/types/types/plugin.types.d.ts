import type { Job, JobPayload, JobResult } from './job.types.js';
/**
 * Plugin lifecycle interface.
 * All hooks are optional — implement only what you need.
 */
export interface IPlugin {
    /** Unique name identifying this plugin */
    readonly name: string;
    /**
     * Called when a job is being enqueued (BEFORE it enters the heap).
     * Throw to reject the job.
     */
    onEnqueue?<T extends JobPayload>(job: Job<T>): void | Promise<void>;
    /**
     * Called when a worker picks up a job (BEFORE handler executes).
     * Throw to cancel processing.
     */
    onProcess?<T extends JobPayload>(job: Job<T>): void | Promise<void>;
    /**
     * Called when a job completes successfully.
     */
    onComplete?<T extends JobPayload>(job: Job<T>, result: JobResult): void | Promise<void>;
    /**
     * Called when a job fails (after all retries or non-retryable).
     */
    onFail?<T extends JobPayload>(job: Job<T>, error: Error): void | Promise<void>;
    /**
     * Called when a job expires (TTL exceeded in pending state).
     */
    onExpire?<T extends JobPayload>(job: Job<T>): void | Promise<void>;
}
