import { QueueError } from './QueueError.js';
/**
 * Thrown when a storage adapter operation fails.
 */
export declare class AdapterError extends QueueError {
    constructor(message: string, cause?: unknown);
}
