import type { IPlugin } from './plugin.types.js';
import type { IStorageAdapter } from './adapter.types.js';

/** Configuration for the worker auto-scaling pool */
export interface WorkerConfig {
    min: number;
    max: number;
    scaleUpThreshold: number;
    scaleDownThreshold: number;
    scaleUpStep: number;
    monitorIntervalMs: number;
}

/** Persistence / crash recovery configuration */
export interface PersistenceConfig {
    walPath: string;
    snapshotPath: string;
    snapshotIntervalMs: number;
    enabled: boolean;
    /**
     * Path to the dedicated Oblivinx3x database file (typically `q.ovn`)
     * when using `OvnDbAdapter`. When set, the queue delegates WAL,
     * snapshot, and recovery to the Oblivinx3x engine and skips its
     * own flat-file WAL/Snapshot/Recovery instances.
     *
     * Cross-platform: works on both Windows and Ubuntu since there is
     * no temp-file + rename on a separate filesystem.
     */
    dbPath?: string;
    /**
     * Skip the queue's own flat-file WAL/Snapshot/Recovery and rely
     * entirely on the storage adapter's native durability.
     * Set this when {@link PersistenceConfig.dbPath} is configured.
     */
    useNativeWAL?: boolean;
}

/** Full queue configuration */
export interface QueueConfig {
    name: string;
    adapter?: IStorageAdapter;
    workers?: Partial<WorkerConfig>;
    persistence?: Partial<PersistenceConfig>;
    plugins?: IPlugin[];
    defaultPriority?: number;
    defaultMaxAttempts?: number;
    defaultMaxDuration?: number;
    maxQueueSize?: number;
}

/** Resolved (filled-with-defaults) queue configuration */
export interface ResolvedQueueConfig {
    name: string;
    adapter: IStorageAdapter;
    workers: WorkerConfig;
    persistence: PersistenceConfig;
    plugins: IPlugin[];
    defaultPriority: number;
    defaultMaxAttempts: number;
    defaultMaxDuration: number;
    maxQueueSize?: number;
}

/** Metrics snapshot returned by queue.metrics.snapshot() */
export interface MetricsSnapshot {
    processed: number;
    failed: number;
    retried: number;
    expired: number;
    depth: number;
    avgLatencyMs: number;
    activeWorkers: number;
}
