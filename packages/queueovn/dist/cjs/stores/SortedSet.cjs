"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SortedSet = void 0;
const node_events_1 = require("node:events");
const node_fs_1 = require("node:fs");
// ─── SortedSet ────────────────────────────────────────────────────────────────
/**
 * In-memory sorted set store — Redis ZSET compatible API.
 * Each "set" is identified by a key (e.g. `leaderboard:tebakkata:628xxx`).
 *
 * Internally: Map<setKey, Map<member, score>> + sorted view rebuilt on demand.
 * For bot leaderboards with < 10_000 members per set, this is plenty fast.
 *
 * WhatsApp bot use cases:
 *  - Game leaderboard:     zadd(`lb:tebakkata:${groupJid}`, score, userJid)
 *  - Activity ranking:     zadd(`active:${groupJid}`, msgCount, userJid)
 *  - Economy richlist:     zadd(`richlist:${botId}`, coins, userJid)
 *  - Win streak tracking:  zadd(`streak:${groupJid}`, streak, userJid)
 */
class SortedSet extends node_events_1.EventEmitter {
    /** setKey → (member → score) */
    sets = new Map();
    /** sorted cache: setKey → ZMember[] sorted ASC, invalidated on write */
    sortedCache = new Map();
    snapshotTimer = null;
    persistPath;
    snapshotIntervalMs;
    constructor(options = {}) {
        super();
        this.persistPath = options.persistPath ?? null;
        this.snapshotIntervalMs = options.snapshotIntervalMs ?? 60_000;
        if (this.persistPath)
            this._load();
        this._startTimers();
    }
    // ─── Write ops ─────────────────────────────────────────────────────────────
    /**
     * ZADD — add or update member with score.
     * Returns 1 if new member was added, 0 if score was updated.
     *
     * @example
     * ```typescript
     * ss.zadd(`lb:tebakkata:${groupJid}`, 10, userJid) // 1 (new)
     * ```
     */
    zadd(key, score, member) {
        const set = this._getOrCreate(key);
        const isNew = !set.has(member) ? 1 : 0;
        set.set(member, score);
        this.sortedCache.delete(key); // invalidate
        this.emit('zadd', key, member, score);
        return isNew;
    }
    /**
     * ZINCRBY — increment member's score. Creates member at 0 if not exists.
     * Returns new score.
     *
     * @example
     * ```typescript
     * // Award points after correct game answer
     * const newScore = ss.zincrby(`lb:${gameType}:${groupJid}`, points, userJid)
     * ```
     */
    zincrby(key, by, member) {
        const set = this._getOrCreate(key);
        const current = set.get(member) ?? 0;
        const next = current + by;
        set.set(member, next);
        this.sortedCache.delete(key);
        return next;
    }
    /**
     * ZREM — remove member(s) from set. Returns number of members removed.
     *
     * @example
     * ```typescript
     * ss.zrem('lb:quiz:group1', 'user1', 'user2')
     * ```
     */
    zrem(key, ...members) {
        const set = this.sets.get(key);
        if (!set)
            return 0;
        let count = 0;
        for (const m of members) {
            if (set.delete(m))
                count++;
        }
        if (count > 0)
            this.sortedCache.delete(key);
        return count;
    }
    /**
     * Delete an entire set.
     *
     * @example
     * ```typescript
     * ss.del('lb:quiz:group1')
     * ```
     */
    del(key) {
        this.sortedCache.delete(key);
        return this.sets.delete(key);
    }
    // ─── Read ops ──────────────────────────────────────────────────────────────
    /**
     * ZSCORE — get score of member, null if not found.
     *
     * @example
     * ```typescript
     * const score = ss.zscore('lb:quiz:group1', 'user1')
     * ```
     */
    zscore(key, member) {
        return this.sets.get(key)?.get(member) ?? null;
    }
    /**
     * ZRANK — 0-based rank of member, ascending (lowest score = 0). Null if not found.
     *
     * @example
     * ```typescript
     * const rank = ss.zrank('lb:quiz:group1', 'user1')
     * ```
     */
    zrank(key, member) {
        const sorted = this._sorted(key);
        const idx = sorted.findIndex(e => e.member === member);
        return idx === -1 ? null : idx;
    }
    /**
     * ZREVRANK — 0-based rank of member, descending (highest score = 0). Null if not found.
     * Most useful for leaderboards: rank 0 = #1 player.
     *
     * @example
     * ```typescript
     * const rank = ss.zrevrank(`lb:tebakkata:${groupJid}`, userJid)
     * // rank 0 = juara 1
     * ```
     */
    zrevrank(key, member) {
        const sorted = this._sorted(key);
        const idx = sorted.findIndex(e => e.member === member);
        return idx === -1 ? null : sorted.length - 1 - idx;
    }
    /**
     * ZCARD — number of members in set.
     *
     * @example
     * ```typescript
     * ss.zcard('lb:quiz:group1') // 42
     * ```
     */
    zcard(key) {
        return this.sets.get(key)?.size ?? 0;
    }
    zrange(key, start, stop, withScores) {
        const sorted = this._sorted(key);
        const len = sorted.length;
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        const slice = sorted.slice(s, e + 1);
        if (withScores === true)
            return slice;
        return slice.map(item => item.member);
    }
    zrevrange(key, start, stop, withScores) {
        const sorted = this._sorted(key).slice().reverse();
        const len = sorted.length;
        const s = start < 0 ? Math.max(0, len + start) : start;
        const e = stop < 0 ? len + stop : Math.min(stop, len - 1);
        const slice = sorted.slice(s, e + 1);
        if (withScores === true)
            return slice;
        return slice.map(item => item.member);
    }
    /**
     * ZRANGEBYSCORE — members with score between min and max (inclusive).
     *
     * @example
     * ```typescript
     * ss.zrangebyscore('lb:quiz:group1', 50, 100)
     * ```
     */
    zrangebyscore(key, min, max) {
        return this._sorted(key).filter(e => e.score >= min && e.score <= max);
    }
    /**
     * List all set keys.
     *
     * @example
     * ```typescript
     * ss.keys() // ['lb:quiz:group1', 'lb:trivia:group2']
     * ```
     */
    keys() {
        return [...this.sets.keys()];
    }
    // ─── WhatsApp leaderboard helpers ──────────────────────────────────────────
    /**
     * Get full leaderboard for a group+gameType, descending.
     * Returns up to `limit` entries with rank (1-based), member, score.
     *
     * @example
     * ```typescript
     * const lb = ss.leaderboard('tebakkata', groupJid, 10)
     * // [{ rank: 1, member: 'jid1', score: 980 }, ...]
     * ```
     */
    leaderboard(gameType, groupJid, limit = 10) {
        const key = `lb:${gameType}:${groupJid}`;
        const top = this.zrevrange(key, 0, limit - 1, true);
        return top.map((e, i) => ({ rank: i + 1, member: e.member, score: e.score }));
    }
    /**
     * Award points and return new rank. Creates entry if not exists.
     *
     * @example
     * ```typescript
     * const { newScore, rank } = ss.award('quiz', groupJid, userJid, 10)
     * ```
     */
    award(gameType, groupJid, userJid, points) {
        const key = `lb:${gameType}:${groupJid}`;
        const newScore = this.zincrby(key, points, userJid);
        const rank = (this.zrevrank(key, userJid) ?? 0) + 1;
        return { newScore, rank };
    }
    /**
     * Reset leaderboard for a group+gameType.
     *
     * @example
     * ```typescript
     * ss.resetLeaderboard('quiz', groupJid)
     * ```
     */
    resetLeaderboard(gameType, groupJid) {
        this.del(`lb:${gameType}:${groupJid}`);
        this.emit('leaderboard-reset', gameType, groupJid);
    }
    /**
     * Global leaderboard aggregated across all groups for a given gameType.
     * Sums scores per member across every group's `lb:{gameType}:*` set.
     *
     * @example
     * ```typescript
     * const global = ss.globalLeaderboard('quiz', 10)
     * // [{ rank: 1, member: 'jid1', score: 2450, groups: 3 }, ...]
     * ```
     */
    globalLeaderboard(gameType, limit = 10) {
        const prefix = `lb:${gameType}:`;
        const aggregated = new Map();
        for (const [key, set] of this.sets) {
            if (!key.startsWith(prefix))
                continue;
            for (const [member, score] of set) {
                const existing = aggregated.get(member);
                if (existing) {
                    existing.score += score;
                    existing.groups++;
                }
                else {
                    aggregated.set(member, { score, groups: 1 });
                }
            }
        }
        const sorted = [...aggregated.entries()]
            .map(([member, { score, groups }]) => ({ member, score, groups }))
            .sort((a, b) => b.score - a.score || a.member.localeCompare(b.member))
            .slice(0, limit);
        return sorted.map((e, i) => ({ rank: i + 1, ...e }));
    }
    // ─── Lifecycle ─────────────────────────────────────────────────────────────
    /**
     * Save snapshot and stop timers. Call on graceful shutdown.
     *
     * @example
     * ```typescript
     * await ss.shutdown()
     * ```
     */
    async shutdown() {
        if (this.snapshotTimer)
            clearInterval(this.snapshotTimer);
        this._save();
    }
    // ─── Internals ─────────────────────────────────────────────────────────────
    _getOrCreate(key) {
        let set = this.sets.get(key);
        if (!set) {
            set = new Map();
            this.sets.set(key, set);
        }
        return set;
    }
    _sorted(key) {
        const cached = this.sortedCache.get(key);
        if (cached)
            return cached;
        const set = this.sets.get(key);
        if (!set)
            return [];
        const sorted = [];
        for (const [member, score] of set)
            sorted.push({ member, score });
        sorted.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
        this.sortedCache.set(key, sorted);
        return sorted;
    }
    _startTimers() {
        if (!this.persistPath)
            return;
        this.snapshotTimer = setInterval(() => this._save(), this.snapshotIntervalMs);
        this.snapshotTimer.unref?.();
    }
    _save() {
        if (!this.persistPath)
            return;
        try {
            const data = {};
            for (const [key, set] of this.sets) {
                data[key] = Object.fromEntries(set);
            }
            (0, node_fs_1.writeFileSync)(this.persistPath, JSON.stringify({ v: 1, data }), 'utf8');
        }
        catch { /* non-fatal */ }
    }
    _load() {
        if (!this.persistPath || !(0, node_fs_1.existsSync)(this.persistPath))
            return;
        try {
            const raw = JSON.parse((0, node_fs_1.readFileSync)(this.persistPath, 'utf8'));
            for (const [key, members] of Object.entries(raw.data ?? {})) {
                const set = new Map();
                for (const [m, s] of Object.entries(members))
                    set.set(m, s);
                this.sets.set(key, set);
            }
        }
        catch { /* corrupt — start fresh */ }
    }
}
exports.SortedSet = SortedSet;
