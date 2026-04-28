import type { Job, JobPayload } from '../types/job.types.js';
import type { JobResult } from '../types/job.types.js';
export interface BatchResult<T extends JobPayload> {
    job: Job<T>;
    result: JobResult;
}
/**
 * JobBatch — group jobs and await completion using all/any semantics.
 *
 * @example
 * const batch = new JobBatch();
 * for (const id of jobIds) batch.add(id);
 * const results = await batch.awaitAll(); // Wait for every job in the batch
 */
export declare class JobBatch {
    private readonly pending;
    /**
     * Register a job ID to track in this batch.
     * Returns a Promise that resolves when this job completes.
     */
    track(jobId: string): Promise<BatchResult<JobPayload>>;
    /**
     * Notify the batch that a job completed successfully.
     */
    complete<T extends JobPayload>(job: Job<T>, result: JobResult): void;
    /**
     * Notify the batch that a job failed permanently.
     */
    fail<T extends JobPayload>(job: Job<T>, error: Error): void;
    /**
     * Returns the number of jobs still being tracked.
     */
    get size(): number;
    /**
     * Wait for ALL jobs in this batch to settle (resolve or reject).
     * Returns an array with all results.
     */
    awaitAll(): Promise<PromiseSettledResult<BatchResult<JobPayload>>[]>;
    /**
     * Wait for the FIRST job in this batch to complete successfully.
     */
    awaitAny(): Promise<BatchResult<JobPayload>>;
}
