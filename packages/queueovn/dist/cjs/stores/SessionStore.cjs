"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionStore = void 0;
const KvStore_js_1 = require("./KvStore.cjs");
// ─── SessionStore ─────────────────────────────────────────────────────────────
/**
 * Multi-step conversation state for WhatsApp bots.
 * Backed by KvStore — no external DB needed.
 *
 * Pattern: bot asks a question → user replies → bot reads state → advance step.
 *
 * @example
 * ```typescript
 * // Step 1: Start quiz session
 * sessions.start(userJid, groupJid, 'quiz', { questionIndex: 0 })
 * await sendMessage(groupJid, 'Pertanyaan 1: Ibukota Jawa Tengah?')
 *
 * // Step 2: On next message from same user in same group
 * const session = sessions.get(userJid, groupJid)
 * if (session?.step === 'quiz') {
 *   const correct = checkAnswer(userJid, messageText, session.data)
 *   if (correct) sessions.advance(userJid, groupJid, 'quiz-done', { ...session.data, score: 1 })
 *   else sessions.end(userJid, groupJid)
 * }
 * ```
 */
class SessionStore {
    kv;
    pubsub;
    defaultTtlMs;
    constructor(options = {}) {
        this.kv = options.kv ?? new KvStore_js_1.KvStore();
        this.pubsub = options.pubsub ?? null;
        this.defaultTtlMs = options.defaultTtlMs ?? 5 * 60_000;
    }
    // ─── Session lifecycle ─────────────────────────────────────────────────────
    /**
     * Start a new session for a user. Overwrites any existing session.
     *
     * @example
     * ```typescript
     * sessions.start(userJid, groupJid, 'register', { step: 1 })
     * ```
     */
    start(userJid, groupJid, step, data = {}, ttlMs) {
        const session = {
            step,
            data,
            userJid,
            groupJid,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        this.kv.set(this._key(userJid, groupJid), session, { ttlMs: ttlMs ?? this.defaultTtlMs });
        this.pubsub?.publish('session:start', { userJid, groupJid, step });
        return session;
    }
    /**
     * Get current session. Returns null if no session or expired.
     *
     * @example
     * ```typescript
     * const session = sessions.get(userJid, groupJid)
     * if (session) console.log(session.step)
     * ```
     */
    get(userJid, groupJid) {
        return this.kv.get(this._key(userJid, groupJid));
    }
    /**
     * Check if a user has an active session.
     *
     * @example
     * ```typescript
     * if (sessions.has(userJid, groupJid)) handleSession()
     * ```
     */
    has(userJid, groupJid) {
        return this.kv.exists(this._key(userJid, groupJid)) > 0;
    }
    /**
     * Advance to a new step, merging extra data.
     * Resets TTL (activity extends session lifetime).
     *
     * @example
     * ```typescript
     * sessions.advance(userJid, groupJid, 'awaiting-confirm', { answer: 'yes' })
     * ```
     */
    advance(userJid, groupJid, nextStep, dataPatch, ttlMs) {
        const session = this.get(userJid, groupJid);
        if (!session)
            return null;
        const prevStep = session.step;
        session.step = nextStep;
        session.data = { ...session.data, ...dataPatch };
        session.updatedAt = Date.now();
        this.kv.set(this._key(userJid, groupJid), session, { ttlMs: ttlMs ?? this.defaultTtlMs });
        this.pubsub?.publish('session:advance', { userJid, groupJid, prevStep, nextStep });
        return session;
    }
    /**
     * Update data without changing the step.
     * BUG FIX: returns null early if session does not exist, instead of
     * calling advance() with empty step which would create a ghost session.
     *
     * @example
     * ```typescript
     * sessions.patch(userJid, groupJid, { score: 42 })
     * ```
     */
    patch(userJid, groupJid, dataPatch, ttlMs) {
        const session = this.get(userJid, groupJid);
        if (!session)
            return null;
        return this.advance(userJid, groupJid, session.step, dataPatch, ttlMs);
    }
    /**
     * End/clear a session.
     *
     * @example
     * ```typescript
     * sessions.end(userJid, groupJid)
     * ```
     */
    end(userJid, groupJid) {
        const existed = this.kv.del(this._key(userJid, groupJid)) > 0;
        if (existed)
            this.pubsub?.publish('session:end', { userJid, groupJid });
        return existed;
    }
    /**
     * Extend session TTL without changing any data (keepalive).
     *
     * @example
     * ```typescript
     * sessions.touch(userJid, groupJid)
     * ```
     */
    touch(userJid, groupJid, ttlMs) {
        return this.kv.expire(this._key(userJid, groupJid), ttlMs ?? this.defaultTtlMs);
    }
    /**
     * Get remaining TTL in ms. -1 = no expiry, -2 = not found.
     *
     * @example
     * ```typescript
     * const remaining = sessions.ttl(userJid, groupJid)
     * ```
     */
    ttl(userJid, groupJid) {
        return this.kv.ttl(this._key(userJid, groupJid));
    }
    // ─── Bulk ops ──────────────────────────────────────────────────────────────
    /**
     * Count active sessions (across all users and groups).
     *
     * @example
     * ```typescript
     * console.log(`${sessions.count()} active sessions`)
     * ```
     */
    count() {
        return this.kv.keys('session:*').length;
    }
    /**
     * Get all active sessions for a specific group.
     *
     * @example
     * ```typescript
     * const groupSessions = sessions.forGroup(groupJid)
     * ```
     */
    forGroup(groupJid) {
        const keys = this.kv.keys(`session:*:${this._escapeJid(groupJid)}`);
        return keys.map(k => this.kv.get(k)).filter(Boolean);
    }
    /**
     * Clear all sessions for a group (e.g. game ended, group kicked).
     *
     * @example
     * ```typescript
     * sessions.clearGroup(groupJid)
     * ```
     */
    clearGroup(groupJid) {
        const keys = this.kv.keys(`session:*:${this._escapeJid(groupJid)}`);
        return this.kv.del(...keys);
    }
    /**
     * List ALL active sessions across all users and groups.
     * Useful for debugging or admin dashboards.
     *
     * @example
     * ```typescript
     * const all = sessions.listAll()
     * console.log(`${all.length} active sessions`)
     * ```
     */
    listAll() {
        const keys = this.kv.keys('session:*');
        return keys.map(k => this.kv.get(k)).filter(Boolean);
    }
    /**
     * End ALL active sessions. Returns the number of sessions ended.
     * Useful on graceful bot shutdown.
     *
     * @example
     * ```typescript
     * const ended = sessions.endAll()
     * console.log(`Cleared ${ended} sessions`)
     * ```
     */
    endAll() {
        const keys = this.kv.keys('session:*');
        if (keys.length === 0)
            return 0;
        const count = this.kv.del(...keys);
        if (count > 0)
            this.pubsub?.publish('session:end-all', { count });
        return count;
    }
    // ─── Step-gated helper ─────────────────────────────────────────────────────
    /**
     * Execute fn only if user is on the expected step.
     * Automatically advances to nextStep on success.
     * If nextStep is null, session is ended.
     *
     * BUG FIX: return type uses union overloads for better narrowing.
     *
     * @example
     * ```typescript
     * await sessions.ifStep(userJid, groupJid, 'awaiting-name', 'awaiting-age', async (session) => {
     *   return { name: messageText }
     * })
     * ```
     */
    async ifStep(userJid, groupJid, expectedStep, nextStep, fn) {
        const session = this.get(userJid, groupJid);
        if (!session || session.step !== expectedStep)
            return { matched: false, session: null };
        const patch = await fn(session);
        if (nextStep === null) {
            this.end(userJid, groupJid);
            return { matched: true, session: null };
        }
        const updated = this.advance(userJid, groupJid, nextStep, patch);
        return { matched: true, session: updated };
    }
    // ─── Private helpers ───────────────────────────────────────────────────────
    _key(userJid, groupJid) {
        return `session:${this._escapeJid(userJid)}:${this._escapeJid(groupJid)}`;
    }
    _escapeJid(jid) {
        return jid.replace(/[^a-zA-Z0-9@._-]/g, '_');
    }
}
exports.SessionStore = SessionStore;
