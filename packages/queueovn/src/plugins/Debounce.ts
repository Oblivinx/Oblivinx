import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult } from '../types/job.types.js';
import { DiscardJobError } from '../errors/DiscardJobError.js';

export interface DebounceOptions {
    /**
     * Debounce window in ms.
     * If the same key is enqueued again within this window,
     * the previous job is superseded by the new one (last-write-wins).
     */
    windowMs: number;

    /**
     * Function to extract the debounce key from a job.
     * Defaults to `job.type`.
     */
    keyFn?: (job: Job<JobPayload>) => string;
}

interface DebounceEntry {
    /** ID of the latest job for this key */
    latestId: string;
    /** Timestamp the entry was created */
    createdAt: number;
}

/**
 * Debounce plugin — last-write-wins per debounce key.
 *
 * When multiple jobs with the same debounce key are enqueued within `windowMs`,
 * only the **last** one will actually be processed; all earlier jobs are
 * silently discarded (via DiscardJobError) when a worker picks them up.
 *
 * This is useful for "flush-on-idle" patterns: e.g. only send the final
 * "user is typing" message after the user stops typing for 500ms.
 *
 * @example
 * const queue = new JobQueue({
 *   name: 'main',
 *   plugins: [new Debounce({ windowMs: 500 })],
 * });
 * await queue.enqueue({ type: 'syncUser', payload: { userId: '42' } });
 * await queue.enqueue({ type: 'syncUser', payload: { userId: '42' } }); // supersedes the first
 * // Only the second job will run
 */
export class Debounce implements IPlugin {
    readonly name = 'Debounce';

    private readonly windowMs: number;
    private readonly keyFn: (job: Job<JobPayload>) => string;

    /**
     * Maps debounce key → latest entry.
     * Old entries are lazily cleaned up when a new job arrives.
     */
    private readonly pending = new Map<string, DebounceEntry>();

    /**
     * Set of job IDs that have been superseded.
     * These will be discarded when a worker picks them up.
     */
    private readonly superseded = new Set<string>();

    constructor({ windowMs, keyFn }: DebounceOptions) {
        this.windowMs = windowMs;
        this.keyFn = keyFn ?? ((job) => job.type);
    }

    onEnqueue<T extends JobPayload>(job: Job<T>): void {
        const key = this.keyFn(job as Job<JobPayload>);
        const now = Date.now();

        const existing = this.pending.get(key);
        if (existing) {
            // Supersede the previous job if still within the window
            if (now - existing.createdAt < this.windowMs) {
                this.superseded.add(existing.latestId);
            }
        }

        this.pending.set(key, { latestId: job.id, createdAt: now });
    }

    onProcess<T extends JobPayload>(job: Job<T>): void {
        if (this.superseded.has(job.id)) {
            this.superseded.delete(job.id);
            throw new DiscardJobError(
                `Job "${job.id}" (type: "${job.type}") was superseded by a newer debounced job`,
            );
        }
    }

    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void {
        this._cleanup(job as Job<JobPayload>);
    }

    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void {
        this._cleanup(job as Job<JobPayload>);
    }

    onExpire<T extends JobPayload>(job: Job<T>): void {
        this._cleanup(job as Job<JobPayload>);
    }

    // ─── Inspection ─────────────────────────────────────────────────────────────

    /** Number of keys currently tracked */
    get pendingCount(): number {
        return this.pending.size;
    }

    /** Number of jobs waiting to be discarded */
    get supersededCount(): number {
        return this.superseded.size;
    }

    // ─── Internal ───────────────────────────────────────────────────────────────

    private _cleanup(job: Job<JobPayload>): void {
        const key = this.keyFn(job);
        const entry = this.pending.get(key);
        if (entry?.latestId === job.id) {
            this.pending.delete(key);
        }
        this.superseded.delete(job.id);
    }
}
