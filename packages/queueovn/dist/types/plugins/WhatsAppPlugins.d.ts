import { KvStore } from '../stores/KvStore.js';
import { PubSub } from '../stores/PubSub.js';
import type { Job, JobPayload } from '../types/job.types.js';
import type { IPlugin } from '../types/plugin.types.js';
export type { IPlugin };
type WaJob = Job<JobPayload>;
export interface AntiSpamAction {
    action: 'warn' | 'mute' | 'kick' | 'ban' | 'ignore';
    /** For 'warn': how many warnings before escalating */
    warnThreshold?: number;
    /** For 'mute': duration in ms */
    muteDuration?: number;
}
export interface AntiSpamOptions {
    /** Max messages in window before triggering. Default: 5 */
    maxMessages?: number;
    /** Sliding window in ms. Default: 10_000 (10 seconds) */
    windowMs?: number;
    /** Action when limit exceeded. Default: { action: 'mute', muteDuration: 60_000 } */
    action?: AntiSpamAction;
    /** Job types to track. Default: tracks all jobs with payload.userJid + payload.groupJid */
    trackTypes?: string[];
    /** KvStore instance (shared with your bot). If not provided, creates own. */
    kv?: KvStore;
    /** PubSub to emit 'spam:detected' events. Optional. */
    pubsub?: PubSub;
    /** Users exempt from anti-spam (e.g. admins). */
    whitelist?: string[];
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
export declare class AntiSpamPlugin implements IPlugin {
    readonly name = "AntiSpam";
    private kv;
    private pubsub;
    private opts;
    constructor(options?: AntiSpamOptions);
    /**
     * onEnqueue hook — checks spam rate before job enters the queue.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue when a job is enqueued
     * ```
     */
    onEnqueue(job: WaJob): void;
}
export interface WaRateLimiterOptions {
    /**
     * Max messages per second per bot number.
     * WhatsApp unofficially allows ~1/sec sustained.
     * Default: 1
     */
    maxPerSecond?: number;
    /**
     * Max messages per minute (burst limit).
     * Default: 20
     */
    maxPerMinute?: number;
    /**
     * Job types that send WA messages and should be rate-limited.
     * Default: ['send-message', 'send-reply', 'send-media', 'broadcast']
     */
    sendTypes?: string[];
    /** Bot JID key to namespace limits. Default: 'default' */
    botKey?: string;
    kv?: KvStore;
    pubsub?: PubSub;
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
export declare class WaRateLimiterPlugin implements IPlugin {
    readonly name = "WaRateLimiter";
    private kv;
    private pubsub;
    private opts;
    constructor(options?: WaRateLimiterOptions);
    /**
     * onEnqueue hook — enforces per-second and per-minute WA rate limits.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue
     * ```
     */
    onEnqueue(job: WaJob): void;
}
export interface MessageBufferOptions {
    /**
     * How long to buffer responses before flushing (ms). Default: 300
     * Prevents rapid-fire responses from flooding a group.
     */
    bufferMs?: number;
    /**
     * Max messages to buffer per target before force-flush. Default: 5
     */
    maxBuffer?: number;
    /**
     * Job type that this plugin intercepts for buffering.
     * Default: 'send-message'
     */
    jobType?: string;
    kv?: KvStore;
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
export declare class MessageBufferPlugin implements IPlugin {
    readonly name = "MessageBuffer";
    private kv;
    private timers;
    private buffers;
    private flush;
    private opts;
    constructor(options?: MessageBufferOptions);
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
    onFlush(fn: (target: string, messages: string[]) => void): this;
    /**
     * onEnqueue hook — buffers the message and throws to discard the original job.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue
     * ```
     */
    onEnqueue(job: WaJob): void;
    /**
     * Shutdown the buffer plugin — clears all pending timers and flushes remaining buffers.
     *
     * @example
     * ```typescript
     * buffer.shutdown()
     * ```
     */
    shutdown(): void;
    private _doFlush;
}
export interface CommandCooldownOptions {
    /**
     * Default cooldown per command (ms). Default: 5_000
     */
    defaultCooldownMs?: number;
    /**
     * Per-command overrides: { 'daily': 86_400_000, 'game': 30_000 }
     */
    commandCooldowns?: Record<string, number>;
    /**
     * Field in job.payload that contains the command name.
     * Default: 'command'
     */
    commandField?: string;
    /**
     * Field in job.payload that contains the user JID.
     * Default: 'userJid'
     */
    userField?: string;
    /**
     * Admin JIDs that bypass cooldowns.
     */
    adminJids?: string[];
    kv?: KvStore;
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
export declare class CommandCooldownPlugin implements IPlugin {
    readonly name = "CommandCooldown";
    private kv;
    private opts;
    constructor(options?: CommandCooldownOptions);
    /**
     * onEnqueue hook — enforces per-user per-command cooldowns.
     *
     * @example
     * ```typescript
     * // Automatically called by JobQueue
     * ```
     */
    onEnqueue(job: WaJob): void;
    /**
     * Manually clear cooldown for a user+command (e.g. admin bypass).
     *
     * @example
     * ```typescript
     * cooldown.clear('628xxx@s.whatsapp.net', 'daily')
     * ```
     */
    clear(userJid: string, command: string): void;
    /**
     * Check remaining cooldown without triggering it.
     *
     * @example
     * ```typescript
     * const ms = cooldown.remaining('628xxx@s.whatsapp.net', 'daily')
     * ```
     */
    remaining(userJid: string, command: string): number;
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
    activeCooldowns(userJid: string): Record<string, number>;
    /**
     * Escape JID characters that could break glob pattern matching.
     */
    private _escapeJid;
}
