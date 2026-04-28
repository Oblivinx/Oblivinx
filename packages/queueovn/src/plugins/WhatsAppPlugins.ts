import { KvStore } from '../stores/KvStore.js'
import { PubSub } from '../stores/PubSub.js'
import type { Job, JobPayload } from '../types/job.types.js'
import type { IPlugin } from '../types/plugin.types.js'

// ─── Re-export types for convenience ──────────────────────────────────────────

export type { IPlugin }

// ─── Minimal internal job shape for WA plugins ───────────────────────────────
// WA plugins use onEnqueue hook, which receives the full Job<T> from core.
// We define a narrow type alias to avoid requiring the entire Job interface
// at the call sites (payload field is always Record<string, unknown>).

type WaJob = Job<JobPayload>

// ─── 1. AntiSpam Plugin ───────────────────────────────────────────────────────

export interface AntiSpamAction {
    action: 'warn' | 'mute' | 'kick' | 'ban' | 'ignore'
    /** For 'warn': how many warnings before escalating */
    warnThreshold?: number
    /** For 'mute': duration in ms */
    muteDuration?: number
}

export interface AntiSpamOptions {
    /** Max messages in window before triggering. Default: 5 */
    maxMessages?: number
    /** Sliding window in ms. Default: 10_000 (10 seconds) */
    windowMs?: number
    /** Action when limit exceeded. Default: { action: 'mute', muteDuration: 60_000 } */
    action?: AntiSpamAction
    /** Job types to track. Default: tracks all jobs with payload.userJid + payload.groupJid */
    trackTypes?: string[]
    /** KvStore instance (shared with your bot). If not provided, creates own. */
    kv?: KvStore
    /** PubSub to emit 'spam:detected' events. Optional. */
    pubsub?: PubSub
    /** Users exempt from anti-spam (e.g. admins). */
    whitelist?: string[]
}

/**
 * Anti-spam plugin for wa-job-queue.
 * Uses sliding window counter (backed by KvStore) to detect message floods.
 *
 * Add to your message-processing queue. Each job must have:
 *   payload.userJid  — sender JID
 *   payload.groupJid — group JID
 *
 * @example
 * ```typescript
 * const antiSpam = new AntiSpamPlugin({
 *   maxMessages: 5,
 *   windowMs: 10_000,
 *   action: { action: 'mute', muteDuration: 5 * 60_000 },
 *   pubsub,
 * })
 *
 * const queue = new JobQueue({ name: 'messages', plugins: [antiSpam] })
 *
 * queue.on('spam:detected', ({ userJid, groupJid, count, action }) => {
 *   // Execute the action in your WA client
 *   if (action === 'mute') waClient.mute(groupJid, userJid, muteDuration)
 * })
 * ```
 */
export class AntiSpamPlugin implements IPlugin {
    readonly name = 'AntiSpam'
    private kv: KvStore
    private pubsub: PubSub | null
    private opts: Omit<Required<AntiSpamOptions>, 'pubsub'> & { pubsub: PubSub | null }

    constructor(options: AntiSpamOptions = {}) {
        this.opts = {
            maxMessages: options.maxMessages ?? 5,
            windowMs: options.windowMs ?? 10_000,
            action: options.action ?? { action: 'mute', muteDuration: 60_000 },
            trackTypes: options.trackTypes ?? [],
            kv: options.kv ?? new KvStore(),
            pubsub: options.pubsub ?? null,
            whitelist: options.whitelist ?? [],
        }
        this.kv = this.opts.kv
        this.pubsub = this.opts.pubsub
    }

    /**
     * onEnqueue hook — checks spam rate before job enters the queue.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue when a job is enqueued
     * ```
     */
    onEnqueue(job: WaJob): void {
        const { userJid, groupJid } = job.payload
        if (!userJid || !groupJid) return
        if (this.opts.trackTypes.length > 0 && !this.opts.trackTypes.includes(job.type)) return
        if (this.opts.whitelist.includes(userJid as string)) return

        const key = `antispam:${userJid}:${groupJid}`
        const { allowed, count } = this.kv.rateCheck(key, this.opts.maxMessages, this.opts.windowMs)

        if (!allowed) {
            const actionPayload = {
                userJid,
                groupJid,
                count,
                action: this.opts.action.action,
                muteDuration: this.opts.action.muteDuration,
                detectedAt: Date.now(),
            }
            this.pubsub?.publish('spam:detected', actionPayload)
            throw Object.assign(new Error(`[AntiSpam] Flood detected: ${userJid} in ${groupJid} (${count} msgs)`), {
                code: 'SPAM_DETECTED',
                payload: actionPayload,
            })
        }
    }
}

