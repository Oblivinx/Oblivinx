import { QueueError } from './QueueError.js';

/**
 * Thrown when a DAG job cannot start because an upstream dependency failed.
 */
export class DependencyError extends QueueError {
    constructor(
        public readonly jobId: string,
        public readonly failedDependencyId: string,
    ) {
        super(
            `Job "${jobId}" cannot run: upstream dependency "${failedDependencyId}" failed`,
        );
        this.name = 'DependencyError';
    }
}

/**
 * Thrown when a DAG contains a cycle.
 */
export class CyclicDependencyError extends QueueError {
    constructor(cycle: string[]) {
        super(`Cyclic dependency detected in DAG: ${cycle.join(' → ')}`);
        this.name = 'CyclicDependencyError';
    }
}

/**
 * Thrown when a job handler for a given type is not registered.
 */
export class UnknownJobTypeError extends QueueError {
    constructor(public readonly jobType: string) {
        super(`No handler registered for job type "${jobType}"`);
        this.name = 'UnknownJobTypeError';
    }
}
