import type { IRetryPolicy } from './RetryPolicy.js';

export interface ExponentialBackoffOptions {
    /** Maximum number of attempts (including original) */
    maxAttempts: number;
    /** Base delay in ms (default: 1000) */
    base?: number;
    /** Cap delay in ms (default: 60_000) */
    cap?: number;
}

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
export class ExponentialBackoff implements IRetryPolicy {
    private readonly maxAttempts: number;
    private readonly base: number;
    private readonly cap: number;

    constructor({ maxAttempts, base = 1_000, cap = 60_000 }: ExponentialBackoffOptions) {
        this.maxAttempts = maxAttempts;
        this.base = base;
        this.cap = cap;
    }

    shouldRetry(attempt: number, _error: Error): boolean {
        return attempt < this.maxAttempts;
    }

    nextDelay(attempt: number, _error: Error): number {
        const ceiling = Math.min(this.cap, this.base * Math.pow(2, attempt));
        return Math.floor(Math.random() * ceiling);
    }
}
