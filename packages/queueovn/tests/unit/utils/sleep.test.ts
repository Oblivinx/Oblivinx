import { describe, it, expect, vi, afterEach } from 'vitest';
import { sleep } from '../../../src/utils/sleep.js';

describe('sleep', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves after the specified number of milliseconds', async () => {
        vi.useFakeTimers();
        let resolved = false;
        const p = sleep(100).then(() => { resolved = true; });
        expect(resolved).toBe(false);
        vi.advanceTimersByTime(100);
        await p;
        expect(resolved).toBe(true);
    });

    it('resolves immediately when ms is 0', async () => {
        vi.useFakeTimers();
        let resolved = false;
        const p = sleep(0).then(() => { resolved = true; });
        vi.advanceTimersByTime(0);
        await p;
        expect(resolved).toBe(true);
    });
});
