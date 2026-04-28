import type { JobPayload, JobHandler } from '../types/job.types.js';
/**
 * JobRegistry — register typed job handlers and look them up by job type.
 *
 * @example
 * registry.register('sendMessage', async (payload, ctx) => { ... });
 * const handler = registry.lookup('sendMessage');
 */
export declare class JobRegistry {
    private readonly handlers;
    /**
     * Register a handler for a given job type.
     * @throws QueueError if the type is already registered
     */
    register<T extends JobPayload>(type: string, handler: JobHandler<T>): void;
    /**
     * Look up the handler for a job type.
     * @throws UnknownJobTypeError if no handler is registered
     */
    lookup(type: string): JobHandler<JobPayload>;
    /**
     * Check if a handler is registered for a job type.
     */
    has(type: string): boolean;
    /**
     * Unregister a job type handler.
     */
    unregister(type: string): void;
    /**
     * Return all registered job types.
     */
    registeredTypes(): string[];
}
