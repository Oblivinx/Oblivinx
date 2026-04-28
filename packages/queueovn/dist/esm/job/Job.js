import { JobState } from './JobState.js';
import { generateId } from '../utils/idGenerator.js';
/**
 * Immutable job value object factory and type guard.
 * Every Job created through this module is frozen.
 */
export function createJob(options, defaults) {
    const now = Date.now();
    const delay = options.delay ?? 0;
    const ttl = options.ttl;
    const job = Object.freeze({
        id: generateId(),
        type: options.type,
        payload: options.payload,
        priority: options.priority ?? defaults.defaultPriority,
        maxAttempts: options.maxAttempts ?? defaults.defaultMaxAttempts,
        attempts: 0,
        maxDuration: options.maxDuration ?? defaults.defaultMaxDuration,
        state: JobState.PENDING,
        createdAt: now,
        runAt: now + delay,
        ttl,
        expiresAt: ttl !== undefined ? now + ttl : undefined,
        flowId: options.flowId,
        dependsOn: options.dependsOn,
        idempotencyKey: options.idempotencyKey,
        retryPolicy: options.retryPolicy,
    });
    return job;
}
/**
 * Create a shallow update of an existing job (returns new frozen object).
 */
export function updateJob(job, changes) {
    return Object.freeze({ ...job, ...changes });
}
/**
 * Type guard for Job<T>
 */
export function isJob(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value['id'] === 'string' &&
        typeof value['type'] === 'string');
}
