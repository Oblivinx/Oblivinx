import type { JobResult } from '../types/job.types.js';

/**
 * Success/failure result wrapper.
 * Use `JobResult.success(value)` or `JobResult.failure(error)`.
 */
export class JobResultFactory {
    /**
     * Create a successful result.
     */
    static success<R>(value: R): JobResult<R> {
        return { ok: true, value };
    }

    /**
     * Create a failure result.
     */
    static failure(error: Error): JobResult<never> {
        return { ok: false, error };
    }
}
