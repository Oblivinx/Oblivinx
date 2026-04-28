import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
export interface RateLimiterOptions {
    /** Max tokens per window */
    limit: number;
    /** Window duration in ms */
    windowMs: number;
    /** Function to extract rate-limit key from job (default: job.type) */
    keyFn?: (job: Job<JobPayload>) => string;
}
/**
 * RateLimiter plugin — per-key token bucket (in-memory, sliding window).
 * Rejects jobs that exceed the configured rate during onEnqueue.
 */
export declare class RateLimiter implements IPlugin {
    readonly name = "RateLimiter";
    private readonly buckets;
    private readonly limit;
    private readonly windowMs;
    private readonly keyFn;
    constructor({ limit, windowMs, keyFn }: RateLimiterOptions);
    onEnqueue<T extends JobPayload>(job: Job<T>): void;
}
