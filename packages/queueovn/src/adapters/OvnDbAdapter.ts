import type { IStorageAdapter } from '../types/adapter.types.js';
import type { Job, JobPayload } from '../types/job.types.js';
import { AdapterError } from '../errors/AdapterError.js';

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
 * Strip non-serializable fields and map `id` → `_id` before storing.
 * retryPolicy is a function — not serializable, must be excluded.
 */
function toDoc<T extends JobPayload>(job: Job<T>): Record<string, unknown> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, retryPolicy, ...rest } = job as any;
    return { _id: id as string, ...rest };
}

/**
 * Reconstruct a Job from a DB document, mapping `_id` → `id`.
 * Handles both old documents (that stored `id` as a field) and new ones (that don't).
 */
function fromDoc<T extends JobPayload>(doc: Record<string, unknown>): Job<T> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, id: _ignored, ...rest } = doc as any;
    return { id: _id as string, ...rest } as Job<T>;
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
export class OvnDbAdapter implements IStorageAdapter {
    /**
     * Marker read by {@link JobQueue} during construction. When `true`,
     * the queue skips its own flat-file WAL/Snapshot/Recovery and lets
     * the underlying Oblivinx3x engine handle durability + recovery.
     *
     * `OvnDbAdapter` always opts in because the .ovn file already
     * contains its own WAL with group-commit and the recovery state
     * machine recovers transparently when the file is reopened.
     */
    public readonly usesNativeWAL = true;

    private readonly dbPath: string;
    private readonly options: OvnDbAdapterOptions;
    private db: any = null;
    private collection: any = null;
    private dlqCollection: any = null;
    private onNewJobFn?: () => void;

    constructor(options: OvnDbAdapterOptions) {
        this.dbPath = options.path;
        this.options = options;
    }

    /** Internal: expose underlying Oblivinx3x handle for advanced callers
     *  (BackupManager, recovery checkpoint tooling). Returns null until
     *  {@link initialize} has been called. */
    getEngineHandle(): unknown {
        return this.db;
    }

    /**
     * Read the queue's recovery checkpoint from the engine's internal
     * `_system` collection. Returns `null` if the queue has never
     * checkpointed before. Cross-platform — no temp files involved.
     */
    async getRecoveryCheckpoint(): Promise<{
        lastCommittedTxid: number;
        timestampMs: number;
    } | null> {
        this.checkInit();
        if (typeof this.db.getRecoveryCheckpoint !== 'function') return null;
        return this.db.getRecoveryCheckpoint();
    }

    /**
     * Persist a recovery checkpoint inside the .ovn file. The engine
     * issues a checkpoint as a side-effect so the WAL is flushed before
     * this returns.
     */
    async setRecoveryCheckpoint(cp: {
        lastCommittedTxid: number;
        timestampMs?: number;
        collectionStates?: Record<string, unknown>;
    }): Promise<void> {
        this.checkInit();
        if (typeof this.db.setRecoveryCheckpoint !== 'function') return;
        await this.db.setRecoveryCheckpoint({
            lastCommittedTxid: cp.lastCommittedTxid,
            timestampMs: cp.timestampMs ?? Date.now(),
            collectionStates: cp.collectionStates ?? {},
        });
    }

    /**
     * Return a durable DLQ store backed by the `dlq` collection. Wired
     * by JobQueue into the {@link DeadLetterQueue} plugin so DLQ entries
     * survive a process restart even when the queue runs with
     * `useNativeWAL: true` (no flat-file WAL).
     */
    getDLQStore(): {
        add(jobId: string, entry: { job: any; errorName: string; errorMessage: string; capturedAt: number }): Promise<void>;
        remove(jobId: string): Promise<void>;
        list(): Promise<Array<{ job: any; errorName: string; errorMessage: string; capturedAt: number }>>;
    } {
        const col = () => {
            this.checkInit();
            return this.dlqCollection;
        };
        return {
            add: async (jobId, entry) => {
                const c = col();
                const doc = { _id: jobId, ...entry, failedAt: entry.capturedAt };
                const { modifiedCount } = await c.updateOne({ _id: jobId }, { $set: doc });
                if (modifiedCount === 0) {
                    try { await c.insertOne(doc); }
                    catch { await c.updateOne({ _id: jobId }, { $set: doc }); }
                }
            },
            remove: async (jobId) => {
                await col().deleteOne({ _id: jobId });
            },
            list: async () => {
                const docs = (await col().find({}, { sort: { failedAt: -1 } })) as any[];
                return docs.map((d: any) => ({
                    job: d.job,
                    errorName: d.errorName,
                    errorMessage: d.errorMessage,
                    capturedAt: d.capturedAt,
                }));
            },
        };
    }

    /**
     * Register callback invoked on every push() so idle workers wake immediately
     * instead of waiting for the next poll cycle.
     */
    setOnNewJob(cb: () => void): void {
        this.onNewJobFn = cb;
    }

