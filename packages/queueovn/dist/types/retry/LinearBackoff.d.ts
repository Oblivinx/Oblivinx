import type { IRetryPolicy } from './RetryPolicy.js';
export interface LinearBackoffOptions {
    /** Maximum number of attempts (including original) */
    maxAttempts: number;
    /** Fixed delay in ms between attempts (default: 1000) */
    interval?: number;
}
/**
 * Linear (fixed-interval) backoff retry policy.
 * Every retry waits the same fixed interval.
 */
export declare class LinearBackoff implements IRetryPolicy {
    private readonly maxAttempts;
    private readonly interval;
    constructor({ maxAttempts, interval }: LinearBackoffOptions);
    shouldRetry(attempt: number, _error: Error): boolean;
    nextDelay(_attempt: number, _error: Error): number;
}
