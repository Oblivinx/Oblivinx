"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobBatch = void 0;
/**
 * JobBatch — group jobs and await completion using all/any semantics.
 *
 * @example
 * const batch = new JobBatch();
 * for (const id of jobIds) batch.add(id);
 * const results = await batch.awaitAll(); // Wait for every job in the batch
 */
class JobBatch {
    pending = new Map();
    /**
     * Register a job ID to track in this batch.
     * Returns a Promise that resolves when this job completes.
     */
    track(jobId) {
        let entry = this.pending.get(jobId);
        if (!entry) {
            let resolveFn;
            let rejectFn;
            const promise = new Promise((resolve, reject) => {
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
    complete(job, result) {
        const entry = this.pending.get(job.id);
        if (entry) {
            this.pending.delete(job.id);
            entry.resolve({ job, result });
        }
    }
    /**
     * Notify the batch that a job failed permanently.
     */
    fail(job, error) {
        const entry = this.pending.get(job.id);
        if (entry) {
            this.pending.delete(job.id);
            entry.reject(error);
        }
    }
    /**
     * Returns the number of jobs still being tracked.
     */
    get size() {
        return this.pending.size;
    }
    /**
     * Wait for ALL jobs in this batch to settle (resolve or reject).
     * Returns an array with all results.
     */
    async awaitAll() {
        const promises = [];
        for (const [id] of this.pending) {
            promises.push(this.track(id));
        }
        return Promise.allSettled(promises);
    }
    /**
     * Wait for the FIRST job in this batch to complete successfully.
     */
    async awaitAny() {
        const promises = [];
        for (const [id] of this.pending) {
            promises.push(this.track(id));
        }
        return Promise.any(promises);
    }
}
exports.JobBatch = JobBatch;
