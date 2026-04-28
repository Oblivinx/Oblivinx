import { EventEmitter } from 'node:events'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ScheduleEntry {
    id: string
    /** Cron expression OR interval in ms (number) */
    schedule: string | number
    jobType: string
    payload: unknown
    /** Whether this schedule is currently active */
    enabled: boolean
    /** Next run timestamp (ms) */
    nextRunAt: number
    /** Total runs completed */
    runCount: number
    /** Last run timestamp */
    lastRunAt: number
    /** Max runs (0 = unlimited) */
    maxRuns: number
    createdAt: number
}

export interface CronSchedulerOptions {
    /** Path to persist schedules as JSON (fallback when db is not provided). */
    persistPath?: string
    /** Oblivinx3x database instance for persistent schedule storage. Preferred over persistPath. */
    db?: any
    /** Clock tick interval (ms). Lower = more precise. Default: 1_000 */
    tickMs?: number
}

type EnqueueFn = (opts: { type: string; payload: unknown }) => Promise<string>

// ─── Minimal cron parser ──────────────────────────────────────────────────────

/**
 * Parse a cron expression or human-readable interval and return the next
 * run Date after `from`.
 *
 * Supports:
 *  - `'every N seconds/minutes/hours'` shorthand
 *  - Standard 5-field cron: `'min hour dom mon dow'`
 *
 * BUG FIX: regex uses word boundaries `\b` and longer alternatives first
 * so `m` won't accidentally match `months`.
 */
function parseCron(expr: string, from: Date): Date {
    // Shorthand: 'every N units'
    // BUG FIX: order alternatives longest-first and use \b word boundary
    const shorthand = expr.match(
        /^every\s+(\d+)\s*(seconds?|sec|s|minutes?|min|m|hours?|hr|h)\b$/i,
    )
    if (shorthand) {
        const n = parseInt(shorthand[1], 10)
        const unit = shorthand[2].toLowerCase()
        let ms: number
        if (unit === 's' || unit === 'sec' || unit.startsWith('second')) {
            ms = n * 1_000
        } else if (unit === 'm' || unit === 'min' || unit.startsWith('minute')) {
            ms = n * 60_000
        } else {
            ms = n * 3_600_000
        }
        return new Date(from.getTime() + ms)
    }

    // Standard 5-field cron (min hour dom mon dow)
    const fields = expr.trim().split(/\s+/)
    if (fields.length !== 5) throw new Error(`Invalid cron expression: "${expr}"`)

    const next = new Date(from)
    next.setSeconds(0, 0)
    next.setMinutes(next.getMinutes() + 1) // Start from next minute

    for (let attempts = 0; attempts < 366 * 24 * 60; attempts++) {
        if (_matchField(fields[1], next.getHours(), 0, 23)
            && _matchField(fields[0], next.getMinutes(), 0, 59)
            && _matchField(fields[2], next.getDate(), 1, 31)
            && _matchField(fields[3], next.getMonth() + 1, 1, 12)
            && _matchField(fields[4], next.getDay(), 0, 6)) {
            return next
        }
        next.setMinutes(next.getMinutes() + 1)
    }

    throw new Error(`Could not compute next run for cron: "${expr}"`)
}

function _matchField(field: string, value: number, _min: number, _max: number): boolean {
    if (field === '*') return true
    if (field.includes('/')) {
        const [, step] = field.split('/')
        return value % parseInt(step, 10) === 0
    }
    if (field.includes(',')) return field.split(',').map(Number).includes(value)
    if (field.includes('-')) {
        const [lo, hi] = field.split('-').map(Number)
        return value >= lo && value <= hi
    }
    return parseInt(field, 10) === value
}

// ─── CronScheduler ────────────────────────────────────────────────────────────

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
export class CronScheduler extends EventEmitter {
    private schedules = new Map<string, ScheduleEntry>()
    private timer: NodeJS.Timeout | null = null
    private enqueue: EnqueueFn

    /** BUG FIX: tracks in-flight schedule IDs to prevent concurrent double-fire */
    private inFlight = new Set<string>()

    /** Pause/resume state */
    private _paused = false

    private readonly persistPath: string | null
    private readonly db: any
    private schedCol: any = null
    private readonly tickMs: number

