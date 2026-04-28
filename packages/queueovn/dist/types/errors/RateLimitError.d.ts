import { QueueError } from './QueueError.js';
/**
 * Thrown by RateLimiter and Throttle plugins when limits are exceeded.
 */
export declare class RateLimitError extends QueueError {
    constructor(message?: string);
}
