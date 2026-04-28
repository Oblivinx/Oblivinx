import type { QueueConfig, ResolvedQueueConfig, WorkerConfig, PersistenceConfig } from '../types/queue.types.js';
export declare const DEFAULT_WORKER_CONFIG: WorkerConfig;
export declare const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig;
/**
 * Resolve user-supplied QueueConfig with defaults.
 */
export declare function resolveConfig(config: QueueConfig): ResolvedQueueConfig;
