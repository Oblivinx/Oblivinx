/**
 * @module security/audit-log
 *
 * Append-only audit log for database operations.
 *
 * @packageDocumentation
 */
/** In-memory audit log backend */
export class InMemoryAuditLogBackend {
    #events = [];
    #maxSize;
    constructor(maxSize = 10000) {
        this.#maxSize = maxSize;
    }
    append(event) {
        this.#events.push(event);
        // Circular buffer: drop oldest when full
        if (this.#events.length > this.#maxSize) {
            this.#events.shift();
        }
    }
    flush() {
        this.#events.length = 0;
    }
    /** Get all events (for debugging/testing) */
    getEvents() {
        return [...this.#events];
    }
}
/**
 * Audit logger — records database operations for compliance and debugging.
 */
export class AuditLogger {
    #backend;
    #enabled;
    #events;
    constructor(options) {
        this.#enabled = options.enabled ?? true;
        this.#backend = options.backend ?? new InMemoryAuditLogBackend();
        this.#events = new Set(options.events ?? ['insert', 'update', 'delete']);
    }
    /**
     * Log an operation.
     */
    log(event) {
        if (!this.#enabled)
            return;
        if (!this.#events.has(event.operation))
            return;
        this.#backend.append({
            timestamp: Date.now(),
            ...event,
        });
    }
    /**
     * Flush all logged events (for file-based backends).
     */
    flush() {
        this.#backend.flush();
    }
}
//# sourceMappingURL=audit-log.js.map