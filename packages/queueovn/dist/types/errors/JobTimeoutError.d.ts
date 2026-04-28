import { QueueError } from './QueueError.js';
/**
 * Thrown when a job exceeds its configured maxDuration.
 */
export declare class JobTimeoutError extends QueueError {
    readonly jobId: string;
    readonly maxDuration: number;
    constructor(jobId: string, maxDuration: number);
}