    /**
     * Initialize the database and create all necessary indexes.
     * Must be called before any other method.
     */
    async initialize(): Promise<void> {
        let OvnClass: any;
        try {
            const mod = await import('oblivinx3x' as string) as any;
            OvnClass = mod.Oblivinx3x ?? mod.Database ?? mod.default;
            if (typeof OvnClass !== 'function') {
                throw new Error('No valid database class found in oblivinx3x module');
            }
        } catch (err: any) {
            throw new AdapterError(
                'OvnDbAdapter requires "oblivinx3x" to be installed. Run: npm install oblivinx3x',
                err,
            );
        }

        // Pass through richer engine options when supported by the SDK.
        // Older oblivinx3x builds ignore unknown keys, so this is safe.
        const dbOptions: Record<string, unknown> = {};
        if (this.options.compression) dbOptions.compression = this.options.compression;
        if (this.options.bufferPool) dbOptions.bufferPool = this.options.bufferPool;
        if (this.options.durability) dbOptions.durability = this.options.durability;
        if (this.options.walGroupCommitBytes) {
            dbOptions.walGroupCommitBytes = this.options.walGroupCommitBytes;
        }
        this.db = Object.keys(dbOptions).length > 0
            ? new OvnClass(this.dbPath, dbOptions)
            : new OvnClass(this.dbPath);

        this.collection = this.db.collection('jobs');
        // Dead-letter queue collection — populated by JobQueue when a job
        // exceeds maxAttempts. Lives in the same .ovn file so backups,
        // recovery, and snapshots cover both queues atomically.
        this.dlqCollection = this.db.collection('dlq');

        await this.ensureIndexes();
    }

    /**
     * Idempotent index setup. Errors that say "already exists" are
     * downgraded to debug — they happen on every restart since the
     * indexes are persisted inside the `.ovn` file.
     */
    private async ensureIndexes(): Promise<void> {
        const tryCreate = async (
            col: any,
            fields: Record<string, 1 | -1>,
            options: Record<string, unknown> = {},
        ): Promise<void> => {
            try {
                await col.createIndex(fields, { background: true, ...options });
            } catch (err: any) {
                const msg = String(err?.message || '').toLowerCase();
                if (msg.includes('already exists') || err?.code === 85 || err?.code === 86) return;
                throw err;
            }
        };

        // 1. Composite index: primary query path for pop() and size()
        await tryCreate(this.collection,
            { state: 1, runAt: 1, priority: 1, createdAt: 1 },
        );

        // 2. Partial index: only covers PENDING+RETRYING docs → faster pop() when queue is busy
        await tryCreate(this.collection,
            { runAt: 1, priority: 1, createdAt: 1 },
            { partialFilterExpression: { state: { $in: ['pending', 'retrying'] } } },
        );

        // 3. TTL index: Oblivinx3x auto-deletes docs whose expiresAt has passed.
        await tryCreate(this.collection,
            { expiresAt: 1 },
            { expireAfterSeconds: 0, sparse: true },
        );

        // DLQ indexes — keep DLQ queryable by failure time.
        await tryCreate(this.dlqCollection, { failedAt: -1 });
        await tryCreate(this.dlqCollection, { type: 1, failedAt: -1 });
    }

    /**
     * Add or re-add a job (upsert semantics).
     *
     * Strategy: update existing first (O(1) via _id index), then insert if not found.
     * A concurrent-insert race is handled by retrying the update on duplicate-key error.
     */
    async push<T extends JobPayload>(job: Job<T>): Promise<void> {
        this.checkInit();
        const doc = toDoc(job);
        const id = doc._id as string;

        // Fast path: update existing document (retries, re-queues from scheduler, etc.)
        const { modifiedCount } = await this.collection.updateOne(
            { _id: id },
            { $set: doc },
        );

        if (modifiedCount === 0) {
            // Slow path: new job — insert it
            try {
                await this.collection.insertOne(doc);
            } catch {
                // Concurrent insert race (extremely rare in single-process usage).
                // Another call inserted it between our updateOne and insertOne — just update.
                await this.collection.updateOne({ _id: id }, { $set: doc });
            }
        }

        // Wake idle process loop immediately — avoids polling latency after a push
        this.onNewJobFn?.();
    }

    /**
     * Claim the highest-priority ready job atomically via optimistic CAS.
     *
     * Fetches up to 5 candidates so that if a concurrent worker claims the
     * top job first, we fall back to the next candidate instead of returning null.
     */
    async pop<T extends JobPayload>(): Promise<Job<T> | null> {
        this.checkInit();
        const now = Date.now();

        // Fetch top 5 candidates (tolerates concurrent races)
        const docs = await this.collection.find(
            {
                state: { $in: ['pending', 'retrying'] },
                runAt: { $lte: now },
            },
            { sort: { priority: 1, runAt: 1, createdAt: 1 }, limit: 5 },
        ) as any[];

        for (const doc of docs) {
            // Optimistic CAS: filter includes state check so modifiedCount=0 means
            // a concurrent worker already claimed this job — try the next candidate.
            const result = await this.collection.updateOne(
                { _id: doc._id, state: { $in: ['pending', 'retrying'] } },
                { $set: { state: 'active', startedAt: now } },
            );
            if (result.modifiedCount > 0) {
                return { ...fromDoc<T>(doc), state: 'active' as any, startedAt: now };
            }
        }
        return null;
    }

