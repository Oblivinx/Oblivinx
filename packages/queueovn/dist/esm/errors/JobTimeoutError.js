import { QueueError } from './QueueError.js';
/**
 * Thrown when a job exceeds its configured maxDuration.
 */
export class JobTimeoutError extends QueueError {
    jobId;
    maxDuration;
    constructor(jobId, maxDuration) {
        super(`Job "${jobId}" timed out after ${maxDuration}ms`);
        this.jobId = jobId;
        this.maxDuration = maxDuration;
        this.name = 'JobTimeoutError';
    }
}
