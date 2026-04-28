"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJob = createJob;
exports.updateJob = updateJob;
exports.isJob = isJob;
const JobState_js_1 = require("./JobState.cjs");
const idGenerator_js_1 = require("../utils/idGenerator.cjs");
/**
 * Immutable job value object factory and type guard.
 * Every Job created through this module is frozen.
 */
function createJob(options, defaults) {
    const now = Date.now();
    const delay = options.delay ?? 0;
    const ttl = options.ttl;
    const job = Object.freeze({
        id: (0, idGenerator_js_1.generateId)(),
        type: options.type,
        payload: options.payload,
        priority: options.priority ?? defaults.defaultPriority,
        maxAttempts: options.maxAttempts ?? defaults.defaultMaxAttempts,
        attempts: 0,
        maxDuration: options.maxDuration ?? defaults.defaultMaxDuration,
        state: JobState_js_1.JobState.PENDING,
        createdAt: now,
        runAt: now + delay,
        ttl,
        expiresAt: ttl !== undefined ? now + ttl : undefined,
        flowId: options.flowId,
        dependsOn: options.dependsOn,
        idempotencyKey: options.idempotencyKey,
        retryPolicy: options.retryPolicy,
    });
    return job;
}
/**
 * Create a shallow update of an existing job (returns new frozen object).
 */
function updateJob(job, changes) {
    return Object.freeze({ ...job, ...changes });
}
/**
 * Type guard for Job<T>
 */
function isJob(value) {
    return (typeof value === 'object' &&
        value !== null &&
        typeof value['id'] === 'string' &&
        typeof value['type'] === 'string');
}
