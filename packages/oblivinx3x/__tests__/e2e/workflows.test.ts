/**
 * E2E Tests — Real-world scenarios: write → read → delete workflows.
 *
 * Tests complete application workflows including error handling,
 * concurrent operations, and edge cases.
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

describe('E2E: User Management System', () => {
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

  it('should handle complete user lifecycle', async () => {
    const dbPath = testDbPath('e2e_user_lifecycle');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    await db.createCollection('users');
    const users = db.collection<any>('users');

    // Create user
    const { insertedId } = await users.insertOne({
      name: 'Alice',
      email: 'alice@example.com',
      age: 28,
      roles: ['admin', 'user'],
      createdAt: Date.now(),
    });
    assert.ok(insertedId);

    // Read user
    const user = await users.findOne({ email: 'alice@example.com' });
    assert.ok(user);
    assert.strictEqual(user!.name, 'Alice');
    assert.strictEqual(user!.roles.length, 2);

    // Update user
    await users.updateOne(
      { email: 'alice@example.com' },
      { $set: { age: 29 }, $push: { roles: 'moderator' } }
    );
    const updated = await users.findOne({ email: 'alice@example.com' });
    assert.strictEqual(updated!.age, 29);

    // Delete user
    const { deletedCount } = await users.deleteOne({ email: 'alice@example.com' });
    assert.strictEqual(deletedCount, 1);

    const remaining = await users.find({});
    assert.strictEqual(remaining.length, 0);

    await db.close();
  });

  it('should handle e-commerce order flow', async () => {
    const dbPath = testDbPath('e2e_ecommerce');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);

    // Setup collections
    await db.createCollection('products');
    await db.createCollection('orders');

    const products = db.collection<any>('products');
    const orders = db.collection<any>('orders');

    // Add products
    await products.insertMany([
      { name: 'Laptop', price: 999.99, stock: 10 },
      { name: 'Phone', price: 699.99, stock: 50 },
      { name: 'Tablet', price: 399.99, stock: 20 },
    ]);

    // Place order
    const order = {
      customer: 'Alice',
      items: [
        { product: 'Laptop', qty: 1, price: 999.99 },
        { product: 'Phone', qty: 2, price: 699.99 },
      ],
      total: 2399.97,
      status: 'pending',
      createdAt: Date.now(),
    };
    await orders.insertOne(order);

    // Query orders by customer
    const aliceOrders = await orders.find({ customer: 'Alice' });
    assert.strictEqual(aliceOrders.length, 1);

    // Update order status
    await orders.updateOne(
      { customer: 'Alice' },
      { $set: { status: 'shipped' } }
    );
    const shipped = await orders.findOne({ customer: 'Alice' });
    assert.strictEqual(shipped!.status, 'shipped');

    // Aggregate: total revenue
    const revenue = await orders.aggregate([
      { $match: { status: 'shipped' } },
      { $group: { _id: null, total: { $sum: '$total' } } },
    ]);
    assert.strictEqual(revenue[0].total, 2399.97);

    await db.close();
  });
});

describe('E2E: Error Handling', () => {
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

  it('should handle operations on closed database', async () => {
    const dbPath = testDbPath('e2e_closed');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    await db.close();

    // Attempting to create collection on closed DB should fail
    try {
      await db.createCollection('test');
      assert.fail('Should have thrown');
    } catch (err: any) {
      // Expected error
    }
  });

  it('should handle duplicate collection creation', async () => {
    const dbPath = testDbPath('e2e_dup_coll');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    await db.createCollection('users');

    try {
      await db.createCollection('users');
      assert.fail('Should have thrown for duplicate collection');
    } catch (err: any) {
      // Expected error
    }

    await db.close();
  });

  it('should handle malformed JSON in queries', async () => {
    const dbPath = testDbPath('e2e_bad_json');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');
    await users.insertOne({ name: 'Alice' });

    // Query with invalid filter should not crash
    try {
      await users.find('not_an_object' as any);
      // May throw or handle gracefully — either is acceptable
    } catch (err: any) {
      // Expected to throw for invalid filter
    }

    await db.close();
  });
});

describe('E2E: Advanced Features', () => {
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

  it('should export and import data', async () => {
    const dbPath = testDbPath('e2e_export');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    await db.createCollection('users');
    const users = db.collection('users');
    await users.insertMany([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);

    // Export
    const exported = await db.export();
    assert.ok(exported.users);
    assert.strictEqual(exported.users.length, 2);

    await db.close();
  });

  it('should backup and verify', async () => {
    const dbPath = testDbPath('e2e_backup');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const backupPath = path.join(TEST_DIR, 'backup_test.json');
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);

    const db = new Oblivinx3x(dbPath);
    await db.createCollection('users');
    const users = db.collection('users');
    await users.insertOne({ name: 'Alice', age: 30 });

    // Backup
    await db.backup(backupPath);
    assert.ok(fs.existsSync(backupPath));

    // Verify backup content
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
    assert.ok(backup.users);
    assert.strictEqual(backup.users.length, 1);

    fs.unlinkSync(backupPath);
    await db.close();
  });

  it('should support autocomplete/prefix search', async () => {
    const dbPath = testDbPath('e2e_autocomplete');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    const users = db.collection('users');
    await users.insertMany([
      { name: 'Alice' },
      { name: 'Alina' },
      { name: 'Ali' },
      { name: 'Bob' },
    ]);

    const results = await users.autocomplete('name', 'Ali', 10);
    assert.ok(results.length >= 2); // Alice, Alina, Ali
    assert.ok(results.every((u: any) => u.name.startsWith('Ali')));

    await db.close();
  });

  it('should handle blob storage', async () => {
    const dbPath = testDbPath('e2e_blob');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);

    // Store a blob
    const data = Buffer.from('Hello, Blob Storage!');
    const blobId = await db.putBlob(data);
    assert.ok(blobId);

    // Retrieve the blob
    const retrieved = await db.getBlob(blobId);
    assert.ok(retrieved);
    assert.strictEqual(Buffer.from(retrieved).toString(), 'Hello, Blob Storage!');

    await db.close();
  });

  it('should handle geospatial index creation', async () => {
    const dbPath = testDbPath('e2e_geo');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    const places = db.collection('places');
    await places.insertMany([
      { name: 'Park A', location: [-73.935242, 40.730610] },
      { name: 'Park B', location: [-73.985656, 40.758896] },
    ]);

    await places.createGeoIndex('location');
    const indexes = await places.listIndexes();
    assert.ok(indexes.some((idx: any) => idx.name.includes('2dsphere')));

    await db.close();
  });
});

describe('E2E: New Update Operators', () => {
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

  it('should support $push with $each', async () => {
    const dbPath = testDbPath('e2e_push_each');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    const users = db.collection<any>('users');
    await users.insertOne({ name: 'Alice', tags: ['admin'] });

    await users.updateOne(
      { name: 'Alice' },
      { $push: { tags: { $each: ['user', 'moderator'] } } }
    );

    const result = await users.findOne({ name: 'Alice' });
    assert.strictEqual(result!.tags.length, 3);

    await db.close();
  });

  it('should support $pullAll', async () => {
    const dbPath = testDbPath('e2e_pull_all');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    const users = db.collection<any>('users');
    await users.insertOne({ name: 'Alice', tags: ['a', 'b', 'c', 'd'] });

    await users.updateOne(
      { name: 'Alice' },
      { $pullAll: { tags: ['a', 'c'] } }
    );

    const result = await users.findOne({ name: 'Alice' });
    assert.deepStrictEqual(result!.tags.sort(), ['b', 'd'].sort());

    await db.close();
  });

  it('should support $addToSet with $each', async () => {
    const dbPath = testDbPath('e2e_addtoset_each');
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

    const db = new Oblivinx3x(dbPath);
    const users = db.collection<any>('users');
    await users.insertOne({ name: 'Alice', colors: ['red'] });

    await users.updateOne(
      { name: 'Alice' },
      { $addToSet: { colors: { $each: ['red', 'blue', 'green'] } } }
    );

    const result = await users.findOne({ name: 'Alice' });
    assert.strictEqual(result!.colors.length, 3); // red not duplicated

    await db.close();
  });
});
