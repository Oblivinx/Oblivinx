import type { Job, JobPayload, JobOptions } from '../types/job.types.js';
import { JobState } from './JobState.js';
import { generateId } from '../utils/idGenerator.js';

/**
 * Immutable job value object factory and type guard.
 * Every Job created through this module is frozen.
 */
export function createJob<T extends JobPayload>(
    options: JobOptions<T>,
    defaults: {
        defaultPriority: number;
        defaultMaxAttempts: number;
        defaultMaxDuration: number;
    },
): Job<T> {
    const now = Date.now();
    const delay = options.delay ?? 0;
    const ttl = options.ttl;

    const job: Job<T> = Object.freeze({
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
export function updateJob<T extends JobPayload>(
    job: Job<T>,
    changes: Partial<Omit<Job<T>, 'id' | 'type' | 'createdAt'>>,
): Job<T> {
    return Object.freeze({ ...job, ...changes });
}

/**
 * Type guard for Job<T>
 */
export function isJob<T extends JobPayload>(value: unknown): value is Job<T> {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>)['id'] === 'string' &&
        typeof (value as Record<string, unknown>)['type'] === 'string'
    );
}
