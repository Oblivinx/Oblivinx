/**
 * @module errors/wrap
 * 
 * Error wrapping utility for native calls.
 * 
 * Catches native errors and maps them to typed TypeScript errors.
 * 
 * @packageDocumentation
 */

import { mapNativeError } from './index.js';

/**
 * Wrap a native call with error handling.
 * 
 * @param fn - Function that calls native code
 * @returns Result of the function
 * @throws Mapped TypeScript error on failure
 */
export function wrapNative<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapNativeError(message);
  }
}

/**
 * Wrap an async native call with error handling.
 * 
 * @param fn - Async function that calls native code
 * @returns Promise resolving to the result
 * @throws Mapped TypeScript error on failure
 */
export async function wrapNativeAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw mapNativeError(message);
  }
}
