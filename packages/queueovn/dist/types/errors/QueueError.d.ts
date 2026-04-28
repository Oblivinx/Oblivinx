/**
 * Base error class for all wa-job-queue errors.
 * All custom errors extend this class.
 */
export declare class QueueError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
