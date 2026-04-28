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
export class LinearBackoff implements IRetryPolicy {
    private readonly maxAttempts: number;
    private readonly interval: number;

    constructor({ maxAttempts, interval = 1_000 }: LinearBackoffOptions) {
        this.maxAttempts = maxAttempts;
        this.interval = interval;
    }

    shouldRetry(attempt: number, _error: Error): boolean {
        return attempt < this.maxAttempts;
    }

    nextDelay(_attempt: number, _error: Error): number {
        return this.interval;
    }
}
