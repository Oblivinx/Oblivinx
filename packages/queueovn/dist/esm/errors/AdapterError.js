import { QueueError } from './QueueError.js';
/**
 * Thrown when a storage adapter operation fails.
 */
export class AdapterError extends QueueError {
    constructor(message, cause) {
        super(message, cause);
        this.name = 'AdapterError';
    }
}
