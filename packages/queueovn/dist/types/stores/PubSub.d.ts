import { EventEmitter } from 'node:events';
export type PubSubHandler<T = unknown> = (message: T, channel: string) => void | Promise<void>;
export interface PubSubOptions {
    /**
     * Max number of listeners per channel. Default: 100.
     */
    maxListeners?: number;
}
export interface Subscription {
    /** Unsubscribe this specific handler */
    unsubscribe(): void;
}
/**
 * In-process pub/sub with Redis-compatible API + pattern subscriptions.
 *
 * All publish/subscribe happens in the same Node.js process. For multi-process
 * bots using IpcRouter/IpcWorker, use `IpcPubSubBridge` (see below) which
 * routes messages through the IPC channel automatically.
 *
 * WhatsApp bot use cases:
 *  - 'group:join'       → welcome handler, leveling handler both subscribe
 *  - 'group:leave'      → goodbye, stats update
 *  - 'message:delete'   → antidelete handler
 *  - 'spam:detected'    → moderation handler
 *  - 'game:answer'      → scoring, streak update
 *  - 'level:up'         → announcement handler
 *  - 'economy:reward'   → balance update + notification
 *
 * @example
 * ```typescript
 * const pubsub = new PubSub()
 *
 * // Multiple independent handlers for same event
 * pubsub.subscribe('group:join', async ({ jid, groupJid }) => {
 *   await sendWelcome(jid, groupJid)
 * })
 * pubsub.subscribe('group:join', async ({ jid }) => {
 *   await levelingService.initUser(jid)
 * })
 *
 * // Publish from message handler
 * pubsub.publish('group:join', { jid, groupJid, timestamp: Date.now() })
 * ```
 */
export declare class PubSub extends EventEmitter {
    /** channel → Set of handlers */
    private channels;
    /** pattern → { regex, handlers } */
    private patterns;
    private readonly maxListeners;
    constructor(options?: PubSubOptions);
    /**
     * SUBSCRIBE — listen to an exact channel name.
     * Returns a Subscription object with `unsubscribe()`.
     *
     * @example
     * ```typescript
     * const sub = pubsub.subscribe('spam:detected', handler)
     * // Later:
     * sub.unsubscribe()
     * ```
     */
    subscribe<T = unknown>(channel: string, handler: PubSubHandler<T>): Subscription;
    /**
     * PSUBSCRIBE — subscribe using a glob pattern.
     * Supported: * (any chars), ? (one char)
     *
     * @example
     * ```typescript
     * pubsub.psubscribe('group:*', ({ groupJid }) => logGroupEvent(groupJid))
     * pubsub.psubscribe('game:answer:*', handler)
     * ```
     */
    psubscribe<T = unknown>(pattern: string, handler: PubSubHandler<T>): Subscription;
    /**
     * Subscribe and automatically unsubscribe after first message.
     * BUG FIX: invokes handler via _invoke() so async errors are properly caught.
     *
     * @example
     * ```typescript
     * pubsub.subscribeOnce('game:end', (result) => announceWinner(result))
     * ```
     */
    subscribeOnce<T = unknown>(channel: string, handler: PubSubHandler<T>): Subscription;
    /**
     * UNSUBSCRIBE — remove a specific handler from a channel.
     * If no handler provided, removes ALL handlers for that channel.
     *
     * @example
     * ```typescript
     * pubsub.unsubscribe('group:join', myHandler)
     * ```
     */
    unsubscribe(channel: string, handler?: PubSubHandler): void;
    /**
     * PUNSUBSCRIBE — remove a pattern subscription.
     *
     * @example
     * ```typescript
     * pubsub.punsubscribe('group:*', myHandler)
     * ```
     */
    punsubscribe(pattern: string, handler?: PubSubHandler): void;
    /**
     * PUBLISH — send a message to all subscribers of a channel.
     * Also triggers matching pattern subscribers.
     * Returns the number of handlers that received the message.
     *
     * Handler errors are caught and emitted as 'handler-error' events.
     *
     * @example
     * ```typescript
     * pubsub.publish('group:join', { jid, groupJid, timestamp: Date.now() })
     * ```
     */
    publish<T = unknown>(channel: string, message: T): number;
    /**
     * PUBSUB CHANNELS — list active channels matching a pattern.
     *
     * @example
     * ```typescript
     * pubsub.activeChannels('group:*')
     * ```
     */
    activeChannels(pattern?: string): string[];
    /**
     * PUBSUB NUMSUB — number of subscribers per channel.
     *
     * @example
     * ```typescript
     * pubsub.numSub('group:join', 'group:leave')
     * ```
     */
    numSub(...channels: string[]): Record<string, number>;
    /**
     * Wait for the next message on a channel, with optional timeout.
     * Useful for multi-step WA conversations where you wait for user reply.
     *
     * @example
     * ```typescript
     * await pubsub.publish('prompt:quiz:628xxx', { question: 'Ibukota Jawa Tengah?' })
     * const reply = await pubsub.waitFor('reply:628xxx:groupJid', 30_000)
     * if (!reply) return 'Waktu habis!'
     * ```
     */
    waitFor<T = unknown>(channel: string, timeoutMs?: number): Promise<T | null>;
    /**
     * Safely invoke a handler, catching sync throws and async rejections.
     * Async errors are emitted as 'handler-error' events.
     */
    private _invoke;
    private _globToRegex;
}
/**
 * Type-safe pub/sub wrapper over `PubSub`.
 * Constrains channels and payloads to a known event map.
 *
 * @example
 * ```typescript
 * import { TypedPubSub, WaBotEvents } from 'wa-job-queue'
 *
 * const pubsub = new TypedPubSub<WaBotEvents>()
 * pubsub.subscribe('group:join', ({ jid, groupJid, name }) => {
 *   // jid, groupJid, name are all fully typed!
 * })
 * pubsub.publish('group:join', { jid: '628xxx', groupJid: 'g1', name: 'Budi', timestamp: Date.now() })
 * ```
 */
