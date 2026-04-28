import { createJob } from './Job.js';
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
export class JobBuilder {
    _type = '';
    _payload = {};
    _priority = BUILDER_DEFAULTS.defaultPriority;
    _delay = 0;
    _maxAttempts = BUILDER_DEFAULTS.defaultMaxAttempts;
    _maxDuration = BUILDER_DEFAULTS.defaultMaxDuration;
    _ttl;
    _flowId;
    _dependsOn;
    _retryPolicy;
    /** Set the job type (must match a registered handler) */
    type(val) {
        this._type = val;
        return this;
    }
    /** Set the job payload */
    payload(val) {
        this._payload = val;
        return this;
    }
    /** Lower number = higher priority (1 = highest, 10 = lowest) */
    priority(val) {
        this._priority = val;
        return this;
    }
    /** Delay in ms before the job becomes eligible for processing */
    delay(val) {
        this._delay = val;
        return this;
    }
    /** Maximum number of attempts (including the first try) */
    maxAttempts(val) {
        this._maxAttempts = val;
        return this;
    }
    /** Maximum wall-clock time in ms a single attempt may take */
    maxDuration(val) {
        this._maxDuration = val;
        return this;
    }
    /** Time-to-live in ms; if still pending after this, job is expired */
    ttl(val) {
        this._ttl = val;
        return this;
    }
    /** Associate this job with a flow/DAG */
    flow(flowId) {
        this._flowId = flowId;
        return this;
    }
    /** Specify upstream DAG dependencies (node IDs) */
    dependsOn(ids) {
        this._dependsOn = ids;
        return this;
    }
    /** Attach a retry policy (used by the queue engine — stored as metadata) */
    retry(_policy) {
        this._retryPolicy = _policy;
        return this;
    }
    /** Get the attached retry policy */
    getRetryPolicy() {
        return this._retryPolicy;
    }
    /**
     * Build and freeze the Job.
     * @throws QueueError if type is not set
     */
    build() {
        const opts = {
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
        return createJob(opts, BUILDER_DEFAULTS);
    }
}
