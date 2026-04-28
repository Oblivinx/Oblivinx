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
export declare class CustomRetry implements IRetryPolicy {
    private readonly predicate;
    private readonly delayFn;
    constructor({ predicate, delay }: CustomRetryOptions);
    shouldRetry(attempt: number, error: Error): boolean;
    nextDelay(attempt: number, error: Error): number;
}
