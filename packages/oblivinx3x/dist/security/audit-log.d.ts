/**
 * @module security/audit-log
 *
 * Append-only audit log for database operations.
 *
 * @packageDocumentation
 */
/** Audit log event */
export interface AuditEvent {
    /** Timestamp in milliseconds */
    timestamp: number;
    /** Operation type */
    operation: 'insert' | 'update' | 'delete' | 'find';
    /** Collection name */
    collection: string;
    /** Document ID (if available) */
    documentId?: string;
    /** Filter used (for find/update/delete) */
    filter?: Record<string, unknown>;
    /** User/session identifier */
    sessionId?: string;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
}
/** Audit log storage backend */
export interface AuditLogBackend {
    append(event: AuditEvent): void;
    flush(): void;
}
/** In-memory audit log backend */
export declare class InMemoryAuditLogBackend implements AuditLogBackend {
    #private;
    constructor(maxSize?: number);
    append(event: AuditEvent): void;
    flush(): void;
    /** Get all events (for debugging/testing) */
    getEvents(): ReadonlyArray<AuditEvent>;
}
/**
 * Audit logger — records database operations for compliance and debugging.
 */
export declare class AuditLogger {
    #private;
    constructor(options: {
        enabled?: boolean;
        backend?: AuditLogBackend;
        events?: ('insert' | 'update' | 'delete' | 'find')[];
    });
    /**
     * Log an operation.
     */
    log(event: Omit<AuditEvent, 'timestamp'>): void;
    /**
     * Flush all logged events (for file-based backends).
     */
    flush(): void;
}
//# sourceMappingURL=audit-log.d.ts.map