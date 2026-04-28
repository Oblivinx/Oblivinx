import { systemClock } from '../utils/clock.js';
/**
 * Metrics plugin — tracks processed/failed/retried counts and average latency.
 * Access via queue.plugins.get('Metrics') or call metrics.snapshot().
 */
export class Metrics {
    name = 'Metrics';
    _processed = 0;
    _failed = 0;
    _retried = 0;
    _expired = 0;
    _totalLatencyMs = 0;
    _activeCount = 0;
    startTimes = new Map();
    clock;
    constructor(clock = systemClock) {
        this.clock = clock;
    }
    onProcess(job) {
        this._activeCount += 1;
        this.startTimes.set(job.id, this.clock.now());
    }
    onComplete(job, _result) {
        this._processed += 1;
        this._activeCount = Math.max(0, this._activeCount - 1);
        const startTime = this.startTimes.get(job.id);
        if (startTime !== undefined) {
            this._totalLatencyMs += this.clock.now() - startTime;
            this.startTimes.delete(job.id);
        }
    }
    onFail(job, _error) {
        this._failed += 1;
        this._activeCount = Math.max(0, this._activeCount - 1);
        this.startTimes.delete(job.id);
    }
    onExpire(_job) {
        this._expired += 1;
    }
    /** Increment the retry counter (called externally by the queue engine) */
    recordRetry() {
        this._retried += 1;
    }
    /**
     * Return a snapshot of current metrics.
     * @param queueDepth - Current number of pending jobs (injected from adapter)
     */
    snapshot(queueDepth = 0) {
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
    reset() {
        this._processed = 0;
        this._failed = 0;
        this._retried = 0;
        this._expired = 0;
        this._totalLatencyMs = 0;
        this._activeCount = 0;
        this.startTimes.clear();
    }
}
