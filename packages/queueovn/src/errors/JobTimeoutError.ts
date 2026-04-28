import { QueueError } from './QueueError.js';

/**
 * Thrown when a job exceeds its configured maxDuration.
 */
export class JobTimeoutError extends QueueError {
    constructor(
        public readonly jobId: string,
        public readonly maxDuration: number,
    ) {
        super(`Job "${jobId}" timed out after ${maxDuration}ms`);
        this.name = 'JobTimeoutError';
    }
}