// ─── 2. WaMessageRateLimiter Plugin ──────────────────────────────────────────

export interface WaRateLimiterOptions {
    /**
     * Max messages per second per bot number.
     * WhatsApp unofficially allows ~1/sec sustained.
     * Default: 1
     */
    maxPerSecond?: number
    /**
     * Max messages per minute (burst limit).
     * Default: 20
     */
    maxPerMinute?: number
    /**
     * Job types that send WA messages and should be rate-limited.
     * Default: ['send-message', 'send-reply', 'send-media', 'broadcast']
     */
    sendTypes?: string[]
    /** Bot JID key to namespace limits. Default: 'default' */
    botKey?: string
    kv?: KvStore
    pubsub?: PubSub
}

/**
 * Rate limiter that respects WhatsApp's unofficial send limits.
 * Throws if the per-second or per-minute limit is exceeded.
 *
 * Use with wa-job-queue's built-in Throttle or as a standalone plugin.
 * The queue's retry mechanism handles the re-enqueueing automatically.
 *
 * @example
 * ```typescript
 * const waRateLimit = new WaRateLimiterPlugin({ maxPerSecond: 1, botKey: 'bot-001' })
 * const queue = new JobQueue({
 *   name: 'send',
 *   plugins: [waRateLimit],
 *   workers: { min: 1, max: 1 }, // Important: single worker for ordered sends
 * })
 * ```
 */
export class WaRateLimiterPlugin implements IPlugin {
    readonly name = 'WaRateLimiter'
    private kv: KvStore
    private pubsub: PubSub | null
    private opts: Omit<Required<WaRateLimiterOptions>, 'pubsub'> & { pubsub: PubSub | null }

    constructor(options: WaRateLimiterOptions = {}) {
        this.opts = {
            maxPerSecond: options.maxPerSecond ?? 1,
            maxPerMinute: options.maxPerMinute ?? 20,
            sendTypes: options.sendTypes ?? ['send-message', 'send-reply', 'send-media', 'broadcast'],
            botKey: options.botKey ?? 'default',
            kv: options.kv ?? new KvStore(),
            pubsub: options.pubsub ?? null,
        }
        this.kv = this.opts.kv
        this.pubsub = this.opts.pubsub
    }

    /**
     * onEnqueue hook — enforces per-second and per-minute WA rate limits.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue
     * ```
     */
    onEnqueue(job: WaJob): void {
        if (!this.opts.sendTypes.includes(job.type)) return

        const secKey = `wa-rate:${this.opts.botKey}:sec`
        const minKey = `wa-rate:${this.opts.botKey}:min`

        const perSec = this.kv.rateCheck(secKey, this.opts.maxPerSecond, 1_000)
        const perMin = this.kv.rateCheck(minKey, this.opts.maxPerMinute, 60_000)

        if (!perSec.allowed) {
            this.pubsub?.publish('wa-rate:throttled', { botKey: this.opts.botKey, scope: 'second', job })
            throw Object.assign(new Error(`[WaRateLimit] Per-second limit hit for bot ${this.opts.botKey}`), {
                code: 'WA_RATE_LIMIT',
                retryAfterMs: perSec.resetIn,
            })
        }

        if (!perMin.allowed) {
            this.pubsub?.publish('wa-rate:throttled', { botKey: this.opts.botKey, scope: 'minute', job })
            throw Object.assign(new Error(`[WaRateLimit] Per-minute limit hit for bot ${this.opts.botKey}`), {
                code: 'WA_RATE_LIMIT',
                retryAfterMs: perMin.resetIn,
            })
        }
    }
}

// ─── 3. MessageBufferPlugin ───────────────────────────────────────────────────

