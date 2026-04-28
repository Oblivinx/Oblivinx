"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Deduplicator = void 0;
const QueueError_js_1 = require("../errors/QueueError.cjs");
/**
 * Deduplicator plugin — prevents duplicate job IDs from entering the queue.
 * Removes the ID from the set after job completes (allows re-enqueue).
 */
class Deduplicator {
    name = 'Deduplicator';
    active = new Set();
    onEnqueue(job) {
        const key = job.idempotencyKey ?? job.id;
        if (this.active.has(key)) {
            throw new QueueError_js_1.QueueError(`Duplicate job: "${key}" is already in the queue`);
        }
        this.active.add(key);
    }
    onComplete(job, _result) {
        const key = job.idempotencyKey ?? job.id;
        this.active.delete(key);
    }
    onFail(job, _error) {
        const key = job.idempotencyKey ?? job.id;
        this.active.delete(key);
    }
    onExpire(job) {
        const key = job.idempotencyKey ?? job.id;
        this.active.delete(key);
    }
    /** Return the current number of tracked active jobs */
    get size() {
        return this.active.size;
    }
}
exports.Deduplicator = Deduplicator;
