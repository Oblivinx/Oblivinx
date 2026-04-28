/**
 * RetryPolicy interface — every policy must implement both methods.
 * The queue engine calls these to decide whether and how long to wait before retry.
 */
export interface IRetryPolicy {
    /**
     * Determine if the job should be retried.
     * @param attempt - Current attempt number (1-based: 1 = first failure)
     * @param error - The error that caused the failure
     */
    shouldRetry(attempt: number, error: Error): boolean;
    /**
     * Compute the delay (in ms) before the next retry.
     * Called only when shouldRetry() returns true.
     */
    nextDelay(attempt: number, error: Error): number;
}
