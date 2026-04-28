import type { IRetryPolicy } from './RetryPolicy.js';

/**
 * NoRetry — fail-fast policy.
 * Always returns false from shouldRetry(), so jobs fail immediately.
 */
export class NoRetry implements IRetryPolicy {
    private static _instance: NoRetry;

    private constructor() { /* singleton */ }

    /** Get the singleton NoRetry instance */
    static getInstance(): NoRetry {
        if (!NoRetry._instance) {
            NoRetry._instance = new NoRetry();
        }
        return NoRetry._instance;
    }

    shouldRetry(_attempt: number, _error: Error): boolean {
        return false;
    }

    nextDelay(_attempt: number, _error: Error): number {
        return 0;
    }
}
