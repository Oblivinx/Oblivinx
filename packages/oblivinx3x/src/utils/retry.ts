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
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts;
  const baseBackoff = opts.backoffMs ?? 50;
  const maxBackoff = opts.maxBackoffMs ?? 5000;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (!isRetryable(err)) {
        throw err;
      }

      if (attempt >= maxAttempts) {
        throw err;
      }

      // Exponential backoff with jitter
      const backoff = Math.min(
        baseBackoff * 2 ** (attempt - 1) + Math.random() * baseBackoff,
        maxBackoff,
      );

      await sleep(backoff);
    }
  }

  // Should not reach here, but TypeScript needs a return
  throw lastError;
}

/**
 * Default retryable error detection.
 * Considers conflict and timeout errors as retryable.
 */
function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name.toLowerCase();
    const message = err.message.toLowerCase();
    return (
      name.includes('conflict') ||
      name.includes('timeout') ||
      message.includes('conflict') ||
      message.includes('write conflict') ||
      message.includes('busy')
    );
  }
  return false;
}

/** Sleep for the given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
