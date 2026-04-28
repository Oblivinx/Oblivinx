import type { JobPayload, JobOptions } from '../types/job.types.js';
import type { IRetryPolicy } from '../retry/RetryPolicy.js';
import { createJob } from './Job.js';
import type { Job } from '../types/job.types.js';

/** Defaults used when building a job */
const BUILDER_DEFAULTS = {
    defaultPriority: 5,
    defaultMaxAttempts: 3,
    defaultMaxDuration: 30_000,
};

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
export class JobBuilder<T extends JobPayload = JobPayload> {
    private _type = '';
    private _payload: T = {} as T;
    private _priority = BUILDER_DEFAULTS.defaultPriority;
    private _delay = 0;
    private _maxAttempts = BUILDER_DEFAULTS.defaultMaxAttempts;
    private _maxDuration = BUILDER_DEFAULTS.defaultMaxDuration;
    private _ttl?: number;
    private _flowId?: string;
    private _dependsOn?: string[];
    private _retryPolicy?: IRetryPolicy;

    /** Set the job type (must match a registered handler) */
    type(val: string): this {
        this._type = val;
        return this;
    }

    /** Set the job payload */
    payload(val: T): this {
        this._payload = val;
        return this;
    }

    /** Lower number = higher priority (1 = highest, 10 = lowest) */
    priority(val: number): this {
        this._priority = val;
        return this;
    }

    /** Delay in ms before the job becomes eligible for processing */
    delay(val: number): this {
        this._delay = val;
        return this;
    }

    /** Maximum number of attempts (including the first try) */
    maxAttempts(val: number): this {
        this._maxAttempts = val;
        return this;
    }

    /** Maximum wall-clock time in ms a single attempt may take */
    maxDuration(val: number): this {
        this._maxDuration = val;
        return this;
    }

    /** Time-to-live in ms; if still pending after this, job is expired */
    ttl(val: number): this {
        this._ttl = val;
        return this;
    }

    /** Associate this job with a flow/DAG */
    flow(flowId: string): this {
        this._flowId = flowId;
        return this;
    }

    /** Specify upstream DAG dependencies (node IDs) */
    dependsOn(ids: string[]): this {
        this._dependsOn = ids;
        return this;
    }

    /** Attach a retry policy (used by the queue engine — stored as metadata) */
    retry(_policy: IRetryPolicy): this {
        this._retryPolicy = _policy;
        return this;
    }

    /** Get the attached retry policy */
    getRetryPolicy(): IRetryPolicy | undefined {
        return this._retryPolicy;
    }

    /**
     * Build and freeze the Job.
     * @throws QueueError if type is not set
     */
    build(): Job<T> {
        const opts: JobOptions<T> = {
            type: this._type,
            payload: this._payload,
            priority: this._priority,
            delay: this._delay,
            maxAttempts: this._maxAttempts,
            maxDuration: this._maxDuration,
            ttl: this._ttl,
            flowId: this._flowId,
            dependsOn: this._dependsOn,
            retryPolicy: this._retryPolicy,
        };
        return createJob<T>(opts, BUILDER_DEFAULTS);
    }
}
