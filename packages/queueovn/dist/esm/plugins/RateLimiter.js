import { RateLimitError } from '../errors/RateLimitError.js';
/**
 * RateLimiter plugin — per-key token bucket (in-memory, sliding window).
 * Rejects jobs that exceed the configured rate during onEnqueue.
 */
export class RateLimiter {
    name = 'RateLimiter';
    buckets = new Map();
    limit;
    windowMs;
    keyFn;
    constructor({ limit, windowMs, keyFn }) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.keyFn = keyFn ?? ((job) => job.type);
    }
    onEnqueue(job) {
        const key = this.keyFn(job);
        const now = Date.now();
        let bucket = this.buckets.get(key);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { tokens: this.limit, resetAt: now + this.windowMs };
            this.buckets.set(key, bucket);
        }
        if (bucket.tokens <= 0) {
            throw new RateLimitError(`Rate limit exceeded for key "${key}"`);
        }
        bucket.tokens -= 1;
    }
}
