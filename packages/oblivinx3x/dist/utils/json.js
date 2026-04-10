/**
 * @module utils/json
 *
 * Safe JSON serialization utilities with depth limits and circular reference detection.
 *
 * @packageDocumentation
 */
import { SerializationError, InputDepthError } from '../errors/index.js';
/**
 * Safely serialize a value to JSON with depth limit and circular reference detection.
 *
 * @param value - The value to serialize
 * @param maxDepth - Maximum nesting depth (default: 20)
 * @returns JSON string
 * @throws {SerializationError} If circular reference detected
 * @throws {InputDepthError} If depth exceeds maxDepth
 */
export function safeSerialize(value, maxDepth = 20) {
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, createReplacer(seen, maxDepth));
    }
    catch (err) {
        if (err instanceof SerializationError || err instanceof InputDepthError) {
            throw err;
        }
        throw new SerializationError(`Failed to serialize: ${err instanceof Error ? err.message : String(err)}`);
    }
}
/**
 * Create a JSON replacer function that tracks depth and circular references.
 */
function createReplacer(seen, _maxDepth) {
    return function replacer(_key, value) {
        if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
                throw new SerializationError(`Circular reference detected at key '${_key}'`);
            }
            seen.add(value);
        }
        return value;
    };
}
/**
 * Safely deserialize JSON, catching any parse errors.
 *
 * @param text - The JSON string to parse
 * @returns The parsed value
 * @throws {SerializationError} If the JSON is invalid
 */
export function safeDeserialize(text) {
    try {
        return JSON.parse(text);
    }
    catch (err) {
        throw new SerializationError(`Failed to deserialize JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
}
//# sourceMappingURL=json.js.map