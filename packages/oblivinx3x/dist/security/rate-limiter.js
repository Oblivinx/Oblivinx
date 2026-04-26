/**
 * @module security/rate-limiter
 *
 * Token bucket rate limiter per collection.
 *
 * @packageDocumentation
 */
import { RateLimitedError } from '../errors/index.js';
/** Default sustained rate: 10,000 ops/sec per connection. */
const DEFAULT_RATE = 10_000;
/** Burst factor: allow 1.5× normal rate for up to BURST_WINDOW_MS. */
const BURST_FACTOR = 1.5;
/** Burst window duration in milliseconds. */
const BURST_WINDOW_MS = 100;
/**
 * Token bucket with burst support.
 *
 * Capacity equals `rate * BURST_FACTOR` so the bucket allows a 1.5× spike
 * for up to BURST_WINDOW_MS before throttling.
 */
class TokenBucket {
    capacity;
    refillRate; // tokens per second
    #tokens;
    #lastRefill; // timestamp in ms
    constructor(rate) {
        this.refillRate = rate;
        // Burst capacity allows 1.5× rate for BURST_WINDOW_MS before steady-state
        this.capacity = rate + Math.ceil(rate * (BURST_FACTOR - 1) * (BURST_WINDOW_MS / 1000));
        this.#tokens = rate; // start at steady-state, not full burst
        this.#lastRefill = Date.now();
    }
    /** Refill tokens based on elapsed time */
    #refill() {
        const now = Date.now();
        const elapsed = (now - this.#lastRefill) / 1000; // seconds
        this.#tokens = Math.min(this.capacity, this.#tokens + elapsed * this.refillRate);
        this.#lastRefill = now;
    }
    /** Try to consume a token. Returns true if allowed. */
    tryConsume() {
        this.#refill();
        if (this.#tokens >= 1) {
            this.#tokens -= 1;
            return true;
        }
        return false;
    }
}
/**
 * Per-collection rate limiter using token bucket algorithm.
 */
export class RateLimiter {
    #buckets = new Map();
    #defaultReadRate = DEFAULT_RATE;
    #defaultWriteRate = DEFAULT_RATE;
    /**
     * Configure rate limits.
     */
    configure(options) {
        if (options.reads !== undefined)
            this.#defaultReadRate = options.reads;
        if (options.writes !== undefined)
            this.#defaultWriteRate = options.writes;
    }
    /**
     * Get or create rate limit buckets for a collection.
     */
    #getBuckets(collection) {
        if (!this.#buckets.has(collection)) {
            this.#buckets.set(collection, {
                reads: new TokenBucket(this.#defaultReadRate),
                writes: new TokenBucket(this.#defaultWriteRate),
            });
        }
        return this.#buckets.get(collection);
    }
    /**
     * Check if a read operation is allowed.
     */
    checkRead(collection) {
        const buckets = this.#getBuckets(collection);
        return buckets.reads.tryConsume();
    }
    /**
     * Check if a write operation is allowed.
     */
    checkWrite(collection) {
        const buckets = this.#getBuckets(collection);
        return buckets.writes.tryConsume();
    }
    /**
     * Assert that an operation is allowed, throwing if not.
     */
    assertAllowed(collection, operation) {
        const allowed = operation === 'read'
            ? this.checkRead(collection)
            : this.checkWrite(collection);
        if (!allowed) {
            throw new RateLimitedError(collection, operation);
        }
    }
    /**
     * Reset rate limits for a collection (for testing).
     */
    reset(collection) {
        this.#buckets.delete(collection);
    }
    /**
     * Reset all rate limits (for testing).
     */
    resetAll() {
        this.#buckets.clear();
    }
}
//# sourceMappingURL=rate-limiter.js.map