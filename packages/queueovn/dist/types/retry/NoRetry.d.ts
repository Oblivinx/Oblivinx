import type { IRetryPolicy } from './RetryPolicy.js';
/**
 * NoRetry — fail-fast policy.
 * Always returns false from shouldRetry(), so jobs fail immediately.
 */
export declare class NoRetry implements IRetryPolicy {
    private static _instance;
    private constructor();
    /** Get the singleton NoRetry instance */
    static getInstance(): NoRetry;
    shouldRetry(_attempt: number, _error: Error): boolean;
    nextDelay(_attempt: number, _error: Error): number;
}
