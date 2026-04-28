import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { createJob } from '../../src/job/Job.js';
import { JobState } from '../../src/job/JobState.js';
import { updateJob } from '../../src/job/Job.js';

const defaults = { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30_000 };

function makeJob(priority = 5, runAt = 0) {
    return createJob({ type: 'test', payload: {}, priority }, { ...defaults, defaultPriority: priority });
}

describe('MemoryAdapter Integration', () => {
    let adapter: MemoryAdapter;
    beforeEach(() => { adapter = new MemoryAdapter(); });

    it('push and pop returns correct job', async () => {
        const job = makeJob();
        await adapter.push(job);
        const popped = await adapter.pop();
        expect(popped?.id).toBe(job.id);
    });

    it('peek does not remove the job', async () => {
        const job = makeJob();
        await adapter.push(job);
        const peeked = await adapter.peek();
        expect(peeked?.id).toBe(job.id);
        expect(await adapter.size()).toBe(1);
    });

    it('returns null when empty', async () => {
        expect(await adapter.pop()).toBeNull();
        expect(await adapter.peek()).toBeNull();
    });

    it('pops in priority order', async () => {
        await adapter.push(makeJob(10));
        await adapter.push(makeJob(1));
        await adapter.push(makeJob(5));
        const first = await adapter.pop();
        const second = await adapter.pop();
        const third = await adapter.pop();
        expect(first!.priority).toBe(1);
        expect(second!.priority).toBe(5);
        expect(third!.priority).toBe(10);
    });

    it('get returns job even after pop', async () => {
        const job = makeJob();
        await adapter.push(job);
        await adapter.pop(); // removes from heap
        // not in heap anymore — update stores it in secondary store
        const active = updateJob(job, { state: JobState.ACTIVE });
        await adapter.update(active);
        const found = await adapter.get(job.id);
        expect(found?.id).toBe(job.id);
    });

    it('update modifies a pending job in heap', async () => {
        const job = makeJob();
        await adapter.push(job);
        const updated = updateJob(job, { state: JobState.PAUSED });
        await adapter.update(updated);
        const fetched = await adapter.get(job.id);
        expect(fetched?.state).toBe(JobState.PAUSED);
    });

    it('remove deletes a job', async () => {
        const job = makeJob();
        await adapter.push(job);
        await adapter.remove(job.id);
        expect(await adapter.size()).toBe(0);
    });

    it('getAll returns all jobs', async () => {
        await adapter.push(makeJob());
        await adapter.push(makeJob());
        const all = await adapter.getAll();
        expect(all).toHaveLength(2);
    });

    it('clear removes all jobs', async () => {
        await adapter.push(makeJob());
        await adapter.push(makeJob());
        await adapter.clear();
        expect(await adapter.size()).toBe(0);
    });

    it('close clears the adapter', async () => {
        await adapter.push(makeJob());
        await adapter.close();
        expect(await adapter.size()).toBe(0);
    });

    it('size counts only pending/retrying jobs', async () => {
        const job1 = makeJob();
        await adapter.push(job1);
        const job2 = makeJob();
        await adapter.push(job2);
        // Simulate one being popped (active)
        await adapter.pop();
        // Size should now be 1 (only pending)
        expect(await adapter.size()).toBe(1);
    });
});
