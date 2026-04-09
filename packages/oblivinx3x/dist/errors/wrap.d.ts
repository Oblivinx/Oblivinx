/**
 * @module errors/wrap
 *
 * Error wrapping utility for native calls.
 *
 * Catches native errors and maps them to typed TypeScript errors.
 *
 * @packageDocumentation
 */
/**
 * Wrap a native call with error handling.
 *
 * @param fn - Function that calls native code
 * @returns Result of the function
 * @throws Mapped TypeScript error on failure
 */
export declare function wrapNative<T>(fn: () => T): T;
/**
 * Wrap an async native call with error handling.
 *
 * @param fn - Async function that calls native code
 * @returns Promise resolving to the result
 * @throws Mapped TypeScript error on failure
 */
export declare function wrapNativeAsync<T>(fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=wrap.d.ts.map