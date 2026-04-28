import { QueueError } from './QueueError.js';
/**
 * Thrown when a DAG job cannot start because an upstream dependency failed.
 */
export declare class DependencyError extends QueueError {
    readonly jobId: string;
    readonly failedDependencyId: string;
    constructor(jobId: string, failedDependencyId: string);
}
/**
 * Thrown when a DAG contains a cycle.
 */
export declare class CyclicDependencyError extends QueueError {
    constructor(cycle: string[]);
}
/**
 * Thrown when a job handler for a given type is not registered.
 */
export declare class UnknownJobTypeError extends QueueError {
    readonly jobType: string;
    constructor(jobType: string);
}
