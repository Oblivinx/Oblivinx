import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import { RateLimitError } from '../errors/RateLimitError.js';

export interface RateLimiterOptions {
    /** Max tokens per window */
    limit: number;
    /** Window duration in ms */
    windowMs: number;
    /** Function to extract rate-limit key from job (default: job.type) */
    keyFn?: (job: Job<JobPayload>) => string;
}

interface Bucket {
    tokens: number;
    resetAt: number;
}

/**
 * RateLimiter plugin — per-key token bucket (in-memory, sliding window).
 * Rejects jobs that exceed the configured rate during onEnqueue.
 */
export class RateLimiter implements IPlugin {
    readonly name = 'RateLimiter';
    private readonly buckets = new Map<string, Bucket>();
    private readonly limit: number;
    private readonly windowMs: number;
    private readonly keyFn: (job: Job<JobPayload>) => string;

    constructor({ limit, windowMs, keyFn }: RateLimiterOptions) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.keyFn = keyFn ?? ((job) => job.type);
    }

    onEnqueue<T extends JobPayload>(job: Job<T>): void {
        const key = this.keyFn(job as Job<JobPayload>);
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
