import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
/**
 * JobTracePlugin — Provides out-of-the-box structured JSON logging
 * for the entire job lifecycle.
 *
 * @example
 * const queue = new JobQueue({
 *   plugins: [new JobTracePlugin()]
 * });
 */
export declare class JobTracePlugin implements IPlugin {
    readonly name = "JobTracePlugin";
    onEnqueue<T extends JobPayload>(job: Job<T>): void;
    onProcess<T extends JobPayload>(job: Job<T>): void;
    onComplete<T extends JobPayload>(job: Job<T>, result: JobResult): void;
    onFail<T extends JobPayload>(job: Job<T>, error: Error): void;
    onExpire<T extends JobPayload>(job: Job<T>): void;
}
