import { defaultLogger as logger } from '../utils/logger.js';
/**
 * JobTracePlugin — Provides out-of-the-box structured JSON logging
 * for the entire job lifecycle.
 *
 * @example
 * const queue = new JobQueue({
 *   plugins: [new JobTracePlugin()]
 * });
 */
export class JobTracePlugin {
    name = 'JobTracePlugin';
    onEnqueue(job) {
        logger.debug('Job enqueued', { id: job.id, type: job.type, priority: job.priority });
    }
    onProcess(job) {
        logger.debug('Job processing', { id: job.id, type: job.type, attempt: job.attempts + 1 });
    }
    onComplete(job, result) {
        const duration = job.startedAt ? Date.now() - job.startedAt : 0;
        logger.info('Job completed', { id: job.id, type: job.type, durationMs: duration, attempt: job.attempts });
    }
    onFail(job, error) {
        logger.error(`Job failed: ${error.message}`, error, { id: job.id, type: job.type, attempt: job.attempts });
    }
    onExpire(job) {
        logger.warn('Job expired', { id: job.id, type: job.type });
    }
}