    constructor(options: CronSchedulerOptions, enqueue: EnqueueFn) {
        super()
        this.persistPath = options.persistPath ?? null
        this.db = options.db ?? null
        this.tickMs = options.tickMs ?? 1_000
        this.enqueue = enqueue
    }

    // ─── Lifecycle ─────────────────────────────────────────────────────────────

    /**
     * Initialize the scheduler: load persisted schedules and start ticking.
     *
     * @example
     * ```typescript
     * await cron.initialize()
     * ```
     */
    async initialize(): Promise<void> {
        if (this.db) {
            this.schedCol = this.db.collection('cron_schedules')
            await this.schedCol.createIndex({ id: 1 }, { unique: true, background: true }).catch(() => { /* index may already exist */ })
            await this._loadFromDb()
        } else if (this.persistPath) {
            this._load()
        }
        this._tick() // Compute missed runs
        this.timer = setInterval(() => this._tick(), this.tickMs)
        this.timer.unref?.()
    }

    /**
     * Stop ticking and save state. Call on graceful shutdown.
     *
     * @example
     * ```typescript
     * await cron.shutdown()
     * ```
     */
    async shutdown(): Promise<void> {
        if (this.timer) clearInterval(this.timer)
        this._save()
    }

    // ─── Schedule management ───────────────────────────────────────────────────

    /**
     * Add or replace a schedule. If a schedule with the same `id` exists, it is replaced.
     *
     * @example
     * ```typescript
     * cron.add({ id: 'stats', schedule: '0 * * * *', jobType: 'flush-stats', payload: {} })
     * ```
     */
    add(entry: {
        id: string
        schedule: string | number
        jobType: string
        payload?: unknown
        maxRuns?: number
        enabled?: boolean
    }): ScheduleEntry {
        const now = Date.now()
        const nextRunAt = this._computeNext(entry.schedule, now)

        const schedule: ScheduleEntry = {
            id: entry.id,
            schedule: entry.schedule,
            jobType: entry.jobType,
            payload: entry.payload ?? {},
            enabled: entry.enabled ?? true,
            nextRunAt,
            runCount: 0,
            lastRunAt: 0,
            maxRuns: entry.maxRuns ?? 0,
            createdAt: now,
        }

        this.schedules.set(entry.id, schedule)
        this._save()
        this._persistEntryToDb(schedule)
        this.emit('added', schedule)
        return schedule
    }

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
    addInterval(id: string, intervalMs: number, jobType: string, payload: unknown = {}, maxRuns = 0): ScheduleEntry {
        return this.add({ id, schedule: intervalMs, jobType, payload, maxRuns })
    }

    /**
     * Remove a schedule by ID.
     *
     * @example
     * ```typescript
     * cron.remove('daily-reset')
     * ```
     */
    remove(id: string): boolean {
        const removed = this.schedules.delete(id)
        if (removed) { this._save(); this._deleteEntryFromDb(id); this.emit('removed', id) }
        return removed
    }

    /**
     * Enable or disable a schedule without removing it.
     *
     * @example
     * ```typescript
     * cron.setEnabled('daily-reset', false) // pause this schedule
     * ```
     */
    setEnabled(id: string, enabled: boolean): boolean {
        const s = this.schedules.get(id)
        if (!s) return false
        s.enabled = enabled
        if (enabled) s.nextRunAt = this._computeNext(s.schedule, Date.now())
        this._save()
        this._persistEntryToDb(s)
        return true
    }

    /**
     * List all schedules, optionally filtered.
     *
     * @example
     * ```typescript
     * cron.list({ enabled: true })
     * ```
     */
    list(filter?: { enabled?: boolean }): ScheduleEntry[] {
        const all = [...this.schedules.values()]
        if (filter?.enabled != null) return all.filter(s => s.enabled === filter.enabled)
        return all
    }

    /**
     * Get a schedule by ID.
     *
     * @example
     * ```typescript
     * const s = cron.get('daily-reset')
     * ```
     */
    get(id: string): ScheduleEntry | null {
        return this.schedules.get(id) ?? null
    }

    /**
     * Force immediate run of a schedule (fire-and-forget, resets nextRunAt).
     *
     * @example
     * ```typescript
     * await cron.runNow('daily-reset')
     * ```
     */
    async runNow(id: string): Promise<string | null> {
        const s = this.schedules.get(id)
        if (!s) return null
        return this._fire(s)
    }

