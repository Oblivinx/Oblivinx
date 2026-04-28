import { EventEmitter } from 'node:events';
import type { ListPushOptions } from '../types/wa.types.js';
export interface KvEntry {
    value: unknown;
    expiresAt: number | null;
}
export interface KvStoreOptions {
    /**
     * Path to persist snapshot. If omitted, data is in-memory only.
     * Recommended: './kv-store.json'
     */
    persistPath?: string;
    /**
     * How often to write snapshot to disk (ms). Default: 30_000
     */
    snapshotIntervalMs?: number;
    /**
     * Maximum number of keys. Oldest-inserted keys evicted when full.
     * Default: 50_000
     */
    maxKeys?: number;
}
export interface KvSetOptions {
    /** TTL in milliseconds */
    ttlMs?: number;
    /** Set only if key does NOT exist (like Redis SETNX). Returns false if key exists. */
    nx?: boolean;
    /** Set only if key EXISTS (like Redis XX). Returns false if key does not exist. */
    xx?: boolean;
}
export interface KvScanResult {
    cursor: number;
    keys: string[];
}
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
export declare class KvStore extends EventEmitter {
    private store;
    private insertOrder;
    private snapshotTimer;
    private cleanupTimer;
    private readonly persistPath;
    private readonly snapshotIntervalMs;
    private readonly maxKeys;
    constructor(options?: KvStoreOptions);
    /**
     * SET — store a value, optionally with TTL.
     * Equivalent to Redis SET key value [EX seconds] [NX|XX]
     *
     * @example
     * ```typescript
     * kv.set('afk:628xxx', 'sleeping', { ttlMs: 3600_000 })
     * ```
     */
    set(key: string, value: unknown, options?: KvSetOptions): boolean;
    /**
     * GET — returns value or null if missing/expired.
     *
     * @example
     * ```typescript
     * const reason = kv.get<string>('afk:628xxx')
     * ```
     */
    get<T = unknown>(key: string): T | null;
    /**
     * DEL — delete one or more keys. Returns number of keys deleted.
     *
     * @example
     * ```typescript
     * kv.del('afk:628xxx', 'session:628xxx')
     * ```
     */
    del(...keys: string[]): number;
    /**
     * EXISTS — returns number of keys that exist and are not expired.
     *
     * @example
     * ```typescript
     * if (kv.exists('lock:game:group1') > 0) console.log('locked')
     * ```
     */
    exists(...keys: string[]): number;
    /**
     * EXPIRE — set TTL on an existing key. Returns false if key not found.
     *
     * @example
     * ```typescript
     * kv.expire('session:628xxx', 60_000)
     * ```
     */
    expire(key: string, ttlMs: number): boolean;
    /**
     * PERSIST — remove TTL from a key.
     *
     * @example
     * ```typescript
     * kv.persist('user:628xxx')
     * ```
     */
    persist(key: string): boolean;
    /**
     * TTL — returns remaining TTL in ms, -1 if no expiry, -2 if not found.
     *
     * @example
     * ```typescript
     * const remaining = kv.ttl('cooldown:628xxx:daily') // 86312000
     * ```
     */
    ttl(key: string): number;
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
    incr(key: string, by?: number, resetTtlMs?: number): number;
    /**
     * DECR / DECRBY — atomically decrement a numeric value.
     *
     * @example
     * ```typescript
     * kv.decr('balance:628xxx', 100)
     * ```
     */
    decr(key: string, by?: number, resetTtlMs?: number): number;
    /**
     * GETSET — return old value and set new value atomically.
     *
     * @example
     * ```typescript
     * const prev = kv.getset<number>('counter', 0)
     * ```
     */
    getset<T = unknown>(key: string, value: unknown, options?: KvSetOptions): T | null;
    /**
     * MSET — set multiple keys at once.
     *
     * @example
     * ```typescript
     * kv.mset([{ key: 'a', value: 1 }, { key: 'b', value: 2, ttlMs: 5000 }])
     * ```
     */
    mset(entries: Array<{
        key: string;
        value: unknown;
        ttlMs?: number;
    }>): void;
    /**
     * MGET — get multiple keys. Returns array with null for missing/expired.
     *
     * @example
     * ```typescript
     * const [a, b] = kv.mget<number>('a', 'b')
     * ```
     */
    mget<T = unknown>(...keys: string[]): Array<T | null>;
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
    hset(key: string, field: string, value: unknown): void;
    /**
     * HGET — get the value of a field in a hash.
     *
     * @example
     * ```typescript
     * const name = kv.hget<string>('user:628xxx', 'name') // 'Budi'
     * ```
     */
    hget<T = unknown>(key: string, field: string): T | null;
    /**
     * HDEL — delete one or more fields from a hash. Returns number deleted.
     *
     * @example
     * ```typescript
     * kv.hdel('user:628xxx', 'tempField')
     * ```
     */
    hdel(key: string, ...fields: string[]): number;
    /**
     * HGETALL — get all fields and values of a hash.
     *
     * @example
     * ```typescript
     * const profile = kv.hgetall('user:628xxx') // { name: 'Budi', level: 5 }
     * ```
     */
    hgetall(key: string): Record<string, unknown> | null;
    /**
     * HKEYS — get all field names in a hash.
     *
     * @example
     * ```typescript
     * kv.hkeys('user:628xxx') // ['name', 'level']
     * ```
     */
    hkeys(key: string): string[];
    /**
     * HLEN — get number of fields in a hash.
     *
     * @example
     * ```typescript
     * kv.hlen('user:628xxx') // 2
     * ```
     */
    hlen(key: string): number;
    /**
     * HEXISTS — check if a field exists in a hash.
     *
     * @example
     * ```typescript
     * kv.hexists('user:628xxx', 'name') // true
     * ```
     */
    hexists(key: string, field: string): boolean;
    /**
     * HINCRBY — increment a numeric field in a hash. Creates field at 0 if not exists.
     *
     * @example
     * ```typescript
     * kv.hincrby('user:628xxx', 'level', 1) // 6
     * ```
     */
    hincrby(key: string, field: string, by: number): number;
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
    lpush(key: string, ...args: [...values: unknown[], options: ListPushOptions] | unknown[]): number;
    /**
     * RPUSH — append one or more values to a list. Returns new length.
     *
     * @example
     * ```typescript
     * kv.rpush('queue:628xxx', 'item1') // 1
     * ```
     */
    rpush(key: string, ...args: [...values: unknown[], options: ListPushOptions] | unknown[]): number;
    /**
     * LPOP — remove and return the first element of a list.
     *
     * @example
     * ```typescript
     * const first = kv.lpop<string>('queue:628xxx')
     * ```
     */
    lpop<T = unknown>(key: string): T | null;
    /**
     * RPOP — remove and return the last element of a list.
     *
     * @example
     * ```typescript
     * const last = kv.rpop<string>('history:628xxx')
     * ```
     */
    rpop<T = unknown>(key: string): T | null;
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
    lrange<T = unknown>(key: string, start: number, stop: number): T[];
    /**
     * LLEN — get the length of a list.
     *
     * @example
     * ```typescript
     * kv.llen('queue:628xxx') // 3
     * ```
     */
    llen(key: string): number;
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
    keys(pattern?: string): string[];
    /**
     * SCAN — cursor-based key iteration (avoids blocking on large key spaces).
     * count is approximate number of keys to return per call.
     *
     * @example
     * ```typescript
     * const { cursor, keys } = kv.scan(0, 'session:*', 50)
     * ```
     */
    scan(cursor: number, pattern?: string, count?: number): KvScanResult;
    /**
     * DBSIZE — returns number of live (non-expired) keys.
     *
     * @example
     * ```typescript
     * console.log(`Store has ${kv.dbsize()} keys`)
     * ```
     */
    dbsize(): number;
    /**
     * FLUSHALL — remove all keys.
     *
     * @example
     * ```typescript
     * kv.flush()
     * ```
     */
    flush(): void;
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
    setnx(key: string, value: unknown, ttlMs?: number): boolean;
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
    rateCheck(key: string, limit: number, windowMs: number): {
        allowed: boolean;
        count: number;
        resetIn: number;
    };
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
    cooldown(key: string, ttlMs: number): boolean;
    /**
     * Flush snapshot to disk and stop timers. Call on graceful shutdown.
     *
     * @example
     * ```typescript
     * process.on('SIGINT', () => kv.shutdown())
     * ```
     */
    shutdown(): Promise<void>;
    private _isExpired;
    private _isAlive;
    private _delete;
    /**
     * BUG FIX: also removes evicted key from insertOrder (shift already does
     * this since oldest is always at index 0, but we guard against inconsistency).
     */
    private _evictIfNeeded;
    /**
     * BUG FIX: collect-then-delete pattern to avoid mutating Map during iteration.
     */
    private _cleanupExpired;
    private _startTimers;
    private _saveSnapshot;
    private _loadSnapshot;
    private _globToRegex;
    /**
     * Parse variadic list push args: last arg MAY be a ListPushOptions object.
     */
    private _parseListArgs;
}
