import { EventEmitter } from 'node:events';
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
    channels = new Map();
    /** pattern → { regex, handlers } */
    patterns = new Map();
    maxListeners;
    constructor(options = {}) {
        super();
        this.maxListeners = options.maxListeners ?? 100;
        this.setMaxListeners(this.maxListeners);
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
    subscribe(channel, handler) {
        let set = this.channels.get(channel);
        if (!set) {
            set = new Set();
            this.channels.set(channel, set);
        }
        set.add(handler);
        return { unsubscribe: () => this.unsubscribe(channel, handler) };
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
    psubscribe(pattern, handler) {
        let entry = this.patterns.get(pattern);
        if (!entry) {
            entry = { regex: this._globToRegex(pattern), handlers: new Set() };
            this.patterns.set(pattern, entry);
        }
        entry.handlers.add(handler);
        return { unsubscribe: () => this.punsubscribe(pattern, handler) };
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
    subscribeOnce(channel, handler) {
        let sub;
        const wrapped = (msg, ch) => {
            sub.unsubscribe();
            // Delegate to handler — _invoke in publish() already handles errors
            return handler(msg, ch);
        };
        sub = this.subscribe(channel, wrapped);
        return sub;
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
    unsubscribe(channel, handler) {
        const set = this.channels.get(channel);
        if (!set)
            return;
        if (handler) {
            set.delete(handler);
            if (set.size === 0)
                this.channels.delete(channel);
        }
        else {
            this.channels.delete(channel);
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
    punsubscribe(pattern, handler) {
        const entry = this.patterns.get(pattern);
        if (!entry)
            return;
        if (handler) {
            entry.handlers.delete(handler);
            if (entry.handlers.size === 0)
                this.patterns.delete(pattern);
        }
        else {
            this.patterns.delete(pattern);
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
    publish(channel, message) {
        let count = 0;
        // Exact channel subscribers
        const exactHandlers = this.channels.get(channel);
        if (exactHandlers) {
            for (const handler of exactHandlers) {
                count++;
                this._invoke(handler, message, channel);
            }
        }
        // Pattern subscribers
        for (const [, { regex, handlers }] of this.patterns) {
            if (regex.test(channel)) {
                for (const handler of handlers) {
                    count++;
                    this._invoke(handler, message, channel);
                }
            }
        }
        this.emit('publish', channel, message, count);
        return count;
    }
    /**
     * PUBSUB CHANNELS — list active channels matching a pattern.
     *
     * @example
     * ```typescript
     * pubsub.activeChannels('group:*')
     * ```
     */
    activeChannels(pattern = '*') {
        const regex = this._globToRegex(pattern);
        return [...this.channels.keys()].filter(ch => regex.test(ch));
    }
    /**
     * PUBSUB NUMSUB — number of subscribers per channel.
     *
     * @example
     * ```typescript
     * pubsub.numSub('group:join', 'group:leave')
     * ```
     */
    numSub(...channels) {
        const result = {};
        for (const ch of channels) {
            result[ch] = this.channels.get(ch)?.size ?? 0;
        }
        return result;
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
    waitFor(channel, timeoutMs) {
        return new Promise((resolve) => {
            let timer = null;
            const sub = this.subscribeOnce(channel, (msg) => {
                if (timer)
                    clearTimeout(timer);
                resolve(msg);
            });
            if (timeoutMs != null) {
                timer = setTimeout(() => {
                    sub.unsubscribe();
                    resolve(null);
                }, timeoutMs);
            }
        });
    }
    // ─── Internals ─────────────────────────────────────────────────────────────
    /**
     * Safely invoke a handler, catching sync throws and async rejections.
     * Async errors are emitted as 'handler-error' events.
     */
    _invoke(handler, message, channel) {
        try {
            const result = handler(message, channel);
            if (result instanceof Promise) {
                result.catch(err => this.emit('handler-error', err, channel));
            }
        }
        catch (err) {
            this.emit('handler-error', err, channel);
        }
    }
    _globToRegex(pattern) {
        const escaped = pattern
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return new RegExp(`^${escaped}$`);
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
export class TypedPubSub {
    inner;
    constructor(options = {}) {
        this.inner = new PubSub(options);
    }
    /**
     * Type-safe subscribe to a known event channel.
     *
     * @example
     * ```typescript
     * typed.subscribe('game:answer', ({ correct, points }) => { })
     * ```
     */
    subscribe(channel, handler) {
        return this.inner.subscribe(channel, handler);
    }
    /**
     * Type-safe publish to a known event channel.
     *
     * @example
     * ```typescript
     * typed.publish('game:answer', { userJid: '628xxx', groupJid: 'g1', gameType: 'quiz', correct: true, points: 10 })
     * ```
     */
    publish(channel, message) {
        return this.inner.publish(channel, message);
    }
    /**
     * Type-safe subscribe-once.
     *
     * @example
     * ```typescript
     * typed.subscribeOnce('game:end', (result) => announceWinner(result))
     * ```
     */
    subscribeOnce(channel, handler) {
        return this.inner.subscribeOnce(channel, handler);
    }
    /**
     * Type-safe waitFor.
     *
     * @example
     * ```typescript
     * const event = await typed.waitFor('level:up', 30_000)
     * ```
     */
    waitFor(channel, timeoutMs) {
        return this.inner.waitFor(channel, timeoutMs);
    }
    /**
     * Unsubscribe a handler from a channel.
     *
     * @example
     * ```typescript
     * typed.unsubscribe('group:join', myHandler)
     * ```
     */
    unsubscribe(channel, handler) {
        this.inner.unsubscribe(channel, handler);
    }
    /**
     * List active channels.
     *
     * @example
     * ```typescript
     * typed.activeChannels()
     * ```
     */
    activeChannels(pattern = '*') {
        return this.inner.activeChannels(pattern);
    }
    /**
     * Get subscriber counts per channel.
     *
     * @example
     * ```typescript
     * typed.numSub('group:join')
     * ```
     */
    numSub(...channels) {
        return this.inner.numSub(...channels);
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
    get raw() {
        return this.inner;
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
    router;
    pubsub;
    shardKeys;
    constructor(router, pubsub, shardKeys) {
        this.router = router;
        this.pubsub = pubsub;
        this.shardKeys = shardKeys;
        // When any shard publishes, broadcast to all other shards via the queue
        this.pubsub.subscribe('__ipc:broadcast__', ({ channel, message }) => {
            for (const shardKey of this.shardKeys()) {
                this.router.enqueue({ shardKey, type: '__pubsub:deliver__', payload: { channel, message } });
            }
        });
    }
    /**
     * Call this in each child shard's IpcWorker to deliver routed messages.
     *
     * @example
     * ```typescript
     * worker.register('__pubsub:deliver__', IpcPubSubBridge.deliverHandler(pubsub))
     * ```
     */
    static deliverHandler(pubsub) {
        return async (payload) => {
            pubsub.publish(payload.channel, payload.message);
        };
    }
}
