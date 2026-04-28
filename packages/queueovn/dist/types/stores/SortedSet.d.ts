import { EventEmitter } from 'node:events';
export interface ZMember {
    member: string;
    score: number;
}
export interface SortedSetOptions {
    persistPath?: string;
    snapshotIntervalMs?: number;
}
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
export declare class SortedSet extends EventEmitter {
    /** setKey → (member → score) */
    private sets;
    /** sorted cache: setKey → ZMember[] sorted ASC, invalidated on write */
    private sortedCache;
    private snapshotTimer;
    private readonly persistPath;
    private readonly snapshotIntervalMs;
    constructor(options?: SortedSetOptions);
    /**
     * ZADD — add or update member with score.
     * Returns 1 if new member was added, 0 if score was updated.
     *
     * @example
     * ```typescript
     * ss.zadd(`lb:tebakkata:${groupJid}`, 10, userJid) // 1 (new)
     * ```
     */
    zadd(key: string, score: number, member: string): 0 | 1;
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
    zincrby(key: string, by: number, member: string): number;
    /**
     * ZREM — remove member(s) from set. Returns number of members removed.
     *
     * @example
     * ```typescript
     * ss.zrem('lb:quiz:group1', 'user1', 'user2')
     * ```
     */
    zrem(key: string, ...members: string[]): number;
    /**
     * Delete an entire set.
     *
     * @example
     * ```typescript
     * ss.del('lb:quiz:group1')
     * ```
     */
    del(key: string): boolean;
    /**
     * ZSCORE — get score of member, null if not found.
     *
     * @example
     * ```typescript
     * const score = ss.zscore('lb:quiz:group1', 'user1')
     * ```
     */
    zscore(key: string, member: string): number | null;
    /**
     * ZRANK — 0-based rank of member, ascending (lowest score = 0). Null if not found.
     *
     * @example
     * ```typescript
     * const rank = ss.zrank('lb:quiz:group1', 'user1')
     * ```
     */
    zrank(key: string, member: string): number | null;
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
    zrevrank(key: string, member: string): number | null;
    /**
     * ZCARD — number of members in set.
     *
     * @example
     * ```typescript
     * ss.zcard('lb:quiz:group1') // 42
     * ```
     */
    zcard(key: string): number;
    /**
     * ZRANGE — members by ascending score, start/stop are 0-based indexes.
     * Negative indexes count from end (-1 = last).
     * BUG FIX: explicit runtime branching for overloaded withScores parameter.
     *
     * @example
     * ```typescript
     * ss.zrange('lb:quiz:group1', 0, 9)         // string[]
     * ss.zrange('lb:quiz:group1', 0, 9, true)   // ZMember[]
     * ```
     */
    zrange(key: string, start: number, stop: number, withScores?: false): string[];
    zrange(key: string, start: number, stop: number, withScores: true): ZMember[];
    /**
     * ZREVRANGE — members by descending score (highest first).
     * start=0, stop=9 → top 10 leaderboard.
     *
     * @example
     * ```typescript
     * const top10 = ss.zrevrange(`lb:${gameType}:${groupJid}`, 0, 9, true)
     * // [{ member: 'userJid', score: 980 }, ...]
     * ```
     */
    zrevrange(key: string, start: number, stop: number, withScores?: false): string[];
    zrevrange(key: string, start: number, stop: number, withScores: true): ZMember[];
    /**
     * ZRANGEBYSCORE — members with score between min and max (inclusive).
     *
     * @example
     * ```typescript
     * ss.zrangebyscore('lb:quiz:group1', 50, 100)
     * ```
     */
    zrangebyscore(key: string, min: number, max: number): ZMember[];
    /**
     * List all set keys.
     *
     * @example
     * ```typescript
     * ss.keys() // ['lb:quiz:group1', 'lb:trivia:group2']
     * ```
     */
    keys(): string[];
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
    leaderboard(gameType: string, groupJid: string, limit?: number): Array<{
        rank: number;
        member: string;
        score: number;
    }>;
    /**
     * Award points and return new rank. Creates entry if not exists.
     *
     * @example
     * ```typescript
     * const { newScore, rank } = ss.award('quiz', groupJid, userJid, 10)
     * ```
     */
    award(gameType: string, groupJid: string, userJid: string, points: number): {
        newScore: number;
        rank: number;
    };
    /**
     * Reset leaderboard for a group+gameType.
     *
     * @example
     * ```typescript
     * ss.resetLeaderboard('quiz', groupJid)
     * ```
     */
    resetLeaderboard(gameType: string, groupJid: string): void;
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
    globalLeaderboard(gameType: string, limit?: number): Array<{
        rank: number;
        member: string;
        score: number;
        groups: number;
    }>;
    /**
     * Save snapshot and stop timers. Call on graceful shutdown.
     *
     * @example
     * ```typescript
     * await ss.shutdown()
     * ```
     */
    shutdown(): Promise<void>;
    private _getOrCreate;
    private _sorted;
    private _startTimers;
    private _save;
    private _load;
}
