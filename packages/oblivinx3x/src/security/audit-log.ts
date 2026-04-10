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
export class InMemoryAuditLogBackend implements AuditLogBackend {
  readonly #events: AuditEvent[] = [];
  readonly #maxSize: number;

  constructor(maxSize = 10000) {
    this.#maxSize = maxSize;
  }

  append(event: AuditEvent): void {
    this.#events.push(event);
    // Circular buffer: drop oldest when full
    if (this.#events.length > this.#maxSize) {
      this.#events.shift();
    }
  }

  flush(): void {
    this.#events.length = 0;
  }

  /** Get all events (for debugging/testing) */
  getEvents(): ReadonlyArray<AuditEvent> {
    return [...this.#events];
  }
}

/**
 * Audit logger — records database operations for compliance and debugging.
 */
export class AuditLogger {
  readonly #backend: AuditLogBackend;
  readonly #enabled: boolean;
  readonly #events: Set<'insert' | 'update' | 'delete' | 'find'>;

  constructor(options: {
    enabled?: boolean;
    backend?: AuditLogBackend;
    events?: ('insert' | 'update' | 'delete' | 'find')[];
  }) {
    this.#enabled = options.enabled ?? true;
    this.#backend = options.backend ?? new InMemoryAuditLogBackend();
    this.#events = new Set(options.events ?? ['insert', 'update', 'delete']);
  }

  /**
   * Log an operation.
   */
  log(event: Omit<AuditEvent, 'timestamp'>): void {
    if (!this.#enabled) return;
    if (!this.#events.has(event.operation as any)) return;

    this.#backend.append({
      timestamp: Date.now(),
      ...event,
    });
  }

  /**
   * Flush all logged events (for file-based backends).
   */
  flush(): void {
    this.#backend.flush();
  }
}
