import type { JobPayload, JobOptions, JobHandler, MetricsSnapshot } from '../types/index.js';
import type { QueueConfig } from '../types/queue.types.js';
import type { ChainStep, DAGConfig } from '../types/flow.types.js';
import { TypedEventEmitter } from '../events/EventEmitter.js';
import { DeadLetterQueue } from '../plugins/DeadLetterQueue.js';
type QueueEventName = Parameters<TypedEventEmitter['on']>[0];
type QueueEventListener = Parameters<TypedEventEmitter['on']>[1];
/**
 * JobQueue — p-queue style job orchestrator. No Redis, no polling, no idle workers.
 *
 * Worker pool design:
 * - A single `processLoop` greedily drains the adapter up to `workers.max` concurrency.
 * - Jobs execute concurrently via fire-and-forget `dispatch()` calls tracked in `activePromises`.
 * - When the queue is empty the loop exits. When a new job arrives (enqueue / scheduler / adapter
 *   reactive push) `startProcessLoop()` restarts it — idempotent via the `processingLoop` flag.
 * - No sleep(), no polling, no idle worker threads consuming CPU/RAM.
 *
 * @example
 * const queue = new JobQueue({ name: 'main', workers: { min: 1, max: 5 } });
 * queue.register('sendMessage', async (payload, ctx) => { ... });
 * await queue.initialize();
 * const id = await queue.enqueue({ type: 'sendMessage', payload: { ... } });
 */
export declare class JobQueue {
    private readonly cfg;
    private readonly registry;
    private readonly scheduler;
    private readonly flowController;
    private readonly emitter;
    /**
     * Flat-file WAL/Snapshot/Recovery — only instantiated when
     * `persistence.useNativeWAL` is false. With OvnDbAdapter (q.ovn) the
     * Oblivinx3x engine provides WAL + recovery natively, so these
     * become null and the queue avoids the temp-rename pattern that
     * fails on Linux when /tmp is on a different filesystem.
     */
    private readonly wal;
    private readonly snapshot;
    private readonly recovery;
    private readonly nativeWAL;
    private readonly defaultRetry;
    /** Number of jobs currently executing (dispatched but not yet finished). */
    private running;
    /** True while processLoop() is running — prevents concurrent loop instances. */
    private processingLoop;
    /** Tracks in-flight dispatch Promises so shutdown() can await them. */
    private readonly activePromises;
    private isClosed;
    private isPaused;
    private drainResolvers;
    constructor(config: QueueConfig);
    on(event: QueueEventName, listener: QueueEventListener): this;
    once(event: QueueEventName, listener: QueueEventListener): this;
    off(event: QueueEventName, listener: QueueEventListener): this;
    /**
     * Initialize the queue: run WAL recovery if persistence is enabled, then start processing.
     */
    initialize(): Promise<void>;
    /** Register a job handler for a given type */
    register<T extends JobPayload>(type: string, handler: JobHandler<T>): void;
    /**
     * Enqueue a job.
     * @returns The job ID
     * @throws QueueError if queue is closed
     */
    enqueue<T extends JobPayload>(options: JobOptions<T>): Promise<string>;
    /**
     * Enqueue many jobs in one batch. Uses {@link IStorageAdapter.pushMany}
     * when the adapter supports it (e.g. {@link OvnDbAdapter}), otherwise
     * falls back to a chunked sequential push so the event loop is not
     * starved. Yields between chunks via `setImmediate` to avoid blocking
     * pending I/O for thousands of enqueues at once.
     */
    enqueueBatch<T extends JobPayload>(jobs: JobOptions<T>[], options?: {
        chunkSize?: number;
        onProgress?: (done: number, total: number) => void;
    }): Promise<string[]>;
    /** Enqueue a linear chain of jobs (A → B → C) */
    flow(steps: ChainStep[]): Promise<string>;
    /** Enqueue a DAG of jobs with dependencies */
    dag(config: DAGConfig): Promise<string>;
    /** Pause processing — in-flight jobs finish, new ones are not started */
    pause(): void;
    /** Resume processing after a pause */
    resume(): void;
    /**
     * Drain: wait until all currently pending AND active jobs complete.
     */
    drain(): Promise<void>;
    /**
     * Gracefully shut down all workers.
     * Waits for in-flight jobs to complete.
     */
    shutdown(): Promise<void>;
    /** Get the current number of pending jobs */
    size(): Promise<number>;
    /** Clear all pending jobs */
    clear(): Promise<void>;
    /**
     * Run a job handler directly in-process, bypassing the queue entirely.
     *
     * Useful for:
     *  - Testing handlers without queue overhead
     *  - Urgent/synchronous one-off executions
     *  - Running jobs in contexts where queue workers are not started
     *
     * Plugin hooks (`onEnqueue`, `onProcess`, `onComplete`, `onFail`) are still
     * invoked so metrics, rate-limiters, and other plugins remain accurate.
     *
     * @returns The handler's return value on success
     * @throws The original handler error on failure (no retries)
     */
    runInProcess<T extends JobPayload, R = unknown>(type: string, payload: T, options?: Omit<JobOptions<T>, 'type' | 'payload'>): Promise<R>;
    /** Get metrics snapshot */
    get metrics(): {
        snapshot: (depth?: number) => MetricsSnapshot;
    };
    /** Get the DeadLetterQueue plugin if configured */
    get dlq(): DeadLetterQueue;
    /**
     * Start the process loop if it isn't already running.
     * Idempotent — safe to call from anywhere (enqueue, scheduler, adapter callback,
     * job completion). Uses a boolean flag instead of spawning threads.
     */
    private startProcessLoop;
    /**
     * Main processing loop — p-queue style.
     *
     * Greedily pops jobs from the adapter and dispatches them concurrently
     * up to `workers.max`. Exits when:
     *   - queue is empty (pop returns null)
     *   - concurrency limit is reached (running >= max)
     *   - queue is closed or paused
     *
     * When a dispatched job finishes, it calls `startProcessLoop()` to resume.
     */
    private runProcessLoop;
    /**
     * Fire-and-forget job execution. Tracks the promise in `activePromises`
     * so shutdown() can await all in-flight work. Calls `startProcessLoop()`
     * when done so the next ready job is picked up without delay.
     */
    private dispatchJob;
    private executeJob;
    private onSuccess;
    private onFailure;
    private handleExpire;
    private checkOpen;
    private checkDrain;
    private static _imports;
}
export {};
