import { KvStore } from './KvStore.js';
import { PubSub } from './PubSub.js';
export interface SessionData<T = Record<string, unknown>> {
    /** Current step/state name */
    step: string;
    /** Arbitrary payload the handler stores between steps */
    data: T;
    /** JID who started the session */
    userJid: string;
    /** Group JID (empty string for DM sessions) */
    groupJid: string;
    /** Session creation time (ms) */
    createdAt: number;
    /** Last activity time (ms) */
    updatedAt: number;
}
export interface SessionStoreOptions {
    /**
     * How long a session stays alive without activity (ms).
     * Default: 5 minutes.
     */
    defaultTtlMs?: number;
    /** KvStore instance to use. If not provided, creates its own. */
    kv?: KvStore;
    /** PubSub instance to publish session events. Optional. */
    pubsub?: PubSub;
}
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
export declare class SessionStore {
    private kv;
    private pubsub;
    private readonly defaultTtlMs;
    constructor(options?: SessionStoreOptions);
    /**
     * Start a new session for a user. Overwrites any existing session.
     *
     * @example
     * ```typescript
     * sessions.start(userJid, groupJid, 'register', { step: 1 })
     * ```
     */
    start<T = Record<string, unknown>>(userJid: string, groupJid: string, step: string, data?: T, ttlMs?: number): SessionData<T>;
    /**
     * Get current session. Returns null if no session or expired.
     *
     * @example
     * ```typescript
     * const session = sessions.get(userJid, groupJid)
     * if (session) console.log(session.step)
     * ```
     */
    get<T = Record<string, unknown>>(userJid: string, groupJid: string): SessionData<T> | null;
    /**
     * Check if a user has an active session.
     *
     * @example
     * ```typescript
     * if (sessions.has(userJid, groupJid)) handleSession()
     * ```
     */
    has(userJid: string, groupJid: string): boolean;
    /**
     * Advance to a new step, merging extra data.
     * Resets TTL (activity extends session lifetime).
     *
     * @example
     * ```typescript
     * sessions.advance(userJid, groupJid, 'awaiting-confirm', { answer: 'yes' })
     * ```
     */
    advance<T = Record<string, unknown>>(userJid: string, groupJid: string, nextStep: string, dataPatch?: Partial<T>, ttlMs?: number): SessionData<T> | null;
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
    patch<T = Record<string, unknown>>(userJid: string, groupJid: string, dataPatch: Partial<T>, ttlMs?: number): SessionData<T> | null;
    /**
     * End/clear a session.
     *
     * @example
     * ```typescript
     * sessions.end(userJid, groupJid)
     * ```
     */
    end(userJid: string, groupJid: string): boolean;
    /**
     * Extend session TTL without changing any data (keepalive).
     *
     * @example
     * ```typescript
     * sessions.touch(userJid, groupJid)
     * ```
     */
    touch(userJid: string, groupJid: string, ttlMs?: number): boolean;
    /**
     * Get remaining TTL in ms. -1 = no expiry, -2 = not found.
     *
     * @example
     * ```typescript
     * const remaining = sessions.ttl(userJid, groupJid)
     * ```
     */
    ttl(userJid: string, groupJid: string): number;
    /**
     * Count active sessions (across all users and groups).
     *
     * @example
     * ```typescript
     * console.log(`${sessions.count()} active sessions`)
     * ```
     */
    count(): number;
    /**
     * Get all active sessions for a specific group.
     *
     * @example
     * ```typescript
     * const groupSessions = sessions.forGroup(groupJid)
     * ```
     */
    forGroup<T = Record<string, unknown>>(groupJid: string): SessionData<T>[];
    /**
     * Clear all sessions for a group (e.g. game ended, group kicked).
     *
     * @example
     * ```typescript
     * sessions.clearGroup(groupJid)
     * ```
     */
    clearGroup(groupJid: string): number;
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
    listAll<T = Record<string, unknown>>(): SessionData<T>[];
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
    endAll(): number;
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
    ifStep<T = Record<string, unknown>>(userJid: string, groupJid: string, expectedStep: string, nextStep: string | null, fn: (session: SessionData<T>) => Promise<Partial<T> | void> | Partial<T> | void): Promise<{
        matched: boolean;
        session: SessionData<T> | null;
    }>;
    private _key;
    private _escapeJid;
}
