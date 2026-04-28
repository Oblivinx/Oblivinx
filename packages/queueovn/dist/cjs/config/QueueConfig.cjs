"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PERSISTENCE_CONFIG = exports.DEFAULT_WORKER_CONFIG = void 0;
exports.resolveConfig = resolveConfig;
const MemoryAdapter_js_1 = require("../adapters/MemoryAdapter.cjs");
exports.DEFAULT_WORKER_CONFIG = {
    min: 1,
    max: 10,
    scaleUpThreshold: 5,
    scaleDownThreshold: 2,
    scaleUpStep: 2,
    monitorIntervalMs: 1_000,
};
exports.DEFAULT_PERSISTENCE_CONFIG = {
    walPath: './wa-queue.wal',
    snapshotPath: './wa-queue.snapshot.json',
    snapshotIntervalMs: 60_000,
    enabled: false,
    // dbPath / useNativeWAL — opt-in for OvnDbAdapter; left undefined by default
};
/**
 * Resolve user-supplied QueueConfig with defaults.
 */
function resolveConfig(config) {
    return {
        name: config.name,
        adapter: config.adapter ?? new MemoryAdapter_js_1.MemoryAdapter(),
        workers: {
            ...exports.DEFAULT_WORKER_CONFIG,
            ...config.workers,
        },
        persistence: {
            ...exports.DEFAULT_PERSISTENCE_CONFIG,
            ...config.persistence,
        },
        plugins: config.plugins ?? [],
        defaultPriority: config.defaultPriority ?? 5,
        defaultMaxAttempts: config.defaultMaxAttempts ?? 3,
        defaultMaxDuration: config.defaultMaxDuration ?? 30_000,
        maxQueueSize: config.maxQueueSize,
    };
}
