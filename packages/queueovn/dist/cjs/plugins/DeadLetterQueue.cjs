"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeadLetterQueue = void 0;
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
class DeadLetterQueue {
    name = 'DeadLetterQueue';
    entries = new Map();
    enqueueCallback;
    // feat: WAL reference for persisting DLQ entries across restarts
    wal = null;
    // feat: alternate durable store (e.g. OvnDb dlq collection). Used
    //       when JobQueue runs in native-WAL mode and `wal` is null.
    store = null;
    /** Called by JobQueue to wire up re-enqueue capability */
    setEnqueueCallback(cb) {
        this.enqueueCallback = cb;
    }
    // feat: called by JobQueue to wire up WAL persistence
    setWAL(wal) {
        this.wal = wal;
    }
    /**
     * Wire an external durable store (typically the OvnDb adapter's
     * `dlq` collection). When present, DLQ writes go through both the
     * in-memory Map and the store so entries survive restart without
     * relying on the flat-file WAL.
     */
    setStore(store) {
        this.store = store;
    }
    onFail(job, error) {
        const capturedAt = Date.now();
        const serialized = {
            job: job,
            errorMessage: error.message,
            errorName: error.name,
            capturedAt,
        };
        this.entries.set(job.id, {
            job: job,
            error,
            capturedAt,
        });
        // feat: persist DLQ entry so it survives crashes — flat-file WAL
        //       and/or external store (OvnDb dlq collection).
        this.wal?.append('DLQ_ADD', job.id, serialized);
        this.store?.add(job.id, serialized).catch(() => { });
    }
    onComplete(job, _result) {
        // If job was retried from DLQ and now succeeded, remove from DLQ
        if (this.entries.has(job.id)) {
            this.entries.delete(job.id);
            // feat: persist DLQ removal on retry success
            this.wal?.append('DLQ_REMOVE', job.id);
            this.store?.remove(job.id).catch(() => null);
        }
    }
    /** Return all DLQ entries */
    list() {
        return Array.from(this.entries.values());
    }
    /** Get a specific DLQ entry */
    get(jobId) {
        return this.entries.get(jobId);
    }
    /** Number of jobs in DLQ */
    get size() {
        return this.entries.size;
    }
    /**
     * Re-enqueue a job from the DLQ with reset attempts.
     * @throws Error if jobId not found in DLQ
     */
    async retry(jobId) {
        const entry = this.entries.get(jobId);
        if (!entry)
            throw new Error(`Job "${jobId}" not found in Dead Letter Queue`);
        if (!this.enqueueCallback)
            throw new Error('DLQ not connected to queue (no enqueue callback)');
        this.entries.delete(jobId);
        // feat: persist DLQ removal on retry
        this.wal?.append('DLQ_REMOVE', jobId);
        await this.store?.remove(jobId).catch(() => null);
        const resetJob = { ...entry.job, attempts: 0, state: 'pending' };
        await this.enqueueCallback(resetJob);
    }
    /** Retry all jobs currently in the DLQ */
    async retryAll() {
        const ids = Array.from(this.entries.keys());
        for (const id of ids) {
            await this.retry(id);
        }
    }
    /**
     * Remove DLQ entries older than the given timestamp (ms since epoch).
     * @param olderThan - Entries captured before this time are removed
     */
    purge(olderThan) {
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
    async restoreFromStore() {
        if (!this.store)
            return;
        const persisted = await this.store.list();
        for (const e of persisted) {
            if (!e.job)
                continue;
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
    restoreFromWAL(entries) {
        for (const entry of entries) {
            if (entry.op === 'DLQ_ADD') {
                const data = entry.data;
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
            }
            else if (entry.op === 'DLQ_REMOVE') {
                this.entries.delete(entry.jobId);
            }
        }
    }
}
exports.DeadLetterQueue = DeadLetterQueue;
