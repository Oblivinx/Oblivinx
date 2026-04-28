import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Scheduler } from '../../../src/core/Scheduler.js';
import { createJob } from '../../../src/job/Job.js';

const DEFAULTS = { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 };

describe('Scheduler', () => {
    let scheduler: Scheduler;

    beforeEach(() => {
        vi.useFakeTimers();
        scheduler = new Scheduler();
    });

    afterEach(() => {
        scheduler.clear();
        vi.useRealTimers();
    });

    it('schedule fires callback when time is reached', async () => {
        const cb = vi.fn();
        scheduler.onReady(cb);
        const job = createJob({ type: 'test', payload: {} }, DEFAULTS);
        scheduler.schedule(job, Date.now() + 100);
        expect(scheduler.size).toBe(1);
        vi.advanceTimersByTime(100);
        expect(cb).toHaveBeenCalledWith(job);
        expect(scheduler.size).toBe(0);
    });

    it('cancel removes a scheduled job and prevents callback', () => {
        const cb = vi.fn();
        scheduler.onReady(cb);
        const job = createJob({ type: 'test', payload: {} }, DEFAULTS);
        scheduler.schedule(job, Date.now() + 100);
        expect(scheduler.size).toBe(1);
        scheduler.cancel(job.id);
        expect(scheduler.size).toBe(0);
        vi.advanceTimersByTime(200);
        expect(cb).not.toHaveBeenCalled();
    });

    it('cancel is no-op for non-existent job', () => {
        scheduler.cancel('nonexistent');
        expect(scheduler.size).toBe(0);
    });

    it('scheduledJobs returns all scheduled jobs', () => {
        const job1 = createJob({ type: 'a', payload: {} }, DEFAULTS);
        const job2 = createJob({ type: 'b', payload: {} }, DEFAULTS);
        scheduler.schedule(job1, Date.now() + 100);
        scheduler.schedule(job2, Date.now() + 200);
        const jobs = scheduler.scheduledJobs();
        expect(jobs).toHaveLength(2);
        expect(jobs.map(j => j.id).sort()).toEqual([job1.id, job2.id].sort());
    });

    it('clear cancels all scheduled jobs', () => {
        const cb = vi.fn();
        scheduler.onReady(cb);
        for (let i = 0; i < 5; i++) {
            const job = createJob({ type: `t${i}`, payload: {} }, DEFAULTS);
            scheduler.schedule(job, Date.now() + 100 * (i + 1));
        }
        expect(scheduler.size).toBe(5);
        scheduler.clear();
        expect(scheduler.size).toBe(0);
        vi.advanceTimersByTime(1000);
        expect(cb).not.toHaveBeenCalled();
    });

    it('size returns 0 when no jobs are scheduled', () => {
        expect(scheduler.size).toBe(0);
    });

    it('fires immediately when runAt is in the past', () => {
        const cb = vi.fn();
        scheduler.onReady(cb);
        const job = createJob({ type: 'test', payload: {} }, DEFAULTS);
        scheduler.schedule(job, Date.now() - 1000);
        vi.advanceTimersByTime(0);
        expect(cb).toHaveBeenCalledWith(job);
    });
});
