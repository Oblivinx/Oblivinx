"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WaBotContext = void 0;
const KvStore_js_1 = require("./KvStore.cjs");
const SortedSet_js_1 = require("./SortedSet.cjs");
const PubSub_js_1 = require("./PubSub.cjs");
const SessionStore_js_1 = require("./SessionStore.cjs");
// ─── WaBotContext ─────────────────────────────────────────────────────────────
/**
 * Central access point for all WhatsApp bot stores and scheduler.
 * Avoids passing kv, ss, pubsub, sessions separately to every handler.
 *
 * @example
 * ```typescript
 * const ctx = new WaBotContext({
 *   kv:       new KvStore({ persistPath: './data/kv.json' }),
 *   ss:       new SortedSet({ persistPath: './data/ss.json' }),
 *   pubsub:   new PubSub(),
 *   sessions: new SessionStore({ kv, pubsub }),
 *   cron:     new CronScheduler({ persistPath: './data/cron.json' }, enqueue),
 * })
 *
 * await ctx.initialize()
 *
 * // Shorthand methods
 * ctx.cooldown(userJid, 'daily', 86_400_000)
 * ctx.award('quiz', groupJid, userJid, 10)
 * ctx.startSession(userJid, groupJid, 'register', { step: 1 })
 * ctx.emit('game:start', { userJid, groupJid, gameType: 'quiz' })
 *
 * await ctx.shutdown()
 * ```
 */
class WaBotContext {
    /** Key-value store for cooldowns, rate limits, flags, hashes, lists */
    kv;
    /** Sorted set store for leaderboards and rankings */
    ss;
    /** Pub/sub for event-driven communication between handlers */
    pubsub;
    /** Multi-step conversation session manager */
    sessions;
    /** Cron/interval scheduler (null if not provided) */
    cron;
    constructor(options = {}) {
        this.kv = options.kv ?? new KvStore_js_1.KvStore();
        this.ss = options.ss ?? new SortedSet_js_1.SortedSet();
        this.pubsub = options.pubsub ?? new PubSub_js_1.PubSub();
        this.sessions = options.sessions ?? new SessionStore_js_1.SessionStore({ kv: this.kv, pubsub: this.pubsub });
        this.cron = options.cron ?? null;
    }
    // ─── Lifecycle ─────────────────────────────────────────────────────────────
    /**
     * Initialize all stores and scheduler. Call once at bot startup.
     *
     * @example
     * ```typescript
     * await ctx.initialize()
     * ```
     */
    async initialize() {
        if (this.cron)
            await this.cron.initialize();
    }
    /**
     * Gracefully shut down all stores and scheduler.
     * Saves snapshots. Call on SIGINT/SIGTERM.
     *
     * @example
     * ```typescript
     * process.on('SIGINT', () => ctx.shutdown())
     * ```
     */
    async shutdown() {
        if (this.cron)
            await this.cron.shutdown();
        await this.kv.shutdown();
        await this.ss.shutdown();
    }
    // ─── Cooldown / Rate helpers (wraps kv) ────────────────────────────────────
    /**
     * Set a cooldown. Returns false if already on cooldown.
     *
     * @example
     * ```typescript
     * if (!ctx.cooldown(userJid, 'daily', 86_400_000)) reply('Already claimed!')
     * ```
     */
    cooldown(userJid, command, ttlMs) {
        return this.kv.cooldown(`cd:${userJid}:${command}`, ttlMs);
    }
    /**
     * Check sliding-window rate limit for a user in a group.
     *
     * @example
     * ```typescript
     * const r = ctx.rateCheck(userJid, groupJid, 5, 10_000)
     * if (!r.allowed) return 'Slow down!'
     * ```
     */
    rateCheck(userJid, groupJid, limit, windowMs) {
        return this.kv.rateCheck(`rate:${userJid}:${groupJid}`, limit, windowMs);
    }
    /**
     * Acquire a lock (mutex) for a resource in a group.
     *
     * @example
     * ```typescript
     * if (!ctx.lock(groupJid, 'game', 30_000)) return 'Game already running!'
     * ```
     */
    lock(groupJid, resource, ttlMs) {
        return this.kv.setnx(`lock:${groupJid}:${resource}`, 1, ttlMs);
    }
    /**
     * Release a lock.
     *
     * @example
     * ```typescript
     * ctx.unlock(groupJid, 'game')
     * ```
     */
    unlock(groupJid, resource) {
        this.kv.del(`lock:${groupJid}:${resource}`);
    }
    /**
     * Check if a resource is locked.
     *
     * @example
     * ```typescript
     * if (ctx.isLocked(groupJid, 'game')) return 'Game in progress!'
     * ```
     */
    isLocked(groupJid, resource) {
        return this.kv.exists(`lock:${groupJid}:${resource}`) > 0;
    }
    // ─── Leaderboard helpers (wraps ss) ────────────────────────────────────────
    /**
     * Award points to a user and get their new rank.
     *
     * @example
     * ```typescript
     * const { newScore, rank } = ctx.award('quiz', groupJid, userJid, 10)
     * ```
     */
    award(gameType, groupJid, userJid, points) {
        return this.ss.award(gameType, groupJid, userJid, points);
    }
    /**
     * Get leaderboard for a game in a group.
     *
     * @example
     * ```typescript
     * const top10 = ctx.leaderboard('quiz', groupJid, 10)
     * ```
     */
    leaderboard(gameType, groupJid, limit = 10) {
        return this.ss.leaderboard(gameType, groupJid, limit);
    }
    // ─── PubSub helpers ────────────────────────────────────────────────────────
    /**
     * Publish an event to all subscribers.
     *
     * @example
     * ```typescript
     * ctx.emit('game:start', { userJid, groupJid, gameType: 'quiz' })
     * ```
     */
    emit(channel, payload) {
        return this.pubsub.publish(channel, payload);
    }
    /**
     * Subscribe to an event channel.
     *
     * @example
     * ```typescript
     * ctx.on('game:answer', ({ correct, points }) => { ... })
     * ```
     */
    on(channel, handler) {
        return this.pubsub.subscribe(channel, handler);
    }
    // ─── Session helpers ───────────────────────────────────────────────────────
    /**
     * Get current session for a user in a group.
     *
     * @example
     * ```typescript
     * const session = ctx.session(userJid, groupJid)
     * ```
     */
    session(userJid, groupJid) {
        return this.sessions.get(userJid, groupJid);
    }
    /**
     * Start a new session.
     *
     * @example
     * ```typescript
     * ctx.startSession(userJid, groupJid, 'register', { step: 1 })
     * ```
     */
    startSession(userJid, groupJid, step, data, ttlMs) {
        return this.sessions.start(userJid, groupJid, step, data, ttlMs);
    }
    /**
     * End a session.
     *
     * @example
     * ```typescript
     * ctx.endSession(userJid, groupJid)
     * ```
     */
    endSession(userJid, groupJid) {
        return this.sessions.end(userJid, groupJid);
    }
    // ─── Scheduler helpers ─────────────────────────────────────────────────────
    /**
     * Add a scheduled job. Throws if cron is not configured.
     *
     * @example
     * ```typescript
     * ctx.schedule('daily-reset', '0 0 * * *', 'daily-stats-reset', {})
     * ```
     */
    schedule(id, cronExpr, jobType, payload = {}) {
        if (!this.cron)
            throw new Error('[WaBotContext] CronScheduler not configured');
        this.cron.add({ id, schedule: cronExpr, jobType, payload });
    }
}
exports.WaBotContext = WaBotContext;
