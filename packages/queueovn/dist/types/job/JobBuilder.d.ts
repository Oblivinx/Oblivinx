import type { JobPayload } from '../types/job.types.js';
import type { IRetryPolicy } from '../retry/RetryPolicy.js';
import type { Job } from '../types/job.types.js';
/**
 * Fluent builder for creating Job instances.
 *
 * @example
 * const job = new JobBuilder()
 *   .type('sendMessage')
 *   .payload({ phone: '628xx', text: 'hi' })
 *   .priority(8)
 *   .delay(5000)
 *   .retry(new ExponentialBackoff({ maxAttempts: 3 }))
 *   .build();
 */
export declare class JobBuilder<T extends JobPayload = JobPayload> {
    private _type;
    private _payload;
    private _priority;
    private _delay;
    private _maxAttempts;
    private _maxDuration;
    private _ttl?;
    private _flowId?;
    private _dependsOn?;
    private _retryPolicy?;
    /** Set the job type (must match a registered handler) */
    type(val: string): this;
    /** Set the job payload */
    payload(val: T): this;
    /** Lower number = higher priority (1 = highest, 10 = lowest) */
    priority(val: number): this;
    /** Delay in ms before the job becomes eligible for processing */
    delay(val: number): this;
    /** Maximum number of attempts (including the first try) */
    maxAttempts(val: number): this;
    /** Maximum wall-clock time in ms a single attempt may take */
    maxDuration(val: number): this;
    /** Time-to-live in ms; if still pending after this, job is expired */
    ttl(val: number): this;
    /** Associate this job with a flow/DAG */
    flow(flowId: string): this;
    /** Specify upstream DAG dependencies (node IDs) */
    dependsOn(ids: string[]): this;
    /** Attach a retry policy (used by the queue engine — stored as metadata) */
    retry(_policy: IRetryPolicy): this;
    /** Get the attached retry policy */
    getRetryPolicy(): IRetryPolicy | undefined;
    /**
     * Build and freeze the Job.
     * @throws QueueError if type is not set
     */
    build(): Job<T>;
}
