import type { QueueConfig, ResolvedQueueConfig, WorkerConfig, PersistenceConfig } from '../types/queue.types.js';
import { MemoryAdapter } from '../adapters/MemoryAdapter.js';

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
    min: 1,
    max: 10,
    scaleUpThreshold: 5,
    scaleDownThreshold: 2,
    scaleUpStep: 2,
    monitorIntervalMs: 1_000,
};

export const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig = {
    walPath: './wa-queue.wal',
    snapshotPath: './wa-queue.snapshot.json',
    snapshotIntervalMs: 60_000,
    enabled: false,
    // dbPath / useNativeWAL — opt-in for OvnDbAdapter; left undefined by default
};

/**
 * Resolve user-supplied QueueConfig with defaults.
 */
export function resolveConfig(config: QueueConfig): ResolvedQueueConfig {
    return {
        name: config.name,
        adapter: config.adapter ?? new MemoryAdapter(),
        workers: {
            ...DEFAULT_WORKER_CONFIG,
            ...config.workers,
        },
        persistence: {
            ...DEFAULT_PERSISTENCE_CONFIG,
            ...config.persistence,
        },
        plugins: config.plugins ?? [],
        defaultPriority: config.defaultPriority ?? 5,
        defaultMaxAttempts: config.defaultMaxAttempts ?? 3,
        defaultMaxDuration: config.defaultMaxDuration ?? 30_000,
        maxQueueSize: config.maxQueueSize,
    };
}
