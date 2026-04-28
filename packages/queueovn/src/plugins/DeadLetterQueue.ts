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
    add(jobId: string, entry: { job: Job<JobPayload>; errorName: string; errorMessage: string; capturedAt: number }): Promise<void>;
    remove(jobId: string): Promise<void>;
    list(): Promise<Array<{ job: Job<JobPayload>; errorName: string; errorMessage: string; capturedAt: number }>>;
}

// feat: serialized form of DLQEntry for WAL persistence
interface SerializedDLQEntry {
    job: Job<JobPayload>;
    errorMessage: string;
    errorName: string;
    capturedAt: number;
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
export class DeadLetterQueue implements IPlugin {
    readonly name = 'DeadLetterQueue';
    private readonly entries = new Map<string, DLQEntry>();
    private enqueueCallback?: (job: Job<JobPayload>) => Promise<void>;
    // feat: WAL reference for persisting DLQ entries across restarts
    private wal: WALWriter | null = null;
    // feat: alternate durable store (e.g. OvnDb dlq collection). Used
    //       when JobQueue runs in native-WAL mode and `wal` is null.
    private store: IDLQStore | null = null;

    /** Called by JobQueue to wire up re-enqueue capability */
    setEnqueueCallback(cb: (job: Job<JobPayload>) => Promise<void>): void {
        this.enqueueCallback = cb;
    }

    // feat: called by JobQueue to wire up WAL persistence
    setWAL(wal: WALWriter): void {
        this.wal = wal;
    }

    /**
     * Wire an external durable store (typically the OvnDb adapter's
     * `dlq` collection). When present, DLQ writes go through both the
     * in-memory Map and the store so entries survive restart without
     * relying on the flat-file WAL.
     */
    setStore(store: IDLQStore): void {
        this.store = store;
    }

    onFail<T extends JobPayload>(job: Job<T>, error: Error): void {
        const capturedAt = Date.now();
        const serialized: SerializedDLQEntry = {
            job: job as Job<JobPayload>,
            errorMessage: error.message,
            errorName: error.name,
            capturedAt,
        };
        this.entries.set(job.id, {
            job: job as Job<JobPayload>,
            error,
            capturedAt,
        });
        // feat: persist DLQ entry so it survives crashes — flat-file WAL
        //       and/or external store (OvnDb dlq collection).
        this.wal?.append('DLQ_ADD', job.id, serialized);
        this.store?.add(job.id, serialized).catch(() => { /* swallow — log path is the WAL */ });
    }

    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void {
        // If job was retried from DLQ and now succeeded, remove from DLQ
        if (this.entries.has(job.id)) {
            this.entries.delete(job.id);
            // feat: persist DLQ removal on retry success
            this.wal?.append('DLQ_REMOVE', job.id);
            this.store?.remove(job.id).catch(() => null);
        }
    }

    /** Return all DLQ entries */
    list(): DLQEntry[] {
        return Array.from(this.entries.values());
    }

    /** Get a specific DLQ entry */
    get(jobId: string): DLQEntry | undefined {
        return this.entries.get(jobId);
    }

    /** Number of jobs in DLQ */
    get size(): number {
        return this.entries.size;
    }

    /**
     * Re-enqueue a job from the DLQ with reset attempts.
     * @throws Error if jobId not found in DLQ
     */
    async retry(jobId: string): Promise<void> {
        const entry = this.entries.get(jobId);
        if (!entry) throw new Error(`Job "${jobId}" not found in Dead Letter Queue`);
        if (!this.enqueueCallback) throw new Error('DLQ not connected to queue (no enqueue callback)');
        this.entries.delete(jobId);
        // feat: persist DLQ removal on retry
        this.wal?.append('DLQ_REMOVE', jobId);
        await this.store?.remove(jobId).catch(() => null);
        const resetJob = { ...entry.job, attempts: 0, state: 'pending' as const };
        await this.enqueueCallback(resetJob as Job<JobPayload>);
    }

    /** Retry all jobs currently in the DLQ */
    async retryAll(): Promise<void> {
        const ids = Array.from(this.entries.keys());
        for (const id of ids) {
            await this.retry(id);
        }
    }

    /**
     * Remove DLQ entries older than the given timestamp (ms since epoch).
     * @param olderThan - Entries captured before this time are removed
     */
    purge(olderThan: number): number {
        let removed = 0;
        for (const [id, entry] of this.entries) {
            if (entry.capturedAt < olderThan) {
                this.entries.delete(id);
                // feat: persist purge removals
                this.wal?.append('DLQ_REMOVE', id);
                this.store?.remove(id).catch(() => null);
                removed++;
            }
        }
        return removed;
    }

    /**
     * Restore DLQ entries from an external store (e.g. OvnDb `dlq` collection)
     * after a process restart. Use this when running with `useNativeWAL: true`
     * — the flat-file WAL is empty so {@link restoreFromWAL} is a no-op.
     */
    async restoreFromStore(): Promise<void> {
        if (!this.store) return;
        const persisted = await this.store.list();
        for (const e of persisted) {
            if (!e.job) continue;
            const error = Object.assign(new Error(e.errorMessage ?? ''), {
                name: e.errorName ?? 'Error',
            });
            this.entries.set(e.job.id, {
                job: e.job,
                error,
                capturedAt: e.capturedAt ?? Date.now(),
            });
        }
    }

    /**
     * Restore DLQ entries from WAL replay after crash recovery.
     * Call this after Recovery.run() during queue initialization.
     */
    // feat: WAL replay to rebuild entries map after process restart
    restoreFromWAL(entries: WALEntry[]): void {
        for (const entry of entries) {
            if (entry.op === 'DLQ_ADD') {
                const data = entry.data as SerializedDLQEntry;
                if (data?.job) {
                    // fix: reconstruct Error object from serialized name+message
                    const error = Object.assign(new Error(data.errorMessage ?? ''), {
                        name: data.errorName ?? 'Error',
                    });
                    this.entries.set(entry.jobId, {
                        job: data.job,
                        error,
                        capturedAt: data.capturedAt ?? Date.now(),
                    });
                }
            } else if (entry.op === 'DLQ_REMOVE') {
                this.entries.delete(entry.jobId);
            }
        }
    }
}
