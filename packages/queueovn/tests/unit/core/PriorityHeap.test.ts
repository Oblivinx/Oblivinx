import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityHeap } from '../../../src/core/PriorityHeap.js';
import type { Job, JobPayload } from '../../../src/types/job.types.js';

function makeJob(id: string, priority: number, runAt = 0): Job<JobPayload> {
    return Object.freeze({
        id,
        type: 'test',
        payload: {},
        priority,
        maxAttempts: 3,
        attempts: 0,
        maxDuration: 30_000,
        state: 'pending',
        createdAt: Date.now(),
        runAt,
    } as Job<JobPayload>);
}

describe('PriorityHeap', () => {
    let heap: PriorityHeap;
    beforeEach(() => { heap = new PriorityHeap(); });

    it('starts empty', () => {
        expect(heap.size).toBe(0);
        expect(heap.extractMin(Date.now())).toBeNull();
    });

    it('inserts and extracts single job', () => {
        const job = makeJob('1', 5);
        heap.insert(job);
        expect(heap.size).toBe(1);
        const out = heap.extractMin(Date.now());
        expect(out?.id).toBe('1');
        expect(heap.size).toBe(0);
    });

    it('extracts in priority order (lower = higher priority)', () => {
        heap.insert(makeJob('low', 10));
        heap.insert(makeJob('high', 1));
        heap.insert(makeJob('mid', 5));

        const first = heap.extractMin(Date.now());
        const second = heap.extractMin(Date.now());
        const third = heap.extractMin(Date.now());

        expect(first?.id).toBe('high');
        expect(second?.id).toBe('mid');
        expect(third?.id).toBe('low');
    });

    it('uses FIFO tiebreaker for same priority', async () => {
        const now = Date.now();
        const a = Object.freeze({ ...makeJob('a', 5), createdAt: now });
        const b = Object.freeze({ ...makeJob('b', 5), createdAt: now + 1 });
        heap.insert(a);
        heap.insert(b);
        expect(heap.extractMin(Date.now())?.id).toBe('a');
        expect(heap.extractMin(Date.now())?.id).toBe('b');
    });

    it('returns null if top job is not ready yet (runAt in future)', () => {
        heap.insert(makeJob('delayed', 1, Date.now() + 10_000));
        expect(heap.extractMin(Date.now())).toBeNull();
    });

    it('peekMin does not remove the job', () => {
        heap.insert(makeJob('x', 1));
        expect(heap.peekMin(Date.now())?.id).toBe('x');
        expect(heap.size).toBe(1);
    });

    it('remove by id works', () => {
        heap.insert(makeJob('a', 1));
        heap.insert(makeJob('b', 2));
        heap.remove('a');
        expect(heap.size).toBe(1);
        expect(heap.extractMin(Date.now())?.id).toBe('b');
    });

    it('remove non-existent id is a noop', () => {
        heap.insert(makeJob('a', 1));
        heap.remove('nonexistent');
        expect(heap.size).toBe(1);
    });

    it('update modifies job data in place', () => {
        const job = makeJob('a', 1);
        heap.insert(job);
        const updated = Object.freeze({ ...job, priority: 99 }) as Job<JobPayload>;
        heap.update(updated);
        const extracted = heap.extractMin(Date.now());
        expect(extracted?.priority).toBe(99);
    });

    it('toArray returns all jobs', () => {
        heap.insert(makeJob('a', 1));
        heap.insert(makeJob('b', 2));
        heap.insert(makeJob('c', 3));
        expect(heap.toArray()).toHaveLength(3);
    });

    it('clear empties the heap', () => {
        heap.insert(makeJob('a', 1));
        heap.clear();
        expect(heap.size).toBe(0);
        expect(heap.toArray()).toHaveLength(0);
    });

    it('handles many items correctly', () => {
        const count = 100;
        for (let i = count; i >= 1; i--) {
            heap.insert(makeJob(String(i), i));
        }
        let prevPriority = -Infinity;
        for (let i = 0; i < count; i++) {
            const job = heap.extractMin(Date.now());
            expect(job!.priority).toBeGreaterThanOrEqual(prevPriority);
            prevPriority = job!.priority;
        }
        expect(heap.size).toBe(0);
    });
});
