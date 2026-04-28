import { QueueError } from './QueueError.js';
/**
 * Thrown by RateLimiter and Throttle plugins when limits are exceeded.
 */
export class RateLimitError extends QueueError {
    constructor(message = 'Rate limit exceeded') {
        super(message);
        this.name = 'RateLimitError';
    }
}
