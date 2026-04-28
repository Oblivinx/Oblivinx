import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
export interface DebounceOptions {
    /**
     * Debounce window in ms.
     * If the same key is enqueued again within this window,
     * the previous job is superseded by the new one (last-write-wins).
     */
    windowMs: number;
    /**
     * Function to extract the debounce key from a job.
     * Defaults to `job.type`.
     */
    keyFn?: (job: Job<JobPayload>) => string;
}
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
export declare class Debounce implements IPlugin {
    readonly name = "Debounce";
    private readonly windowMs;
    private readonly keyFn;
    /**
     * Maps debounce key → latest entry.
     * Old entries are lazily cleaned up when a new job arrives.
     */
    private readonly pending;
    /**
     * Set of job IDs that have been superseded.
     * These will be discarded when a worker picks them up.
     */
    private readonly superseded;
    constructor({ windowMs, keyFn }: DebounceOptions);
    onEnqueue<T extends JobPayload>(job: Job<T>): void;
    onProcess<T extends JobPayload>(job: Job<T>): void;
    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void;
    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void;
    onExpire<T extends JobPayload>(job: Job<T>): void;
    /** Number of keys currently tracked */
    get pendingCount(): number;
    /** Number of jobs waiting to be discarded */
    get supersededCount(): number;
    private _cleanup;
}
