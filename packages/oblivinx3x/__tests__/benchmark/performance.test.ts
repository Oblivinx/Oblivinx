/**
 * Benchmark Tests — Performance measurement.
 *
 * Measures throughput and latency for various operations.
 * Not a pass/fail test — reports metrics for regression tracking.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import { Oblivinx3x } from '../../dist/index.js';

const TEST_DIR = path.join(process.cwd(), '__tests__', '__tmp__');

function testDbPath(name: string): string {
  return path.join(TEST_DIR, `${name}.ovn`);
}

function formatOps(count: number, elapsedMs: number): string {
  const opsPerSec = (count / elapsedMs) * 1000;
  return `${opsPerSec.toFixed(0)} ops/sec`;
}

describe('Benchmarks', () => {
  before(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  after(() => {
    if (fs.existsSync(TEST_DIR)) {
      for (const file of fs.readdirSync(TEST_DIR)) {
        if (file.endsWith('.ovn')) fs.unlinkSync(path.join(TEST_DIR, file));
      }
    }
  });

  it('should measure insertMany throughput (10K docs)', async () => {
    const dbPath = testDbPath('bench_insert');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const TOTAL = 10_000;
    const BATCH = 1_000;

    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');

    const start = performance.now();
    for (let i = 0; i < TOTAL; i += BATCH) {
      const batch = [];
      for (let j = 0; j < BATCH; j++) {
        batch.push({ name: `user_${i + j}`, age: 20 + (j % 50) });
      }
      await users.insertMany(batch);
    }
    const elapsed = performance.now() - start;

    console.log(`  📊 Insert ${TOTAL.toLocaleString()} docs: ${elapsed.toFixed(0)}ms (${formatOps(TOTAL, elapsed)})`);
    assert.ok(elapsed < 30000, 'Insert should complete within 30s');

    await db.close();
  });

  it('should measure find throughput with index', async () => {
    const dbPath = testDbPath('bench_find');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const TOTAL = 5_000;
    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');

    // Setup
    const batch = [];
    for (let i = 0; i < TOTAL; i++) {
      batch.push({ name: `user_${i % 100}`, age: 20 + (i % 50), score: Math.random() * 100 });
    }
    await users.insertMany(batch);
    await users.createIndex({ name: 1 });

    // Benchmark queries
    const QUERIES = 100;
    const start = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      await users.find({ name: `user_${i % 100}` });
    }
    const elapsed = performance.now() - start;

    console.log(`  📊 Find ${QUERIES} queries (indexed): ${elapsed.toFixed(0)}ms (${formatOps(QUERIES, elapsed)})`);

    await db.close();
  });

  it('should measure count performance', async () => {
    const dbPath = testDbPath('bench_count');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const TOTAL = 5_000;
    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');

    const batch = [];
    for (let i = 0; i < TOTAL; i++) {
      batch.push({ name: `user_${i}`, active: i % 2 === 0 });
    }
    await users.insertMany(batch);

    const QUERIES = 50;
    const start = performance.now();
    for (let i = 0; i < QUERIES; i++) {
      await users.countDocuments({ active: true });
    }
    const elapsed = performance.now() - start;

    console.log(`  📊 Count ${QUERIES} times: ${elapsed.toFixed(0)}ms (${formatOps(QUERIES, elapsed)})`);

    await db.close();
  });

  it('should measure update throughput', async () => {
    const dbPath = testDbPath('bench_update');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const TOTAL = 1_000;
    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');

    const batch = [];
    for (let i = 0; i < TOTAL; i++) {
      batch.push({ name: `user_${i}`, score: 0 });
    }
    await users.insertMany(batch);

    const start = performance.now();
    for (let i = 0; i < TOTAL; i++) {
      await users.updateOne({ name: `user_${i}` }, { $inc: { score: 1 } });
    }
    const elapsed = performance.now() - start;

    console.log(`  📊 Update ${TOTAL} docs: ${elapsed.toFixed(0)}ms (${formatOps(TOTAL, elapsed)})`);

    await db.close();
  });

  it('should measure aggregation pipeline performance', async () => {
    const dbPath = testDbPath('bench_agg');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const TOTAL = 2_000;
    const db = new Oblivinx3x(dbPath);
    const orders = db.collection('orders');

    const categories = ['electronics', 'clothing', 'food', 'books'];
    const batch = [];
    for (let i = 0; i < TOTAL; i++) {
      batch.push({
        category: categories[i % categories.length],
        amount: Math.floor(Math.random() * 100) + 10,
      });
    }
    await orders.insertMany(batch);

    const RUNS = 20;
    const start = performance.now();
    for (let i = 0; i < RUNS; i++) {
      await orders.aggregate([
        { $match: { amount: { $gt: 20 } } },
        { $group: { _id: '$category', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
      ]);
    }
    const elapsed = performance.now() - start;

    console.log(`  📊 Aggregation ${RUNS} runs: ${elapsed.toFixed(0)}ms (${formatOps(RUNS, elapsed)})`);

    await db.close();
  });

  it('should measure data persistence overhead', async () => {
    const dbPath = testDbPath('bench_persist');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const TOTAL = 1_000;
    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');

    const batch = [];
    for (let i = 0; i < TOTAL; i++) {
      batch.push({ name: `user_${i}`, data: 'x'.repeat(100) });
    }
    await users.insertMany(batch);

    // Measure close time (includes flush to disk)
    const start = performance.now();
    await db.close();
    const elapsed = performance.now() - start;

    const fileSize = fs.statSync(dbPath).size;
    console.log(`  📊 Close/flush: ${elapsed.toFixed(0)}ms, File size: ${(fileSize / 1024).toFixed(1)} KB`);
    assert.ok(fileSize > 0, 'File should have data');
  });
});
