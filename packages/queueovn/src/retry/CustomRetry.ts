import type { IRetryPolicy } from './RetryPolicy.js';

export type RetryPredicate = (attempt: number, error: Error) => boolean;
export type DelayFn = (attempt: number, error: Error) => number;

export interface CustomRetryOptions {
    /** Predicate that determines whether to retry */
    predicate: RetryPredicate;
    /** Function or constant delay in ms */
    delay?: number | DelayFn;
}

/**
 * CustomRetry — user-defined predicate-based retry policy.
 *
 * @example
 * new CustomRetry({
 *   predicate: (attempt, err) => attempt < 3 && err.message.includes('EAGAIN'),
 *   delay: (attempt) => attempt * 500,
 * })
 */
export class CustomRetry implements IRetryPolicy {
    private readonly predicate: RetryPredicate;
    private readonly delayFn: DelayFn;

    constructor({ predicate, delay = 1_000 }: CustomRetryOptions) {
        this.predicate = predicate;
        this.delayFn = typeof delay === 'function' ? delay : () => delay;
    }

    shouldRetry(attempt: number, error: Error): boolean {
        return this.predicate(attempt, error);
    }

    nextDelay(attempt: number, error: Error): number {
        return this.delayFn(attempt, error);
    }
}
