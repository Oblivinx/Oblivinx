/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Uses setTimeout under the hood — compatible with vi.useFakeTimers().
 */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
