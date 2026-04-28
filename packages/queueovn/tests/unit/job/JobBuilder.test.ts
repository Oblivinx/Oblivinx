import { describe, it, expect, beforeEach } from 'vitest';
import { JobBuilder } from '../../../src/job/JobBuilder.js';
import { JobState } from '../../../src/job/JobState.js';
import { JobResultFactory } from '../../../src/job/JobResult.js';
import { createJob, updateJob, isJob } from '../../../src/job/Job.js';

describe('Job layer', () => {
    describe('JobBuilder', () => {
        it('builds a job with defaults', () => {
            const job = new JobBuilder().type('test').payload({ x: 1 }).build();
            expect(job.id).toBeTruthy();
            expect(job.type).toBe('test');
            expect(job.priority).toBe(5);
            expect(job.maxAttempts).toBe(3);
            expect(job.state).toBe(JobState.PENDING);
        });

        it('supports all fluent methods', () => {
            const job = new JobBuilder()
                .type('t')
                .payload({ a: 1 })
                .priority(1)
                .delay(5000)
                .maxAttempts(10)
                .maxDuration(60_000)
                .ttl(120_000)
                .flow('flow-1')
                .dependsOn(['dep-a'])
                .build();

            expect(job.priority).toBe(1);
            expect(job.maxAttempts).toBe(10);
            expect(job.maxDuration).toBe(60_000);
            expect(job.ttl).toBe(120_000);
            expect(job.flowId).toBe('flow-1');
            expect(job.dependsOn).toEqual(['dep-a']);
            expect(job.runAt).toBeGreaterThan(Date.now());
        });

        it('getRetryPolicy returns undefined by default', () => {
            const builder = new JobBuilder().type('t').payload({});
            expect(builder.getRetryPolicy()).toBeUndefined();
        });
    });

    describe('JobState', () => {
        it('has all required states', () => {
            expect(JobState.PENDING).toBe('pending');
            expect(JobState.ACTIVE).toBe('active');
            expect(JobState.DONE).toBe('done');
            expect(JobState.FAILED).toBe('failed');
            expect(JobState.RETRYING).toBe('retrying');
            expect(JobState.PAUSED).toBe('paused');
            expect(JobState.EXPIRED).toBe('expired');
            expect(JobState.DLQ).toBe('dlq');
        });
    });

    describe('JobResultFactory', () => {
        it('creates a success result', () => {
            const r = JobResultFactory.success('ok');
            expect(r.ok).toBe(true);
            if (r.ok) expect(r.value).toBe('ok');
        });

        it('creates a failure result', () => {
            const err = new Error('boom');
            const r = JobResultFactory.failure(err);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error).toBe(err);
        });
    });

    describe('createJob / updateJob / isJob', () => {
        it('createJob creates a frozen job', () => {
            const job = createJob(
                { type: 'x', payload: {} },
                { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30_000 },
            );
            expect(Object.isFrozen(job)).toBe(true);
            expect(job.id).toBeTruthy();
        });

        it('updateJob returns a new object with changes applied', () => {
            const job = createJob(
                { type: 'x', payload: {} },
                { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30_000 },
            );
            const updated = updateJob(job, { state: JobState.DONE });
            expect(updated.state).toBe(JobState.DONE);
            expect(job.state).toBe(JobState.PENDING); // original unchanged
        });

        it('isJob returns true for a job', () => {
            const job = createJob(
                { type: 'x', payload: {} },
                { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30_000 },
            );
            expect(isJob(job)).toBe(true);
        });

        it('isJob returns false for non-jobs', () => {
            expect(isJob(null)).toBe(false);
            expect(isJob({ id: 123 })).toBe(false);
            expect(isJob('string')).toBe(false);
        });
    });
});
