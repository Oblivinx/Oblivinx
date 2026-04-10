/**
 * @module utils/retry
 *
 * Generic retry utility with configurable backoff and retryable error detection.
 *
 * @packageDocumentation
 */
/** Options for the withRetry function */
export interface RetryOptions {
    /** Maximum number of attempts (including the first) */
    maxAttempts: number;
    /** Optional predicate to determine if an error is retryable */
    isRetryable?: (err: unknown) => boolean;
    /** Base backoff in milliseconds (default: 50ms) */
    backoffMs?: number;
    /** Maximum backoff cap in milliseconds (default: 5000ms) */
    maxBackoffMs?: number;
}
/**
 * Execute an async function with retry logic and exponential backoff.
 *
 * @param fn - The async function to execute
 * @param opts - Retry options
 * @returns The result of the function
 * @throws The last error if all attempts fail
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => collection.insertOne(doc),
 *   { maxAttempts: 3, backoffMs: 50 }
 * );
 * ```
 */
export declare function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>;
//# sourceMappingURL=retry.d.ts.map