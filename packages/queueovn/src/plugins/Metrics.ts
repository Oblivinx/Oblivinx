import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult, MetricsSnapshot } from '../types/index.js';
import type { IClock } from '../utils/clock.js';
import { systemClock } from '../utils/clock.js';

/**
 * Metrics plugin — tracks processed/failed/retried counts and average latency.
 * Access via queue.plugins.get('Metrics') or call metrics.snapshot().
 */
export class Metrics implements IPlugin {
    readonly name = 'Metrics';
    private _processed = 0;
    private _failed = 0;
    private _retried = 0;
    private _expired = 0;
    private _totalLatencyMs = 0;
    private _activeCount = 0;
    private readonly startTimes = new Map<string, number>();
    private readonly clock: IClock;

    constructor(clock: IClock = systemClock) {
        this.clock = clock;
    }

    onProcess<T extends JobPayload>(job: Job<T>): void {
        this._activeCount += 1;
        this.startTimes.set(job.id, this.clock.now());
    }

    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void {
        this._processed += 1;
        this._activeCount = Math.max(0, this._activeCount - 1);
        const startTime = this.startTimes.get(job.id);
        if (startTime !== undefined) {
            this._totalLatencyMs += this.clock.now() - startTime;
            this.startTimes.delete(job.id);
        }
    }

    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void {
        this._failed += 1;
        this._activeCount = Math.max(0, this._activeCount - 1);
        this.startTimes.delete(job.id);
    }

    onExpire<T extends JobPayload>(_job: Job<T>): void {
        this._expired += 1;
    }

    /** Increment the retry counter (called externally by the queue engine) */
    recordRetry(): void {
        this._retried += 1;
    }

    /**
     * Return a snapshot of current metrics.
     * @param queueDepth - Current number of pending jobs (injected from adapter)
     */
    snapshot(queueDepth = 0): MetricsSnapshot {
        return {
            processed: this._processed,
            failed: this._failed,
            retried: this._retried,
            expired: this._expired,
            depth: queueDepth,
            avgLatencyMs: this._processed > 0
                ? Math.round(this._totalLatencyMs / this._processed)
                : 0,
            activeWorkers: this._activeCount,
        };
    }

    /** Reset all counters */
    reset(): void {
        this._processed = 0;
        this._failed = 0;
        this._retried = 0;
        this._expired = 0;
        this._totalLatencyMs = 0;
        this._activeCount = 0;
        this.startTimes.clear();
    }
}
