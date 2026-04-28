import { describe, it, expect, vi } from 'vitest';
import { JobBatch } from '../../../src/job/JobBatch.js';
import { createJob } from '../../../src/job/Job.js';

describe('JobBatch', () => {
    it('awaits multiple jobs to complete', async () => {
        const batch = new JobBatch();

        const job1 = createJob({ type: 'test', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });
        const job2 = createJob({ type: 'test', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });

        // Track jobs FIRST
        const prom1 = batch.track(job1.id);
        const prom2 = batch.track(job2.id);
        expect(batch.size).toBe(2);

        const prom = batch.awaitAll();

        // Complete them
        batch.complete(job1, { ok: true, value: 10 });
        expect(batch.size).toBe(1);

        batch.complete(job2, { ok: true, value: 20 });
        expect(batch.size).toBe(0);

        const awaited = await prom;

        expect(awaited.length).toBe(2);
        expect((awaited[0] as any).value.result.value).toBe(10);
        expect((awaited[1] as any).value.result.value).toBe(20);
    });

    it('awaits the first job to complete with awaitAny', async () => {
        const batch = new JobBatch();

        const job1 = createJob({ type: 'test', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });
        const job2 = createJob({ type: 'test', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });

        batch.track(job1.id);
        batch.track(job2.id);

        const prom = batch.awaitAny();

        // Job2 completes first
        batch.complete(job2, { ok: true, value: 99 });

        const result = await prom;
        expect(result.job.id).toBe(job2.id);
        expect(result.result.value).toBe(99);
    });

    it('handles fail correctly', async () => {
        const batch = new JobBatch();
        const job = createJob({ type: 'test', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });

        const promId = batch.track(job.id);
        const promAll = batch.awaitAll();

        batch.fail(job, new Error('boom'));

        const results = await promAll;
        expect(results.length).toBe(1);
        expect(results[0]!.status).toBe('rejected');
        expect((results[0] as any).reason.message).toBe('boom');

        await expect(promId).rejects.toThrow('boom');
    });

    it('safely ignores untracked jobs', () => {
        const batch = new JobBatch();
        const job = createJob({ type: 'test', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 3000 });
        // Should not throw
        batch.complete(job, { ok: true, value: 1 });
        batch.fail(job, new Error('x'));
        expect(batch.size).toBe(0);
    });
});
