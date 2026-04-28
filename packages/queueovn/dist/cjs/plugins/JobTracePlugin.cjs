"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobTracePlugin = void 0;
const logger_js_1 = require("../utils/logger.cjs");
/**
 * JobTracePlugin — Provides out-of-the-box structured JSON logging
 * for the entire job lifecycle.
 *
 * @example
 * const queue = new JobQueue({
 *   plugins: [new JobTracePlugin()]
 * });
 */
class JobTracePlugin {
    name = 'JobTracePlugin';
    onEnqueue(job) {
        logger_js_1.defaultLogger.debug('Job enqueued', { id: job.id, type: job.type, priority: job.priority });
    }
    onProcess(job) {
        logger_js_1.defaultLogger.debug('Job processing', { id: job.id, type: job.type, attempt: job.attempts + 1 });
    }
    onComplete(job, result) {
        const duration = job.startedAt ? Date.now() - job.startedAt : 0;
        logger_js_1.defaultLogger.info('Job completed', { id: job.id, type: job.type, durationMs: duration, attempt: job.attempts });
    }
    onFail(job, error) {
        logger_js_1.defaultLogger.error(`Job failed: ${error.message}`, error, { id: job.id, type: job.type, attempt: job.attempts });
    }
    onExpire(job) {
        logger_js_1.defaultLogger.warn('Job expired', { id: job.id, type: job.type });
    }
}
exports.JobTracePlugin = JobTracePlugin;
