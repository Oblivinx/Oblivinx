import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JobTracePlugin } from '../../../src/plugins/JobTracePlugin.js';
import { defaultLogger } from '../../../src/utils/logger.js';
import { createJob } from '../../../src/job/Job.js';
import { JobResultFactory } from '../../../src/job/JobResult.js';

describe('JobTracePlugin', () => {
    let plugin: JobTracePlugin;

    beforeEach(() => {
        plugin = new JobTracePlugin();
        vi.restoreAllMocks();
    });

    it('should have name "JobTracePlugin"', () => {
        expect(plugin.name).toBe('JobTracePlugin');
    });

    it('onEnqueue logs debug with job info', () => {
        const spy = vi.spyOn(defaultLogger, 'debug');
        const job = createJob({ type: 'test', payload: { x: 1 } }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 });
        plugin.onEnqueue(job);
        expect(spy).toHaveBeenCalledWith('Job enqueued', { id: job.id, type: 'test', priority: job.priority });
    });

    it('onProcess logs debug with attempt count', () => {
        const spy = vi.spyOn(defaultLogger, 'debug');
        const job = createJob({ type: 'work', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 });
        plugin.onProcess(job);
        expect(spy).toHaveBeenCalledWith('Job processing', { id: job.id, type: 'work', attempt: job.attempts + 1 });
    });

    it('onComplete logs info with duration when startedAt is set', () => {
        const spy = vi.spyOn(defaultLogger, 'info');
        const job = createJob({ type: 'done', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 });
        // Set startedAt to simulate an active job
        const activeJob = { ...job, startedAt: Date.now() - 100 };
        const result = JobResultFactory.success('ok');
        plugin.onComplete(activeJob, result);
        expect(spy).toHaveBeenCalledOnce();
        const call = spy.mock.calls[0]!;
        expect(call[0]).toBe('Job completed');
        expect((call[1] as Record<string, unknown>).durationMs).toBeGreaterThanOrEqual(0);
    });

    it('onComplete logs info with 0 duration when startedAt is not set', () => {
        const spy = vi.spyOn(defaultLogger, 'info');
        const job = createJob({ type: 'done', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 });
        const result = JobResultFactory.success('ok');
        plugin.onComplete(job, result);
        expect(spy).toHaveBeenCalledOnce();
        const call = spy.mock.calls[0]!;
        expect((call[1] as Record<string, unknown>).durationMs).toBe(0);
    });

    it('onFail logs error with error message', () => {
        const spy = vi.spyOn(defaultLogger, 'error');
        const job = createJob({ type: 'fail', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 });
        const error = new Error('something broke');
        plugin.onFail(job, error);
        expect(spy).toHaveBeenCalledWith(
            'Job failed: something broke',
            error,
            { id: job.id, type: 'fail', attempt: job.attempts },
        );
    });

    it('onExpire logs warn with job info', () => {
        const spy = vi.spyOn(defaultLogger, 'warn');
        const job = createJob({ type: 'expired', payload: {} }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30000 });
        plugin.onExpire(job);
        expect(spy).toHaveBeenCalledWith('Job expired', { id: job.id, type: 'expired' });
    });
});
