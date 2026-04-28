import type { Job, JobPayload } from '../../src/types/job.types.js';
import { createJob } from '../../src/job/Job.js';

const defaults = {
    defaultPriority: 5,
    defaultMaxAttempts: 3,
    defaultMaxDuration: 30_000,
};

export function makeMockJob(
    type = 'test',
    overrides: Partial<Job<JobPayload>> = {},
): Job<JobPayload> {
    const base = createJob({ type, payload: { test: true }, ...overrides as Record<string, unknown> }, defaults);
    return { ...base, ...overrides };
}

export const mockJobs = {
    highPriority: () => makeMockJob('high-priority', { priority: 1 }),
    lowPriority: () => makeMockJob('low-priority', { priority: 10 }),
    withDelay: () => createJob(
        { type: 'delayed', payload: {}, delay: 5000 },
        defaults,
    ),
    withTTL: () => createJob(
        { type: 'ttl-test', payload: {}, ttl: 2000 },
        defaults,
    ),
};
