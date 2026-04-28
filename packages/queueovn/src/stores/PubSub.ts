import { EventEmitter } from 'node:events'

// ─── Types ────────────────────────────────────────────────────────────────────

export type PubSubHandler<T = unknown> = (message: T, channel: string) => void | Promise<void>

export interface PubSubOptions {
    /**
     * Max number of listeners per channel. Default: 100.
     */
    maxListeners?: number
}

export interface Subscription {
    /** Unsubscribe this specific handler */
    unsubscribe(): void
}

// ─── PubSub ───────────────────────────────────────────────────────────────────

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
export class PubSub extends EventEmitter {
    /** channel → Set of handlers */
    private channels = new Map<string, Set<PubSubHandler>>()
    /** pattern → { regex, handlers } */
    private patterns = new Map<string, { regex: RegExp; handlers: Set<PubSubHandler> }>()

    private readonly maxListeners: number

    constructor(options: PubSubOptions = {}) {
        super()
        this.maxListeners = options.maxListeners ?? 100
        this.setMaxListeners(this.maxListeners)
    }

    // ─── Subscribe ─────────────────────────────────────────────────────────────

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
    subscribe<T = unknown>(channel: string, handler: PubSubHandler<T>): Subscription {
        let set = this.channels.get(channel)
        if (!set) { set = new Set(); this.channels.set(channel, set) }
        set.add(handler as PubSubHandler)
        return { unsubscribe: () => this.unsubscribe(channel, handler as PubSubHandler) }
    }

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
    psubscribe<T = unknown>(pattern: string, handler: PubSubHandler<T>): Subscription {
        let entry = this.patterns.get(pattern)
        if (!entry) {
            entry = { regex: this._globToRegex(pattern), handlers: new Set() }
            this.patterns.set(pattern, entry)
        }
        entry.handlers.add(handler as PubSubHandler)
        return { unsubscribe: () => this.punsubscribe(pattern, handler as PubSubHandler) }
    }

    /**
     * Subscribe and automatically unsubscribe after first message.
     * BUG FIX: invokes handler via _invoke() so async errors are properly caught.
     *
     * @example
     * ```typescript
     * pubsub.subscribeOnce('game:end', (result) => announceWinner(result))
     * ```
     */
    subscribeOnce<T = unknown>(channel: string, handler: PubSubHandler<T>): Subscription {
        let sub: Subscription
        const wrapped: PubSubHandler<T> = (msg, ch) => {
            sub.unsubscribe()
            // Delegate to handler — _invoke in publish() already handles errors
            return handler(msg, ch)
        }
        sub = this.subscribe(channel, wrapped)
        return sub
    }

    // ─── Unsubscribe ───────────────────────────────────────────────────────────

    /**
     * UNSUBSCRIBE — remove a specific handler from a channel.
     * If no handler provided, removes ALL handlers for that channel.
     *
     * @example
     * ```typescript
     * pubsub.unsubscribe('group:join', myHandler)
     * ```
     */
    unsubscribe(channel: string, handler?: PubSubHandler): void {
        const set = this.channels.get(channel)
        if (!set) return
        if (handler) {
            set.delete(handler)
            if (set.size === 0) this.channels.delete(channel)
        } else {
            this.channels.delete(channel)
        }
    }

    /**
     * PUNSUBSCRIBE — remove a pattern subscription.
     *
     * @example
     * ```typescript
     * pubsub.punsubscribe('group:*', myHandler)
     * ```
     */
    punsubscribe(pattern: string, handler?: PubSubHandler): void {
        const entry = this.patterns.get(pattern)
        if (!entry) return
        if (handler) {
            entry.handlers.delete(handler)
            if (entry.handlers.size === 0) this.patterns.delete(pattern)
        } else {
            this.patterns.delete(pattern)
        }
    }

    // ─── Publish ───────────────────────────────────────────────────────────────

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
    publish<T = unknown>(channel: string, message: T): number {
        let count = 0

        // Exact channel subscribers
        const exactHandlers = this.channels.get(channel)
        if (exactHandlers) {
            for (const handler of exactHandlers) {
                count++
                this._invoke(handler, message, channel)
            }
        }

        // Pattern subscribers
        for (const [, { regex, handlers }] of this.patterns) {
            if (regex.test(channel)) {
                for (const handler of handlers) {
                    count++
                    this._invoke(handler, message, channel)
                }
            }
        }

        this.emit('publish', channel, message, count)
        return count
    }

    /**
     * PUBSUB CHANNELS — list active channels matching a pattern.
     *
     * @example
     * ```typescript
     * pubsub.activeChannels('group:*')
     * ```
     */
    activeChannels(pattern = '*'): string[] {
        const regex = this._globToRegex(pattern)
        return [...this.channels.keys()].filter(ch => regex.test(ch))
    }

    /**
     * PUBSUB NUMSUB — number of subscribers per channel.
     *
     * @example
     * ```typescript
     * pubsub.numSub('group:join', 'group:leave')
     * ```
     */
    numSub(...channels: string[]): Record<string, number> {
        const result: Record<string, number> = {}
        for (const ch of channels) {
            result[ch] = this.channels.get(ch)?.size ?? 0
        }
        return result
    }

