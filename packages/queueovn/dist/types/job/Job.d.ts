import type { Job, JobPayload, JobOptions } from '../types/job.types.js';
/**
 * Immutable job value object factory and type guard.
 * Every Job created through this module is frozen.
 */
export declare function createJob<T extends JobPayload>(options: JobOptions<T>, defaults: {
    defaultPriority: number;
    defaultMaxAttempts: number;
    defaultMaxDuration: number;
}): Job<T>;
/**
 * Create a shallow update of an existing job (returns new frozen object).
 */
export declare function updateJob<T extends JobPayload>(job: Job<T>, changes: Partial<Omit<Job<T>, 'id' | 'type' | 'createdAt'>>): Job<T>;
/**
 * Type guard for Job<T>
 */
export declare function isJob<T extends JobPayload>(value: unknown): value is Job<T>;