export declare class TypedPubSub<TEvents extends Record<string, unknown>> {
    private readonly inner;
    constructor(options?: PubSubOptions);
    /**
     * Type-safe subscribe to a known event channel.
     *
     * @example
     * ```typescript
     * typed.subscribe('game:answer', ({ correct, points }) => { })
     * ```
     */
    subscribe<K extends keyof TEvents & string>(channel: K, handler: (message: TEvents[K], channel: string) => void | Promise<void>): Subscription;
    /**
     * Type-safe publish to a known event channel.
     *
     * @example
     * ```typescript
     * typed.publish('game:answer', { userJid: '628xxx', groupJid: 'g1', gameType: 'quiz', correct: true, points: 10 })
     * ```
     */
    publish<K extends keyof TEvents & string>(channel: K, message: TEvents[K]): number;
    /**
     * Type-safe subscribe-once.
     *
     * @example
     * ```typescript
     * typed.subscribeOnce('game:end', (result) => announceWinner(result))
     * ```
     */
    subscribeOnce<K extends keyof TEvents & string>(channel: K, handler: (message: TEvents[K], channel: string) => void | Promise<void>): Subscription;
    /**
     * Type-safe waitFor.
     *
     * @example
     * ```typescript
     * const event = await typed.waitFor('level:up', 30_000)
     * ```
     */
    waitFor<K extends keyof TEvents & string>(channel: K, timeoutMs?: number): Promise<TEvents[K] | null>;
    /**
     * Unsubscribe a handler from a channel.
     *
     * @example
     * ```typescript
     * typed.unsubscribe('group:join', myHandler)
     * ```
     */
    unsubscribe<K extends keyof TEvents & string>(channel: K, handler?: (message: TEvents[K], channel: string) => void | Promise<void>): void;
    /**
     * List active channels.
     *
     * @example
     * ```typescript
     * typed.activeChannels()
     * ```
     */
    activeChannels(pattern?: string): string[];
    /**
     * Get subscriber counts per channel.
     *
     * @example
     * ```typescript
     * typed.numSub('group:join')
     * ```
     */
    numSub(...channels: Array<keyof TEvents & string>): Record<string, number>;
    /**
     * Access the underlying untyped PubSub instance.
     * Useful when you need pattern subscriptions or other advanced features.
     *
     * @example
     * ```typescript
     * typed.raw.psubscribe('game:*', handler)
     * ```
     */
    get raw(): PubSub;
}
/**
 * Bridges pub/sub across IPC processes (IpcRouter/IpcWorker).
 * Install in main process to forward published messages to all shards.
 *
 * @example
 * ```typescript
 * // Main process
 * const bridge = new IpcPubSubBridge(router, pubsub)
 *
 * // Child shard process — publish fires in all shards automatically
 * pubsub.publish('group:join', payload)
 * ```
 */
export declare class IpcPubSubBridge {
    private router;
    private pubsub;
    private shardKeys;
    constructor(router: {
        enqueue: (opts: {
            shardKey: string;
            type: string;
            payload: unknown;
        }) => Promise<string>;
    }, pubsub: PubSub, shardKeys: () => string[]);
    /**
     * Call this in each child shard's IpcWorker to deliver routed messages.
     *
     * @example
     * ```typescript
     * worker.register('__pubsub:deliver__', IpcPubSubBridge.deliverHandler(pubsub))
     * ```
     */
    static deliverHandler(pubsub: PubSub): (payload: {
        channel: string;
        message: unknown;
    }) => Promise<void>;
}
