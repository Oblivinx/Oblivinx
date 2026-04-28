import type { JobResult } from '../types/job.types.js';
/**
 * Success/failure result wrapper.
 * Use `JobResult.success(value)` or `JobResult.failure(error)`.
 */
export declare class JobResultFactory {
    /**
     * Create a successful result.
     */
    static success<R>(value: R): JobResult<R>;
    /**
     * Create a failure result.
     */
    static failure(error: Error): JobResult<never>;
}