    // ─── Global pause/resume ──────────────────────────────────────────────────

    /**
     * Pause all schedule firing globally. Timer keeps running but no jobs fire.
     *
     * @example
     * ```typescript
     * cron.pause()
     * ```
     */
    pause(): void {
        this._paused = true
        this.emit('paused')
    }

    /**
     * Resume schedule firing after a global pause.
     *
     * @example
     * ```typescript
     * cron.resume()
     * ```
     */
    resume(): void {
        this._paused = false
        this.emit('resumed')
    }

    /**
     * Whether the scheduler is globally paused.
     *
     * @example
     * ```typescript
     * if (cron.isPaused) console.log('Scheduler is paused')
     * ```
     */
    get isPaused(): boolean {
        return this._paused
    }

    // ─── Tick ──────────────────────────────────────────────────────────────────

    /**
     * BUG FIX: uses inFlight set to prevent concurrent double-fire
     * when _tick() re-enters while _fire() is still awaiting.
     */
    private async _tick(): Promise<void> {
        if (this._paused) return

        const now = Date.now()
        for (const [, s] of this.schedules) {
            if (!s.enabled) continue
            if (now < s.nextRunAt) continue
            if (this.inFlight.has(s.id)) continue // already firing

            if (s.maxRuns > 0 && s.runCount >= s.maxRuns) {
                s.enabled = false
                this.emit('exhausted', s)
                continue
            }
            await this._fire(s)
        }
    }

    private async _fire(s: ScheduleEntry): Promise<string> {
        this.inFlight.add(s.id)
        const now = Date.now()
        s.runCount++
        s.lastRunAt = now
        s.nextRunAt = this._computeNext(s.schedule, now)

        try {
            const jobId = await this.enqueue({ type: s.jobType, payload: s.payload })
            this.emit('fired', s, jobId)
            this._save()
            this._persistEntryToDb(s)
            return jobId
        } catch (err) {
            this.emit('fire-error', s, err)
            return ''
        } finally {
            this.inFlight.delete(s.id)
        }
    }

    // ─── Internals ─────────────────────────────────────────────────────────────

    private _computeNext(schedule: string | number, fromMs: number): number {
        if (typeof schedule === 'number') return fromMs + schedule
        return parseCron(schedule, new Date(fromMs)).getTime()
    }

    private _save(): void {
        if (!this.persistPath) return
        try {
            const data = [...this.schedules.values()]
            writeFileSync(this.persistPath, JSON.stringify({ v: 1, schedules: data }), 'utf8')
        } catch { /* non-fatal */ }
    }

    private _load(): void {
        if (!this.persistPath || !existsSync(this.persistPath)) return
        try {
            const raw = JSON.parse(readFileSync(this.persistPath, 'utf8'))
            for (const entry of raw.schedules ?? []) {
                this.schedules.set(entry.id, entry)
            }
        } catch { /* corrupt snapshot */ }
    }

    // ─── Oblivinx3x persistence helpers ──────────────────────────────────────

    /** Upsert a single schedule entry into the Oblivinx3x collection (fire-and-forget). */
    private _persistEntryToDb(entry: ScheduleEntry): void {
        if (!this.schedCol) return
        this.schedCol.updateOne(
            { _id: entry.id },
            { $set: { ...entry, _id: entry.id } },
        ).catch(() => { /* non-fatal */ })
    }

    /** Delete a schedule entry from the Oblivinx3x collection (fire-and-forget). */
    private _deleteEntryFromDb(id: string): void {
        if (!this.schedCol) return
        this.schedCol.deleteOne({ _id: id }).catch(() => { /* non-fatal */ })
    }

    /** Load all schedules from the Oblivinx3x collection on startup. */
    private async _loadFromDb(): Promise<void> {
        if (!this.schedCol) return
        try {
            const docs = await this.schedCol.find({}) as any[]
            for (const doc of docs) {
                const { _id, ...entry } = doc as any
                this.schedules.set(entry.id ?? _id, { ...entry, id: entry.id ?? _id })
            }
        } catch { /* empty db or corrupt data */ }
    }
}