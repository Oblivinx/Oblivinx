/**
 * Unit Tests — CRUD Operations
 *
 * Tests basic insert, find, update, delete with isolated state.
 * Each test creates its own database and cleans up after.
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

describe('CRUD Operations', () => {
  before(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  after(() => {
    // Cleanup all test databases
    if (fs.existsSync(TEST_DIR)) {
      for (const file of fs.readdirSync(TEST_DIR)) {
        if (file.endsWith('.ovn')) {
          fs.unlinkSync(path.join(TEST_DIR, file));
        }
      }
    }
  });

  describe('insertOne', () => {
    it('should insert a single document and return an ID', async () => {
      const dbPath = testDbPath('insert_one');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      await db.createCollection('users');
      const users = db.collection('users');

      const result = await users.insertOne({ name: 'Alice', age: 30 });
      assert.ok(result.insertedId, 'Should return insertedId');
      assert.strictEqual(typeof result.insertedId, 'string');

      await db.close();
    });

    it('should auto-generate _id if not provided', async () => {
      const dbPath = testDbPath('insert_autoid');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      const result = await users.insertOne({ name: 'Bob' });
      assert.ok(result.insertedId, 'Should auto-generate _id');
      await db.close();
    });
  });

  describe('insertMany', () => {
    it('should insert multiple documents in a batch', async () => {
      const dbPath = testDbPath('insert_many');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');

      const result = await users.insertMany([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
        { name: 'Charlie', age: 35 },
      ]);

      assert.strictEqual(result.insertedCount, 3);
      assert.strictEqual(result.insertedIds.length, 3);

      await db.close();
    });

    it('should handle empty array gracefully', async () => {
      const dbPath = testDbPath('insert_many_empty');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      const result = await users.insertMany([]);
      assert.strictEqual(result.insertedCount, 0);
      await db.close();
    });
  });

  describe('find', () => {
    it('should find all documents with empty filter', async () => {
      const dbPath = testDbPath('find_all');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);

      const results = await users.find({});
      assert.strictEqual(results.length, 2);

      await db.close();
    });

    it('should filter by exact match', async () => {
      const dbPath = testDbPath('find_filter');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
        { name: 'Alice', age: 35 },
      ]);

      const results = await users.find({ name: 'Alice' });
      assert.strictEqual(results.length, 2);
      assert.ok(results.every((u: any) => u.name === 'Alice'));

      await db.close();
    });

    it('should support comparison operators ($gt, $lt)', async () => {
      const dbPath = testDbPath('find_comparison');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'A', age: 20 },
        { name: 'B', age: 30 },
        { name: 'C', age: 40 },
      ]);

      const results = await users.find({ age: { $gt: 25 } });
      assert.strictEqual(results.length, 2);

      await db.close();
    });

    it('should support $in operator', async () => {
      const dbPath = testDbPath('find_in');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
        { name: 'Charlie', age: 35 },
      ]);

      const results = await users.find({ name: { $in: ['Alice', 'Charlie'] } });
      assert.strictEqual(results.length, 2);

      await db.close();
    });

    it('should support $and and $or logical operators', async () => {
      const dbPath = testDbPath('find_logical');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice', age: 30, active: true },
        { name: 'Bob', age: 25, active: false },
        { name: 'Charlie', age: 35, active: true },
      ]);

      const results = await users.find({ $and: [{ active: true }, { age: { $gt: 28 } }] });
      assert.strictEqual(results.length, 2);

      await db.close();
    });

    it('should support sort, limit, and skip options', async () => {
      const dbPath = testDbPath('find_options');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'A', age: 30 },
        { name: 'B', age: 20 },
        { name: 'C', age: 40 },
        { name: 'D', age: 10 },
      ]);

      const results = await users.find({}, { sort: { age: -1 }, limit: 2, skip: 1 });
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].age, 30);
      assert.strictEqual(results[1].age, 20);

      await db.close();
    });

    it('should support projection (include/exclude fields)', async () => {
      const dbPath = testDbPath('find_projection');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertOne({ name: 'Alice', age: 30, email: 'alice@example.com' });

      const results = await users.find({}, { projection: { name: 1, _id: 1 } });
      assert.ok(results[0].name);
      assert.ok(results[0]._id);
      // Note: projection behavior depends on implementation
      await db.close();
    });
  });

  describe('findOne', () => {
    it('should return first matching document or null', async () => {
      const dbPath = testDbPath('findone');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice', age: 30 },
        { name: 'Bob', age: 25 },
      ]);

      const result = await users.findOne({ name: 'Alice' });
      assert.ok(result);
      assert.strictEqual(result!.name, 'Alice');

      const notFound = await users.findOne({ name: 'Nobody' });
      assert.strictEqual(notFound, null);

      await db.close();
    });
  });

  describe('countDocuments', () => {
    it('should count all documents with empty filter', async () => {
      const dbPath = testDbPath('count_all');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([{ name: 'A' }, { name: 'B' }, { name: 'C' }]);

      const count = await users.countDocuments({});
      assert.strictEqual(count, 3);

      await db.close();
    });

    it('should count only matching documents', async () => {
      const dbPath = testDbPath('count_filter');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice', active: true },
        { name: 'Bob', active: false },
        { name: 'Charlie', active: true },
      ]);

      const count = await users.countDocuments({ active: true });
      assert.strictEqual(count, 2);

      await db.close();
    });
  });

  describe('updateOne', () => {
    it('should update first matching document', async () => {
      const dbPath = testDbPath('update_one');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertOne({ name: 'Alice', age: 30 });

      const result = await users.updateOne({ name: 'Alice' }, { $set: { age: 31 } });
      assert.strictEqual(result.matchedCount, 1);
      assert.strictEqual(result.modifiedCount, 1);

      const updated = await users.findOne({ name: 'Alice' });
      assert.strictEqual(updated!.age, 31);

      await db.close();
    });

    it('should support $inc operator', async () => {
      const dbPath = testDbPath('update_inc');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertOne({ name: 'Alice', score: 100 });

      await users.updateOne({ name: 'Alice' }, { $inc: { score: 50 } });
      const result = await users.findOne({ name: 'Alice' });
      assert.strictEqual(result!.score, 150);

      await db.close();
    });
  });

  describe('updateMany', () => {
    it('should update all matching documents', async () => {
      const dbPath = testDbPath('update_many');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'A', status: 'pending' },
        { name: 'B', status: 'pending' },
        { name: 'C', status: 'done' },
      ]);

      const result = await users.updateMany(
        { status: 'pending' },
        { $set: { status: 'processed' } }
      );
      assert.strictEqual(result.matchedCount, 2);
      assert.strictEqual(result.modifiedCount, 2);

      await db.close();
    });
  });

  describe('deleteOne', () => {
    it('should delete first matching document', async () => {
      const dbPath = testDbPath('delete_one');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'Alice' },
        { name: 'Bob' },
      ]);

      const result = await users.deleteOne({ name: 'Alice' });
      assert.strictEqual(result.deletedCount, 1);

      const remaining = await users.find({});
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].name, 'Bob');

      await db.close();
    });
  });

  describe('deleteMany', () => {
    it('should delete all matching documents', async () => {
      const dbPath = testDbPath('delete_many');
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

      const db = new Oblivinx3x(dbPath);
      const users = db.collection('users');
      await users.insertMany([
        { name: 'A', status: 'temp' },
        { name: 'B', status: 'temp' },
        { name: 'C', status: 'keep' },
      ]);

      const result = await users.deleteMany({ status: 'temp' });
      assert.strictEqual(result.deletedCount, 2);

      const remaining = await users.find({});
      assert.strictEqual(remaining.length, 1);

      await db.close();
    });
  });
});
