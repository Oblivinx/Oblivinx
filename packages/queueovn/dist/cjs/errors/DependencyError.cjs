"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.UnknownJobTypeError = exports.CyclicDependencyError = exports.DependencyError = void 0;
const QueueError_js_1 = require("./QueueError.cjs");
/**
 * Thrown when a DAG job cannot start because an upstream dependency failed.
 */
class DependencyError extends QueueError_js_1.QueueError {
    jobId;
    failedDependencyId;
    constructor(jobId, failedDependencyId) {
        super(`Job "${jobId}" cannot run: upstream dependency "${failedDependencyId}" failed`);
        this.jobId = jobId;
        this.failedDependencyId = failedDependencyId;
        this.name = 'DependencyError';
    }
}
exports.DependencyError = DependencyError;
/**
 * Thrown when a DAG contains a cycle.
 */
class CyclicDependencyError extends QueueError_js_1.QueueError {
    constructor(cycle) {
        super(`Cyclic dependency detected in DAG: ${cycle.join(' → ')}`);
        this.name = 'CyclicDependencyError';
    }
}
exports.CyclicDependencyError = CyclicDependencyError;
/**
 * Thrown when a job handler for a given type is not registered.
 */
class UnknownJobTypeError extends QueueError_js_1.QueueError {
    jobType;
    constructor(jobType) {
        super(`No handler registered for job type "${jobType}"`);
        this.jobType = jobType;
        this.name = 'UnknownJobTypeError';
    }
}
exports.UnknownJobTypeError = UnknownJobTypeError;
