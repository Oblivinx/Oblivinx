"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.KvStore = void 0;
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
// ─── KvStore ──────────────────────────────────────────────────────────────────
/**
 * In-memory key-value store with Redis-compatible API.
 * Supports TTL, INCR, pattern matching, persistence snapshot, and pub/sub hooks.
 * Also provides Hash and List data structures (no per-field TTL — TTL is per key).
 *
 * WhatsApp bot use cases:
 *  - Cooldown: set(`cooldown:${userId}:${cmd}`, 1, { ttlMs: 30_000 })
 *  - AFK status: set(`afk:${jid}`, reason, { ttlMs: 8 * 3600_000 })
 *  - Spam counter: incr(`spam:${jid}:${groupJid}`, 1, windowMs)
 *  - Lock (mutex): setnx(`lock:${groupJid}:game`, 1, { ttlMs: 30_000 })
 *  - Session flag: set(`session:${jid}`, 'awaiting-answer', { ttlMs: 60_000 })
 *  - User profile: hset(`user:${jid}`, 'name', 'Budi')
 *  - Command history: lpush(`history:${jid}`, 'cmd1', 'cmd2')
 */
class KvStore extends node_events_1.EventEmitter {
    store = new Map();
    insertOrder = [];
    snapshotTimer = null;
    cleanupTimer = null;
    persistPath;
    snapshotIntervalMs;
    maxKeys;
    constructor(options = {}) {
        super();
        this.persistPath = options.persistPath ?? null;
        this.snapshotIntervalMs = options.snapshotIntervalMs ?? 30_000;
        this.maxKeys = options.maxKeys ?? 50_000;
        if (this.persistPath)
            this._loadSnapshot();
        this._startTimers();
    }
    // ─── Core ops ──────────────────────────────────────────────────────────────
    /**
     * SET — store a value, optionally with TTL.
     * Equivalent to Redis SET key value [EX seconds] [NX|XX]
     *
     * @example
     * ```typescript
     * kv.set('afk:628xxx', 'sleeping', { ttlMs: 3600_000 })
     * ```
     */
    set(key, value, options = {}) {
        const exists = this._isAlive(key);
        if (options.nx && exists)
            return false;
        if (options.xx && !exists)
            return false;
        const expiresAt = options.ttlMs != null ? Date.now() + options.ttlMs : null;
        this._evictIfNeeded(key);
        this.store.set(key, { value, expiresAt });
        if (!this.insertOrder.includes(key))
            this.insertOrder.push(key);
        this.emit('set', key, value);
        return true;
    }
    /**
     * GET — returns value or null if missing/expired.
     *
     * @example
     * ```typescript
     * const reason = kv.get<string>('afk:628xxx')
     * ```
     */
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (this._isExpired(entry)) {
            this._delete(key);
            return null;
        }
        return entry.value;
    }
    /**
     * DEL — delete one or more keys. Returns number of keys deleted.
     *
     * @example
     * ```typescript
     * kv.del('afk:628xxx', 'session:628xxx')
     * ```
     */
    del(...keys) {
        let count = 0;
        for (const key of keys) {
            if (this._delete(key))
                count++;
        }
        return count;
    }
    /**
     * EXISTS — returns number of keys that exist and are not expired.
     *
     * @example
     * ```typescript
     * if (kv.exists('lock:game:group1') > 0) console.log('locked')
     * ```
     */
    exists(...keys) {
        return keys.filter(k => this._isAlive(k)).length;
    }
    /**
     * EXPIRE — set TTL on an existing key. Returns false if key not found.
     *
     * @example
     * ```typescript
     * kv.expire('session:628xxx', 60_000)
     * ```
     */
    expire(key, ttlMs) {
        const entry = this.store.get(key);
        if (!entry || this._isExpired(entry))
            return false;
        entry.expiresAt = Date.now() + ttlMs;
        return true;
    }
    /**
     * PERSIST — remove TTL from a key.
     *
     * @example
     * ```typescript
     * kv.persist('user:628xxx')
     * ```
     */
    persist(key) {
        const entry = this.store.get(key);
        if (!entry || this._isExpired(entry))
            return false;
        entry.expiresAt = null;
        return true;
    }
    /**
     * TTL — returns remaining TTL in ms, -1 if no expiry, -2 if not found.
     *
     * @example
     * ```typescript
     * const remaining = kv.ttl('cooldown:628xxx:daily') // 86312000
     * ```
     */
    ttl(key) {
        const entry = this.store.get(key);
        if (!entry || this._isExpired(entry))
            return -2;
        if (entry.expiresAt === null)
            return -1;
        return Math.max(0, entry.expiresAt - Date.now());
    }
    // ─── Counter ops ───────────────────────────────────────────────────────────
    /**
     * INCR / INCRBY — atomically increment a numeric value.
     * Creates key with value 0 before incrementing if not exists.
     * Optionally resets TTL on every increment (sliding window pattern).
     *
     * BUG FIX: preserves remaining TTL correctly even after internal get()
     * may have lazily deleted an expired key.
     *
     * @example
     * ```typescript
     * // Sliding-window spam counter: max 5 messages in 10 seconds
     * const count = kv.incr(`spam:${jid}`, 1, 10_000)
     * if (count > 5) takeAction()
     * ```
     */
    incr(key, by = 1, resetTtlMs) {
        // Snapshot the remaining TTL BEFORE get() potentially deletes the key
        const entryBefore = this.store.get(key);
        let preservedTtlMs;
        if (resetTtlMs == null && entryBefore && !this._isExpired(entryBefore) && entryBefore.expiresAt != null) {
            preservedTtlMs = entryBefore.expiresAt - Date.now();
            if (preservedTtlMs <= 0)
                preservedTtlMs = undefined;
        }
        const current = this.get(key) ?? 0;
        const next = current + by;
        const opts = {};
        if (resetTtlMs != null) {
            opts.ttlMs = resetTtlMs;
        }
        else if (preservedTtlMs != null) {
            opts.ttlMs = preservedTtlMs;
        }
        this.set(key, next, opts);
        return next;
    }
    /**
     * DECR / DECRBY — atomically decrement a numeric value.
     *
     * @example
     * ```typescript
     * kv.decr('balance:628xxx', 100)
     * ```
     */
    decr(key, by = 1, resetTtlMs) {
        return this.incr(key, -by, resetTtlMs);
    }
    /**
     * GETSET — return old value and set new value atomically.
     *
     * @example
     * ```typescript
     * const prev = kv.getset<number>('counter', 0)
     * ```
     */
    getset(key, value, options = {}) {
        const old = this.get(key);
        this.set(key, value, options);
        return old;
    }
    // ─── Batch ops ─────────────────────────────────────────────────────────────
    /**
     * MSET — set multiple keys at once.
     *
     * @example
     * ```typescript
     * kv.mset([{ key: 'a', value: 1 }, { key: 'b', value: 2, ttlMs: 5000 }])
     * ```
     */
    mset(entries) {
        for (const e of entries)
            this.set(e.key, e.value, { ttlMs: e.ttlMs });
    }
    /**
     * MGET — get multiple keys. Returns array with null for missing/expired.
     *
     * @example
     * ```typescript
     * const [a, b] = kv.mget<number>('a', 'b')
     * ```
     */
    mget(...keys) {
        return keys.map(k => this.get(k));
    }
    // ─── Hash ops (Redis HSET/HGET compatible) ────────────────────────────────
    /**
     * HSET — set a field in a hash stored at key.
     * Creates the hash if it does not exist. Hash TTL is per-key, not per-field.
     *
     * @example
     * ```typescript
     * kv.hset('user:628xxx', 'name', 'Budi')
     * kv.hset('user:628xxx', 'level', 5)
     * ```
     */
    hset(key, field, value) {
        let hash = this.get(key);
        if (hash == null || typeof hash !== 'object')
            hash = {};
        hash[field] = value;
        // Preserve existing TTL
        const entry = this.store.get(key);
        const ttlMs = entry?.expiresAt != null ? Math.max(0, entry.expiresAt - Date.now()) : undefined;
        this.set(key, hash, { ttlMs });
    }
    /**
     * HGET — get the value of a field in a hash.
     *
     * @example
     * ```typescript
     * const name = kv.hget<string>('user:628xxx', 'name') // 'Budi'
     * ```
     */
    hget(key, field) {
        const hash = this.get(key);
        if (hash == null || typeof hash !== 'object')
            return null;
        return hash[field] ?? null;
    }
    /**
     * HDEL — delete one or more fields from a hash. Returns number deleted.
     *
     * @example
     * ```typescript
     * kv.hdel('user:628xxx', 'tempField')
     * ```
     */
    hdel(key, ...fields) {
        const hash = this.get(key);
        if (hash == null || typeof hash !== 'object')
            return 0;
        let count = 0;
        for (const f of fields) {
            if (f in hash) {
                delete hash[f];
                count++;
            }
        }
        if (count > 0) {
            const entry = this.store.get(key);
            const ttlMs = entry?.expiresAt != null ? Math.max(0, entry.expiresAt - Date.now()) : undefined;
            this.set(key, hash, { ttlMs });
        }
        return count;
    }
    /**
     * HGETALL — get all fields and values of a hash.
     *
     * @example
     * ```typescript
     * const profile = kv.hgetall('user:628xxx') // { name: 'Budi', level: 5 }
     * ```
     */
    hgetall(key) {
        const hash = this.get(key);
        if (hash == null || typeof hash !== 'object')
            return null;
        return { ...hash };
    }
    /**
     * HKEYS — get all field names in a hash.
     *
     * @example
     * ```typescript
     * kv.hkeys('user:628xxx') // ['name', 'level']
     * ```
     */
    hkeys(key) {
        const hash = this.get(key);
        if (hash == null || typeof hash !== 'object')
            return [];
        return Object.keys(hash);
    }
    /**
     * HLEN — get number of fields in a hash.
     *
     * @example
     * ```typescript
     * kv.hlen('user:628xxx') // 2
     * ```
     */
    hlen(key) {
        return this.hkeys(key).length;
    }
    /**
     * HEXISTS — check if a field exists in a hash.
     *
     * @example
     * ```typescript
     * kv.hexists('user:628xxx', 'name') // true
     * ```
     */
    hexists(key, field) {
        const hash = this.get(key);
        if (hash == null || typeof hash !== 'object')
            return false;
        return field in hash;
    }
    /**
     * HINCRBY — increment a numeric field in a hash. Creates field at 0 if not exists.
     *
     * @example
     * ```typescript
     * kv.hincrby('user:628xxx', 'level', 1) // 6
     * ```
     */
    hincrby(key, field, by) {
        const current = this.hget(key, field) ?? 0;
        const next = current + by;
        this.hset(key, field, next);
        return next;
    }
    // ─── List ops (Redis LPUSH/RPUSH compatible) ──────────────────────────────
    /**
     * LPUSH — prepend one or more values to a list. Returns new length.
     * Optionally trims from right if `maxLen` is exceeded.
     *
     * @example
     * ```typescript
     * kv.lpush('history:628xxx', 'cmd1', 'cmd2')              // 2
     * kv.lpush('recent:628xxx', 'msg', { maxLen: 100 })       // trimmed
     * ```
     */
    lpush(key, ...args) {
        const { values, options } = this._parseListArgs(args);
        let list = this.get(key);
        if (!Array.isArray(list))
            list = [];
        list.unshift(...values);
        if (options.maxLen != null && list.length > options.maxLen) {
            list.length = options.maxLen; // trim from right
        }
        const entry = this.store.get(key);
        const ttlMs = entry?.expiresAt != null ? Math.max(0, entry.expiresAt - Date.now()) : undefined;
        this.set(key, list, { ttlMs });
        return list.length;
    }
    /**
     * RPUSH — append one or more values to a list. Returns new length.
     *
     * @example
     * ```typescript
     * kv.rpush('queue:628xxx', 'item1') // 1
     * ```
     */
    rpush(key, ...args) {
        const { values, options } = this._parseListArgs(args);
        let list = this.get(key);
        if (!Array.isArray(list))
            list = [];
        list.push(...values);
        if (options.maxLen != null && list.length > options.maxLen) {
            list.splice(0, list.length - options.maxLen); // trim from left
        }
        const entry = this.store.get(key);
        const ttlMs = entry?.expiresAt != null ? Math.max(0, entry.expiresAt - Date.now()) : undefined;
        this.set(key, list, { ttlMs });
        return list.length;
    }
    /**
     * LPOP — remove and return the first element of a list.
     *
     * @example
     * ```typescript
     * const first = kv.lpop<string>('queue:628xxx')
     * ```
     */
    lpop(key) {
        const list = this.get(key);
        if (!Array.isArray(list) || list.length === 0)
            return null;
        const val = list.shift();
        const entry = this.store.get(key);
        const ttlMs = entry?.expiresAt != null ? Math.max(0, entry.expiresAt - Date.now()) : undefined;
        this.set(key, list, { ttlMs });
        return val;
    }
    /**
     * RPOP — remove and return the last element of a list.
     *
     * @example
     * ```typescript
     * const last = kv.rpop<string>('history:628xxx')
     * ```
     */
    rpop(key) {
        const list = this.get(key);
        if (!Array.isArray(list) || list.length === 0)
            return null;
        const val = list.pop();
        const entry = this.store.get(key);
        const ttlMs = entry?.expiresAt != null ? Math.max(0, entry.expiresAt - Date.now()) : undefined;
        this.set(key, list, { ttlMs });
        return val;
    }
    /**
     * LRANGE — get a range of elements from a list.
     * Supports negative indexes (-1 = last).
     *
     * @example
     * ```typescript
     * kv.lrange<string>('history:628xxx', 0, -1) // all items
     * kv.lrange<string>('history:628xxx', 0, 4)  // first 5
     * ```
     */
    lrange(key, start, stop) {
        const list = this.get(key);
        if (!Array.isArray(list))
            return [];
        const len = list.length;
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        return list.slice(s, e + 1);
    }
    /**
     * LLEN — get the length of a list.
     *
     * @example
     * ```typescript
     * kv.llen('queue:628xxx') // 3
     * ```
     */
    llen(key) {
        const list = this.get(key);
        if (!Array.isArray(list))
            return 0;
        return list.length;
    }
    // ─── Key enumeration ───────────────────────────────────────────────────────
    /**
     * KEYS — return all keys matching a glob-style pattern.
     * Supported: * (any), ? (single char), [abc] (char class)
     *
     * @example
     * ```typescript
     * kv.keys('cooldown:*')          // all cooldown keys
     * kv.keys('spam:*:628123*')      // spam keys for a specific number prefix
     * ```
     */
    keys(pattern = '*') {
        const regex = this._globToRegex(pattern);
        const result = [];
        for (const [key, entry] of this.store) {
            if (!this._isExpired(entry) && regex.test(key))
                result.push(key);
        }
        return result;
    }
    /**
     * SCAN — cursor-based key iteration (avoids blocking on large key spaces).
     * count is approximate number of keys to return per call.
     *
     * @example
     * ```typescript
     * const { cursor, keys } = kv.scan(0, 'session:*', 50)
     * ```
     */
    scan(cursor, pattern = '*', count = 100) {
        const allKeys = this.keys(pattern);
        const slice = allKeys.slice(cursor, cursor + count);
        const nextCursor = cursor + count >= allKeys.length ? 0 : cursor + count;
        return { cursor: nextCursor, keys: slice };
    }
    /**
     * DBSIZE — returns number of live (non-expired) keys.
     *
     * @example
     * ```typescript
     * console.log(`Store has ${kv.dbsize()} keys`)
     * ```
     */
    dbsize() {
        return this.keys('*').length;
    }
    /**
     * FLUSHALL — remove all keys.
     *
     * @example
     * ```typescript
     * kv.flush()
     * ```
     */
    flush() {
        this.store.clear();
        this.insertOrder = [];
        this.emit('flush');
    }
    // ─── Atomic helpers for WhatsApp bots ──────────────────────────────────────
    /**
     * SETNX — set only if key does not exist.
     * Useful as a mutex/lock.
     *
     * @example
     * ```typescript
     * // Lock game start per group
     * if (!kv.setnx(`lock:game:${groupJid}`, 1, 30_000)) {
     *   return 'Game already running!'
     * }
     * ```
     */
    setnx(key, value, ttlMs) {
        return this.set(key, value, { nx: true, ttlMs });
    }
    /**
     * Check if a sliding-window rate limit is exceeded.
     * Returns { allowed: boolean, count: number, resetIn: number }
     *
     * @example
     * ```typescript
     * const r = kv.rateCheck(`spam:${jid}:${groupJid}`, 5, 10_000)
     * if (!r.allowed) warn(jid, `Slow down! Try again in ${r.resetIn}ms`)
     * ```
     */
    rateCheck(key, limit, windowMs) {
        const count = this.incr(key, 1, windowMs);
        const resetIn = this.ttl(key);
        return { allowed: count <= limit, count, resetIn: Math.max(0, resetIn) };
    }
    /**
     * Set a cooldown and return false if already on cooldown.
     *
     * @example
     * ```typescript
     * if (!kv.cooldown(`cmd:daily:${jid}`, 86_400_000)) {
     *   return `Daily sudah diklaim! Coba lagi dalam ${kv.ttl('cmd:daily:' + jid)}ms`
     * }
     * ```
     */
    cooldown(key, ttlMs) {
        return this.setnx(key, 1, ttlMs);
    }
    // ─── Lifecycle ─────────────────────────────────────────────────────────────
    /**
     * Flush snapshot to disk and stop timers. Call on graceful shutdown.
     *
     * @example
     * ```typescript
     * process.on('SIGINT', () => kv.shutdown())
     * ```
     */
    async shutdown() {
        if (this.snapshotTimer)
            clearInterval(this.snapshotTimer);
        if (this.cleanupTimer)
            clearInterval(this.cleanupTimer);
        this._saveSnapshot();
    }
    // ─── Internals ─────────────────────────────────────────────────────────────
    _isExpired(entry) {
        return entry.expiresAt !== null && Date.now() > entry.expiresAt;
    }
    _isAlive(key) {
        const entry = this.store.get(key);
        if (!entry)
            return false;
        if (this._isExpired(entry)) {
            this._delete(key);
            return false;
        }
        return true;
    }
    _delete(key) {
        if (!this.store.has(key))
            return false;
        this.store.delete(key);
        const idx = this.insertOrder.indexOf(key);
        if (idx !== -1)
            this.insertOrder.splice(idx, 1);
        this.emit('del', key);
        return true;
    }
    /**
     * BUG FIX: also removes evicted key from insertOrder (shift already does
     * this since oldest is always at index 0, but we guard against inconsistency).
     */
    _evictIfNeeded(key) {
        if (this.store.size < this.maxKeys)
            return;
        if (this.store.has(key))
            return; // update, not insert
        // Evict oldest key — shift() removes from insertOrder already
        const oldest = this.insertOrder.shift();
        if (oldest) {
            this.store.delete(oldest);
            this.emit('del', oldest);
        }
    }
    /**
     * BUG FIX: collect-then-delete pattern to avoid mutating Map during iteration.
     */
    _cleanupExpired() {
        const now = Date.now();
        const expired = [];
        for (const [key, entry] of this.store) {
            if (entry.expiresAt !== null && now > entry.expiresAt) {
                expired.push(key);
            }
        }
        for (const key of expired) {
            this.store.delete(key);
            const idx = this.insertOrder.indexOf(key);
            if (idx !== -1)
                this.insertOrder.splice(idx, 1);
            this.emit('expired', key);
        }
    }
    _startTimers() {
        // Cleanup expired keys every 5 seconds
        this.cleanupTimer = setInterval(() => this._cleanupExpired(), 5_000);
        this.cleanupTimer.unref?.();
        if (this.persistPath) {
            this.snapshotTimer = setInterval(() => this._saveSnapshot(), this.snapshotIntervalMs);
            this.snapshotTimer.unref?.();
        }
    }
    _saveSnapshot() {
        if (!this.persistPath)
            return;
        try {
            const now = Date.now();
            const data = {};
            for (const [key, entry] of this.store) {
                // Skip already expired entries from snapshot
                if (entry.expiresAt !== null && now > entry.expiresAt)
                    continue;
                data[key] = entry;
            }
            (0, node_fs_1.writeFileSync)(this.persistPath, JSON.stringify({ v: 1, data, savedAt: now }), 'utf8');
        }
        catch { /* non-fatal */ }
    }
    _loadSnapshot() {
        if (!this.persistPath || !(0, node_fs_1.existsSync)(this.persistPath))
            return;
        try {
            const raw = JSON.parse((0, node_fs_1.readFileSync)(this.persistPath, 'utf8'));
            const now = Date.now();
            for (const [key, entry] of Object.entries(raw.data ?? {})) {
                if (entry.expiresAt !== null && now > entry.expiresAt)
                    continue;
                this.store.set(key, entry);
                this.insertOrder.push(key);
            }
        }
        catch { /* corrupt snapshot — start fresh */ }
    }
    _globToRegex(pattern) {
        const escaped = pattern
            .replace(/[.+^${}()|\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')
            .replace(/\[([^\]]+)\]/g, '[$1]');
        return new RegExp(`^${escaped}$`);
    }
    /**
     * Parse variadic list push args: last arg MAY be a ListPushOptions object.
     */
    _parseListArgs(args) {
        if (args.length === 0)
            return { values: [], options: {} };
        const last = args[args.length - 1];
        if (typeof last === 'object' && last !== null && !Array.isArray(last) && 'maxLen' in last) {
            return { values: args.slice(0, -1), options: last };
        }
        return { values: args, options: {} };
    }
}
exports.KvStore = KvStore;
