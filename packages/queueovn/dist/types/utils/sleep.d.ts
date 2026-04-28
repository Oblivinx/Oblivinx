/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Uses setTimeout under the hood — compatible with vi.useFakeTimers().
 */
export declare function sleep(ms: number): Promise<void>;
