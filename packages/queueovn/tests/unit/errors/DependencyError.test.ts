import { describe, it, expect } from 'vitest';
import { DependencyError, CyclicDependencyError, UnknownJobTypeError } from '../../../src/errors/DependencyError.js';
import { QueueError } from '../../../src/errors/QueueError.js';

describe('DependencyError', () => {
    it('constructs with jobId and failedDependencyId', () => {
        const err = new DependencyError('job-1', 'dep-2');
        expect(err).toBeInstanceOf(QueueError);
        expect(err).toBeInstanceOf(DependencyError);
        expect(err.name).toBe('DependencyError');
        expect(err.jobId).toBe('job-1');
        expect(err.failedDependencyId).toBe('dep-2');
        expect(err.message).toContain('job-1');
        expect(err.message).toContain('dep-2');
    });
});

describe('CyclicDependencyError', () => {
    it('constructs with cycle array', () => {
        const err = new CyclicDependencyError(['a', 'b', 'a']);
        expect(err).toBeInstanceOf(QueueError);
        expect(err.name).toBe('CyclicDependencyError');
        expect(err.message).toContain('a → b → a');
    });
});

describe('UnknownJobTypeError', () => {
    it('constructs with job type', () => {
        const err = new UnknownJobTypeError('missing-handler');
        expect(err).toBeInstanceOf(QueueError);
        expect(err.name).toBe('UnknownJobTypeError');
        expect(err.jobType).toBe('missing-handler');
        expect(err.message).toContain('missing-handler');
    });
});
