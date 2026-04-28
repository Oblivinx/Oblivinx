/**
 * Linear (fixed-interval) backoff retry policy.
 * Every retry waits the same fixed interval.
 */
export class LinearBackoff {
    maxAttempts;
    interval;
    constructor({ maxAttempts, interval = 1_000 }) {
        this.maxAttempts = maxAttempts;
        this.interval = interval;
    }
    shouldRetry(attempt, _error) {
        return attempt < this.maxAttempts;
    }
    nextDelay(_attempt, _error) {
        return this.interval;
    }
}
