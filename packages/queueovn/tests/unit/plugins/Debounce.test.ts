import { describe, it, expect, vi } from 'vitest';
import { Debounce } from '../../../src/plugins/Debounce.js';
import { createJob } from '../../../src/job/Job.js';
import { DiscardJobError } from '../../../src/errors/DiscardJobError.js';

describe('Debounce Plugin', () => {
    function makeJob(id: string, type: string) {
        return createJob({ type, payload: { id } }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });
    }

    it('supersedes previous job within window', () => {
        vi.useFakeTimers();
        const plugin = new Debounce({ windowMs: 500 });

        const jobA1 = makeJob('1', 'sync');
        const jobA2 = makeJob('2', 'sync');

        plugin.onEnqueue(jobA1);
        vi.advanceTimersByTime(200);
        // still within window, A2 supersedes A1
        plugin.onEnqueue(jobA2);

        expect(plugin.pendingCount).toBe(1);
        expect(plugin.supersededCount).toBe(1);

        // A1 gets processed -> should throw DiscardJobError
        expect(() => plugin.onProcess(jobA1)).toThrow(DiscardJobError);

        // A2 gets processed -> should succeed
        expect(() => plugin.onProcess(jobA2)).not.toThrow();

        // Cleanup A2
        plugin.onComplete(jobA2, { ok: true, value: null });
        expect(plugin.pendingCount).toBe(0);

        vi.useRealTimers();
    });

    it('does not supersede if window has passed', () => {
        vi.useFakeTimers();
        const plugin = new Debounce({ windowMs: 500 });

        const job1 = makeJob('1', 'sync');
        plugin.onEnqueue(job1);

        // Advance past window
        vi.advanceTimersByTime(600);

        const job2 = makeJob('2', 'sync');
        plugin.onEnqueue(job2);

        // Both are valid since they were enqueued outside of each other's window.
        // Wait, DebounceEntry tracks createdAt. If window passed, the old job is NOT added to superseded.
        expect(plugin.supersededCount).toBe(0);

        expect(() => plugin.onProcess(job1)).not.toThrow();
        expect(() => plugin.onProcess(job2)).not.toThrow();

        vi.useRealTimers();
    });

    it('uses custom keyFn if provided', () => {
        vi.useFakeTimers();
        const plugin = new Debounce({
            windowMs: 500,
            keyFn: (j) => (j.payload as { id: string }).id
        });

        // Different types, same key (id)
        const job1 = makeJob('same-id', 'sync_A');
        const job2 = makeJob('same-id', 'sync_B');

        plugin.onEnqueue(job1);
        plugin.onEnqueue(job2);

        expect(plugin.supersededCount).toBe(1);
        expect(() => plugin.onProcess(job1)).toThrow(DiscardJobError);
        expect(() => plugin.onProcess(job2)).not.toThrow();

        vi.useRealTimers();
    });

    it('cleans up on fail and expire', () => {
        const plugin = new Debounce({ windowMs: 500 });
        const job = makeJob('1', 'sync');

        plugin.onEnqueue(job);
        expect(plugin.pendingCount).toBe(1);

        plugin.onFail(job, new Error('fail'));
        expect(plugin.pendingCount).toBe(0);

        plugin.onEnqueue(job);
        expect(plugin.pendingCount).toBe(1);

        plugin.onExpire(job);
        expect(plugin.pendingCount).toBe(0);
    });
});