    async peek<T extends JobPayload>(): Promise<Job<T> | null> {
        this.checkInit();
        const docs = await this.collection.find(
            {
                state: { $in: ['pending', 'retrying'] },
                runAt: { $lte: Date.now() },
            },
            { sort: { priority: 1, runAt: 1, createdAt: 1 }, limit: 1 },
        ) as any[];
        if (docs.length === 0) return null;
        return fromDoc<T>(docs[0]);
    }

    async get<T extends JobPayload>(id: string): Promise<Job<T> | null> {
        this.checkInit();
        const doc = await this.collection.findOne({ _id: id });
        if (!doc) return null;
        return fromDoc<T>(doc);
    }

    async update<T extends JobPayload>(job: Job<T>): Promise<void> {
        this.checkInit();
        const doc = toDoc(job);
        await this.collection.updateOne({ _id: doc._id }, { $set: doc });
    }

    async remove(id: string): Promise<void> {
        this.checkInit();
        await this.collection.deleteOne({ _id: id });
    }

    /**
     * Bulk push — single round-trip per chunk via Oblivinx3x's
     * native `insertMany`. Falls back to per-doc upsert when the SDK
     * predates the bulk API. Ordered=false keeps throughput high by
     * skipping the stop-on-first-error semantics.
     */
    async pushMany<T extends JobPayload>(jobs: Job<T>[]): Promise<void> {
        this.checkInit();
        if (jobs.length === 0) return;
        const docs = jobs.map((j) => toDoc(j));

        if (typeof this.collection.insertMany === 'function') {
            try {
                await this.collection.insertMany(docs, {
                    ordered: false,
                    chunkSize: 5000,
                });
                this.onNewJobFn?.();
                return;
            } catch (err: any) {
                // If the bulk insert hit duplicates (job already exists from
                // an earlier enqueue), fall through to the upsert loop so
                // the existing rows get refreshed instead of dropped.
                const msg = String(err?.message || '').toLowerCase();
                if (!msg.includes('duplicate') && !msg.includes('unique')) {
                    throw err;
                }
            }
        }

        // Fallback path — per-doc upsert. Still fewer round-trips than
        // looping push() because we skip the changefeed wakeup until the
        // batch finishes.
        for (const doc of docs) {
            const id = doc._id as string;
            const { modifiedCount } = await this.collection.updateOne(
                { _id: id },
                { $set: doc },
            );
            if (modifiedCount === 0) {
                try {
                    await this.collection.insertOne(doc);
                } catch {
                    await this.collection.updateOne({ _id: id }, { $set: doc });
                }
            }
        }
        this.onNewJobFn?.();
    }

    /**
     * Bulk remove — single deleteMany round-trip when supported,
     * otherwise per-id deleteOne (used by retention/cleanup paths).
     */
    async removeMany(ids: string[]): Promise<void> {
        this.checkInit();
        if (ids.length === 0) return;
        if (typeof this.collection.deleteMany === 'function') {
            await this.collection.deleteMany({ _id: { $in: ids } });
            return;
        }
        for (const id of ids) {
            await this.collection.deleteOne({ _id: id });
        }
    }

    async size(): Promise<number> {
        this.checkInit();
        return this.collection.countDocuments({
            state: { $in: ['pending', 'retrying'] },
            runAt: { $lte: Date.now() },
        });
    }

    async getAll<T extends JobPayload>(): Promise<Job<T>[]> {
        this.checkInit();
        const docs = await this.collection.find({}) as any[];
        return docs.map((doc: any) => fromDoc<T>(doc));
    }

    async clear(): Promise<void> {
        this.checkInit();
        await this.collection.deleteMany({});
    }

    async close(): Promise<void> {
        if (this.db) {
            await this.db.close();
            this.db = null;
            this.collection = null;
        }
    }

    /**
     * Returns job count grouped by state using an aggregation pipeline.
     * Useful for monitoring dashboards and health checks.
     *
     * @example
     * const s = await adapter.stats();
     * // { pending: 5, active: 2, retrying: 1, done: 100, failed: 3 }
     */
    async stats(): Promise<Record<string, number>> {
        this.checkInit();
        const results = await this.collection.aggregate([
            { $group: { _id: '$state', count: { $sum: 1 } } },
        ]) as any[];
        return Object.fromEntries(
            results.map((r: any) => [r._id ?? 'unknown', r.count as number]),
        );
    }

    private checkInit(): void {
        if (!this.db || !this.collection) {
            throw new AdapterError('OvnDbAdapter not initialized. Call initialize() first.');
        }
    }
}
