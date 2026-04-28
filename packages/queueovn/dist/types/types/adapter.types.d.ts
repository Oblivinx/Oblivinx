import type { Job, JobPayload } from './job.types.js';
/** Interface that all storage adapters must implement */
export interface IStorageAdapter {
    /**
     * Add a job to the store
     */
    push<T extends JobPayload>(job: Job<T>): Promise<void>;
    /**
     * Get AND remove the highest-priority ready job (runAt <= now, state=pending)
     */
    pop<T extends JobPayload>(): Promise<Job<T> | null>;
    /**
     * Peek at the highest-priority ready job without removing it
     */
    peek<T extends JobPayload>(): Promise<Job<T> | null>;
    /**
     * Get a job by id (any state)
     */
    get<T extends JobPayload>(id: string): Promise<Job<T> | null>;
    /**
     * Update a job in the store (upsert semantics)
     */
    update<T extends JobPayload>(job: Job<T>): Promise<void>;
    /**
     * Remove a job completely from the store
     */
    remove(id: string): Promise<void>;
    /**
     * Number of jobs in PENDING state with runAt <= now
     */
    size(): Promise<number>;
    /**
     * Retrieve ALL jobs (any state) — used by crash recovery
     */
    getAll<T extends JobPayload>(): Promise<Job<T>[]>;
    /**
     * Drop all jobs
     */
    clear(): Promise<void>;
    /**
     * Cleanup and close any underlying resources
     */
    close(): Promise<void>;
    /**
     * Bulk push optimization (optional). Adapters that can batch their
     * underlying writes implement this so {@link JobQueue.enqueueBatch}
     * gets a single round-trip per chunk instead of N round-trips.
     *
     * Backward-compatible: queue falls back to looped {@link push} when
     * an adapter does not implement it.
     */
    pushMany?<T extends JobPayload>(jobs: Job<T>[]): Promise<void>;
    /**
     * Bulk remove optimization (optional). Used by future cleanup paths.
     */
    removeMany?(ids: string[]): Promise<void>;
}
