import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
import { QueueError } from '../errors/QueueError.js';

/**
 * Deduplicator plugin — prevents duplicate job IDs from entering the queue.
 * Removes the ID from the set after job completes (allows re-enqueue).
 */
export class Deduplicator implements IPlugin {
    readonly name = 'Deduplicator';
    private readonly active = new Set<string>();

    onEnqueue<T extends JobPayload>(job: Job<T>): void {
        const key = job.idempotencyKey ?? job.id;
        if (this.active.has(key)) {
            throw new QueueError(`Duplicate job: "${key}" is already in the queue`);
        }
        this.active.add(key);
    }

    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void {
        const key = job.idempotencyKey ?? job.id;
        this.active.delete(key);
    }

    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void {
        const key = job.idempotencyKey ?? job.id;
        this.active.delete(key);
    }

    onExpire<T extends JobPayload>(job: Job<T>): void {
        const key = job.idempotencyKey ?? job.id;
        this.active.delete(key);
    }

    /** Return the current number of tracked active jobs */
    get size(): number {
        return this.active.size;
    }
}
