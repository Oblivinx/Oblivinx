"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LinearBackoff = void 0;
/**
 * Linear (fixed-interval) backoff retry policy.
 * Every retry waits the same fixed interval.
 */
class LinearBackoff {
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
exports.LinearBackoff = LinearBackoff;
