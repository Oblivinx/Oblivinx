import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
import type { WALWriter, WALEntry } from '../persistence/WALWriter.js';
export interface DLQEntry {
    job: Job<JobPayload>;
    error: Error;
    capturedAt: number;
}
/**
 * Optional persistence backend for DLQ entries.
 * Implemented by adapters that have native durability (e.g. OvnDbAdapter
 * stores entries in its `dlq` collection). With this in place, DLQ
 * entries survive a process restart even when the queue is configured
 * with `useNativeWAL: true` (no flat-file WAL to replay).
 */
export interface IDLQStore {
    add(jobId: string, entry: {
        job: Job<JobPayload>;
        errorName: string;
        errorMessage: string;
        capturedAt: number;
    }): Promise<void>;
    remove(jobId: string): Promise<void>;
    list(): Promise<Array<{
        job: Job<JobPayload>;
        errorName: string;
        errorMessage: string;
        capturedAt: number;
    }>>;
}
/**
 * DeadLetterQueue plugin — captures permanently failed jobs.
 * Provides inspect/retry/purge API.
 *
 * @example
 * const dlq = new DeadLetterQueue();
 * queue.on('dead-letter', ({ job, error }) => console.log(job.id, error));
 * queue.dlq.list()           // all DLQ entries
 * queue.dlq.retry(jobId)     // re-enqueue a job from DLQ
 */
export declare class DeadLetterQueue implements IPlugin {
    readonly name = "DeadLetterQueue";
    private readonly entries;
    private enqueueCallback?;
    private wal;
    private store;
    /** Called by JobQueue to wire up re-enqueue capability */
    setEnqueueCallback(cb: (job: Job<JobPayload>) => Promise<void>): void;
    setWAL(wal: WALWriter): void;
    /**
     * Wire an external durable store (typically the OvnDb adapter's
     * `dlq` collection). When present, DLQ writes go through both the
     * in-memory Map and the store so entries survive restart without
     * relying on the flat-file WAL.
     */
    setStore(store: IDLQStore): void;
    onFail<T extends JobPayload>(job: Job<T>, error: Error): void;
    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void;
    /** Return all DLQ entries */
    list(): DLQEntry[];
    /** Get a specific DLQ entry */
    get(jobId: string): DLQEntry | undefined;
    /** Number of jobs in DLQ */
    get size(): number;
    /**
     * Re-enqueue a job from the DLQ with reset attempts.
     * @throws Error if jobId not found in DLQ
     */
    retry(jobId: string): Promise<void>;
    /** Retry all jobs currently in the DLQ */
    retryAll(): Promise<void>;
    /**
     * Remove DLQ entries older than the given timestamp (ms since epoch).
     * @param olderThan - Entries captured before this time are removed
     */
    purge(olderThan: number): number;
    /**
     * Restore DLQ entries from an external store (e.g. OvnDb `dlq` collection)
     * after a process restart. Use this when running with `useNativeWAL: true`
     * — the flat-file WAL is empty so {@link restoreFromWAL} is a no-op.
     */
    restoreFromStore(): Promise<void>;
    /**
     * Restore DLQ entries from WAL replay after crash recovery.
     * Call this after Recovery.run() during queue initialization.
     */
    restoreFromWAL(entries: WALEntry[]): void;
}
