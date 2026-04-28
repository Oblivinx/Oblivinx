import { QueueError } from './QueueError.js';
/**
 * Thrown when a DAG job cannot start because an upstream dependency failed.
 */
export class DependencyError extends QueueError {
    jobId;
    failedDependencyId;
    constructor(jobId, failedDependencyId) {
        super(`Job "${jobId}" cannot run: upstream dependency "${failedDependencyId}" failed`);
        this.jobId = jobId;
        this.failedDependencyId = failedDependencyId;
        this.name = 'DependencyError';
    }
}
/**
 * Thrown when a DAG contains a cycle.
 */
export class CyclicDependencyError extends QueueError {
    constructor(cycle) {
        super(`Cyclic dependency detected in DAG: ${cycle.join(' → ')}`);
        this.name = 'CyclicDependencyError';
    }
}
/**
 * Thrown when a job handler for a given type is not registered.
 */
export class UnknownJobTypeError extends QueueError {
    jobType;
    constructor(jobType) {
        super(`No handler registered for job type "${jobType}"`);
        this.jobType = jobType;
        this.name = 'UnknownJobTypeError';
    }
}
