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
export class JobBatch {
    private readonly pending = new Map<
        string,
        {
            promise: Promise<BatchResult<JobPayload>>;
            resolve: (r: BatchResult<JobPayload>) => void;
            reject: (e: Error) => void;
        }
    >();

    /**
     * Register a job ID to track in this batch.
     * Returns a Promise that resolves when this job completes.
     */
    track(jobId: string): Promise<BatchResult<JobPayload>> {
        let entry = this.pending.get(jobId);
        if (!entry) {
            let resolveFn!: (r: BatchResult<JobPayload>) => void;
            let rejectFn!: (e: Error) => void;
            const promise = new Promise<BatchResult<JobPayload>>((resolve, reject) => {
                resolveFn = resolve;
                rejectFn = reject;
            });
            entry = { promise, resolve: resolveFn, reject: rejectFn };
            this.pending.set(jobId, entry);
        }
        return entry.promise;
    }

    /**
     * Notify the batch that a job completed successfully.
     */
    complete<T extends JobPayload>(job: Job<T>, result: JobResult): void {
        const entry = this.pending.get(job.id);
        if (entry) {
            this.pending.delete(job.id);
            entry.resolve({ job, result });
        }
    }

    /**
     * Notify the batch that a job failed permanently.
     */
    fail<T extends JobPayload>(job: Job<T>, error: Error): void {
        const entry = this.pending.get(job.id);
        if (entry) {
            this.pending.delete(job.id);
            entry.reject(error);
        }
    }

    /**
     * Returns the number of jobs still being tracked.
     */
    get size(): number {
        return this.pending.size;
    }

    /**
     * Wait for ALL jobs in this batch to settle (resolve or reject).
     * Returns an array with all results.
     */
    async awaitAll(): Promise<PromiseSettledResult<BatchResult<JobPayload>>[]> {
        const promises: Promise<BatchResult<JobPayload>>[] = [];
        for (const [id] of this.pending) {
            promises.push(this.track(id));
        }
        return Promise.allSettled(promises);
    }

    /**
     * Wait for the FIRST job in this batch to complete successfully.
     */
    async awaitAny(): Promise<BatchResult<JobPayload>> {
        const promises: Promise<BatchResult<JobPayload>>[] = [];
        for (const [id] of this.pending) {
            promises.push(this.track(id));
        }
        return Promise.any(promises);
    }
}
