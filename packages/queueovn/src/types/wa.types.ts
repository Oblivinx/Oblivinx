// ═══════════════════════════════════════════════
// FILE: src/types/wa.types.ts
// Shared WhatsApp-specific types for plugins, stores, and WaBotContext
// ═══════════════════════════════════════════════

/**
 * Standard WhatsApp bot event map.
 * Used with `TypedPubSub<WaBotEvents>` for fully type-safe pub/sub.
 *
 * @example
 * ```typescript
 * const pubsub = new TypedPubSub<WaBotEvents>()
 * pubsub.subscribe('group:join', ({ jid, groupJid, name }) => { /* fully typed *\/ })
 * pubsub.publish('group:join', { jid, groupJid, name, timestamp: Date.now() })
 * ```
 */
export interface WaBotEvents {
    'group:join': { jid: string; groupJid: string; name: string; timestamp: number }
    'group:leave': { jid: string; groupJid: string; timestamp: number }
    'message:delete': { messageId: string; groupJid: string; senderJid: string; content: string }
    'message:incoming': { jid: string; groupJid: string; text: string; type: string; messageId: string }
    'spam:detected': { userJid: string; groupJid: string; count: number; action: string; muteDuration?: number }
    'game:start': { userJid: string; groupJid: string; gameType: string }
    'game:answer': { userJid: string; groupJid: string; gameType: string; correct: boolean; points: number }
    'game:end': { groupJid: string; gameType: string; winner: string; finalScore: number }
    'level:up': { userJid: string; groupJid: string; oldLevel: number; newLevel: number }
    'economy:reward': { userJid: string; type: string; amount: number; balance: number }
    'moderation:action': { userJid: string; groupJid: string; action: string; executorJid: string; reason: string }
    'session:start': { userJid: string; groupJid: string; step: string }
    'session:advance': { userJid: string; groupJid: string; prevStep: string; nextStep: string }
    'session:end': { userJid: string; groupJid: string }
}

/**
 * Options for constructing a `WaBotContext`.
 */
export interface WaBotContextOptions {
    kv?: import('../stores/KvStore.js').KvStore
    ss?: import('../stores/SortedSet.js').SortedSet
    pubsub?: import('../stores/PubSub.js').PubSub
    sessions?: import('../stores/SessionStore.js').SessionStore
    cron?: import('../scheduler/CronScheduler.js').CronScheduler
}

/** Options for KvStore list push operations */
export interface ListPushOptions {
    /** Auto-trim list from opposite end if length exceeds this value */
    maxLen?: number
}
