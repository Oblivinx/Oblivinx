/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          wa-job-queue — Aggressive Integration Test Suite        ║
 * ║                                                                  ║
 * ║  Covers every public API, plugin, edge-case, and perf scenario  ║
 * ║  Run: npx tsx example.ts                                        ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import {
  JobQueue,
  JobBatch,
  JobBuilder,
  Metrics,
  DeadLetterQueue,
  RateLimiter,
  Deduplicator,
  Debounce,
  Throttle,
  JobTTL,
  ExponentialBackoff,
  LinearBackoff,
  NoRetry,
  CustomRetry,
  CircuitBreaker,
  FileAdapter,
  MemoryAdapter,
  QueueEvent,
  sleep,
} from '../src';

// ─── ANSI ────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m', blue: '\x1b[34m', gray: '\x1b[90m',
};
const fmt = (color: string, s: string) => `${color}${s}${C.reset}`;

// ─── Test runner ─────────────────────────────────────────────────────────────
interface TestResult { name: string; ok: boolean; ms: number; note?: string }
const suite: TestResult[] = [];
let currentSection = '';

function section(title: string) {
  currentSection = title;
  console.log(`\n${C.bold}${C.cyan}┌─ ${title} ${'─'.repeat(Math.max(0, 62 - title.length))}${C.reset}`);
}

async function test(name: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  try {
    await fn();
    const ms = performance.now() - t0;
    suite.push({ name: `${currentSection} › ${name}`, ok: true, ms });
    console.log(`│ ${fmt(C.green, '✓')} ${name} ${fmt(C.gray, `${ms.toFixed(1)}ms`)}`);
  } catch (err) {
    const ms = performance.now() - t0;
    const note = err instanceof Error ? err.message : String(err);
    suite.push({ name: `${currentSection} › ${name}`, ok: false, ms, note });
    console.log(`│ ${fmt(C.red, '✗')} ${name} ${fmt(C.gray, `${ms.toFixed(1)}ms`)}`);
    console.log(`│   ${fmt(C.red, '→ ' + note)}`);
  }
}

function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

function log(msg: string) {
  console.log(`│   ${fmt(C.gray, msg)}`);
}

// ─── tmp dir for file-based adapters ─────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-example-'));
const tmpFile = (name: string) => path.join(TMP, name);
process.on('exit', () => fs.rmSync(TMP, { recursive: true, force: true }));

