import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
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
export class JobTracePlugin implements IPlugin {
    readonly name = 'JobTracePlugin';

    onEnqueue<T extends JobPayload>(job: Job<T>): void {
        logger.debug('Job enqueued', { id: job.id, type: job.type, priority: job.priority });
    }

    onProcess<T extends JobPayload>(job: Job<T>): void {
        logger.debug('Job processing', { id: job.id, type: job.type, attempt: job.attempts + 1 });
    }

    onComplete<T extends JobPayload>(job: Job<T>, result: JobResult): void {
        const duration = job.startedAt ? Date.now() - job.startedAt : 0;
        logger.info('Job completed', { id: job.id, type: job.type, durationMs: duration, attempt: job.attempts });
    }

    onFail<T extends JobPayload>(job: Job<T>, error: Error): void {
        logger.error(`Job failed: ${error.message}`, error, { id: job.id, type: job.type, attempt: job.attempts });
    }

    onExpire<T extends JobPayload>(job: Job<T>): void {
        logger.warn('Job expired', { id: job.id, type: job.type });
    }
}
