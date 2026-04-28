import { EventEmitter } from 'node:events';
export interface ScheduleEntry {
    id: string;
    /** Cron expression OR interval in ms (number) */
    schedule: string | number;
    jobType: string;
    payload: unknown;
    /** Whether this schedule is currently active */
    enabled: boolean;
    /** Next run timestamp (ms) */
    nextRunAt: number;
    /** Total runs completed */
    runCount: number;
    /** Last run timestamp */
    lastRunAt: number;
    /** Max runs (0 = unlimited) */
    maxRuns: number;
    createdAt: number;
}
export interface CronSchedulerOptions {
    /** Path to persist schedules as JSON (fallback when db is not provided). */
    persistPath?: string;
    /** Oblivinx3x database instance for persistent schedule storage. Preferred over persistPath. */
    db?: any;
    /** Clock tick interval (ms). Lower = more precise. Default: 1_000 */
    tickMs?: number;
}
type EnqueueFn = (opts: {
    type: string;
    payload: unknown;
}) => Promise<string>;
/**
 * Persistent recurring job scheduler that integrates with wa-job-queue.
 * Schedules survive bot restarts when persistPath is configured.
 *
 * WhatsApp bot use cases:
 *  - Daily reward reset:       '0 0 * * *'     (midnight every day)
 *  - Hourly stats flush:       '0 * * * *'     (top of every hour)
 *  - Leaderboard announce:     'every 24 hours'
 *  - Anti-spam counter reset:  'every 10 minutes'
 *  - DB cleanup:               '0 2 * * *'     (2 AM every day)
 *  - Monthly stats status:     '0 8 1 * *'     (8 AM on 1st of month)
 *  - Group activity report:    '0 20 * * 0'    (Sunday 8 PM)
 *
 * @example
 * ```typescript
 * const cron = new CronScheduler({ persistPath: './cron.json' }, queue.enqueue.bind(queue))
 * await cron.initialize()
 *
 * cron.add({
 *   id: 'daily-reset',
 *   schedule: '0 0 * * *',
 *   jobType: 'daily-stats-reset',
 *   payload: {},
 * })
 *
 * cron.add({
 *   id: 'cleanup',
 *   schedule: 'every 1 hour',
 *   jobType: 'db-cleanup',
 *   payload: { tables: ['GroupMessage', 'BotTelemetry'] },
 * })
 * ```
 */
export declare class CronScheduler extends EventEmitter {
    private schedules;
    private timer;
    private enqueue;
    /** BUG FIX: tracks in-flight schedule IDs to prevent concurrent double-fire */
    private inFlight;
    /** Pause/resume state */
    private _paused;
    private readonly persistPath;
    private readonly db;
    private schedCol;
    private readonly tickMs;
    constructor(options: CronSchedulerOptions, enqueue: EnqueueFn);
    /**
     * Initialize the scheduler: load persisted schedules and start ticking.
     *
     * @example
     * ```typescript
     * await cron.initialize()
     * ```
     */
    initialize(): Promise<void>;
    /**
     * Stop ticking and save state. Call on graceful shutdown.
     *
     * @example
     * ```typescript
     * await cron.shutdown()
     * ```
     */
    shutdown(): Promise<void>;
    /**
     * Add or replace a schedule. If a schedule with the same `id` exists, it is replaced.
     *
     * @example
     * ```typescript
     * cron.add({ id: 'stats', schedule: '0 * * * *', jobType: 'flush-stats', payload: {} })
     * ```
     */
    add(entry: {
        id: string;
        schedule: string | number;
        jobType: string;
        payload?: unknown;
        maxRuns?: number;
        enabled?: boolean;
    }): ScheduleEntry;
    /**
     * Convenience method for adding an interval-based schedule.
     * Shorthand for `add({ id, schedule: intervalMs, jobType, payload })`.
     *
     * @example
     * ```typescript
     * cron.addInterval('flush-stats', 5 * 60_000, 'flush-user-stats', {})
     * cron.addInterval('cleanup', 60 * 60_000, 'db-cleanup', { tables: ['BotTelemetry'] })
     * ```
     */
    addInterval(id: string, intervalMs: number, jobType: string, payload?: unknown, maxRuns?: number): ScheduleEntry;
    /**
     * Remove a schedule by ID.
     *
     * @example
     * ```typescript
     * cron.remove('daily-reset')
     * ```
     */
    remove(id: string): boolean;
    /**
     * Enable or disable a schedule without removing it.
     *
     * @example
     * ```typescript
     * cron.setEnabled('daily-reset', false) // pause this schedule
     * ```
     */
    setEnabled(id: string, enabled: boolean): boolean;
    /**
     * List all schedules, optionally filtered.
     *
     * @example
     * ```typescript
     * cron.list({ enabled: true })
     * ```
     */
    list(filter?: {
        enabled?: boolean;
    }): ScheduleEntry[];
    /**
     * Get a schedule by ID.
     *
     * @example
     * ```typescript
     * const s = cron.get('daily-reset')
     * ```
     */
    get(id: string): ScheduleEntry | null;
    /**
     * Force immediate run of a schedule (fire-and-forget, resets nextRunAt).
     *
     * @example
     * ```typescript
     * await cron.runNow('daily-reset')
     * ```
     */
    runNow(id: string): Promise<string | null>;
    /**
     * Pause all schedule firing globally. Timer keeps running but no jobs fire.
     *
     * @example
     * ```typescript
     * cron.pause()
     * ```
     */
    pause(): void;
    /**
     * Resume schedule firing after a global pause.
     *
     * @example
     * ```typescript
     * cron.resume()
     * ```
     */
    resume(): void;
    /**
     * Whether the scheduler is globally paused.
     *
     * @example
     * ```typescript
     * if (cron.isPaused) console.log('Scheduler is paused')
     * ```
     */
    get isPaused(): boolean;
    /**
     * BUG FIX: uses inFlight set to prevent concurrent double-fire
     * when _tick() re-enters while _fire() is still awaiting.
     */
    private _tick;
    private _fire;
    private _computeNext;
    private _save;
    private _load;
    /** Upsert a single schedule entry into the Oblivinx3x collection (fire-and-forget). */
    private _persistEntryToDb;
    /** Delete a schedule entry from the Oblivinx3x collection (fire-and-forget). */
    private _deleteEntryFromDb;
    /** Load all schedules from the Oblivinx3x collection on startup. */
    private _loadFromDb;
}
export {};
