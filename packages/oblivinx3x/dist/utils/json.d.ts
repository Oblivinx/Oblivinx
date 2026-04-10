/**
 * @module utils/json
 *
 * Safe JSON serialization utilities with depth limits and circular reference detection.
 *
 * @packageDocumentation
 */
/**
 * Safely serialize a value to JSON with depth limit and circular reference detection.
 *
 * @param value - The value to serialize
 * @param maxDepth - Maximum nesting depth (default: 20)
 * @returns JSON string
 * @throws {SerializationError} If circular reference detected
 * @throws {InputDepthError} If depth exceeds maxDepth
 */
export declare function safeSerialize(value: unknown, maxDepth?: number): string;
/**
 * Safely deserialize JSON, catching any parse errors.
 *
 * @param text - The JSON string to parse
 * @returns The parsed value
 * @throws {SerializationError} If the JSON is invalid
 */
export declare function safeDeserialize<T = unknown>(text: string): T;
//# sourceMappingURL=json.d.ts.map