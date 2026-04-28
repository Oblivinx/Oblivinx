import type { JobPayload, JobHandler } from '../types/job.types.js';
import { UnknownJobTypeError } from '../errors/DependencyError.js';

/**
 * JobRegistry — register typed job handlers and look them up by job type.
 *
 * @example
 * registry.register('sendMessage', async (payload, ctx) => { ... });
 * const handler = registry.lookup('sendMessage');
 */
export class JobRegistry {
    private readonly handlers = new Map<string, JobHandler<JobPayload>>();

    /**
     * Register a handler for a given job type.
     * @throws QueueError if the type is already registered
     */
    register<T extends JobPayload>(type: string, handler: JobHandler<T>): void {
        this.handlers.set(type, handler as JobHandler<JobPayload>);
    }

    /**
     * Look up the handler for a job type.
     * @throws UnknownJobTypeError if no handler is registered
     */
    lookup(type: string): JobHandler<JobPayload> {
        const handler = this.handlers.get(type);
        if (!handler) throw new UnknownJobTypeError(type);
        return handler;
    }

    /**
     * Check if a handler is registered for a job type.
     */
    has(type: string): boolean {
        return this.handlers.has(type);
    }

    /**
     * Unregister a job type handler.
     */
    unregister(type: string): void {
        this.handlers.delete(type);
    }

    /**
     * Return all registered job types.
     */
    registeredTypes(): string[] {
        return Array.from(this.handlers.keys());
    }
}
