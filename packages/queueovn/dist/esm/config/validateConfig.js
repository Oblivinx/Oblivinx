import { QueueError } from '../errors/QueueError.js';
/**
 * Runtime validation of QueueConfig.
 * Uses plain checks (no zod dependency required for runtime).
 * Zod can be used in user-land for schema docs if desired.
 *
 * @throws QueueError if config is invalid
 */
export function validateConfig(config) {
    if (!config.name || typeof config.name !== 'string' || config.name.trim() === '') {
        throw new QueueError('QueueConfig.name must be a non-empty string');
    }
    if (config.maxQueueSize !== undefined && config.maxQueueSize < 1) {
        throw new QueueError('QueueConfig.maxQueueSize must be >= 1');
    }
    if (config.workers) {
        const w = config.workers;
        if (w.min !== undefined && w.min < 0) {
            throw new QueueError('QueueConfig.workers.min must be >= 0');
        }
        if (w.max !== undefined && w.max < 1) {
            throw new QueueError('QueueConfig.workers.max must be >= 1');
        }
        if (w.min !== undefined && w.max !== undefined && w.min > w.max) {
            throw new QueueError('QueueConfig.workers.min must be <= max');
        }
        if (w.monitorIntervalMs !== undefined && w.monitorIntervalMs < 100) {
            throw new QueueError('QueueConfig.workers.monitorIntervalMs must be >= 100ms');
        }
    }
    if (config.defaultMaxAttempts !== undefined && config.defaultMaxAttempts < 1) {
        throw new QueueError('QueueConfig.defaultMaxAttempts must be >= 1');
    }
    if (config.defaultMaxDuration !== undefined && config.defaultMaxDuration < 100) {
        throw new QueueError('QueueConfig.defaultMaxDuration must be >= 100ms');
    }
    // feat: validate persistence config so misconfigured paths fail fast at startup
    if (config.persistence) {
        const p = config.persistence;
        if (p.enabled && p.walPath !== undefined && typeof p.walPath !== 'string') {
            throw new QueueError('QueueConfig.persistence.walPath must be a string');
        }
        if (p.enabled && p.snapshotPath !== undefined && typeof p.snapshotPath !== 'string') {
            throw new QueueError('QueueConfig.persistence.snapshotPath must be a string');
        }
        if (p.snapshotIntervalMs !== undefined && p.snapshotIntervalMs < 1000) {
            throw new QueueError('QueueConfig.persistence.snapshotIntervalMs must be >= 1000ms');
        }
        if (p.dbPath !== undefined && typeof p.dbPath !== 'string') {
            throw new QueueError('QueueConfig.persistence.dbPath must be a string');
        }
        if (p.useNativeWAL !== undefined && typeof p.useNativeWAL !== 'boolean') {
            throw new QueueError('QueueConfig.persistence.useNativeWAL must be a boolean');
        }
    }
    // feat: validate plugins is an array if provided
    if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
        throw new QueueError('QueueConfig.plugins must be an array');
    }
    // feat: validate defaultPriority is a positive number if provided
    if (config.defaultPriority !== undefined && (config.defaultPriority < 1 || config.defaultPriority > 10)) {
        throw new QueueError('QueueConfig.defaultPriority must be between 1 and 10');
    }
}
