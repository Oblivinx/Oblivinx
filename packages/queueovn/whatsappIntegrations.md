# wa-job-queue — WhatsApp Extensions

> Redis-like features untuk WhatsApp bot, tanpa Redis. Pure in-memory + Oblivinx3x persistence.

Tambahan di atas `wa-job-queue` inti. Install library utama terlebih dahulu, lalu tambahkan modul-modul ini ke project bot kamu.

---

## Daftar isi

- [Overview](#overview)
- [KvStore — Key-Value + TTL](#kvstore)
- [SortedSet — Leaderboard](#sortedset)
- [PubSub — Event Broadcasting](#pubsub)
- [SessionStore — Multi-step Conversation](#sessionstore)
- [CronScheduler — Recurring Jobs](#cronscheduler)
- [Plugin: AntiSpamPlugin](#antispamplugin)
- [Plugin: WaRateLimiterPlugin](#waratelimiterplugin)
- [Plugin: CommandCooldownPlugin](#commandcooldownplugin)
- [Plugin: MessageBufferPlugin](#messagebufferplugin)
- [Contoh integrasi lengkap](#contoh-integrasi-lengkap)
- [Apa yang tidak perlu Redis lagi](#apa-yang-tidak-perlu-redis-lagi)

---

## Overview

| Redis feature          | Pengganti di library ini        |
|------------------------|---------------------------------|
| `GET/SET/EXPIRE/DEL`   | `KvStore`                       |
| `INCR/INCRBY`          | `KvStore.incr()`                |
| `SETNX` (mutex/lock)   | `KvStore.setnx()`               |
| `ZADD/ZREVRANK/ZRANGE` | `SortedSet`                     |
| `PUBLISH/SUBSCRIBE`    | `PubSub`                        |
| Session/state store    | `SessionStore` (di atas KvStore)|
| Cron / recurring jobs  | `CronScheduler` (di atas queue) |
| Rate limiting          | `CommandCooldownPlugin` + `AntiSpamPlugin` |
| WA send rate limit     | `WaRateLimiterPlugin`           |

Semua data disimpan in-memory dan dapat di-persist ke file JSON. Tidak ada proses eksternal.

---

## KvStore

Redis-compatible key-value store dengan TTL, INCR, pattern keys, dan snapshot persistence.

```ts
import { KvStore } from 'wa-job-queue'

const kv = new KvStore({
  persistPath: './data/kv-store.json',   // persist to disk (optional)
  snapshotIntervalMs: 30_000,            // snapshot every 30s (default)
  maxKeys: 50_000,                       // max keys before LRU evict
})
```

### SET / GET / DEL

```ts
// SET dengan TTL
kv.set('afk:628123@s.whatsapp.net', 'Lagi makan', { ttlMs: 2 * 3600_000 })

// GET — returns null jika expired atau tidak ada
const afkReason = kv.get<string>('afk:628xxx')

// DEL
kv.del('afk:628xxx')

// EXISTS
kv.exists('afk:628xxx') // 1 atau 0

// TTL — sisa ms, -1 jika permanent, -2 jika tidak ada
kv.ttl('afk:628xxx')    // misal: 3498123
```

### INCR — Sliding window counter

```ts
// Sliding window anti-spam: max 5 pesan dalam 10 detik
// TTL di-reset setiap kali incr dipanggil
const count = kv.incr(`spam:${jid}:${groupJid}`, 1, 10_000)
if (count > 5) kickUser(jid)
```

### SETNX — Mutex / Lock

```ts
// Lock per group agar game tidak bisa dimulai 2x
if (!kv.setnx(`lock:game:${groupJid}`, 1, 30_000)) {
  return 'Game sudah berjalan!'
}
// ... start game ...
kv.del(`lock:game:${groupJid}`) // release lock setelah selesai
```

### rateCheck — Rate limiting satu baris

```ts
const { allowed, count, resetIn } = kv.rateCheck(
  `rate:${userJid}:${groupJid}`,
  limit = 10,
  windowMs = 60_000,
)
if (!allowed) {
  return `Terlalu banyak pesan! Coba lagi dalam ${Math.ceil(resetIn / 1000)} detik.`
}
```

### cooldown — Command cooldown satu baris

```ts
// Returns false jika sedang cooldown
if (!kv.cooldown(`daily:${userJid}`, 24 * 3600_000)) {
  const remaining = kv.ttl(`daily:${userJid}`)
  return `Daily sudah diklaim! Coba lagi dalam ${Math.ceil(remaining / 3600000)} jam.`
}
// ... beri reward ...
```

### MSET / MGET — Batch operations

```ts
kv.mset([
  { key: 'config:lang:628xxx', value: 'id', ttlMs: 7 * 86_400_000 },
  { key: 'config:tz:628xxx',   value: 'Asia/Jakarta' },
])

const [lang, tz] = kv.mget('config:lang:628xxx', 'config:tz:628xxx')
```

### KEYS — Pattern matching

```ts
// Semua cooldown yang aktif untuk user tertentu
const cooldowns = kv.keys(`cmd-cooldown:628xxx*`)

// Semua user yang sedang AFK
const afkUsers = kv.keys('afk:*')

// Semua lock game yang aktif
const activeLocks = kv.keys('lock:game:*')
```

### Events

```ts
kv.on('set', (key, value) => {})
kv.on('del', (key) => {})
kv.on('expired', (key) => {})
kv.on('flush', () => {})
```

---

## SortedSet

Redis ZADD/ZREVRANK/ZRANGE — untuk leaderboard game, richlist ekonomi, activity ranking.

```ts
import { SortedSet } from 'wa-job-queue'

const ss = new SortedSet({
  persistPath: './data/sorted-sets.json',
  snapshotIntervalMs: 60_000,
})
```

### Leaderboard game

```ts
// Award poin setelah jawab benar
const { newScore, rank } = ss.award('tebakkata', groupJid, userJid, 10)
// → { newScore: 150, rank: 3 }  (rank 1-based, 1 = juara)

// Top 10 leaderboard
const top10 = ss.leaderboard('tebakkata', groupJid, 10)
// → [{ rank: 1, member: 'jid1@s.whatsapp.net', score: 980 }, ...]

// Rank satu user
const rank = ss.zrevrank(`lb:tebakkata:${groupJid}`, userJid) ?? -1
// → 0 = juara 1, 1 = juara 2, dst.

// Reset leaderboard bulanan
ss.resetLeaderboard('tebakkata', groupJid)
```

### Manual ZADD/ZREVRANGE

```ts
// Add atau update
ss.zadd(`lb:family100:${groupJid}`, 750, userJid)

// Increment score (most common)
ss.zincrby(`lb:family100:${groupJid}`, 50, userJid)

// Top 5 dengan score
const top5 = ss.zrevrange(`lb:family100:${groupJid}`, 0, 4, true)
// → [{ member: 'jid', score: 980 }, ...]

// Score satu user
const score = ss.zscore(`lb:family100:${groupJid}`, userJid)

// Jumlah member
const total = ss.zcard(`lb:family100:${groupJid}`)
```

### Richlist ekonomi

```ts
// Update balance di leaderboard setiap transaksi
ss.zadd(`richlist:${botId}`, user.walletBalance, userJid)

// Top 10 terkaya
const richlist = ss.zrevrange(`richlist:${botId}`, 0, 9, true)
```

---

## PubSub

In-process event bus. Multiple handler untuk event yang sama, tanpa coupling langsung antar modul.

```ts
import { PubSub } from 'wa-job-queue'

const pubsub = new PubSub()
```

### Subscribe / Publish

```ts
// Handler 1: welcome message
pubsub.subscribe('group:join', async ({ jid, groupJid, name }) => {
  await sendMessage(groupJid, `Selamat datang @${name}! 🎉`)
})

// Handler 2: leveling init (independent dari handler 1)
pubsub.subscribe('group:join', async ({ jid }) => {
  await initUserLevel(jid)
})

// Handler 3: log join event
pubsub.subscribe('group:join', async ({ jid, groupJid }) => {
  await logJoin(jid, groupJid)
})

// Publish dari WA event handler — semua handler di atas terpanggil
pubsub.publish('group:join', { jid, groupJid, name: pushName })
```

### Pattern subscribe

```ts
// Subscribe ke semua game events
pubsub.psubscribe('game:*', async (payload, channel) => {
  console.log(`Game event: ${channel}`, payload)
})

// Subscribe ke semua group events
pubsub.psubscribe('group:*', async (payload, channel) => {
  await auditLog(channel, payload)
})
```

### waitFor — Tunggu reply user

```ts
// Tanya user, tunggu jawaban max 30 detik
await sendMessage(groupJid, 'Ketik nama kamu:')

// Publish dari incoming message handler saat pesan dari user ini masuk
// pubsub.publish(`reply:${userJid}:${groupJid}`, { text: incomingMessage })

const reply = await pubsub.waitFor<{ text: string }>(
  `reply:${userJid}:${groupJid}`,
  30_000
)

if (!reply) return 'Waktu habis!'
return `Halo, ${reply.text}!`
```

### Unsubscribe

```ts
const sub = pubsub.subscribe('spam:detected', handler)
// ...
sub.unsubscribe()
```

### Standard WA events yang direkomendasikan

```ts
// Events yang perlu di-publish dari WA message handler:
pubsub.publish('group:join',        { jid, groupJid, name })
pubsub.publish('group:leave',       { jid, groupJid })
pubsub.publish('message:delete',    { messageId, groupJid, senderJid, content })
pubsub.publish('message:incoming',  { jid, groupJid, text, type })
pubsub.publish('spam:detected',     { userJid, groupJid, count, action })
pubsub.publish('game:answer',       { userJid, groupJid, gameType, answer, correct })
pubsub.publish('level:up',          { userJid, groupJid, oldLevel, newLevel })
pubsub.publish('economy:reward',    { userJid, type, amount, balance })
pubsub.publish('moderation:action', { userJid, groupJid, action, executorJid, reason })
```

---

## SessionStore

Multi-step conversation state. Backed by KvStore — expire otomatis, tidak ada DB write.

```ts
import { SessionStore } from 'wa-job-queue'

const sessions = new SessionStore({
  defaultTtlMs: 5 * 60_000,  // 5 menit inactivity = session expired
  kv,                          // share KvStore yang sama dengan bot
  pubsub,                      // optional: emit session events
})
```

### Basic usage

```ts
// Command: !daftar
sessions.start(userJid, groupJid, 'await-name')
await sendMessage(groupJid, `@${name} Siapa nama lengkap kamu?`)

// Incoming message handler (cek semua incoming messages)
const session = sessions.get(userJid, groupJid)

if (session?.step === 'await-name') {
  sessions.advance(userJid, groupJid, 'await-age', { fullName: messageText })
  await sendMessage(groupJid, `Berapa umur kamu?`)

} else if (session?.step === 'await-age') {
  const age = parseInt(messageText)
  sessions.end(userJid, groupJid)
  await registerUser(userJid, session.data.fullName, age)
  await sendMessage(groupJid, `Berhasil daftar sebagai ${session.data.fullName}, umur ${age}!`)
}
```

### ifStep — Step-gated helper

```ts
const { matched } = await sessions.ifStep(
  userJid, groupJid,
  'await-name',     // expected step
  'await-age',      // next step (null = end session)
  async (session) => {
    if (messageText.length < 3) throw new Error('Nama terlalu pendek')
    return { fullName: messageText }  // data patch
  }
)

if (!matched) return // User tidak dalam session ini
```

### Group operations

```ts
// Semua session aktif di group ini
const activeSessions = sessions.forGroup(groupJid)

// Clear semua session di group (misalnya bot di-restart di group)
sessions.clearGroup(groupJid)

// Total session aktif
const total = sessions.count()
```

---

## CronScheduler

Persistent recurring job scheduler. Integrates langsung dengan wa-job-queue.

```ts
import { CronScheduler } from 'wa-job-queue'

const cron = new CronScheduler(
  { persistPath: './data/cron.json' },
  queue.enqueue.bind(queue),
)
await cron.initialize()
```

### Tambah jadwal

```ts
// Standard cron expression (5-field)
cron.add({
  id: 'daily-reset',
  schedule: '0 0 * * *',        // Midnight setiap hari
  jobType: 'daily-stats-reset',
  payload: {},
})

cron.add({
  id: 'db-cleanup',
  schedule: '0 2 * * *',        // 2 AM setiap hari
  jobType: 'db-cleanup',
  payload: { tables: ['GroupMessage', 'BotTelemetry', 'CommandCooldown'] },
})

cron.add({
  id: 'monthly-status',
  schedule: '0 8 1 * *',        // 8 AM tanggal 1 setiap bulan
  jobType: 'send-monthly-stats',
  payload: {},
})

// Shorthand interval
cron.add({
  id: 'leaderboard-announce',
  schedule: 'every 24 hours',
  jobType: 'announce-leaderboard',
  payload: { gameType: 'tebakkata' },
})

cron.add({
  id: 'flush-stats',
  schedule: 'every 5 minutes',
  jobType: 'flush-user-stats',
  payload: {},
})

// One-time: maxRuns = 1
cron.add({
  id: 'welcome-blast',
  schedule: 'every 1 minutes',
  jobType: 'send-broadcast',
  payload: { message: 'Bot launched!' },
  maxRuns: 1,
})
```

### Manage schedules

```ts
cron.remove('daily-reset')
cron.setEnabled('leaderboard-announce', false)  // pause
cron.setEnabled('leaderboard-announce', true)   // resume
cron.runNow('db-cleanup')                        // trigger immediately

const all = cron.list()
const active = cron.list({ enabled: true })
const entry = cron.get('daily-reset')
// { id, schedule, jobType, nextRunAt, runCount, lastRunAt, ... }
```

---

## AntiSpamPlugin

Deteksi flood message per user per group. Integrates dengan wa-job-queue sebagai plugin.

```ts
import { AntiSpamPlugin } from 'wa-job-queue'

const antiSpam = new AntiSpamPlugin({
  maxMessages: 5,
  windowMs: 10_000,       // 5 pesan dalam 10 detik = spam
  action: {
    action: 'mute',
    muteDuration: 5 * 60_000,
  },
  kv,                      // share KvStore
  pubsub,                  // emit 'spam:detected' event
  whitelist: [adminJid],   // admin tidak kena anti-spam
})

const queue = new JobQueue({
  name: 'messages',
  plugins: [antiSpam],
})

// Handle detection di luar queue
pubsub.subscribe('spam:detected', async ({ userJid, groupJid, action, muteDuration }) => {
  if (action === 'mute') await waClient.groupParticipantsUpdate(groupJid, [userJid], 'demote')
  if (action === 'kick') await waClient.groupParticipantsUpdate(groupJid, [userJid], 'remove')
  await sendMessage(groupJid, `@${userJid} terdeteksi spam dan di-mute selama ${muteDuration/60000} menit.`)
})
```

Job yang di-enqueue harus punya `payload.userJid` dan `payload.groupJid`:

```ts
await queue.enqueue({
  type: 'process-message',
  payload: { userJid, groupJid, text, messageId },
})
```

---

## WaRateLimiterPlugin

Rate limiter untuk WhatsApp send limit (~1 pesan/detik per nomor).

```ts
import { WaRateLimiterPlugin } from 'wa-job-queue'

const waRateLimit = new WaRateLimiterPlugin({
  maxPerSecond: 1,
  maxPerMinute: 20,
  botKey: 'bot-main',
  sendTypes: ['send-message', 'send-media', 'send-reply'],
  kv,
})

const sendQueue = new JobQueue({
  name: 'send',
  plugins: [waRateLimit],
  workers: { min: 1, max: 1 },   // Single worker penting untuk ordered sends
  defaultMaxAttempts: 3,
})

sendQueue.register('send-message', async ({ to, text }) => {
  await waClient.sendMessage(to, { text })
})
```

---

## CommandCooldownPlugin

Per-user, per-command cooldown. Menggantikan `CommandCooldown` model di DB.

```ts
import { CommandCooldownPlugin } from 'wa-job-queue'

const cooldown = new CommandCooldownPlugin({
  defaultCooldownMs: 5_000,
  commandCooldowns: {
    daily:      86_400_000,      // 24 jam
    weekly:     7 * 86_400_000,  // 7 hari
    game:       30_000,          // 30 detik
    quiz:       10_000,
    sticker:    3_000,
    tts:        5_000,
  },
  adminJids: ['6281234567890@s.whatsapp.net'],
  kv,
})

const queue = new JobQueue({
  name: 'commands',
  plugins: [cooldown],
})

// Job harus punya payload.userJid dan payload.command
await queue.enqueue({
  type: 'run-command',
  payload: { userJid, groupJid, command: 'daily', args: [] },
})

// Cek cooldown tanpa enqueue
const remaining = cooldown.remaining(userJid, 'daily')
// → 82340000 (ms)

// Admin clear cooldown
cooldown.clear(userJid, 'daily')

// Lihat semua cooldown aktif user
const active = cooldown.activeCooldowns(userJid)
// → { game: 23000, sticker: 1200 }
```

---

## Contoh integrasi lengkap

```ts
import {
  JobQueue, OvnDbAdapter,
  KvStore, SortedSet, PubSub, SessionStore, CronScheduler,
  AntiSpamPlugin, WaRateLimiterPlugin, CommandCooldownPlugin,
} from 'wa-job-queue'

// ── 1. Shared stores ───────────────────────────────────────────────────────
const kv      = new KvStore({ persistPath: './data/kv.json' })
const ss      = new SortedSet({ persistPath: './data/sorted-sets.json' })
const pubsub  = new PubSub()
const sessions = new SessionStore({ kv, pubsub, defaultTtlMs: 5 * 60_000 })

// ── 2. Plugins ─────────────────────────────────────────────────────────────
const antiSpam   = new AntiSpamPlugin({ maxMessages: 5, windowMs: 10_000, kv, pubsub })
const waLimit    = new WaRateLimiterPlugin({ maxPerSecond: 1, botKey: 'main', kv })
const cmdCooldown = new CommandCooldownPlugin({
  commandCooldowns: { daily: 86_400_000, game: 30_000 },
  kv,
})

// ── 3. Queues ──────────────────────────────────────────────────────────────
const adapter = new OvnDbAdapter({ path: './data/jobs.ovn' })
await adapter.initialize()

// Queue untuk processing pesan masuk
const msgQueue = new JobQueue({
  name: 'messages',
  adapter,
  plugins: [antiSpam, cmdCooldown],
  workers: { min: 2, max: 8 },
})

// Queue khusus untuk kirim pesan ke WA (rate limited)
const sendQueue = new JobQueue({
  name: 'send',
  adapter,
  plugins: [waLimit],
  workers: { min: 1, max: 1 },
})

// ── 4. Job handlers ────────────────────────────────────────────────────────
msgQueue.register('process-message', async ({ userJid, groupJid, text, command }) => {
  // Check session
  const session = sessions.get(userJid, groupJid)
  if (session) {
    pubsub.publish(`reply:${userJid}:${groupJid}`, { text })
    return
  }

  if (command === 'game') {
    // Lock agar tidak 2 game bersamaan
    if (!kv.setnx(`lock:game:${groupJid}`, 1, 60_000)) {
      await sendQueue.enqueue({ type: 'send-message', payload: { to: groupJid, text: 'Game sedang berjalan!' } })
      return
    }
    pubsub.publish('game:start', { userJid, groupJid, gameType: 'tebakkata' })
  }
})

sendQueue.register('send-message', async ({ to, text }) => {
  await waClient.sendMessage(to, { text })
})

// ── 5. PubSub handlers ─────────────────────────────────────────────────────
pubsub.subscribe('spam:detected', async ({ userJid, groupJid, muteDuration }) => {
  await sendQueue.enqueue({
    type: 'send-message',
    payload: { to: groupJid, text: `@${userJid} dideteksi spam, di-mute ${muteDuration/60000}m` }
  })
})

pubsub.subscribe('game:answer', async ({ userJid, groupJid, gameType, correct, points }) => {
  if (correct) {
    const { newScore, rank } = ss.award(gameType, groupJid, userJid, points)
    kv.incr(`streak:${userJid}:${groupJid}`, 1, 3600_000)
  }
})

pubsub.subscribe('level:up', async ({ userJid, groupJid, newLevel }) => {
  await sendQueue.enqueue({
    type: 'send-message',
    payload: { to: groupJid, text: `Selamat @${userJid} naik ke Level ${newLevel}! 🎉` }
  })
})

// ── 6. CronScheduler ───────────────────────────────────────────────────────
const cron = new CronScheduler(
  { persistPath: './data/cron.json' },
  msgQueue.enqueue.bind(msgQueue),
)
await cron.initialize()

cron.add({ id: 'daily-reset',  schedule: '0 0 * * *',  jobType: 'daily-stats-reset', payload: {} })
cron.add({ id: 'db-cleanup',   schedule: '0 2 * * *',  jobType: 'db-cleanup', payload: {} })
cron.add({ id: 'flush-stats',  schedule: 'every 5 minutes', jobType: 'flush-user-stats', payload: {} })

// ── 7. Initialize & start ──────────────────────────────────────────────────
await msgQueue.initialize()
await sendQueue.initialize()

// ── 8. Dari WA message event ───────────────────────────────────────────────
waClient.ev.on('messages.upsert', async ({ messages }) => {
  for (const msg of messages) {
    if (!msg.message || msg.key.fromMe) continue

    const userJid  = msg.key.participant ?? msg.key.remoteJid!
    const groupJid = msg.key.remoteJid!
    const text     = msg.message.conversation ?? ''
    const command  = text.startsWith('!') ? text.slice(1).split(' ')[0] : null

    await msgQueue.enqueue({
      type: 'process-message',
      payload: { userJid, groupJid, text, command, messageId: msg.key.id },
    })
  }
})

// ── 9. Graceful shutdown ───────────────────────────────────────────────────
process.on('SIGINT', async () => {
  await msgQueue.shutdown()
  await sendQueue.shutdown()
  await kv.shutdown()
  await ss.shutdown()
  await cron.shutdown()
  process.exit(0)
})
```

---

## Apa yang tidak perlu Redis lagi

| Kebutuhan sebelumnya              | Solusi baru                                    |
|-----------------------------------|------------------------------------------------|
| `SET cooldown:user:cmd EX 30`     | `kv.cooldown(key, 30_000)`                     |
| `INCR spam:user:group` + `EXPIRE` | `kv.incr(key, 1, windowMs)`                    |
| `SETNX lock:game:group`           | `kv.setnx(key, 1, ttlMs)`                      |
| `ZADD lb:game:group score user`   | `ss.zincrby(key, points, userJid)`             |
| `ZREVRANGE lb 0 9`                | `ss.leaderboard(gameType, groupJid, 10)`       |
| `ZREVRANK lb user`                | `ss.zrevrank(key, userJid)`                    |
| `SUBSCRIBE group:join`            | `pubsub.subscribe('group:join', handler)`      |
| `PUBLISH group:join payload`      | `pubsub.publish('group:join', payload)`        |
| Session store (HSET/HGET)         | `sessions.start/get/advance/end`               |
| Cron via redis-cron               | `cron.add({ schedule: '0 0 * * *', ... })`    |
| BullMQ rate limiter               | `CommandCooldownPlugin` + `AntiSpamPlugin`     |
| WA send queue (rate limit)        | `WaRateLimiterPlugin` + single worker          |

---

## Struktur file

```
src/
  stores/
    KvStore.ts          ← GET/SET/EXPIRE/INCR/SETNX/KEYS/rateCheck/cooldown
    SortedSet.ts        ← ZADD/ZREVRANK/ZREVRANGE/leaderboard/award
    PubSub.ts           ← SUBSCRIBE/PUBLISH/PSUBSCRIBE/waitFor
    SessionStore.ts     ← Multi-step conversation state (di atas KvStore)
  scheduler/
    CronScheduler.ts    ← Recurring jobs, survives restart, cron expressions
  plugins/
    WhatsAppPlugins.ts  ← AntiSpam, WaRateLimiter, CommandCooldown, MessageBuffer
  index.ts              ← Barrel exports
```

---

MIT License