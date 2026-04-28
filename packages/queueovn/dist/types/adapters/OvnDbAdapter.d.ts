import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
interface OvnDbAdapterOptions {
    /** Path to the Oblivinx3x database file (typically `q.ovn`) */
    path: string;
    /** Compression algorithm passed through to Oblivinx3x. Default: 'lz4'. */
    compression?: 'lz4' | 'zstd' | 'none';
    /** Buffer pool size for the engine. Default: '64MB'. */
    bufferPool?: string;
    /** Durability level — 'fast' for D0 bulk, 'safe' for group_commit. */
    durability?: 'fast' | 'safe' | 'group_commit';
    /** Group-commit threshold in bytes for the WAL. Default: 512KB. */
    walGroupCommitBytes?: number;
}
/**
 * OvnDbAdapter — persistent adapter backed by Oblivinx3x with full ACID guarantees.
 *
 * Compatible with oblivinx3x ^0.0.5 (Nova).
 *
 * Highlights:
 * - Upsert via updateOne → insertOne fallback (race-safe with retry)
 * - Optimistic CAS in pop() — race-free multi-worker operation
 * - Partial index on PENDING/RETRYING — faster pop() scans
 * - TTL index on expiresAt — automatic job expiry without manual cleanup
 * - Aggregation-based stats() — real-time state distribution
 * - Reactive push notification via setOnNewJob() — workers wake immediately
 *
 * @example
 * const adapter = new OvnDbAdapter({ path: './jobs.ovn' });
 * await adapter.initialize();
 * adapter.setOnNewJob(() => triggerProcess());
 */
export declare class OvnDbAdapter implements IStorageAdapter {
    /**
     * Marker read by {@link JobQueue} during construction. When `true`,
     * the queue skips its own flat-file WAL/Snapshot/Recovery and lets
     * the underlying Oblivinx3x engine handle durability + recovery.
     *
     * `OvnDbAdapter` always opts in because the .ovn file already
     * contains its own WAL with group-commit and the recovery state
     * machine recovers transparently when the file is reopened.
     */
    readonly usesNativeWAL = true;
    private readonly dbPath;
    private readonly options;
    private db;
    private collection;
    private dlqCollection;
    private onNewJobFn?;
    constructor(options: OvnDbAdapterOptions);
    /** Internal: expose underlying Oblivinx3x handle for advanced callers
     *  (BackupManager, recovery checkpoint tooling). Returns null until
     *  {@link initialize} has been called. */
    getEngineHandle(): unknown;
    /**
     * Read the queue's recovery checkpoint from the engine's internal
     * `_system` collection. Returns `null` if the queue has never
     * checkpointed before. Cross-platform — no temp files involved.
     */
    getRecoveryCheckpoint(): Promise<{
        lastCommittedTxid: number;
        timestampMs: number;
    } | null>;
    /**
     * Persist a recovery checkpoint inside the .ovn file. The engine
     * issues a checkpoint as a side-effect so the WAL is flushed before
     * this returns.
     */
    setRecoveryCheckpoint(cp: {
        lastCommittedTxid: number;
        timestampMs?: number;
        collectionStates?: Record<string, unknown>;
    }): Promise<void>;
    /**
     * Return a durable DLQ store backed by the `dlq` collection. Wired
     * by JobQueue into the {@link DeadLetterQueue} plugin so DLQ entries
     * survive a process restart even when the queue runs with
     * `useNativeWAL: true` (no flat-file WAL).
     */
    getDLQStore(): {
        add(jobId: string, entry: {
            job: any;
            errorName: string;
            errorMessage: string;
            capturedAt: number;
        }): Promise<void>;
        remove(jobId: string): Promise<void>;
        list(): Promise<Array<{
            job: any;
            errorName: string;
            errorMessage: string;
            capturedAt: number;
        }>>;
    };
    /**
     * Register callback invoked on every push() so idle workers wake immediately
     * instead of waiting for the next poll cycle.
     */
    setOnNewJob(cb: () => void): void;
    /**
     * Initialize the database and create all necessary indexes.
     * Must be called before any other method.
     */
    initialize(): Promise<void>;
    /**
     * Idempotent index setup. Errors that say "already exists" are
     * downgraded to debug — they happen on every restart since the
     * indexes are persisted inside the `.ovn` file.
     */
    private ensureIndexes;
    /**
     * Add or re-add a job (upsert semantics).
     *
     * Strategy: update existing first (O(1) via _id index), then insert if not found.
     * A concurrent-insert race is handled by retrying the update on duplicate-key error.
     */
    push<T extends JobPayload>(job: Job<T>): Promise<void>;
    /**
     * Claim the highest-priority ready job atomically via optimistic CAS.
     *
     * Fetches up to 5 candidates so that if a concurrent worker claims the
     * top job first, we fall back to the next candidate instead of returning null.
     */
    pop<T extends JobPayload>(): Promise<Job<T> | null>;
    peek<T extends JobPayload>(): Promise<Job<T> | null>;
    get<T extends JobPayload>(id: string): Promise<Job<T> | null>;
    update<T extends JobPayload>(job: Job<T>): Promise<void>;
    remove(id: string): Promise<void>;
    /**
     * Bulk push — single round-trip per chunk via Oblivinx3x's
     * native `insertMany`. Falls back to per-doc upsert when the SDK
     * predates the bulk API. Ordered=false keeps throughput high by
     * skipping the stop-on-first-error semantics.
     */
    pushMany<T extends JobPayload>(jobs: Job<T>[]): Promise<void>;
    /**
     * Bulk remove — single deleteMany round-trip when supported,
     * otherwise per-id deleteOne (used by retention/cleanup paths).
     */
    removeMany(ids: string[]): Promise<void>;
    size(): Promise<number>;
    getAll<T extends JobPayload>(): Promise<Job<T>[]>;
    clear(): Promise<void>;
    close(): Promise<void>;
    /**
     * Returns job count grouped by state using an aggregation pipeline.
     * Useful for monitoring dashboards and health checks.
     *
     * @example
     * const s = await adapter.stats();
     * // { pending: 5, active: 2, retrying: 1, done: 100, failed: 3 }
     */
    stats(): Promise<Record<string, number>>;
    private checkInit;
}
export {};
