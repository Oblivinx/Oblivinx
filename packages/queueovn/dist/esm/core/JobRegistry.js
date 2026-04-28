import { UnknownJobTypeError } from '../errors/DependencyError.js';
/**
 * JobRegistry — register typed job handlers and look them up by job type.
 *
 * @example
 * registry.register('sendMessage', async (payload, ctx) => { ... });
 * const handler = registry.lookup('sendMessage');
 */
export class JobRegistry {
    handlers = new Map();
    /**
     * Register a handler for a given job type.
     * @throws QueueError if the type is already registered
     */
    register(type, handler) {
        this.handlers.set(type, handler);
    }
    /**
     * Look up the handler for a job type.
     * @throws UnknownJobTypeError if no handler is registered
     */
    lookup(type) {
        const handler = this.handlers.get(type);
        if (!handler)
            throw new UnknownJobTypeError(type);
        return handler;
    }
    /**
     * Check if a handler is registered for a job type.
     */
    has(type) {
        return this.handlers.has(type);
    }
    /**
     * Unregister a job type handler.
     */
    unregister(type) {
        this.handlers.delete(type);
    }
    /**
     * Return all registered job types.
     */
    registeredTypes() {
        return Array.from(this.handlers.keys());
    }
}
