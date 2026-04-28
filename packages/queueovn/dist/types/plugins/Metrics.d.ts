import type { IPlugin } from '../types/plugin.types.js';
import type { Job, JobPayload, JobResult, MetricsSnapshot } from '../types/index.js';
import type { IClock } from '../utils/clock.js';
/**
 * Metrics plugin — tracks processed/failed/retried counts and average latency.
 * Access via queue.plugins.get('Metrics') or call metrics.snapshot().
 */
export declare class Metrics implements IPlugin {
    readonly name = "Metrics";
    private _processed;
    private _failed;
    private _retried;
    private _expired;
    private _totalLatencyMs;
    private _activeCount;
    private readonly startTimes;
    private readonly clock;
    constructor(clock?: IClock);
    onProcess<T extends JobPayload>(job: Job<T>): void;
    onComplete<T extends JobPayload>(job: Job<T>, _result: JobResult): void;
    onFail<T extends JobPayload>(job: Job<T>, _error: Error): void;
    onExpire<T extends JobPayload>(_job: Job<T>): void;
    /** Increment the retry counter (called externally by the queue engine) */
    recordRetry(): void;
    /**
     * Return a snapshot of current metrics.
     * @param queueDepth - Current number of pending jobs (injected from adapter)
     */
    snapshot(queueDepth?: number): MetricsSnapshot;
    /** Reset all counters */
    reset(): void;
}
