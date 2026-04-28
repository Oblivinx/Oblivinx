import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
/**
 * Deduplicator plugin — prevents duplicate job IDs from entering the queue.
 * Removes the ID from the set after job completes (allows re-enqueue).
 */
export declare class Deduplicator implements IPlugin {
    readonly name = "Deduplicator";
    private readonly active;
    onEnqueue<T extends JobPayload>(job: Job<T>): void;
    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void;
    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void;
    onExpire<T extends JobPayload>(job: Job<T>): void;
    /** Return the current number of tracked active jobs */
    get size(): number;
}
