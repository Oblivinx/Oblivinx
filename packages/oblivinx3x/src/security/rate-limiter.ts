/**
 * @module security/rate-limiter
 *
 * Token bucket rate limiter per collection.
 *
 * @packageDocumentation
 */

import { RateLimitedError } from '../errors/index.js';

/** Token bucket for rate limiting */
class TokenBucket {
  readonly capacity: number;
  readonly refillRate: number; // tokens per second
  #tokens: number;
  #lastRefill: number; // timestamp in ms

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.#tokens = capacity;
    this.#lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time */
  #refill(): void {
    const now = Date.now();
    const elapsed = (now - this.#lastRefill) / 1000; // seconds
    this.#tokens = Math.min(
      this.capacity,
      this.#tokens + elapsed * this.refillRate,
    );
    this.#lastRefill = now;
  }

  /** Try to consume a token. Returns true if allowed. */
  tryConsume(): boolean {
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
  readonly #buckets = new Map<string, { reads: TokenBucket; writes: TokenBucket }>();
  #defaultReadRate = Infinity;
  #defaultWriteRate = Infinity;

  /**
   * Configure rate limits.
   */
  configure(options: { reads?: number; writes?: number }): void {
    if (options.reads !== undefined) this.#defaultReadRate = options.reads;
    if (options.writes !== undefined) this.#defaultWriteRate = options.writes;
  }

  /**
   * Get or create rate limit buckets for a collection.
   */
  #getBuckets(collection: string): { reads: TokenBucket; writes: TokenBucket } {
    if (!this.#buckets.has(collection)) {
      this.#buckets.set(collection, {
        reads: new TokenBucket(this.#defaultReadRate, this.#defaultReadRate),
        writes: new TokenBucket(this.#defaultWriteRate, this.#defaultWriteRate),
      });
    }
    return this.#buckets.get(collection)!;
  }

  /**
   * Check if a read operation is allowed.
   */
  checkRead(collection: string): boolean {
    const buckets = this.#getBuckets(collection);
    return buckets.reads.tryConsume();
  }

  /**
   * Check if a write operation is allowed.
   */
  checkWrite(collection: string): boolean {
    const buckets = this.#getBuckets(collection);
    return buckets.writes.tryConsume();
  }

  /**
   * Assert that an operation is allowed, throwing if not.
   */
  assertAllowed(collection: string, operation: 'read' | 'write'): void {
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
  reset(collection: string): void {
    this.#buckets.delete(collection);
  }

  /**
   * Reset all rate limits (for testing).
   */
  resetAll(): void {
    this.#buckets.clear();
  }
}
