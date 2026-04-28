/** FSM states for a Job lifecycle */
export type JobState = 'pending' | 'active' | 'done' | 'failed' | 'retrying' | 'paused' | 'expired' | 'dlq';
/** Typed job payload — any serializable record */
export type JobPayload = Record<string, unknown>;
/** A single immutable job value object */
export interface Job<T extends JobPayload = JobPayload> {
    readonly id: string;
    readonly type: string;
    readonly payload: T;
    readonly priority: number;
    readonly maxAttempts: number;
    readonly attempts: number;
    readonly maxDuration: number;
    readonly state: JobState;
    readonly createdAt: number;
    readonly runAt: number;
    readonly ttl?: number;
    readonly expiresAt?: number;
    readonly startedAt?: number;
    readonly finishedAt?: number;
    readonly lastError?: string;
    readonly flowId?: string;
    readonly dependsOn?: string[];
    readonly idempotencyKey?: string;
    /**
     * Per-job retry policy. Overrides the queue's default retry policy.
     * Not serialized/persisted — after crash recovery jobs fall back to the queue default.
     */
    readonly retryPolicy?: import('../retry/RetryPolicy.js').IRetryPolicy;
}
/** Options passed to queue.enqueue() */
export interface JobOptions<T extends JobPayload = JobPayload> {
    type: string;
    payload: T;
    priority?: number;
    delay?: number;
    maxAttempts?: number;
    maxDuration?: number;
    ttl?: number;
    shardKey?: string;
    flowId?: string;
    dependsOn?: string[];
    idempotencyKey?: string;
    /**
     * Override the default retry policy for this specific job.
     * Takes precedence over the queue-level default.
     */
    retryPolicy?: import('../retry/RetryPolicy.js').IRetryPolicy;
}
/** Result of a successful job */
export interface JobSuccess<R = unknown> {
    readonly ok: true;
    readonly value: R;
}
/** Result of a failed job */
export interface JobFailure {
    readonly ok: false;
    readonly error: Error;
}
/** Union result type */
export type JobResult<R = unknown> = JobSuccess<R> | JobFailure;
/** Context passed to job handler */
export interface JobContext {
    readonly jobId: string;
    readonly attempt: number;
    readonly signal?: AbortSignal;
}
/** Handler function registered per job type */
export type JobHandler<T extends JobPayload = JobPayload, R = unknown> = (payload: T, ctx: JobContext) => Promise<R>;
