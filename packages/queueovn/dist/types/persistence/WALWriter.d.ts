export type WALOperation = 'ENQUEUE' | 'ACTIVATE' | 'COMPLETE' | 'FAIL' | 'RETRY' | 'EXPIRE' | 'DLQ' | 'CHAIN_REGISTER' | 'CHAIN_ADVANCE' | 'CHAIN_COMPLETE' | 'DAG_REGISTER' | 'DAG_COMPLETE_DEP' | 'DLQ_ADD' | 'DLQ_REMOVE';
export interface WALEntry {
    seq: number;
    op: WALOperation;
    jobId: string;
    timestamp: number;
    data?: unknown;
}
/**
 * WALWriter — Write-Ahead Log for crash recovery.
 * Each operation is appended as a JSON line (synchronous for atomicity).
 */
export declare class WALWriter {
    private readonly walPath;
    private seq;
    private enabled;
    private stream;
    constructor(walPath: string, enabled?: boolean);
    /**
     * Initialize: ensure directory exists & read current sequence number.
     */
    initialize(): void;
    /**
     * Append a WAL entry synchronously.
     */
    append(op: WALOperation, jobId: string, data?: unknown): WALEntry;
    /**
     * Read all WAL entries from disk.
     */
    readAll(): WALEntry[];
    /**
     * Read WAL entries after a given sequence number (for post-snapshot replay).
     */
    readAfter(seq: number): WALEntry[];
    /**
     * Truncate the WAL (called after snapshot is persisted).
     */
    truncate(): Promise<void>;
    /**
     * Close the stream gracefully
     */
    close(): Promise<void>;
    get currentSeq(): number;
}
