import { KvStore } from './KvStore.js';
import { SortedSet } from './SortedSet.js';
import { PubSub } from './PubSub.js';
import type { PubSubHandler, Subscription } from './PubSub.js';
import { SessionStore } from './SessionStore.js';
import type { SessionData } from './SessionStore.js';
import { CronScheduler } from '../scheduler/CronScheduler.js';
import type { WaBotContextOptions } from '../types/wa.types.js';
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
export declare class WaBotContext {
    /** Key-value store for cooldowns, rate limits, flags, hashes, lists */
    readonly kv: KvStore;
    /** Sorted set store for leaderboards and rankings */
    readonly ss: SortedSet;
    /** Pub/sub for event-driven communication between handlers */
    readonly pubsub: PubSub;
    /** Multi-step conversation session manager */
    readonly sessions: SessionStore;
    /** Cron/interval scheduler (null if not provided) */
    readonly cron: CronScheduler | null;
    constructor(options?: WaBotContextOptions);
    /**
     * Initialize all stores and scheduler. Call once at bot startup.
     *
     * @example
     * ```typescript
     * await ctx.initialize()
     * ```
     */
    initialize(): Promise<void>;
    /**
     * Gracefully shut down all stores and scheduler.
     * Saves snapshots. Call on SIGINT/SIGTERM.
     *
     * @example
     * ```typescript
     * process.on('SIGINT', () => ctx.shutdown())
     * ```
     */
    shutdown(): Promise<void>;
    /**
     * Set a cooldown. Returns false if already on cooldown.
     *
     * @example
     * ```typescript
     * if (!ctx.cooldown(userJid, 'daily', 86_400_000)) reply('Already claimed!')
     * ```
     */
    cooldown(userJid: string, command: string, ttlMs: number): boolean;
    /**
     * Check sliding-window rate limit for a user in a group.
     *
     * @example
     * ```typescript
     * const r = ctx.rateCheck(userJid, groupJid, 5, 10_000)
     * if (!r.allowed) return 'Slow down!'
     * ```
     */
    rateCheck(userJid: string, groupJid: string, limit: number, windowMs: number): {
        allowed: boolean;
        count: number;
        resetIn: number;
    };
    /**
     * Acquire a lock (mutex) for a resource in a group.
     *
     * @example
     * ```typescript
     * if (!ctx.lock(groupJid, 'game', 30_000)) return 'Game already running!'
     * ```
     */
    lock(groupJid: string, resource: string, ttlMs: number): boolean;
    /**
     * Release a lock.
     *
     * @example
     * ```typescript
     * ctx.unlock(groupJid, 'game')
     * ```
     */
    unlock(groupJid: string, resource: string): void;
    /**
     * Check if a resource is locked.
     *
     * @example
     * ```typescript
     * if (ctx.isLocked(groupJid, 'game')) return 'Game in progress!'
     * ```
     */
    isLocked(groupJid: string, resource: string): boolean;
    /**
     * Award points to a user and get their new rank.
     *
     * @example
     * ```typescript
     * const { newScore, rank } = ctx.award('quiz', groupJid, userJid, 10)
     * ```
     */
    award(gameType: string, groupJid: string, userJid: string, points: number): {
        newScore: number;
        rank: number;
    };
    /**
     * Get leaderboard for a game in a group.
     *
     * @example
     * ```typescript
     * const top10 = ctx.leaderboard('quiz', groupJid, 10)
     * ```
     */
    leaderboard(gameType: string, groupJid: string, limit?: number): Array<{
        rank: number;
        member: string;
        score: number;
    }>;
    /**
     * Publish an event to all subscribers.
     *
     * @example
     * ```typescript
     * ctx.emit('game:start', { userJid, groupJid, gameType: 'quiz' })
     * ```
     */
    emit(channel: string, payload: unknown): number;
    /**
     * Subscribe to an event channel.
     *
     * @example
     * ```typescript
     * ctx.on('game:answer', ({ correct, points }) => { ... })
     * ```
     */
    on<T = unknown>(channel: string, handler: PubSubHandler<T>): Subscription;
    /**
     * Get current session for a user in a group.
     *
     * @example
     * ```typescript
     * const session = ctx.session(userJid, groupJid)
     * ```
     */
    session<T = Record<string, unknown>>(userJid: string, groupJid: string): SessionData<T> | null;
    /**
     * Start a new session.
     *
     * @example
     * ```typescript
     * ctx.startSession(userJid, groupJid, 'register', { step: 1 })
     * ```
     */
    startSession<T = Record<string, unknown>>(userJid: string, groupJid: string, step: string, data?: T, ttlMs?: number): SessionData<T>;
    /**
     * End a session.
     *
     * @example
     * ```typescript
     * ctx.endSession(userJid, groupJid)
     * ```
     */
    endSession(userJid: string, groupJid: string): boolean;
    /**
     * Add a scheduled job. Throws if cron is not configured.
     *
     * @example
     * ```typescript
     * ctx.schedule('daily-reset', '0 0 * * *', 'daily-stats-reset', {})
     * ```
     */
    schedule(id: string, cronExpr: string | number, jobType: string, payload?: unknown): void;
}
