import { createJob, updateJob } from '../job/Job.js';
import { JobState } from '../job/JobState.js';
import { JobResultFactory } from '../job/JobResult.js';
import { JobRegistry } from './JobRegistry.js';
import { Scheduler } from './Scheduler.js';
import { FlowController } from './FlowController.js';
import { TypedEventEmitter } from '../events/EventEmitter.js';
import { QueueEvent } from '../events/QueueEvents.js';
import { ExponentialBackoff } from '../retry/ExponentialBackoff.js';
import { WALWriter } from '../persistence/WALWriter.js';
import { Snapshot } from '../persistence/Snapshot.js';
import { Recovery } from '../persistence/Recovery.js';
import { validateConfig } from '../config/validateConfig.js';
import { resolveConfig } from '../config/QueueConfig.js';
import { AdapterError } from '../errors/AdapterError.js';
import { QueueError } from '../errors/QueueError.js';
import { JobTimeoutError } from '../errors/JobTimeoutError.js';
import { DiscardJobError } from '../errors/DiscardJobError.js';
import { Metrics } from '../plugins/Metrics.js';
import { DeadLetterQueue } from '../plugins/DeadLetterQueue.js';
import { JobTTL } from '../plugins/JobTTL.js';
import { systemClock } from '../utils/clock.js';
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
export class JobQueue {
    cfg;
    registry = new JobRegistry();
    scheduler;
    flowController;
    emitter = new TypedEventEmitter();
    /**
     * Flat-file WAL/Snapshot/Recovery — only instantiated when
     * `persistence.useNativeWAL` is false. With OvnDbAdapter (q.ovn) the
     * Oblivinx3x engine provides WAL + recovery natively, so these
     * become null and the queue avoids the temp-rename pattern that
     * fails on Linux when /tmp is on a different filesystem.
     */
    wal;
    snapshot;
    recovery;
    nativeWAL;
    defaultRetry;
    // ─── p-queue style worker pool ───────────────────────────────────────────────
    /** Number of jobs currently executing (dispatched but not yet finished). */
    running = 0;
    /** True while processLoop() is running — prevents concurrent loop instances. */
    processingLoop = false;
    /** Tracks in-flight dispatch Promises so shutdown() can await them. */
    activePromises = new Set();
    isClosed = false;
    isPaused = false;
    drainResolvers = [];
    constructor(config) {
        validateConfig(config);
        this.cfg = resolveConfig(config);
        this.scheduler = new Scheduler(systemClock);
        this.defaultRetry = new ExponentialBackoff({
            maxAttempts: this.cfg.defaultMaxAttempts,
        });
        // useNativeWAL=true → adapter handles durability (e.g. OvnDbAdapter
        // with q.ovn). Skip the queue's flat-file WAL/Snapshot/Recovery
        // entirely so we don't pay double-write cost or hit the temp-rename
        // bug on Linux.
        //
        // Auto-detect: an adapter exposing `usesNativeWAL: true` (currently
        // only OvnDbAdapter) opts in by default. Users can still override
        // with `persistence.useNativeWAL: false` if they really want the
        // flat-file shadow log on top of the engine WAL.
        const adapterMark = this.cfg.adapter.usesNativeWAL === true;
        const explicit = this.cfg.persistence.useNativeWAL;
        this.nativeWAL = this.cfg.persistence.enabled === true
            && (explicit === true || (explicit === undefined && adapterMark));
        if (this.nativeWAL) {
            this.wal = null;
            this.snapshot = null;
            this.recovery = null;
        }
        else {
            this.wal = new WALWriter(this.cfg.persistence.walPath, this.cfg.persistence.enabled);
            this.snapshot = new Snapshot(this.cfg.persistence.snapshotPath, this.cfg.adapter);
            this.recovery = new Recovery(this.wal, this.snapshot, this.cfg.adapter);
        }
        this.flowController = new FlowController(this.cfg.adapter, this.wal, () => this.startProcessLoop());
        // Wire JobTTL expire callback
        const ttlPlugin = this.cfg.plugins.find((p) => p instanceof JobTTL);
        if (ttlPlugin) {
            ttlPlugin.onExpireCallback((job) => {
                this.handleExpire(job).catch((err) => {
                    this.emitter.emit(QueueEvent.ERROR, err instanceof Error ? err : new QueueError(String(err)));
                });
            });
        }
        // Wire DLQ enqueue callback + persistence:
        //   - flat-file WAL when running in legacy mode
        //   - OvnDbAdapter `dlq` collection when running in native-WAL mode
        const dlqPlugin = this.cfg.plugins.find((p) => p instanceof DeadLetterQueue);
        if (dlqPlugin) {
            dlqPlugin.setEnqueueCallback(async (job) => {
                await this.cfg.adapter.push(job);
                this.startProcessLoop();
            });
            if (this.cfg.persistence.enabled && this.wal) {
                dlqPlugin.setWAL(this.wal);
            }
            const adapterAny = this.cfg.adapter;
            if (typeof adapterAny.getDLQStore === 'function') {
                dlqPlugin.setStore(adapterAny.getDLQStore());
            }
        }
        // Scheduler delivers delayed jobs back into the adapter
        this.scheduler.onReady((job) => {
            this.cfg.adapter.push(job).then(() => {
                this.startProcessLoop();
            }).catch((err) => {
                this.emitter.emit(QueueEvent.ERROR, err instanceof Error ? err : new AdapterError('Scheduler push failed', err));
            });
        });
    }
    // ─── Typed event methods ──────────────────────────────────────────────────────
    on(event, listener) {
        this.emitter.on(event, listener);
        return this;
    }
    once(event, listener) {
        this.emitter.once(event, listener);
        return this;
    }
    off(event, listener) {
        this.emitter.off(event, listener);
        return this;
    }
    // ─── Lifecycle ────────────────────────────────────────────────────────────────
    /**
     * Initialize the queue: run WAL recovery if persistence is enabled, then start processing.
     */
    async initialize() {
        // Initialize the storage adapter first so OvnDbAdapter (q.ovn) can
        // open its database file before any push/recovery happens.
        if (typeof this.cfg.adapter.initialize === 'function') {
            await this.cfg.adapter.initialize();
        }
        if (this.cfg.persistence.enabled && !this.nativeWAL && this.wal && this.snapshot && this.recovery) {
            this.wal.initialize();
            await this.recovery.run();
            const walEntries = this.wal.readAll();
            this.flowController.restoreFromWAL(walEntries);
            const dlqPlugin = this.cfg.plugins.find((p) => p instanceof DeadLetterQueue);
            dlqPlugin?.restoreFromWAL(walEntries);
            this.snapshot.schedule(this.cfg.persistence.snapshotIntervalMs, () => this.wal.currentSeq, () => {
                this.wal.truncate().catch((err) => {
                    this.emitter.emit(QueueEvent.ERROR, err instanceof Error ? err : new QueueError(String(err)));
                });
            }, (err) => {
                this.emitter.emit(QueueEvent.ERROR, err);
            });
        }
        // Native-WAL mode: the adapter (OvnDbAdapter) opens the .ovn file
        // which triggers the engine's WAL replay automatically. Pending
        // jobs reappear in the next pop() — no manual recovery needed.
        // Restore DLQ from the adapter-backed store (the `dlq` collection)
        // so failed jobs persisted before the crash are still queryable.
        if (this.nativeWAL) {
            const dlqPlugin = this.cfg.plugins.find((p) => p instanceof DeadLetterQueue);
            await dlqPlugin?.restoreFromStore?.().catch((err) => {
                this.emitter.emit(QueueEvent.ERROR, err instanceof Error ? err : new QueueError(String(err)));
            });
        }
        // Wire reactive notification: adapter calls this when a job is pushed so the
        // process loop wakes up immediately instead of waiting for the next enqueue.
        if (typeof this.cfg.adapter.setOnNewJob === 'function') {
            this.cfg.adapter.setOnNewJob(() => this.startProcessLoop());
        }
        // Start processing any jobs recovered from WAL / already in the adapter.
        this.startProcessLoop();
    }
    /** Register a job handler for a given type */
    register(type, handler) {
        this.registry.register(type, handler);
    }
    /**
     * Enqueue a job.
     * @returns The job ID
     * @throws QueueError if queue is closed
     */
    async enqueue(options) {
        this.checkOpen();
        if (this.cfg.maxQueueSize !== undefined) {
            const currentSize = await this.size();
            if (currentSize >= this.cfg.maxQueueSize) {
                throw new QueueError(`Queue is full (maxQueueSize: ${this.cfg.maxQueueSize}). Backpressure applied.`);
            }
        }
        const job = createJob(options, {
            defaultPriority: this.cfg.defaultPriority,
            defaultMaxAttempts: this.cfg.defaultMaxAttempts,
            defaultMaxDuration: this.cfg.defaultMaxDuration,
        });
        // Run onEnqueue plugin hooks (serial, stop on error)
        for (const plugin of this.cfg.plugins) {
            if (plugin.onEnqueue)
                await plugin.onEnqueue(job);
        }
        if (job.runAt > systemClock.now()) {
            this.scheduler.schedule(job, job.runAt);
        }
        else {
            await this.cfg.adapter.push(job);
            if (this.cfg.persistence.enabled && this.wal) {
                this.wal.append('ENQUEUE', job.id, job);
            }
            this.startProcessLoop();
        }
        this.emitter.emit(QueueEvent.ENQUEUED, job);
        return job.id;
    }
    /**
     * Enqueue many jobs in one batch. Uses {@link IStorageAdapter.pushMany}
     * when the adapter supports it (e.g. {@link OvnDbAdapter}), otherwise
     * falls back to a chunked sequential push so the event loop is not
     * starved. Yields between chunks via `setImmediate` to avoid blocking
     * pending I/O for thousands of enqueues at once.
     */
    async enqueueBatch(jobs, options) {
        this.checkOpen();
        if (jobs.length === 0)
            return [];
        const chunkSize = Math.max(1, options?.chunkSize ?? 1000);
        const total = jobs.length;
        const ids = [];
        const built = [];
        const delayed = [];
        const ready = [];
        // 1. Build all Job objects up-front (sync, no I/O) and partition
        //    into ready vs scheduled-for-later. Plugins still get a chance
        //    to inspect each job via onEnqueue.
        const now = systemClock.now();
        for (const opts of jobs) {
            const job = createJob(opts, {
                defaultPriority: this.cfg.defaultPriority,
                defaultMaxAttempts: this.cfg.defaultMaxAttempts,
                defaultMaxDuration: this.cfg.defaultMaxDuration,
            });
            for (const plugin of this.cfg.plugins) {
                if (plugin.onEnqueue)
                    await plugin.onEnqueue(job);
            }
            built.push(job);
            ids.push(job.id);
            (job.runAt > now ? delayed : ready).push(job);
        }
        // 2. Schedule delayed jobs through the scheduler.
        for (const j of delayed)
            this.scheduler.schedule(j, j.runAt);
        // 3. Push ready jobs in chunks, yielding to the event loop between
        //    chunks so other I/O (sock messages, timers) keeps flowing.
        const adapter = this.cfg.adapter;
        for (let i = 0; i < ready.length; i += chunkSize) {
            const slice = ready.slice(i, i + chunkSize);
            if (typeof adapter.pushMany === 'function') {
                await adapter.pushMany(slice);
            }
            else {
                for (const j of slice)
                    await adapter.push(j);
            }
            if (this.cfg.persistence.enabled && this.wal) {
                for (const j of slice)
                    this.wal.append('ENQUEUE', j.id, j);
            }
            options?.onProgress?.(Math.min(i + chunkSize, total), total);
            // Yield so the Node.js event loop is not starved on huge batches.
            await new Promise((resolve) => setImmediate(resolve));
        }
        // 4. Single processLoop wakeup at the end — beats firing it per job.
        this.startProcessLoop();
        for (const j of built)
            this.emitter.emit(QueueEvent.ENQUEUED, j);
        return ids;
    }
    /** Enqueue a linear chain of jobs (A → B → C) */
    async flow(steps) {
        this.checkOpen();
        return this.flowController.chain(steps);
    }
    /** Enqueue a DAG of jobs with dependencies */
    async dag(config) {
        this.checkOpen();
        return this.flowController.dag(config);
    }
    /** Pause processing — in-flight jobs finish, new ones are not started */
    pause() {
        this.isPaused = true;
    }
    /** Resume processing after a pause */
    resume() {
        this.isPaused = false;
        this.startProcessLoop();
    }
    /**
     * Drain: wait until all currently pending AND active jobs complete.
     */
    async drain() {
        const size = await this.cfg.adapter.size();
        if (size === 0 && this.running === 0)
            return;
        return new Promise((resolve) => {
            this.drainResolvers.push(resolve);
        });
    }
    /**
     * Gracefully shut down all workers.
     * Waits for in-flight jobs to complete.
     */
    async shutdown() {
        this.isClosed = true;
        this.scheduler.clear();
        this.snapshot?.stop();
        // Wait for all in-flight dispatch promises to settle
        if (this.activePromises.size > 0) {
            await Promise.all(this.activePromises);
        }
        await this.cfg.adapter.close();
        if (this.cfg.persistence.enabled && this.wal) {
            await this.wal.close();
        }
        // Clear JobTTL timers
        const ttlPlugin = this.cfg.plugins.find((p) => p instanceof JobTTL);
        ttlPlugin?.clear();
        this.emitter.removeAllListeners();
    }
    /** Get the current number of pending jobs */
    async size() {
        return this.cfg.adapter.size();
    }
    /** Clear all pending jobs */
    async clear() {
        await this.cfg.adapter.clear();
    }
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
    async runInProcess(type, payload, options) {
        this.checkOpen();
        const job = createJob({ type, payload, ...options }, {
            defaultPriority: this.cfg.defaultPriority,
            defaultMaxAttempts: this.cfg.defaultMaxAttempts,
            defaultMaxDuration: this.cfg.defaultMaxDuration,
        });
        for (const plugin of this.cfg.plugins) {
            if (plugin.onEnqueue)
                await plugin.onEnqueue(job);
        }
        for (const plugin of this.cfg.plugins) {
            if (plugin.onProcess)
                await plugin.onProcess(job);
        }
        const handler = this.registry.lookup(type);
        const abortController = new AbortController();
        const ctx = { jobId: job.id, attempt: 1, signal: abortController.signal };
        let handlerResult;
        try {
            let timeoutId;
            const maxDuration = options?.maxDuration ?? this.cfg.defaultMaxDuration;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    const err = new JobTimeoutError(job.id, maxDuration);
                    abortController.abort(err);
                    reject(err);
                }, maxDuration);
            });
            handlerResult = await Promise.race([
                handler(job.payload, ctx),
                timeoutPromise,
            ]).finally(() => clearTimeout(timeoutId));
        }
        catch (err) {
            const error = err instanceof Error ? err : new QueueError(String(err));
            const result = JobResultFactory.failure(error);
            const failedJob = updateJob(job, {
                state: JobState.FAILED,
                attempts: 1,
                lastError: error.message,
                finishedAt: systemClock.now(),
            });
            for (const plugin of this.cfg.plugins) {
                if (plugin.onFail)
                    await plugin.onFail(failedJob, error);
            }
            this.emitter.emit(QueueEvent.FAILED, failedJob, error);
            throw err;
        }
        const result = JobResultFactory.success(handlerResult);
        const doneJob = updateJob(job, {
            state: JobState.DONE,
            attempts: 1,
            finishedAt: systemClock.now(),
        });
        for (const plugin of this.cfg.plugins) {
            if (plugin.onComplete)
                await plugin.onComplete(doneJob, result);
        }
        this.emitter.emit(QueueEvent.COMPLETED, doneJob, result);
        return handlerResult;
    }
    /** Get metrics snapshot */
    get metrics() {
        const metricsPlugin = this.cfg.plugins.find((p) => p instanceof Metrics);
        return {
            snapshot: (depth) => {
                if (metricsPlugin)
                    return metricsPlugin.snapshot(depth);
                return {
                    processed: 0,
                    failed: 0,
                    retried: 0,
                    expired: 0,
                    depth: depth ?? 0,
                    avgLatencyMs: 0,
                    activeWorkers: this.running,
                };
            },
        };
    }
    /** Get the DeadLetterQueue plugin if configured */
    get dlq() {
        const plugin = this.cfg.plugins.find((p) => p instanceof DeadLetterQueue);
        if (!plugin)
            throw new QueueError('DeadLetterQueue plugin is not configured');
        return plugin;
    }
    // ─── p-queue style worker pool ────────────────────────────────────────────────
    /**
     * Start the process loop if it isn't already running.
     * Idempotent — safe to call from anywhere (enqueue, scheduler, adapter callback,
     * job completion). Uses a boolean flag instead of spawning threads.
     */
    startProcessLoop() {
        if (this.processingLoop || this.isClosed || this.isPaused)
            return;
        this.processingLoop = true;
        void this.runProcessLoop();
    }
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
    async runProcessLoop() {
        try {
            while (!this.isClosed && !this.isPaused && this.running < this.cfg.workers.max) {
                // Pop next ready job
                let job = null;
                try {
                    job = await this.cfg.adapter.pop();
                }
                catch (err) {
                    this.emitter.emit(QueueEvent.ERROR, new AdapterError('Failed to pop job', err));
                    break;
                }
                if (!job)
                    break; // Queue empty — exit loop, wait for next trigger
                // Run onProcess plugin hooks before marking job active
                let skipJob = false;
                try {
                    for (const plugin of this.cfg.plugins) {
                        if (plugin.onProcess)
                            await plugin.onProcess(job);
                    }
                }
                catch (err) {
                    if (DiscardJobError.is(err)) {
                        // Silent discard — job consumed, try next immediately
                        continue;
                    }
                    // Throttle / backpressure — re-queue and back off
                    await this.cfg.adapter.push(job).catch(() => { });
                    skipJob = true;
                }
                if (skipJob)
                    break;
                // Mark as active in adapter and WAL
                const activeJob = updateJob(job, { state: JobState.ACTIVE, startedAt: systemClock.now() });
                await this.cfg.adapter.update(activeJob).catch(() => { });
                if (this.cfg.persistence.enabled && this.wal) {
                    this.wal.append('ACTIVATE', activeJob.id);
                }
                this.emitter.emit(QueueEvent.ACTIVE, activeJob);
                // Dispatch — runs concurrently, does NOT block the loop
                this.running++;
                this.dispatchJob(activeJob);
            }
        }
        finally {
            this.processingLoop = false;
        }
    }
    /**
     * Fire-and-forget job execution. Tracks the promise in `activePromises`
     * so shutdown() can await all in-flight work. Calls `startProcessLoop()`
     * when done so the next ready job is picked up without delay.
     */
    dispatchJob(job) {
        const wrapper = async () => {
            try {
                await this.executeJob(job);
            }
            catch (err) {
                // Safety net: executeJob handles its own errors internally,
                // but emit to surface any unexpected throw.
                this.emitter.emit(QueueEvent.ERROR, err instanceof Error ? err : new QueueError(String(err)));
            }
            finally {
                this.running = Math.max(0, this.running - 1);
                this.activePromises.delete(promise);
                this.checkDrain();
                this.startProcessLoop(); // Pick up next job without delay
            }
        };
        const promise = wrapper();
        this.activePromises.add(promise);
    }
    // ─── Job execution ────────────────────────────────────────────────────────────
    async executeJob(job) {
        const handler = this.registry.lookup(job.type);
        const abortController = new AbortController();
        const ctx = { jobId: job.id, attempt: job.attempts + 1, signal: abortController.signal };
        let result;
        try {
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    const err = new JobTimeoutError(job.id, job.maxDuration);
                    abortController.abort(err);
                    reject(err);
                }, job.maxDuration);
            });
            const handlerResult = await Promise.race([
                handler(job.payload, ctx),
                timeoutPromise,
            ]).finally(() => clearTimeout(timeoutId));
            result = JobResultFactory.success(handlerResult);
        }
        catch (err) {
            const error = err instanceof Error ? err : new QueueError(String(err));
            result = JobResultFactory.failure(error);
        }
        if (result.ok) {
            await this.onSuccess(job, result);
        }
        else {
            await this.onFailure(job, result.error);
        }
    }
    async onSuccess(job, result) {
        const doneJob = updateJob(job, {
            state: JobState.DONE,
            finishedAt: systemClock.now(),
            attempts: job.attempts + 1,
        });
        await this.cfg.adapter.update(doneJob).catch(() => { });
        if (this.cfg.persistence.enabled && this.wal) {
            this.wal.append('COMPLETE', doneJob.id, result);
        }
        for (const plugin of this.cfg.plugins) {
            if (plugin.onComplete)
                await plugin.onComplete(doneJob, result);
        }
        await this.flowController.onJobComplete(doneJob);
        this.emitter.emit(QueueEvent.COMPLETED, doneJob, result);
    }
    async onFailure(job, error) {
        const attempts = job.attempts + 1;
        const retryPolicy = job.retryPolicy ?? this.defaultRetry;
        if (attempts < job.maxAttempts && retryPolicy.shouldRetry(attempts, error)) {
            const delay = retryPolicy.nextDelay(attempts, error);
            const retryJob = updateJob(job, {
                state: JobState.RETRYING,
                attempts,
                lastError: error.message,
                runAt: systemClock.now() + delay,
            });
            if (delay > 0) {
                this.scheduler.schedule(retryJob, retryJob.runAt);
            }
            else {
                await this.cfg.adapter.push(retryJob);
            }
            if (this.cfg.persistence.enabled && this.wal) {
                this.wal.append('RETRY', retryJob.id);
            }
            const metricsPlugin = this.cfg.plugins.find((p) => p instanceof Metrics);
            metricsPlugin?.recordRetry();
            this.emitter.emit(QueueEvent.RETRYING, retryJob, attempts);
        }
        else {
            // Permanent failure
            const failedJob = updateJob(job, {
                state: JobState.FAILED,
                attempts,
                lastError: error.message,
                finishedAt: systemClock.now(),
            });
            await this.cfg.adapter.update(failedJob).catch(() => { });
            if (this.cfg.persistence.enabled && this.wal) {
                this.wal.append('FAIL', failedJob.id);
            }
            for (const plugin of this.cfg.plugins) {
                if (plugin.onFail)
                    await plugin.onFail(failedJob, error);
            }
            this.flowController.onJobFail(failedJob);
            this.emitter.emit(QueueEvent.DEAD_LETTER, failedJob, error);
            this.emitter.emit(QueueEvent.FAILED, failedJob, error);
        }
    }
    async handleExpire(job) {
        const expired = updateJob(job, { state: JobState.EXPIRED });
        await this.cfg.adapter.remove(job.id).catch(() => { });
        if (this.cfg.persistence.enabled && this.wal) {
            this.wal.append('EXPIRE', job.id);
        }
        for (const plugin of this.cfg.plugins) {
            if (plugin.onExpire)
                await plugin.onExpire(expired);
        }
        this.emitter.emit(QueueEvent.EXPIRED, expired);
    }
    // ─── Helpers ──────────────────────────────────────────────────────────────────
    checkOpen() {
        if (this.isClosed)
            throw new QueueError('JobQueue is closed');
    }
    checkDrain() {
        // Only resolve drain when: no jobs running, no process loop alive,
        // no delayed retries in the scheduler, and the adapter queue is empty.
        if (this.running > 0 || this.processingLoop || this.scheduler.size > 0)
            return;
        this.cfg.adapter.size().then((size) => {
            if (size === 0 && this.running === 0) {
                for (const resolve of this.drainResolvers)
                    resolve();
                this.drainResolvers = [];
            }
        }).catch(() => { });
    }
    // Keep imports alive
    static _imports = { AdapterError, QueueError, JobTimeoutError, DiscardJobError };
}