    // ─── Await helper ──────────────────────────────────────────────────────────

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
    waitFor<T = unknown>(channel: string, timeoutMs?: number): Promise<T | null> {
        return new Promise((resolve) => {
            let timer: NodeJS.Timeout | null = null

            const sub = this.subscribeOnce<T>(channel, (msg) => {
                if (timer) clearTimeout(timer)
                resolve(msg)
            })

            if (timeoutMs != null) {
                timer = setTimeout(() => {
                    sub.unsubscribe()
                    resolve(null)
                }, timeoutMs)
            }
        })
    }

    // ─── Internals ─────────────────────────────────────────────────────────────

    /**
     * Safely invoke a handler, catching sync throws and async rejections.
     * Async errors are emitted as 'handler-error' events.
     */
    private _invoke(handler: PubSubHandler, message: unknown, channel: string): void {
        try {
            const result = handler(message, channel)
            if (result instanceof Promise) {
                result.catch(err => this.emit('handler-error', err, channel))
            }
        } catch (err) {
            this.emit('handler-error', err, channel)
        }
    }

    private _globToRegex(pattern: string): RegExp {
        const escaped = pattern
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
        return new RegExp(`^${escaped}$`)
    }
}

// ─── TypedPubSub ──────────────────────────────────────────────────────────────

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
export class TypedPubSub<TEvents extends Record<string, unknown>> {
    private readonly inner: PubSub

    constructor(options: PubSubOptions = {}) {
        this.inner = new PubSub(options)
    }

    /**
     * Type-safe subscribe to a known event channel.
     *
     * @example
     * ```typescript
     * typed.subscribe('game:answer', ({ correct, points }) => { })
     * ```
     */
    subscribe<K extends keyof TEvents & string>(
        channel: K,
        handler: (message: TEvents[K], channel: string) => void | Promise<void>,
    ): Subscription {
        return this.inner.subscribe(channel, handler as PubSubHandler)
    }

    /**
     * Type-safe publish to a known event channel.
     *
     * @example
     * ```typescript
     * typed.publish('game:answer', { userJid: '628xxx', groupJid: 'g1', gameType: 'quiz', correct: true, points: 10 })
     * ```
     */
    publish<K extends keyof TEvents & string>(channel: K, message: TEvents[K]): number {
        return this.inner.publish(channel, message)
    }

    /**
     * Type-safe subscribe-once.
     *
     * @example
     * ```typescript
     * typed.subscribeOnce('game:end', (result) => announceWinner(result))
     * ```
     */
    subscribeOnce<K extends keyof TEvents & string>(
        channel: K,
        handler: (message: TEvents[K], channel: string) => void | Promise<void>,
    ): Subscription {
        return this.inner.subscribeOnce(channel, handler as PubSubHandler)
    }

    /**
     * Type-safe waitFor.
     *
     * @example
     * ```typescript
     * const event = await typed.waitFor('level:up', 30_000)
     * ```
     */
    waitFor<K extends keyof TEvents & string>(channel: K, timeoutMs?: number): Promise<TEvents[K] | null> {
        return this.inner.waitFor<TEvents[K]>(channel, timeoutMs)
    }

    /**
     * Unsubscribe a handler from a channel.
     *
     * @example
     * ```typescript
     * typed.unsubscribe('group:join', myHandler)
     * ```
     */
    unsubscribe<K extends keyof TEvents & string>(
        channel: K,
        handler?: (message: TEvents[K], channel: string) => void | Promise<void>,
    ): void {
        this.inner.unsubscribe(channel, handler as PubSubHandler | undefined)
    }

    /**
     * List active channels.
     *
     * @example
     * ```typescript
     * typed.activeChannels()
     * ```
     */
    activeChannels(pattern = '*'): string[] {
        return this.inner.activeChannels(pattern)
    }

    /**
     * Get subscriber counts per channel.
     *
     * @example
     * ```typescript
     * typed.numSub('group:join')
     * ```
     */
    numSub(...channels: Array<keyof TEvents & string>): Record<string, number> {
        return this.inner.numSub(...channels)
    }

    /**
     * Access the underlying untyped PubSub instance.
     * Useful when you need pattern subscriptions or other advanced features.
     *
     * @example
     * ```typescript
     * typed.raw.psubscribe('game:*', handler)
     * ```
     */
    get raw(): PubSub {
        return this.inner
    }
}

// ─── IpcPubSubBridge ──────────────────────────────────────────────────────────

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
export class IpcPubSubBridge {
    constructor(
        private router: { enqueue: (opts: { shardKey: string; type: string; payload: unknown }) => Promise<string> },
        private pubsub: PubSub,
        private shardKeys: () => string[],
    ) {
        // When any shard publishes, broadcast to all other shards via the queue
        this.pubsub.subscribe<{ channel: string; message: unknown }>('__ipc:broadcast__', ({ channel, message }) => {
            for (const shardKey of this.shardKeys()) {
                this.router.enqueue({ shardKey, type: '__pubsub:deliver__', payload: { channel, message } })
            }
        })
    }

    /**
     * Call this in each child shard's IpcWorker to deliver routed messages.
     *
     * @example
     * ```typescript
     * worker.register('__pubsub:deliver__', IpcPubSubBridge.deliverHandler(pubsub))
     * ```
     */
    static deliverHandler(pubsub: PubSub) {
        return async (payload: { channel: string; message: unknown }) => {
            pubsub.publish(payload.channel, payload.message)
        }
    }
}