/**
 * Exponential backoff with full jitter.
 *
 * Formula: delay = random(0, min(cap, base * 2^attempt))
 *
 * Example with base=1000, cap=60000:
 *   attempt 1 → 0–2000ms
 *   attempt 2 → 0–4000ms
 *   attempt 3 → 0–8000ms
 *   ...capped at 60000ms
 */
export class ExponentialBackoff {
    maxAttempts;
    base;
    cap;
    constructor({ maxAttempts, base = 1_000, cap = 60_000 }) {
        this.maxAttempts = maxAttempts;
        this.base = base;
        this.cap = cap;
    }
    shouldRetry(attempt, _error) {
        return attempt < this.maxAttempts;
    }
    nextDelay(attempt, _error) {
        const ceiling = Math.min(this.cap, this.base * Math.pow(2, attempt));
        return Math.floor(Math.random() * ceiling);
    }
}
