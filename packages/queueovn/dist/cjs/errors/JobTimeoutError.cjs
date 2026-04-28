"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobTimeoutError = void 0;
const QueueError_js_1 = require("./QueueError.cjs");
/**
 * Thrown when a job exceeds its configured maxDuration.
 */
class JobTimeoutError extends QueueError_js_1.QueueError {
    jobId;
    maxDuration;
    constructor(jobId, maxDuration) {
        super(`Job "${jobId}" timed out after ${maxDuration}ms`);
        this.jobId = jobId;
        this.maxDuration = maxDuration;
        this.name = 'JobTimeoutError';
    }
}
exports.JobTimeoutError = JobTimeoutError;