export interface MessageBufferOptions {
    /**
     * How long to buffer responses before flushing (ms). Default: 300
     * Prevents rapid-fire responses from flooding a group.
     */
    bufferMs?: number
    /**
     * Max messages to buffer per target before force-flush. Default: 5
     */
    maxBuffer?: number
    /**
     * Job type that this plugin intercepts for buffering.
     * Default: 'send-message'
     */
    jobType?: string
    kv?: KvStore
}

/**
 * Buffers multiple send-message jobs for the same target (groupJid/userJid)
 * and coalesces them into a single batched send.
 *
 * Useful when multiple handlers respond to the same event simultaneously.
 * Instead of 4 separate sends (4 × WA round trips), they get merged.
 *
 * BUG FIX: Added `shutdown()` method to clear all pending timers.
 *
 * @example
 * ```typescript
 * // Without buffer: user gets 4 messages in rapid succession
 * // With buffer: user gets 1 merged message after 300ms
 *
 * const buffer = new MessageBufferPlugin({ bufferMs: 300 })
 * const queue = new JobQueue({ name: 'send', plugins: [buffer] })
 * ```
 */
export class MessageBufferPlugin implements IPlugin {
    readonly name = 'MessageBuffer'
    private kv: KvStore
    private timers = new Map<string, NodeJS.Timeout>()
    private buffers = new Map<string, string[]>()
    private flush: ((target: string, messages: string[]) => void) | null = null
    private opts: Required<MessageBufferOptions>

    constructor(options: MessageBufferOptions = {}) {
        this.opts = {
            bufferMs: options.bufferMs ?? 300,
            maxBuffer: options.maxBuffer ?? 5,
            jobType: options.jobType ?? 'send-message',
            kv: options.kv ?? new KvStore(),
        }
        this.kv = this.opts.kv
    }

    /**
     * Register the flush callback — called with merged messages when buffer flushes.
     *
     * @example
     * ```typescript
     * buffer.onFlush(async (target, messages) => {
     *   await waClient.sendMessage(target, messages.join('\n'))
     * })
     * ```
     */
    onFlush(fn: (target: string, messages: string[]) => void): this {
        this.flush = fn
        return this
    }

    /**
     * onEnqueue hook — buffers the message and throws to discard the original job.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue
     * ```
     */
    onEnqueue(job: WaJob): void {
        if (job.type !== this.opts.jobType) return
        const target = (job.payload.to ?? job.payload.groupJid ?? job.payload.userJid) as string
        const text = job.payload.text as string
        if (!target || !text) return

        // Buffer the message
        let buf = this.buffers.get(target)
        if (!buf) { buf = []; this.buffers.set(target, buf) }
        buf.push(text)

        // Cancel existing timer
        const existing = this.timers.get(target)
        if (existing) clearTimeout(existing)

        // Force flush if buffer is full
        if (buf.length >= this.opts.maxBuffer) {
            this._doFlush(target)
            return
        }

        // Schedule flush
        const timer = setTimeout(() => this._doFlush(target), this.opts.bufferMs)
        this.timers.set(target, timer)

        // Signal to queue to discard original job (we'll handle sending in flush)
        throw Object.assign(new Error('[MessageBuffer] Buffered — will flush'), { code: 'BUFFERED', silent: true })
    }

    /**
     * Shutdown the buffer plugin — clears all pending timers and flushes remaining buffers.
     *
     * @example
     * ```typescript
     * buffer.shutdown()
     * ```
     */
    shutdown(): void {
        for (const [target, timer] of this.timers) {
            clearTimeout(timer)
            this._doFlush(target)
        }
        this.timers.clear()
        this.buffers.clear()
    }

    private _doFlush(target: string): void {
        const messages = this.buffers.get(target)
        if (!messages?.length) return
        this.buffers.delete(target)
        this.timers.delete(target)
        this.flush?.(target, messages)
    }
}

// ─── 4. CommandCooldown Plugin ───────────────────────────────────────────────

