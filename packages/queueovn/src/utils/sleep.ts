/**
 * Returns a Promise that resolves after `ms` milliseconds.
 * Uses setTimeout under the hood — compatible with vi.useFakeTimers().
 */
export function sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
