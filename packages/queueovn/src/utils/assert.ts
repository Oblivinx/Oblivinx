import { QueueError } from '../errors/QueueError.js';

/**
 * Type-safe internal assertion.
 * Throws QueueError if condition is falsy.
 */
export function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new QueueError(`Assertion failed: ${message}`);
    }
}