export interface CommandCooldownOptions {
    /**
     * Default cooldown per command (ms). Default: 5_000
     */
    defaultCooldownMs?: number
    /**
     * Per-command overrides: { 'daily': 86_400_000, 'game': 30_000 }
     */
    commandCooldowns?: Record<string, number>
    /**
     * Field in job.payload that contains the command name.
     * Default: 'command'
     */
    commandField?: string
    /**
     * Field in job.payload that contains the user JID.
     * Default: 'userJid'
     */
    userField?: string
    /**
     * Admin JIDs that bypass cooldowns.
     */
    adminJids?: string[]
    kv?: KvStore
}

/**
 * Per-user, per-command cooldown plugin.
 * Replaces the CommandCooldown DB model entirely.
 *
 * BUG FIX: `activeCooldowns()` properly escapes JID characters
 * that could break KvStore glob patterns.
 *
 * @example
 * ```typescript
 * const cooldown = new CommandCooldownPlugin({
 *   defaultCooldownMs: 5_000,
 *   commandCooldowns: {
 *     daily:  86_400_000, // 24 hours
 *     weekly: 7 * 86_400_000,
 *     game:   30_000,
 *     quiz:   10_000,
 *   },
 *   adminJids: ['6281234567890@s.whatsapp.net'],
 * })
 * ```
 */
export class CommandCooldownPlugin implements IPlugin {
    readonly name = 'CommandCooldown'
    private kv: KvStore
    private opts: Required<CommandCooldownOptions>

    constructor(options: CommandCooldownOptions = {}) {
        this.opts = {
            defaultCooldownMs: options.defaultCooldownMs ?? 5_000,
            commandCooldowns: options.commandCooldowns ?? {},
            commandField: options.commandField ?? 'command',
            userField: options.userField ?? 'userJid',
            adminJids: options.adminJids ?? [],
            kv: options.kv ?? new KvStore(),
        }
        this.kv = this.opts.kv
    }

    /**
     * onEnqueue hook — enforces per-user per-command cooldowns.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue
     * ```
     */
    onEnqueue(job: WaJob): void {
        const command = job.payload[this.opts.commandField] as string
        const userJid = job.payload[this.opts.userField] as string
        if (!command || !userJid) return
        if (this.opts.adminJids.includes(userJid)) return

        const ttlMs = this.opts.commandCooldowns[command] ?? this.opts.defaultCooldownMs
        const key = `cmd-cooldown:${userJid}:${command}`
        const remaining = this.kv.ttl(key)

        if (remaining > 0) {
            throw Object.assign(
                new Error(`[Cooldown] Command "${command}" on cooldown for ${userJid} (${remaining}ms remaining)`),
                { code: 'ON_COOLDOWN', command, userJid, remainingMs: remaining },
            )
        }

        this.kv.cooldown(key, ttlMs)
    }

    /**
     * Manually clear cooldown for a user+command (e.g. admin bypass).
     *
     * @example
     * ```typescript
     * cooldown.clear('628xxx@s.whatsapp.net', 'daily')
     * ```
     */
    clear(userJid: string, command: string): void {
        this.kv.del(`cmd-cooldown:${userJid}:${command}`)
    }

    /**
     * Check remaining cooldown without triggering it.
     *
     * @example
     * ```typescript
     * const ms = cooldown.remaining('628xxx@s.whatsapp.net', 'daily')
     * ```
     */
    remaining(userJid: string, command: string): number {
        const ttl = this.kv.ttl(`cmd-cooldown:${userJid}:${command}`)
        return ttl < 0 ? 0 : ttl
    }

    /**
     * Get all active cooldowns for a user.
     * BUG FIX: escapes JID characters that could break glob patterns.
     *
     * @example
     * ```typescript
     * const active = cooldown.activeCooldowns('628xxx@s.whatsapp.net')
     * // { daily: 82000, game: 5000 }
     * ```
     */
    activeCooldowns(userJid: string): Record<string, number> {
        const escaped = this._escapeJid(userJid)
        const keys = this.kv.keys(`cmd-cooldown:${escaped}:*`)
        const result: Record<string, number> = {}
        for (const key of keys) {
            const command = key.split(':').pop() ?? ''
            result[command] = Math.max(0, this.kv.ttl(key))
        }
        return result
    }

    /**
     * Escape JID characters that could break glob pattern matching.
     */
    private _escapeJid(jid: string): string {
        return jid.replace(/[^a-zA-Z0-9@._-]/g, '_')
    }
}