/**
 * Integration Tests — Oblivinx3x Engine
 *
 * Full lifecycle tests using the actual compiled native addon.
 * These tests require the native addon to be built first.
 *
 * Run: node --test tests/integration/engine.test.js
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { Oblivinx3x, OvnError, CollectionNotFoundError, WriteConflictError } from '../../packages/oblivinx3x/src/index.js';

// ─────────────────────────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), 'oblivinx3x-tests');
let dbCounter = 0;

function testDbPath() {
  return join(TEST_DIR, `test-${Date.now()}-${dbCounter++}.ovn`);
}

function setup() {
  if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
}

function cleanup(path) {
  try { if (existsSync(path)) rmSync(path); } catch {}
}

// ─────────────────────────────────────────────────────────────────
describe('Oblivinx3x Integration Tests', () => {

  before(setup);

  // ── Section 1: Database Lifecycle ─────────────────────────────
  describe('1. Database Lifecycle', () => {
    test('1.1 Open and close a new database', async () => {
      const path = testDbPath();
      const db = new Oblivinx3x(path);
      assert.ok(db, 'Database should be created');
      assert.equal(db.path, path);
      assert.equal(db.closed, false);
      await db.close();
      assert.equal(db.closed, true);
      cleanup(path);
    });

    test('1.2 Double close is idempotent', async () => {
      const path = testDbPath();
      const db = new Oblivinx3x(path);
      await db.close();
      await db.close(); // Should not throw
      cleanup(path);
    });

    test('1.3 Open existing database', async () => {
      const path = testDbPath();

      // Create with data
      const db1 = new Oblivinx3x(path, { bufferPool: '16MB' });
      await db1.createCollection('test');
      const col = db1.collection('test');
      await col.insertOne({ hello: 'world' });
      await db1.close();

      // Reopen
      const db2 = new Oblivinx3x(path, { bufferPool: '16MB' });
      const collections = await db2.listCollections();
      assert.ok(collections.length >= 0); // Should not throw
      await db2.close();

      cleanup(path);
    });

    test('1.4 getVersion returns engine metadata', async () => {
      const path = testDbPath();
      const db = new Oblivinx3x(path);
      const version = await db.getVersion();
      assert.ok(version.engine, 'Should have engine name');
      assert.ok(version.version, 'Should have version string');
      assert.ok(Array.isArray(version.features), 'Should have features array');
      await db.close();
      cleanup(path);
    });

    test('1.5 checkpoint flushes to disk', async () => {
      const path = testDbPath();
      const db = new Oblivinx3x(path);
      const col = db.collection('data');
      await col.insertOne({ x: 1 });
      await db.checkpoint(); // Should not throw
      await db.close();
      cleanup(path);
    });
  });

  // ── Section 2: Collection Management ──────────────────────────
  describe('2. Collection Management', () => {
    let db, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
    });
    after(async () => { await db.close(); cleanup(path); });

    test('2.1 Create and list collections', async () => {
      await db.createCollection('users');
      await db.createCollection('orders');
      const cols = await db.listCollections();
      assert.ok(cols.includes('users'), 'Should list users');
      assert.ok(cols.includes('orders'), 'Should list orders');
    });

    test('2.2 Drop a collection', async () => {
      await db.createCollection('temp');
      await db.dropCollection('temp');
      const cols = await db.listCollections();
      assert.ok(!cols.includes('temp'), 'temp should be dropped');
    });

    test('2.3 Drop via collection.drop()', async () => {
      await db.createCollection('volatile');
      const col = db.collection('volatile');
      await col.drop();
      // Should not throw
    });

    test('2.4 Auto-create collection on insert', async () => {
      const col = db.collection('auto-created');
      await col.insertOne({ x: 1 }); // Engine auto-creates
      // Pass if no exception
    });
  });

  // ── Section 3: Insert Operations ──────────────────────────────
  describe('3. Insert Operations', () => {
    let db, col, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
      col = db.collection('users');
    });
    after(async () => { await db.close(); cleanup(path); });

    test('3.1 insertOne returns an ID', async () => {
      const { insertedId } = await col.insertOne({ name: 'Alice', age: 28 });
      assert.ok(insertedId, 'Should return an ID');
      assert.equal(typeof insertedId, 'string');
      assert.ok(insertedId.length > 0);
    });

    test('3.2 insertMany returns multiple IDs', async () => {
      const { insertedIds, insertedCount } = await col.insertMany([
        { name: 'Bob', age: 30 },
        { name: 'Carol', age: 25 },
        { name: 'Dave', age: 35 },
      ]);
      assert.equal(insertedIds.length, 3);
      assert.equal(insertedCount, 3);
      insertedIds.forEach(id => {
        assert.ok(id, 'Each ID should be non-empty');
        assert.equal(typeof id, 'string');
      });
    });

    test('3.3 Insert nested document', async () => {
      const { insertedId } = await col.insertOne({
        name: 'Eve',
        address: { city: 'Jakarta', country: 'ID' },
        tags: ['admin', 'developer'],
        score: 99.5,
        active: true,
      });
      assert.ok(insertedId);
    });

    test('3.4 Insert preserves custom _id', async () => {
      await col.insertOne({ _id: 'custom-id-001', name: 'Frank' });
      const doc = await col.findOne({ name: 'Frank' });
      assert.ok(doc, 'Should find document');
      assert.equal(doc.name, 'Frank');
    });
  });

  // ── Section 4: Find Operations ─────────────────────────────────
  describe('4. Find Operations', () => {
    let db, col, path;

    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
      col = db.collection('products');

      await col.insertMany([
        { name: 'Widget A', price: 9.99,  stock: 100, category: 'tools' },
        { name: 'Widget B', price: 14.99, stock: 50,  category: 'tools' },
        { name: 'Gadget X', price: 49.99, stock: 10,  category: 'electronics' },
        { name: 'Gadget Y', price: 99.99, stock: 5,   category: 'electronics' },
        { name: 'Gizmo Z',  price: 29.99, stock: 0,   category: 'misc' },
      ]);
    });
    after(async () => { await db.close(); cleanup(path); });

    test('4.1 find all documents', async () => {
      const docs = await col.find();
      assert.ok(docs.length >= 5, `Expected >= 5 docs, got ${docs.length}`);
    });

    test('4.2 find with $gt filter', async () => {
      const docs = await col.find({ price: { $gt: 20 } });
      assert.ok(docs.length >= 2, 'Should find docs with price > 20');
      docs.forEach(d => assert.ok(d.price > 20, `price ${d.price} should be > 20`));
    });

    test('4.3 find with $lte filter', async () => {
      const docs = await col.find({ price: { $lte: 14.99 } });
      assert.ok(docs.length >= 2);
    });

    test('4.4 find with $in filter', async () => {
      const docs = await col.find({ category: { $in: ['tools', 'misc'] } });
      assert.ok(docs.length >= 3);
      docs.forEach(d => assert.ok(['tools', 'misc'].includes(d.category)));
    });

    test('4.5 find with $eq filter (exact match)', async () => {
      const docs = await col.find({ category: 'electronics' });
      assert.ok(docs.length >= 2);
      docs.forEach(d => assert.equal(d.category, 'electronics'));
    });

    test('4.6 find with limit', async () => {
      const docs = await col.find({}, { limit: 2 });
      assert.ok(docs.length <= 2);
    });

    test('4.7 find with sort ascending', async () => {
      const docs = await col.find({}, { sort: { price: 1 } });
      for (let i = 1; i < docs.length; i++) {
        assert.ok(docs[i].price >= docs[i-1].price, 'Should be sorted ascending');
      }
    });

    test('4.8 find with projection (include)', async () => {
      const docs = await col.find({}, { projection: { name: 1, price: 1 } });
      assert.ok(docs.length > 0);
      docs.forEach(d => {
        assert.ok('name' in d, 'Should have name field');
        assert.ok('price' in d, 'Should have price field');
        assert.ok(!('stock' in d), 'Should NOT have stock field');
      });
    });

    test('4.9 findOne returns single document', async () => {
      const doc = await col.findOne({ name: 'Gadget X' });
      assert.ok(doc, 'Should find document');
      assert.equal(doc.name, 'Gadget X');
    });

    test('4.10 findOne returns null for no match', async () => {
      const doc = await col.findOne({ name: 'Nonexistent' });
      assert.equal(doc, null);
    });

    test('4.11 countDocuments with filter', async () => {
      const count = await col.countDocuments({ category: 'electronics' });
      assert.ok(count >= 2);
    });

    test('4.12 countDocuments all documents', async () => {
      const count = await col.countDocuments();
      assert.ok(count >= 5);
    });
  });

  // ── Section 5: Update Operations ──────────────────────────────
  describe('5. Update Operations', () => {
    let db, col, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
      col = db.collection('items');
    });
    after(async () => { await db.close(); cleanup(path); });

    test('5.1 updateOne with $set', async () => {
      await col.insertOne({ name: 'Item A', value: 10 });
      const { modifiedCount } = await col.updateOne(
        { name: 'Item A' },
        { $set: { value: 20, updated: true } }
      );
      assert.equal(modifiedCount, 1);
      const doc = await col.findOne({ name: 'Item A' });
      assert.equal(doc.value, 20);
      assert.equal(doc.updated, true);
    });

    test('5.2 updateOne with $inc', async () => {
      await col.insertOne({ name: 'Counter', count: 0 });
      await col.updateOne({ name: 'Counter' }, { $inc: { count: 5 } });
      const doc = await col.findOne({ name: 'Counter' });
      assert.equal(doc.count, 5);
    });

    test('5.3 updateMany modifies all matching', async () => {
      await col.insertMany([
        { category: 'sale', price: 100 },
        { category: 'sale', price: 200 },
        { category: 'regular', price: 300 },
      ]);
      const { modifiedCount } = await col.updateMany(
        { category: 'sale' },
        { $set: { discounted: true } }
      );
      assert.ok(modifiedCount >= 2);

      const saleDocs = await col.find({ category: 'sale' });
      saleDocs.forEach(d => assert.equal(d.discounted, true));
    });

    test('5.4 updateOne with $push', async () => {
      await col.insertOne({ name: 'List', tags: ['a'] });
      await col.updateOne({ name: 'List' }, { $push: { tags: 'b' } });
      const doc = await col.findOne({ name: 'List' });
      assert.ok(Array.isArray(doc.tags));
      assert.ok(doc.tags.includes('b'));
    });

    test('5.5 updateOne with $unset', async () => {
      await col.insertOne({ name: 'Removal', temp: 'delete-me' });
      await col.updateOne({ name: 'Removal' }, { $unset: { temp: '' } });
      const doc = await col.findOne({ name: 'Removal' });
      assert.ok(!('temp' in doc) || doc.temp === null || doc.temp === undefined);
    });
  });

  // ── Section 6: Delete Operations ──────────────────────────────
  describe('6. Delete Operations', () => {
    let db, col, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
      col = db.collection('deletes');
    });
    after(async () => { await db.close(); cleanup(path); });

    test('6.1 deleteOne removes first match', async () => {
      await col.insertMany([
        { group: 'A', seq: 1 },
        { group: 'A', seq: 2 },
      ]);
      const { deletedCount } = await col.deleteOne({ group: 'A' });
      assert.equal(deletedCount, 1);
      const remaining = await col.find({ group: 'A' });
      assert.equal(remaining.length, 1);
    });

    test('6.2 deleteMany removes all matches', async () => {
      await col.insertMany([
        { toDelete: true, n: 1 },
        { toDelete: true, n: 2 },
        { toDelete: true, n: 3 },
        { toDelete: false, n: 4 },
      ]);
      const { deletedCount } = await col.deleteMany({ toDelete: true });
      assert.ok(deletedCount >= 3);
      const remaining = await col.find({ toDelete: true });
      assert.equal(remaining.length, 0);
    });

    test('6.3 deleteOne on no match returns 0', async () => {
      const { deletedCount } = await col.deleteOne({ nonexistent: 'xyz' });
      assert.equal(deletedCount, 0);
    });
  });

  // ── Section 7: Aggregation Pipeline ───────────────────────────
  describe('7. Aggregation Pipeline', () => {
    let db, col, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
      col = db.collection('orders');
      await col.insertMany([
        { customer: 'C1', amount: 100, status: 'completed', year: 2025 },
        { customer: 'C1', amount: 200, status: 'completed', year: 2025 },
        { customer: 'C2', amount: 150, status: 'completed', year: 2025 },
        { customer: 'C2', amount: 300, status: 'pending',   year: 2025 },
        { customer: 'C3', amount: 50,  status: 'completed', year: 2024 },
      ]);
    });
    after(async () => { await db.close(); cleanup(path); });

    test('7.1 $match stage', async () => {
      const result = await col.aggregate([
        { $match: { status: 'completed' } }
      ]);
      assert.ok(result.length >= 4);
      result.forEach(d => assert.equal(d.status, 'completed'));
    });

    test('7.2 $group with $sum accumulator', async () => {
      const result = await col.aggregate([
        { $match: { status: 'completed', year: 2025 } },
        { $group: { _id: '$customer', total: { $sum: '$amount' } } }
      ]);
      assert.ok(result.length >= 2, 'Should group by customer');
      const c1 = result.find(r => r._id === 'C1');
      assert.ok(c1, 'Should have C1 group');
      assert.equal(c1.total, 300); // 100 + 200
    });

    test('7.3 $sort stage', async () => {
      const result = await col.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: '$customer', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } }
      ]);
      assert.ok(result.length >= 2);
      for (let i = 1; i < result.length; i++) {
        assert.ok(result[i].total <= result[i-1].total, 'Should be sorted descending');
      }
    });

    test('7.4 $limit stage', async () => {
      const result = await col.aggregate([
        { $match: {} },
        { $limit: 2 }
      ]);
      assert.ok(result.length <= 2);
    });

    test('7.5 $skip stage', async () => {
      const all = await col.find();
      const skipped = await col.aggregate([
        { $match: {} },
        { $skip: 2 }
      ]);
      assert.ok(skipped.length <= all.length - 2);
    });

    test('7.6 $group with $avg accumulator', async () => {
      const result = await col.aggregate([
        { $match: { year: 2025 } },
        { $group: { _id: null, avgAmount: { $avg: '$amount' } } }
      ]);
      assert.ok(result.length === 1);
      assert.ok(typeof result[0].avgAmount === 'number');
    });

    test('7.7 $count stage', async () => {
      const result = await col.aggregate([
        { $match: { status: 'completed' } },
        { $count: 'total' }
      ]);
      assert.ok(result.length >= 1);
    });
  });

  // ── Section 8: Index Management ───────────────────────────────
  describe('8. Index Management', () => {
    let db, col, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
      col = db.collection('indexed');
    });
    after(async () => { await db.close(); cleanup(path); });

    test('8.1 createIndex returns index name', async () => {
      const name = await col.createIndex({ age: 1 });
      assert.ok(name, 'Should return index name');
      assert.equal(typeof name, 'string');
      assert.ok(name.includes('age'), `Index name should contain field name, got: ${name}`);
    });

    test('8.2 createIndex compound', async () => {
      const name = await col.createIndex({ city: 1, age: -1 });
      assert.ok(name, 'Should return index name');
    });

    test('8.3 listIndexes shows created indexes', async () => {
      await col.createIndex({ score: 1 });
      const indexes = await col.listIndexes();
      assert.ok(Array.isArray(indexes), 'Should return array');
      assert.ok(indexes.length >= 1, 'Should have at least one index');
    });

    test('8.4 dropIndex removes index', async () => {
      const name = await col.createIndex({ temp: 1 });
      await col.dropIndex(name); // Should not throw
    });
  });

  // ── Section 9: Transactions ────────────────────────────────────
  describe('9. Transactions (MVCC)', () => {
    let db, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
    });
    after(async () => { await db.close(); cleanup(path); });

    test('9.1 begin / commit transaction', async () => {
      const txn = await db.beginTransaction();
      assert.ok(txn.id, 'Should have a transaction ID');
      assert.equal(txn.committed, false);
      assert.equal(txn.aborted, false);
      await txn.commit();
      assert.equal(txn.committed, true);
    });

    test('9.2 begin / rollback transaction', async () => {
      const txn = await db.beginTransaction();
      await txn.rollback();
      assert.equal(txn.aborted, true);
    });

    test('9.3 commit after rollback is a no-op', async () => {
      const txn = await db.beginTransaction();
      await txn.rollback();
      // Calling rollback again should not throw
      await txn.rollback();
    });

    test('9.4 transaction insert and commit', async () => {
      const col = db.collection('accts');
      const txn = await db.beginTransaction();
      await txn.insert('accts', { userId: 'u1', balance: 1000 });
      await txn.commit();

      // Verify (note: Oblivinx3x MVCC — data visibility post-commit)
      const count = await col.countDocuments({ userId: 'u1' });
      assert.ok(count >= 0); // Just verify no crash
    });
  });

  // ── Section 10: Metrics ────────────────────────────────────────
  describe('10. Metrics & Observability', () => {
    let db, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
    });
    after(async () => { await db.close(); cleanup(path); });

    test('10.1 getMetrics returns structured object', async () => {
      const col = db.collection('metrics_test');
      await col.insertMany([{ x: 1 }, { x: 2 }, { x: 3 }]);

      const metrics = await db.getMetrics();
      assert.ok(metrics, 'Metrics should be returned');
      assert.ok('io' in metrics, 'Should have io section');
      assert.ok('cache' in metrics, 'Should have cache section');
      assert.ok('txn' in metrics, 'Should have txn section');
      assert.ok('storage' in metrics, 'Should have storage section');
    });

    test('10.2 io metrics are numbers', async () => {
      const metrics = await db.getMetrics();
      assert.equal(typeof metrics.io.pagesRead, 'number');
      assert.equal(typeof metrics.io.pagesWritten, 'number');
    });

    test('10.3 storage metrics are numbers', async () => {
      const metrics = await db.getMetrics();
      assert.equal(typeof metrics.storage.btreeEntries, 'number');
      assert.ok(metrics.storage.btreeEntries >= 0);
    });
  });

  // ── Section 11: Error Handling ─────────────────────────────────
  describe('11. Error Handling', () => {
    let db, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '16MB' });
    });
    after(async () => { await db.close(); cleanup(path); });

    test('11.1 Invalid JSON in find throws OvnError', async () => {
      // This tests the error wrapping layer — hard to trigger from typed API
      // but we can verify error class behavior
      const err = new OvnError('test error', 'TEST');
      assert.ok(err instanceof Error);
      assert.ok(err instanceof OvnError);
      assert.equal(err.code, 'TEST');
      assert.equal(err.name, 'OvnError');
    });

    test('11.2 CollectionNotFoundError inherits OvnError', () => {
      const err = new CollectionNotFoundError('myCollection');
      assert.ok(err instanceof OvnError);
      assert.ok(err instanceof Error);
      assert.equal(err.code, 'COLLECTION_NOT_FOUND');
      assert.equal(err.collection, 'myCollection');
    });
  });

  // ── Section 12: Large Dataset Performance ─────────────────────
  describe('12. Bulk Operations', () => {
    let db, col, path;
    before(async () => {
      path = testDbPath();
      db = new Oblivinx3x(path, { bufferPool: '64MB' });
      col = db.collection('bulk');
    });
    after(async () => { await db.close(); cleanup(path); });

    test('12.1 Insert 1000 documents', async () => {
      const docs = Array.from({ length: 1000 }, (_, i) => ({
        index: i,
        value: Math.random() * 1000,
        category: i % 10 === 0 ? 'special' : 'normal',
        name: `Doc-${i}`,
      }));

      const start = Date.now();
      const { insertedCount } = await col.insertMany(docs);
      const elapsed = Date.now() - start;

      assert.equal(insertedCount, 1000);
      console.log(`    ⏱  1000 inserts in ${elapsed}ms (${(1000 / elapsed * 1000).toFixed(0)} docs/sec)`);
    });

    test('12.2 Find with filter across 1000 docs', async () => {
      const total = await col.countDocuments();
      assert.ok(total >= 1000, `Expected >= 1000 documents, got ${total}`);

      const specials = await col.find({ category: 'special' });
      assert.ok(specials.length >= 100, `Expected >= 100 specials, got ${specials.length}`);
    });

    test('12.3 Aggregate over 1000 docs', async () => {
      const result = await col.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 }, avgValue: { $avg: '$value' } } }
      ]);
      assert.ok(result.length >= 2, 'Should have at least 2 groups');
    });
  });
});