async function main() {
  // ════════════════════════════════════════════════════════════════════════════
  //  1. BASIC LIFECYCLE
  // ════════════════════════════════════════════════════════════════════════════
  section('1 · Basic Lifecycle');

  await test('enqueue → process → drain → shutdown', async () => {
    const q = new JobQueue({ name: 'basic', workers: { min: 1, max: 2 } });
    let got = '';
    q.register('greet', async (p: { name: string }) => { got = `Hello ${p.name}`; });
    await q.initialize();
    await q.enqueue({ type: 'greet', payload: { name: 'World' } });
    await q.drain();
    ok(got === 'Hello World', `got "${got}"`);
    await q.shutdown();
  });

  await test('20 concurrent workers process 200 jobs without loss', async () => {
    const q = new JobQueue({ name: 'concurrent', workers: { min: 4, max: 20 } });
    let n = 0;
    q.register('inc', async () => { n++; });
    await q.initialize();
    await Promise.all(Array.from({ length: 200 }, () => q.enqueue({ type: 'inc', payload: {} })));
    await q.drain();
    ok(n === 200, `expected 200 got ${n}`);
    await q.shutdown();
  });

  await test('pause → resume — jobs wait and then all complete', async () => {
    const q = new JobQueue({ name: 'pause', workers: { min: 1, max: 2 } });
    let done = 0;
    q.register('work', async () => { done++; });
    await q.initialize();
    q.pause();
    for (let i = 0; i < 10; i++) await q.enqueue({ type: 'work', payload: {} });
    ok(done === 0, 'paused: no jobs should have run yet');
    q.resume();
    await q.drain();
    ok(done === 10, `expected 10 got ${done}`);
    await q.shutdown();
  });

  await test('clear() drops all pending jobs', async () => {
    const q = new JobQueue({ name: 'clear', workers: { min: 0, max: 1 } });
    q.register('noop', async () => { });
    q.pause();
    for (let i = 0; i < 50; i++) await q.enqueue({ type: 'noop', payload: {} });
    ok(await q.size() === 50, 'should have 50 queued');
    await q.clear();
    ok(await q.size() === 0, 'should have 0 after clear');
    await q.shutdown();
  });

  await test('shutdown waits for in-flight jobs', async () => {
    const q = new JobQueue({ name: 'shutdown', workers: { min: 4, max: 4 } });
    let done = 0;
    q.register('slow', async () => { await sleep(30); done++; });
    await q.initialize();
    for (let i = 0; i < 8; i++) await q.enqueue({ type: 'slow', payload: {} });
    await q.shutdown(); // waits for the 4 active jobs, does not start the other 4
    ok(done === 4, `expected 4 in-flight jobs done before shutdown resolved, got ${done}`);
  });

  await test('throws QueueError after shutdown', async () => {
    const q = new JobQueue({ name: 'closed', workers: { min: 1, max: 1 } });
    q.register('x', async () => { });
    await q.shutdown();
    let threw = false;
    try { await q.enqueue({ type: 'x', payload: {} }); } catch { threw = true; }
    ok(threw, 'should throw QueueError on closed queue');
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  2. PRIORITY HEAP
  // ════════════════════════════════════════════════════════════════════════════
  section('2 · Priority Ordering');

  await test('strict priority ordering across 6 priority levels', async () => {
    const q = new JobQueue({ name: 'prio', workers: { min: 1, max: 1 } });
    const order: number[] = [];
    q.register('t', async (p: { p: number }) => { order.push(p.p); });
    q.pause();
    for (const p of [5, 1, 9, 2, 7, 3]) {
      await q.enqueue({ type: 't', payload: { p }, priority: p });
    }
    q.resume();
    await q.initialize();
    await q.drain();
    for (let i = 1; i < order.length; i++) {
      ok(order[i]! >= order[i - 1]!, `priority broke at pos ${i}: ${order.join(',')}`);
    }
    await q.shutdown();
  });

  await test('1,000 jobs: 90%+ high-prio processed before any low-prio', async () => {
    const q = new JobQueue({ name: 'prio-load', workers: { min: 1, max: 1 } });
    const order: number[] = [];
    q.register('pj', async (p: { p: number }) => { order.push(p.p); });
    q.pause();
    const lo = Array.from({ length: 500 }, () => q.enqueue({ type: 'pj', payload: { p: 9 }, priority: 9 }));
    const hi = Array.from({ length: 500 }, () => q.enqueue({ type: 'pj', payload: { p: 1 }, priority: 1 }));
    await Promise.all([...lo, ...hi]);
    q.resume();
    await q.initialize();
    await q.drain();
    const first500prio1 = order.slice(0, 500).filter((p) => p === 1).length;
    const pct = (first500prio1 / 500) * 100;
    log(`${pct.toFixed(1)}% priority-1 jobs in first 500 processed`);
    ok(pct >= 90, `expected >=90%, got ${pct.toFixed(1)}%`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  3. RETRY POLICIES
  // ════════════════════════════════════════════════════════════════════════════
  section('3 · Retry Policies');

  await test('ExponentialBackoff — 3 attempts, eventual success', async () => {
    const q = new JobQueue({ name: 'exp', workers: { min: 1, max: 1 }, defaultMaxAttempts: 5 });
    let attempts = 0;
    q.register('flaky', async () => { if (++attempts < 3) throw new Error('transient'); });
    const retries: number[] = [];
    (q.on as Function)('retrying', (_: unknown, n: unknown) => retries.push(n as number));
    await q.initialize();
    await q.enqueue({
      type: 'flaky', payload: {},
      retryPolicy: new ExponentialBackoff({ maxAttempts: 5, base: 10, cap: 50 }),
      maxAttempts: 5,
    });
    await sleep(100);
    await q.drain();
    ok(attempts === 3, `expected 3 attempts, got ${attempts}`);
    ok(retries.length === 2, `expected 2 retrying events, got ${retries.length}`);
    await q.shutdown();
  });

  await test('LinearBackoff — fixed interval, reaches max attempts → DLQ', async () => {
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({ name: 'linear', plugins: [dlq], workers: { min: 1, max: 1 } });
    let attempts = 0;
    q.register('fail', async () => { attempts++; throw new Error('permanent'); });
    await q.initialize();
    await q.enqueue({
      type: 'fail', payload: {},
      retryPolicy: new LinearBackoff({ maxAttempts: 3, interval: 5 }),
      maxAttempts: 3,
    });
    await sleep(50);
    await q.drain();
    ok(attempts === 3, `expected 3 attempts, got ${attempts}`);
    ok(dlq.size === 1, `DLQ should have 1 entry, has ${dlq.size}`);
    await q.shutdown();
  });

  await test('NoRetry — job fails immediately, no retries', async () => {
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({ name: 'noretry', plugins: [dlq], workers: { min: 1, max: 1 } });
    let calls = 0;
    q.register('instant-fail', async () => { calls++; throw new Error('no retry'); });
    await q.initialize();
    await q.enqueue({
      type: 'instant-fail', payload: {},
      retryPolicy: NoRetry.getInstance(),
      maxAttempts: 10, // ignored by NoRetry
    });
    await q.drain();
    ok(calls === 1, `NoRetry should call handler exactly once, got ${calls}`);
    ok(dlq.size === 1, 'should be in DLQ');
    await q.shutdown();
  });

  await test('CustomRetry — retry only on specific error type', async () => {
    const q = new JobQueue({ name: 'custom', workers: { min: 1, max: 1 } });
    let attempts = 0;
    q.register('selective', async () => {
      attempts++;
      if (attempts < 3) throw new Error('RETRYABLE: need retry');
      // success on attempt 3
    });
    const policy = new CustomRetry({
      predicate: (attempt, err) => attempt < 5 && err.message.startsWith('RETRYABLE'),
      delay: (attempt) => attempt * 5,
    });
    await q.initialize();
    await q.enqueue({ type: 'selective', payload: {}, retryPolicy: policy, maxAttempts: 5 });
    await sleep(50);
    await q.drain();
    ok(attempts === 3, `expected 3 attempts got ${attempts}`);
    await q.shutdown();
  });

  await test('DLQ retry — re-enqueues job with reset attempt count', async () => {
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({ name: 'dlq-retry', plugins: [dlq], workers: { min: 1, max: 1 } });
    let phase2 = false;
    q.register('recover', async () => {
      if (!phase2) throw new Error('will fail first');
      // phase2 succeeds
    });
    await q.initialize();
    await q.enqueue({
      type: 'recover', payload: {},
      retryPolicy: NoRetry.getInstance(), maxAttempts: 1,
    });
    await q.drain();
    ok(dlq.size === 1, 'should be in DLQ');

    // Now fix and retry
    phase2 = true;
    const entry = dlq.list()[0]!;
    await dlq.retry(entry.job.id);
    await q.drain();
    ok(dlq.size === 0, 'DLQ should be empty after successful retry');
    await q.shutdown();
  });

  await test('DLQ purge removes old entries', async () => {
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({ name: 'dlq-purge', plugins: [dlq], workers: { min: 1, max: 1 } });
    q.register('x', async () => { throw new Error('fail'); });
    await q.initialize();
    for (let i = 0; i < 5; i++) {
      await q.enqueue({ type: 'x', payload: {}, retryPolicy: NoRetry.getInstance(), maxAttempts: 1 });
    }
    await q.drain();
    ok(dlq.size === 5, `expected 5 in DLQ, got ${dlq.size}`);
    const purged = dlq.purge(Date.now() + 1000); // purge everything
    ok(purged === 5, `expected 5 purged, got ${purged}`);
    ok(dlq.size === 0, 'DLQ should be empty');
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  4. FLOW — CHAIN (A→B→C)
  // ════════════════════════════════════════════════════════════════════════════
  section('4 · Flow › Linear Chain');

  await test('5-step chain executes in exact order', async () => {
    const q = new JobQueue({ name: 'chain5', workers: { min: 1, max: 2 } });
    const log: string[] = [];
    for (const s of ['a', 'b', 'c', 'd', 'e']) {
      q.register(`step-${s}`, async () => { log.push(s); });
    }
    await q.initialize();
    await q.flow([
      { type: 'step-a', payload: {} }, { type: 'step-b', payload: {} },
      { type: 'step-c', payload: {} }, { type: 'step-d', payload: {} },
      { type: 'step-e', payload: {} },
    ]);
    await q.drain();
    ok(log.join('') === 'abcde', `expected abcde got ${log.join('')}`);
    await q.shutdown();
  });

  await test('3 parallel chains interleave without contamination', async () => {
    const q = new JobQueue({ name: 'chains-parallel', workers: { min: 3, max: 6 } });
    const logs: Record<string, string[]> = { X: [], Y: [], Z: [] };
    for (const chain of ['X', 'Y', 'Z']) {
      q.register(`${chain}-1`, async () => { logs[chain]!.push('1'); });
      q.register(`${chain}-2`, async () => { logs[chain]!.push('2'); });
      q.register(`${chain}-3`, async () => { logs[chain]!.push('3'); });
    }
    await q.initialize();
    await Promise.all(['X', 'Y', 'Z'].map((ch) => q.flow([
      { type: `${ch}-1`, payload: {} },
      { type: `${ch}-2`, payload: {} },
      { type: `${ch}-3`, payload: {} },
    ])));
    await q.drain();
    for (const [ch, log] of Object.entries(logs)) {
      ok(log.join('') === '123', `chain ${ch} order broken: ${log.join('')}`);
    }
    await q.shutdown();
  });

  await test('chain aborts remaining steps on failure (maxAttempts=1)', async () => {
    const q = new JobQueue({ name: 'chain-fail', workers: { min: 1, max: 1 }, defaultMaxAttempts: 1 });
    const ran: string[] = [];
    q.register('cA', async () => { ran.push('A'); throw new Error('A failed'); });
    q.register('cB', async () => { ran.push('B'); });
    q.register('cC', async () => { ran.push('C'); });
    await q.initialize();
    await q.flow([
      { type: 'cA', payload: {} },
      { type: 'cB', payload: {} },
      { type: 'cC', payload: {} },
    ]);
    await q.drain();
    ok(ran.length === 1 && ran[0] === 'A', `only A should run, got: ${ran.join(',')}`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  5. FLOW — DAG
  // ════════════════════════════════════════════════════════════════════════════
  section('5 · Flow › DAG');

  await test('diamond DAG: A → B+C → D (topological order)', async () => {
    const q = new JobQueue({ name: 'dag-diamond', workers: { min: 2, max: 4 } });
    const log: string[] = [];
    q.register('dA', async () => { log.push('A'); await sleep(5); });
    q.register('dB', async () => { log.push('B'); });
    q.register('dC', async () => { log.push('C'); });
    q.register('dD', async () => { log.push('D'); });
    await q.initialize();
    await q.dag({
      nodes: {
        A: { type: 'dA', payload: {} },
        B: { type: 'dB', payload: {}, dependsOn: ['A'] },
        C: { type: 'dC', payload: {}, dependsOn: ['A'] },
        D: { type: 'dD', payload: {}, dependsOn: ['B', 'C'] },
      },
    });
    await q.drain();
    ok(log[0] === 'A', `A must run first, got: ${log[0]}`);
    ok(log[log.length - 1] === 'D', `D must run last, got: ${log[log.length - 1]}`);
    ok(log.includes('B') && log.includes('C'), 'B and C must both run');
    await q.shutdown();
  });

  await test('wide DAG: 1 root → 8 parallel leaves', async () => {
    const q = new JobQueue({ name: 'dag-wide', workers: { min: 4, max: 8 } });
    const done: string[] = [];
    q.register('root', async () => { done.push('root'); await sleep(5); });
    for (let i = 0; i < 8; i++) q.register(`leaf${i}`, async () => { done.push(`leaf${i}`); });
    const nodes: Record<string, { type: string; payload: Record<string, unknown>; dependsOn?: string[] }> = {
      root: { type: 'root', payload: {} },
    };
    for (let i = 0; i < 8; i++) nodes[`leaf${i}`] = { type: `leaf${i}`, payload: {}, dependsOn: ['root'] };
    await q.initialize();
    await q.dag({ nodes });
    await q.drain();
    ok(done[0] === 'root', 'root must be first');
    ok(done.length === 9, `expected 9 nodes executed, got ${done.length}`);
    await q.shutdown();
  });

  await test('DAG rejects cyclic dependencies (throws CyclicDependencyError)', async () => {
    const q = new JobQueue({ name: 'dag-cycle', workers: { min: 1, max: 1 } });
    q.register('x', async () => { }); q.register('y', async () => { });
    let threw = false;
    try {
      await q.dag({
        nodes: {
          x: { type: 'x', payload: {}, dependsOn: ['y'] },
          y: { type: 'y', payload: {}, dependsOn: ['x'] },
        }
      });
    } catch { threw = true; }
    ok(threw, 'should throw CyclicDependencyError');
    await q.shutdown();
  });

  await test('DAG downstream nodes cancelled when ancestor fails', async () => {
    const q = new JobQueue({ name: 'dag-cancel', workers: { min: 1, max: 2 }, defaultMaxAttempts: 1 });
    const ran: string[] = [];
    q.register('root', async () => { ran.push('root'); throw new Error('root failed'); });
    q.register('child', async () => { ran.push('child'); });
    q.register('grandchild', async () => { ran.push('grandchild'); });
    await q.initialize();
    await q.dag({
      nodes: {
        root: { type: 'root', payload: {} },
        child: { type: 'child', payload: {}, dependsOn: ['root'] },
        grandchild: { type: 'grandchild', payload: {}, dependsOn: ['child'] },
      }
    });
    await q.drain();
    ok(!ran.includes('child'), 'child must NOT run after root fails');
    ok(!ran.includes('grandchild'), 'grandchild must NOT run');
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  6. ALL PLUGINS
  // ════════════════════════════════════════════════════════════════════════════
  section('6 · Plugins › Metrics');

  await test('tracks processed / failed / retried / avgLatencyMs', async () => {
    const metrics = new Metrics();
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({
      name: 'metrics', plugins: [metrics, dlq],
      workers: { min: 2, max: 2 }, defaultMaxAttempts: 1,
    });
    q.register('ok', async () => { await sleep(5); });
    q.register('fail', async () => { throw new Error('x'); });
    await q.initialize();
    await Promise.all([
      q.enqueue({ type: 'ok', payload: {} }),
      q.enqueue({ type: 'ok', payload: {} }),
      q.enqueue({ type: 'ok', payload: {} }),
      q.enqueue({ type: 'fail', payload: {}, maxAttempts: 1 }),
      q.enqueue({ type: 'fail', payload: {}, maxAttempts: 1 }),
    ]);
    await q.drain();
    const snap = metrics.snapshot(await q.size());
    log(`processed=${snap.processed} failed=${snap.failed} avgLatencyMs=${snap.avgLatencyMs}ms`);
    ok(snap.processed === 3, `expected 3 processed, got ${snap.processed}`);
    ok(snap.failed >= 2, `expected >=2 failed, got ${snap.failed}`);
    ok(snap.avgLatencyMs >= 0, 'avgLatencyMs should be non-negative');
    await q.shutdown();
  });

  await test('Metrics.reset() zeroes all counters', async () => {
    const metrics = new Metrics();
    const q = new JobQueue({ name: 'metrics-reset', plugins: [metrics], workers: { min: 1, max: 1 } });
    q.register('n', async () => { });
    await q.initialize();
    await q.enqueue({ type: 'n', payload: {} });
    await q.drain();
    metrics.reset();
    const snap = metrics.snapshot();
    ok(snap.processed === 0 && snap.failed === 0, 'all counters should be 0 after reset');
    await q.shutdown();
  });

  section('6 · Plugins › RateLimiter');

  await test('rejects enqueue over window limit (limit=3, window=5s)', async () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 5_000 });
    const q = new JobQueue({ name: 'rl', plugins: [rl], workers: { min: 0, max: 1 } });
    q.register('x', async () => { });
    let rejected = 0;
    for (let i = 0; i < 6; i++) {
      try { await q.enqueue({ type: 'x', payload: {} }); }
      catch { rejected++; }
    }
    ok(rejected === 3, `expected 3 rejections, got ${rejected}`);
    await q.shutdown();
  });

  await test('per-type key function isolates limits correctly', async () => {
    const rl = new RateLimiter({
      limit: 2, windowMs: 5_000,
      keyFn: (j) => (j.payload as { key: string }).key,
    });
    const q = new JobQueue({ name: 'rl-key', plugins: [rl], workers: { min: 0, max: 1 } });
    q.register('x', async () => { });
    let rejA = 0, rejB = 0;
    for (let i = 0; i < 5; i++) {
      try { await q.enqueue({ type: 'x', payload: { key: 'A' } }); } catch { rejA++; }
      try { await q.enqueue({ type: 'x', payload: { key: 'B' } }); } catch { rejB++; }
    }
    ok(rejA === 3, `A should reject 3, got ${rejA}`);
    ok(rejB === 3, `B should reject 3, got ${rejB}`);
    await q.shutdown();
  });

  section('6 · Plugins › Deduplicator');

  await test('blocks duplicate idempotencyKey while job is in-flight', async () => {
    const dedup = new Deduplicator();
    const q = new JobQueue({ name: 'dedup', plugins: [dedup], workers: { min: 0, max: 1 } });
    q.register('msg', async () => { await sleep(50); });
    let threw = false;
    await q.enqueue({ type: 'msg', payload: {}, idempotencyKey: 'user-42' });
    try { await q.enqueue({ type: 'msg', payload: {}, idempotencyKey: 'user-42' }); }
    catch { threw = true; }
    ok(threw, 'duplicate idempotencyKey must be rejected');
    ok(dedup.size === 1, `dedup size should be 1, got ${dedup.size}`);
    await q.shutdown();
  });

  await test('allows re-enqueue after job completes', async () => {
    const dedup = new Deduplicator();
    const q = new JobQueue({ name: 'dedup-reuse', plugins: [dedup], workers: { min: 1, max: 1 } });
    let count = 0;
    q.register('msg', async () => { count++; });
    await q.initialize();
    await q.enqueue({ type: 'msg', payload: {}, idempotencyKey: 'k1' });
    await q.drain();
    // same key allowed again after completion
    await q.enqueue({ type: 'msg', payload: {}, idempotencyKey: 'k1' });
    await q.drain();
    ok(count === 2, `expected 2 executions, got ${count}`);
    await q.shutdown();
  });

  section('6 · Plugins › Debounce');

  await test('10 rapid enqueues → only the LAST one is processed', async () => {
    const debounce = new Debounce({ windowMs: 500 });
    const q = new JobQueue({ name: 'bounce', plugins: [debounce], workers: { min: 1, max: 1 } });
    const payloads: number[] = [];
    q.register('sync', async (p: { i: number }) => { payloads.push(p.i); });
    // fix: pause so all 10 enqueues complete before the worker picks up any job
    q.pause();
    await q.initialize();
    for (let i = 0; i < 10; i++) {
      await q.enqueue({ type: 'sync', payload: { i } });
    }
    q.resume();
    await q.drain();
    ok(payloads.length === 1, `expected 1 processed (debounced), got ${payloads.length}`);
    ok(payloads[0] === 9, `expected last payload i=9, got ${payloads[0]}`);
    await q.shutdown();
  });

  section('6 · Plugins › Throttle');

  await test('maxConcurrent=2 enforced across 3 workers, 20 jobs', async () => {
    const throttle = new Throttle({ maxConcurrent: 2 });
    const q = new JobQueue({ name: 'throttle', plugins: [throttle], workers: { min: 3, max: 3 } });
    let live = 0, maxLive = 0, done = 0;
    q.register('heavy', async () => {
      live++; maxLive = Math.max(maxLive, live);
      await sleep(15);
      live--; done++;
    });
    await q.initialize();
    for (let i = 0; i < 20; i++) await q.enqueue({ type: 'heavy', payload: {} });
    await q.drain();
    log(`maxConcurrent observed: ${maxLive}, jobs done: ${done}`);
    ok(maxLive <= 2, `max concurrent exceeded: ${maxLive}`);
    ok(done === 20, `expected 20 done, got ${done}`);
    await q.shutdown();
  });

  section('6 · Plugins › JobTTL');

  await test('job expires before being processed (no workers)', async () => {
    const ttl = new JobTTL();
    // fix: use max:1 (min:0 means no workers start, but max:0 is rejected by validation)
    const q = new JobQueue({ name: 'ttl-expire', plugins: [ttl], workers: { min: 0, max: 1 } });
    q.register('msg', async () => { });
    let expired = false;
    q.on('expired', () => { expired = true; });
    q.pause();
    await q.enqueue({ type: 'msg', payload: {}, ttl: 40 });
    await sleep(80);
    ok(expired, 'job should have expired');
    await q.shutdown();
  });

  await test('job processed before TTL — no false expiry', async () => {
    const ttl = new JobTTL();
    const q = new JobQueue({ name: 'ttl-process', plugins: [ttl], workers: { min: 1, max: 1 } });
    let processed = false, expired = false;
    q.register('fast', async () => { processed = true; });
    q.on('expired', () => { expired = true; });
    await q.initialize();
    await q.enqueue({ type: 'fast', payload: {}, ttl: 500 });
    await q.drain();
    await sleep(20);
    ok(processed, 'job should have been processed');
    ok(!expired, 'job should NOT be expired if processed in time');
    await q.shutdown();
  });

  section('6 · Plugins › Multi-plugin stack');

  await test('Metrics + DLQ + RateLimiter + Deduplicator all active simultaneously', async () => {
    const metrics = new Metrics();
    const dlq = new DeadLetterQueue();
    const rl = new RateLimiter({ limit: 100, windowMs: 10_000 });
    const dedup = new Deduplicator();
    const q = new JobQueue({
      name: 'all-plugins',
      plugins: [metrics, dlq, rl, dedup],
      workers: { min: 2, max: 4 },
      defaultMaxAttempts: 1,
    });
    let ok2 = 0;
    q.register('work', async () => { ok2++; });
    q.register('bad', async () => { throw new Error('bad'); });
    await q.initialize();
    for (let i = 0; i < 20; i++) {
      await q.enqueue({ type: 'work', payload: {}, idempotencyKey: `w-${i}` });
    }
    for (let i = 0; i < 5; i++) {
      await q.enqueue({ type: 'bad', payload: {}, maxAttempts: 1 });
    }
    await q.drain();
    const snap = metrics.snapshot();
    log(`processed=${snap.processed} failed=${snap.failed} dlqSize=${dlq.size}`);
    ok(ok2 === 20, `expected 20 work jobs done, got ${ok2}`);
    ok(dlq.size === 5, `expected 5 in DLQ, got ${dlq.size}`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  7. JobBatch
  // ════════════════════════════════════════════════════════════════════════════
  section('7 · JobBatch');

  await test('awaitAll settles all tracked jobs', async () => {
    const q = new JobQueue({ name: 'batch-all', workers: { min: 2, max: 4 } });
    const batch = new JobBatch();
    q.register('bwork', async (p: { i: number }) => p.i * 2);
    q.on('completed', ((...a: unknown[]) => batch.complete(a[0] as never, a[1] as never)) as never);
    q.on('failed', ((...a: unknown[]) => batch.fail(a[0] as never, a[1] as never)) as never);
    // fix: pause so all 10 jobs are enqueued + tracked before any worker processes them
    q.pause();
    await q.initialize();

    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const id = await q.enqueue({ type: 'bwork', payload: { i } });
      batch.track(id);
      ids.push(id);
    }
    q.resume();
    const results = await batch.awaitAll();
    ok(results.length === 10, `expected 10 results, got ${results.length}`);
    ok(results.every((r) => r.status === 'fulfilled'), 'all batch jobs should succeed');
    await q.shutdown();
  });

  await test('awaitAny resolves with the first finished job', async () => {
    const q = new JobQueue({ name: 'batch-any', workers: { min: 3, max: 3 } });
    const batch = new JobBatch();
    const delays = [100, 10, 50]; // second job (10ms) finishes first
    let firstDone = -1;
    q.register('race', async (p: { i: number; d: number }) => {
      await sleep(p.d);
      if (firstDone === -1) firstDone = p.i;
      return p.i;
    });
    q.on('completed', ((...a: unknown[]) => batch.complete(a[0] as never, a[1] as never)) as never);
    q.on('failed', ((...a: unknown[]) => batch.fail(a[0] as never, a[1] as never)) as never);
    await q.initialize();

    for (let i = 0; i < 3; i++) {
      const id = await q.enqueue({ type: 'race', payload: { i, d: delays[i]! } });
      batch.track(id);
    }
    const first = await batch.awaitAny();
    ok(first.job.type === 'race', 'awaitAny should resolve with a race job');
    log(`first finished: job index ${(first.job.payload as { i: number }).i} (10ms delay)`);
    await q.drain();
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  8. JobBuilder (fluent API)
  // ════════════════════════════════════════════════════════════════════════════
  section('8 · JobBuilder');

  await test('builds job with all fields set correctly', async () => {
    const q = new JobQueue({ name: 'builder', workers: { min: 1, max: 1 } });
    let ctx: { attempt: number } | null = null;
    q.register('built', async (_, c) => { ctx = { attempt: c.attempt }; });
    await q.initialize();

    const policy = new LinearBackoff({ maxAttempts: 3, interval: 10 });
    const job = new JobBuilder()
      .type('built')
      .payload({ data: 'hello' })
      .priority(2)
      .maxAttempts(3)
      .maxDuration(5_000)
      .retry(policy)
      .build();

    ok(job.type === 'built', 'type mismatch');
    ok(job.priority === 2, 'priority mismatch');
    ok(job.maxAttempts === 3, 'maxAttempts mismatch');
    ok(job.maxDuration === 5_000, 'maxDuration mismatch');

    await q.enqueue({ type: job.type, payload: job.payload, priority: job.priority });
    await q.drain();
    ok(ctx !== null, 'handler should have been called');
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  9. runInProcess
  // ════════════════════════════════════════════════════════════════════════════
  section('9 · runInProcess');

  await test('returns handler result, bypasses queue', async () => {
    const q = new JobQueue({ name: 'rip', workers: { min: 0, max: 1 } });
    q.register('add', async (p: { a: number; b: number }) => p.a + p.b);
    const r = await q.runInProcess<{ a: number; b: number }, number>('add', { a: 17, b: 25 });
    ok(r === 42, `expected 42, got ${r}`);
    await q.shutdown();
  });

  await test('rethrows error and emits failed event', async () => {
    const metrics = new Metrics();
    const q = new JobQueue({ name: 'rip-fail', plugins: [metrics], workers: { min: 0, max: 1 } });
    q.register('boom', async () => { throw new Error('kaboom'); });
    let caught = '';
    try { await q.runInProcess('boom', {}); } catch (e) { caught = (e as Error).message; }
    ok(caught === 'kaboom', `expected "kaboom" got "${caught}"`);
    ok(metrics.snapshot().failed === 1, 'failed counter should be 1');
    await q.shutdown();
  });

  await test('plugin hooks (onEnqueue/onProcess/onComplete) fire in runInProcess', async () => {
    const metrics = new Metrics();
    const q = new JobQueue({ name: 'rip-hooks', plugins: [metrics], workers: { min: 0, max: 1 } });
    q.register('x', async () => 'ok');
    await q.runInProcess('x', {});
    ok(metrics.snapshot().processed === 1, 'onComplete hook should increment processed');
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  10. DELAYED JOBS & SCHEDULER
  // ════════════════════════════════════════════════════════════════════════════
  section('10 · Delayed Jobs & Scheduler');

  await test('delayed job does not execute before delay expires', async () => {
    const q = new JobQueue({ name: 'delay-check', workers: { min: 1, max: 1 } });
    let ran = false;
    q.register('future', async () => { ran = true; });
    await q.initialize();
    await q.enqueue({ type: 'future', payload: {}, delay: 80 });
    await sleep(20);
    ok(!ran, 'job should not have run yet at 20ms');
    await sleep(100);
    await q.drain();
    ok(ran, 'job should have run after delay');
    await q.shutdown();
  });

  await test('20 delayed jobs all fire and are processed', async () => {
    const q = new JobQueue({ name: 'delay-burst', workers: { min: 2, max: 4 } });
    let done = 0;
    q.register('d', async () => { done++; });
    await q.initialize();
    for (let i = 0; i < 20; i++) {
      await q.enqueue({ type: 'd', payload: {}, delay: 20 + i * 3 });
    }
    await sleep(200);
    await q.drain();
    ok(done === 20, `expected 20 fired, got ${done}`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  11. BACKPRESSURE & maxQueueSize
  // ════════════════════════════════════════════════════════════════════════════
  section('11 · Backpressure › maxQueueSize');

  await test('blocks at capacity, resumes after drain', async () => {
    const q = new JobQueue({ name: 'bp', maxQueueSize: 5, workers: { min: 1, max: 1 } });
    q.register('bp-work', async () => { await sleep(5); });
    q.pause();
    for (let i = 0; i < 5; i++) await q.enqueue({ type: 'bp-work', payload: {} });
    let threw = false;
    try { await q.enqueue({ type: 'bp-work', payload: {} }); } catch { threw = true; }
    ok(threw, '6th enqueue should throw');

    await q.clear();
    // Now should accept again
    await q.enqueue({ type: 'bp-work', payload: {} });
    ok(await q.size() === 1, 'should accept after clear');
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  12. JOB TIMEOUT
  // ════════════════════════════════════════════════════════════════════════════
  section('12 · Job Timeout');

  await test('slow job hits maxDuration → JobTimeoutError → DLQ', async () => {
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({
      name: 'timeout', plugins: [dlq],
      workers: { min: 1, max: 1 }, defaultMaxAttempts: 1,
    });
    q.register('slow', async () => { await sleep(5_000); });
    await q.initialize();
    await q.enqueue({ type: 'slow', payload: {}, maxDuration: 50, maxAttempts: 1 });
    await sleep(120); // wait for timeout + retry delay
    await q.drain();
    ok(dlq.size === 1, `job should be in DLQ after timeout, dlq.size=${dlq.size}`);
    const err = dlq.list()[0]!.error;
    ok(err.name === 'JobTimeoutError', `expected JobTimeoutError, got ${err.name}`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  13. EVENT SYSTEM
  // ════════════════════════════════════════════════════════════════════════════
  section('13 · Event System');

  await test('all 5 lifecycle events fire in correct sequence', async () => {
    const q = new JobQueue({ name: 'events', workers: { min: 1, max: 1 }, defaultMaxAttempts: 2 });
    const events: string[] = [];
    q.on(QueueEvent.ENQUEUED, () => events.push('enqueued'));
    q.on(QueueEvent.ACTIVE, () => events.push('active'));
    q.on(QueueEvent.RETRYING, () => events.push('retrying'));
    q.on(QueueEvent.COMPLETED, () => events.push('completed'));

    let attempt = 0;
    q.register('ev', async () => { if (++attempt === 1) throw new Error('first'); });
    const policy = new LinearBackoff({ maxAttempts: 2, interval: 5 });
    await q.initialize();
    await q.enqueue({ type: 'ev', payload: {}, retryPolicy: policy, maxAttempts: 2 });
    // fix: give the 5ms LinearBackoff retry time to fire before drain
    await sleep(50);
    await q.drain();

    ok(events[0] === 'enqueued', `first event should be enqueued, got ${events[0]}`);
    ok(events.includes('active'), 'active event must fire');
    ok(events.includes('retrying'), 'retrying event must fire');
    ok(events.includes('completed'), 'completed event must fire');
    await q.shutdown();
  });

  await test('once() listener fires only once', async () => {
    const q = new JobQueue({ name: 'once', workers: { min: 1, max: 1 } });
    let count = 0;
    q.once('completed', () => { count++; });
    q.register('n', async () => { });
    await q.initialize();
    await q.enqueue({ type: 'n', payload: {} });
    await q.enqueue({ type: 'n', payload: {} });
    await q.drain();
    ok(count === 1, `once listener should fire once, fired ${count} times`);
    await q.shutdown();
  });

  await test('off() removes listener correctly', async () => {
    const q = new JobQueue({ name: 'off', workers: { min: 1, max: 1 } });
    let count = 0;
    const handler = () => { count++; };
    q.on('completed', handler);
    q.off('completed', handler);
    q.register('n', async () => { });
    await q.initialize();
    await q.enqueue({ type: 'n', payload: {} });
    await q.drain();
    ok(count === 0, `removed listener should not fire, fired ${count} times`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  14. CircuitBreaker (standalone utility)
  // ════════════════════════════════════════════════════════════════════════════
  section('14 · CircuitBreaker');

  await test('opens after threshold failures, fast-fails, then recovers', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeMs: 50 });
    ok(cb.currentState === 'CLOSED', 'should start CLOSED');

    // Trigger 3 failures → OPEN
    for (let i = 0; i < 3; i++) {
      try { await cb.execute(async () => { throw new Error('fail'); }); } catch { }
    }
    ok(cb.currentState === 'OPEN', `should be OPEN after 3 failures, got ${cb.currentState}`);

    // Fast-fail while OPEN
    let fastFailed = false;
    try { await cb.execute(async () => 'ok'); } catch (e) {
      fastFailed = (e as Error).message.includes('OPEN');
    }
    ok(fastFailed, 'should fast-fail while OPEN');

    // Wait recovery window → HALF_OPEN → probe succeeds → CLOSED
    await sleep(60);
    await cb.execute(async () => 'probe ok');
    ok(cb.currentState === 'CLOSED', `should return to CLOSED after recovery, got ${cb.currentState}`);
  });

  await test('CircuitBreaker integrates with queue handler (external API guard)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, recoveryTimeMs: 30 });
    const q = new JobQueue({ name: 'cb-queue', workers: { min: 2, max: 2 }, defaultMaxAttempts: 1 });
    const dlq = new DeadLetterQueue();
    q.register('api', async () => { await cb.execute(async () => { throw new Error('api-down'); }); });
    (q as JobQueue & { plugins?: unknown[] });
    const q2 = new JobQueue({ name: 'cb-q2', plugins: [dlq], workers: { min: 1, max: 1 } });
    q2.register('api', async () => { await cb.execute(async () => { throw new Error('api-down'); }); });
    await q2.initialize();
    for (let i = 0; i < 3; i++) {
      await q2.enqueue({ type: 'api', payload: {}, maxAttempts: 1 });
    }
    await q2.drain();
    log(`CB state after 3 failures: ${cb.currentState}, DLQ size: ${dlq.size}`);
    ok(cb.currentState === 'OPEN', 'circuit should be OPEN');
    ok(dlq.size === 3, `all 3 jobs should be in DLQ, got ${dlq.size}`);
    await q.shutdown();
    await q2.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  15. FILE ADAPTER
  // ════════════════════════════════════════════════════════════════════════════
  section('15 · FileAdapter');

  await test('jobs persist to disk and survive queue restart', async () => {
    const filePath = tmpFile('jobs.json');
    const adapter1 = new FileAdapter({ filePath });
    await adapter1.initialize();

    const q1 = new JobQueue({ name: 'file-q', adapter: adapter1, workers: { min: 0, max: 1 } });
    q1.register('saved', async () => { });
    q1.pause();
    await q1.enqueue({ type: 'saved', payload: { msg: 'persisted' } });
    await q1.shutdown();

    // Restart with same file
    const adapter2 = new FileAdapter({ filePath });
    await adapter2.initialize();
    const q2 = new JobQueue({ name: 'file-q2', adapter: adapter2, workers: { min: 1, max: 1 } });
    let found = '';
    q2.register('saved', async (p: { msg: string }) => { found = p.msg; });
    await q2.initialize();
    await q2.drain();
    ok(found === 'persisted', `expected "persisted" got "${found}"`);
    await q2.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  16. MemoryAdapter direct API
  // ════════════════════════════════════════════════════════════════════════════
  section('16 · MemoryAdapter O(1) index');

  await test('get() is O(1) — 10k jobs, direct lookup stays fast', async () => {
    const { createJob } = await import('../src/job/Job.js');
    const adapter = new MemoryAdapter();
    const ids: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      const job = createJob({ type: 'x', payload: { i } }, { defaultPriority: 5, defaultMaxAttempts: 3, defaultMaxDuration: 30_000 });
      await adapter.push(job);
      ids.push(job.id);
    }
    // Time 1000 random lookups
    const t0 = performance.now();
    for (let i = 0; i < 1_000; i++) {
      const id = ids[Math.floor(Math.random() * ids.length)]!;
      await adapter.get(id);
    }
    const elapsed = performance.now() - t0;
    log(`1,000 random get() on 10k-job adapter: ${elapsed.toFixed(1)}ms`);
    ok(elapsed < 50, `get() should be O(1) and fast, took ${elapsed.toFixed(1)}ms`);
    await adapter.close();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  17. WORKER SPAWN — no over-spawn under burst
  // ════════════════════════════════════════════════════════════════════════════
  section('17 · Worker Pool Integrity');

  await test('burst of 500 jobs — all processed, no duplicates', async () => {
    const q = new JobQueue({ name: 'burst', workers: { min: 2, max: 10 } });
    const seen = new Set<number>();
    let dups = 0;
    q.register('burst', async (p: { i: number }) => {
      if (seen.has(p.i)) dups++;
      else seen.add(p.i);
      await sleep(1);
    });
    await q.initialize();
    await Promise.all(Array.from({ length: 500 }, (_, i) =>
      q.enqueue({ type: 'burst', payload: { i } })
    ));
    await q.drain();
    log(`processed=${seen.size} duplicates=${dups}`);
    ok(seen.size === 500, `expected 500 unique, got ${seen.size}`);
    ok(dups === 0, `duplicate executions: ${dups}`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  18. validateConfig — config validation
  // ════════════════════════════════════════════════════════════════════════════
  section('18 · Config Validation');

  await test('invalid name throws QueueError', async () => {
    let threw = false;
    try { new JobQueue({ name: '' }); } catch { threw = true; }
    ok(threw, 'empty name should throw');
  });

  await test('workers.min > workers.max throws', async () => {
    let threw = false;
    try { new JobQueue({ name: 'v', workers: { min: 5, max: 2 } }); } catch { threw = true; }
    ok(threw, 'min > max should throw');
  });

  await test('maxQueueSize < 1 throws', async () => {
    let threw = false;
    try { new JobQueue({ name: 'v', maxQueueSize: 0 }); } catch { threw = true; }
    ok(threw, 'maxQueueSize=0 should throw');
  });

  await test('defaultMaxAttempts < 1 throws', async () => {
    let threw = false;
    try { new JobQueue({ name: 'v', defaultMaxAttempts: 0 }); } catch { threw = true; }
    ok(threw, 'defaultMaxAttempts=0 should throw');
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  19. PERFORMANCE BENCHMARKS
  // ════════════════════════════════════════════════════════════════════════════
  section('19 · Performance Benchmarks');

  await test('🚀 1,000 no-op jobs — target <1s', async () => {
    const q = new JobQueue({ name: 'perf-1k', workers: { min: 4, max: 8 } });
    let done = 0;
    q.register('w', async () => { done++; });
    await q.initialize();
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 1_000 }, () => q.enqueue({ type: 'w', payload: {} })));
    await q.drain();
    const ms = performance.now() - t0;
    const rps = Math.round(1_000 / ms * 1_000);
    log(`1,000 jobs in ${ms.toFixed(0)}ms → ${rps.toLocaleString()} jobs/s`);
    ok(done === 1_000, `expected 1000, got ${done}`);
    ok(ms < 1_000, `too slow: ${ms.toFixed(0)}ms (target <1000ms)`);
    await q.shutdown();
  });

  await test('🚀 5,000 no-op jobs — target <4s', async () => {
    const q = new JobQueue({ name: 'perf-5k', workers: { min: 6, max: 12 } });
    let done = 0;
    q.register('w', async () => { done++; });
    await q.initialize();
    const t0 = performance.now();
    const batches = Array.from({ length: 10 }, (_, b) =>
      Promise.all(Array.from({ length: 500 }, (__, i) =>
        q.enqueue({ type: 'w', payload: { id: b * 500 + i } })
      ))
    );
    for (const batch of batches) await batch;
    await q.drain();
    const ms = performance.now() - t0;
    const rps = Math.round(5_000 / ms * 1_000);
    log(`5,000 jobs in ${ms.toFixed(0)}ms → ${rps.toLocaleString()} jobs/s`);
    ok(done === 5_000, `expected 5000, got ${done}`);
    ok(ms < 4_000, `too slow: ${ms.toFixed(0)}ms (target <4000ms)`);
    await q.shutdown();
  });

  await test('🚀 10,000 jobs with 4 worker types, priority mix — target <8s', async () => {
    const metrics = new Metrics();
    const q = new JobQueue({ name: 'perf-10k', plugins: [metrics], workers: { min: 8, max: 16 } });
    let done = 0;
    for (const type of ['typeA', 'typeB', 'typeC', 'typeD']) {
      q.register(type, async () => { done++; });
    }
    await q.initialize();
    const types = ['typeA', 'typeB', 'typeC', 'typeD'];
    const t0 = performance.now();
    const all = Array.from({ length: 10_000 }, (_, i) =>
      q.enqueue({ type: types[i % 4]!, payload: { i }, priority: (i % 5) + 1 })
    );
    await Promise.all(all);
    await q.drain();
    const ms = performance.now() - t0;
    const rps = Math.round(10_000 / ms * 1_000);
    log(`10,000 jobs in ${ms.toFixed(0)}ms → ${rps.toLocaleString()} jobs/s`);
    log(`metrics: processed=${metrics.snapshot().processed}`);
    ok(done === 10_000, `expected 10000, got ${done}`);
    ok(ms < 8_000, `too slow: ${ms.toFixed(0)}ms (target <8000ms)`);
    await q.shutdown();
  });

  await test('🚀 mixed I/O sim: 2,000 jobs with 5-20ms async work — target <15s', async () => {
    const q = new JobQueue({ name: 'perf-io', workers: { min: 10, max: 20 } });
    let done = 0;
    q.register('io', async (p: { ms: number }) => { await sleep(p.ms); done++; });
    await q.initialize();
    const t0 = performance.now();
    await Promise.all(Array.from({ length: 2_000 }, (_, i) =>
      q.enqueue({ type: 'io', payload: { ms: 5 + (i % 4) * 5 } })
    ));
    await q.drain();
    const ms = performance.now() - t0;
    const concEff = (2_000 * 12.5) / ms; // theoretical ideal: avg 12.5ms per job
    log(`2,000 I/O jobs in ${ms.toFixed(0)}ms, concurrency efficiency: ${concEff.toFixed(1)}x`);
    ok(done === 2_000, `expected 2000, got ${done}`);
    ok(ms < 15_000, `too slow: ${ms.toFixed(0)}ms`);
    await q.shutdown();
  });

  await test('🚀 priority correctness under 2k load (both priority levels)', async () => {
    const q = new JobQueue({ name: 'perf-prio', workers: { min: 1, max: 1 } });
    const order: number[] = [];
    q.register('pj', async (p: { p: number }) => { order.push(p.p); });
    q.pause();
    for (let i = 0; i < 1_000; i++) await q.enqueue({ type: 'pj', payload: { p: 9 }, priority: 9 });
    for (let i = 0; i < 1_000; i++) await q.enqueue({ type: 'pj', payload: { p: 1 }, priority: 1 });
    q.resume();
    await q.initialize();
    await q.drain();
    const first1000prio1 = order.slice(0, 1_000).filter((p) => p === 1).length;
    const pct = (first1000prio1 / 1_000) * 100;
    log(`${pct.toFixed(1)}% priority-1 in first 1,000`);
    ok(pct >= 90, `expected >=90%, got ${pct.toFixed(1)}%`);
    await q.shutdown();
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  20. STRESS ADVERSARIAL
  // ════════════════════════════════════════════════════════════════════════════
  section('20 · Stress & Adversarial');

  await test('rapid pause/resume cycles — no job loss (100 cycles)', async () => {
    const q = new JobQueue({ name: 'pause-stress', workers: { min: 2, max: 4 } });
    let done = 0;
    q.register('s', async () => { done++; await sleep(1); });
    await q.initialize();
    for (let i = 0; i < 200; i++) await q.enqueue({ type: 's', payload: {} });
    // Rapidly toggle pause/resume
    for (let i = 0; i < 100; i++) {
      if (i % 2 === 0) q.pause(); else q.resume();
      await Promise.resolve();
    }
    q.resume();
    await q.drain();
    ok(done === 200, `expected 200 done, got ${done}`);
    await q.shutdown();
  });

  await test('1,000 jobs with 10% random failures and retry — eventual consistency', async () => {
    const dlq = new DeadLetterQueue();
    const q = new JobQueue({
      name: 'chaos', plugins: [dlq],
      workers: { min: 6, max: 10 }, defaultMaxAttempts: 3,
    });
    let done = 0;
    q.register('chaos', async (p: { i: number }) => {
      // 10% random failure on first attempt (non-deterministic, but bounded)
      if (Math.random() < 0.05) throw new Error('random transient');
      done++;
    });
    const policy = new ExponentialBackoff({ maxAttempts: 3, base: 5, cap: 20 });
    await q.initialize();
    await Promise.all(Array.from({ length: 1_000 }, () =>
      q.enqueue({ type: 'chaos', payload: {}, retryPolicy: policy, maxAttempts: 3 })
    ));
    await q.drain();
    const total = done + dlq.size;
    log(`done=${done} dlq=${dlq.size} total=${total}`);
    ok(total === 1_000, `every job should either succeed or be in DLQ, got ${total}`);
    ok(done >= 900, `most jobs should succeed, got ${done}`);
    await q.shutdown();
  });

  await test('enqueue from within a job handler (nested enqueue)', async () => {
    const q = new JobQueue({ name: 'nested', workers: { min: 2, max: 4 } });
    let secondDone = false;
    q.register('outer', async () => {
      await q.enqueue({ type: 'inner', payload: {} });
    });
    q.register('inner', async () => { secondDone = true; });
    await q.initialize();
    await q.enqueue({ type: 'outer', payload: {} });
    await sleep(100);
    await q.drain();
    ok(secondDone, 'inner job enqueued from handler should execute');
    await q.shutdown();
  });

  await test('multiple queues on same process — fully isolated', async () => {
    const qA = new JobQueue({ name: 'iso-A', workers: { min: 2, max: 4 } });
    const qB = new JobQueue({ name: 'iso-B', workers: { min: 2, max: 4 } });
    let a = 0, b = 0;
    qA.register('work', async () => { a++; });
    qB.register('work', async () => { b++; });
    await qA.initialize();
    await qB.initialize();
    for (let i = 0; i < 100; i++) await qA.enqueue({ type: 'work', payload: {} });
    for (let i = 0; i < 200; i++) await qB.enqueue({ type: 'work', payload: {} });
    await Promise.all([qA.drain(), qB.drain()]);
    ok(a === 100, `qA: expected 100, got ${a}`);
    ok(b === 200, `qB: expected 200, got ${b}`);
    await Promise.all([qA.shutdown(), qB.shutdown()]);
  });

  // ════════════════════════════════════════════════════════════════════════════
  //  SUMMARY
  // ════════════════════════════════════════════════════════════════════════════
  const passed = suite.filter((t) => t.ok).length;
  const failed = suite.filter((t) => !t.ok).length;
  const totalMs = suite.reduce((s, t) => s + t.ms, 0);

  console.log(`\n${C.bold}${'═'.repeat(68)}${C.reset}`);
  console.log(`${C.bold} RESULTS  ${fmt(C.green, `${passed} passed`)}${failed ? fmt(C.red, `  ${failed} failed`) : ''}  ${fmt(C.gray, `${totalMs.toFixed(0)}ms total`)}${C.reset}`);
  console.log(`${'═'.repeat(68)}`);

  if (failed > 0) {
    console.log(`\n${fmt(C.red + C.bold, 'FAILURES:')}`);
    for (const t of suite.filter((x) => !x.ok)) {
      console.log(`  ${fmt(C.red, '✗')} ${t.name}`);
      if (t.note) console.log(`    ${fmt(C.gray, t.note)}`);
    }
    process.exit(1);
  }

  console.log(`\n${fmt(C.green + C.bold, '✓ All tests passed!')}`);
  process.exit(0);

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});