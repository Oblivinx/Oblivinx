/**
 * @module security/rate-limiter
 *
 * Token bucket rate limiter per collection.
 *
 * @packageDocumentation
 */
/**
 * Per-collection rate limiter using token bucket algorithm.
 */
export declare class RateLimiter {
    #private;
    /**
     * Configure rate limits.
     */
    configure(options: {
        reads?: number;
        writes?: number;
    }): void;
    /**
     * Check if a read operation is allowed.
     */
    checkRead(collection: string): boolean;
    /**
     * Check if a write operation is allowed.
     */
    checkWrite(collection: string): boolean;
    /**
     * Assert that an operation is allowed, throwing if not.
     */
    assertAllowed(collection: string, operation: 'read' | 'write'): void;
    /**
     * Reset rate limits for a collection (for testing).
     */
    reset(collection: string): void;
    /**
     * Reset all rate limits (for testing).
     */
    resetAll(): void;
}
//# sourceMappingURL=rate-limiter.d.ts.map