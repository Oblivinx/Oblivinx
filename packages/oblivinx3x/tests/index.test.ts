import { test } from 'node:test';
import * as assert from 'node:assert';
import { Database } from '../dist/index.js';
import { rmSync } from 'node:fs';

test('Oblivinx3x Engine Initial Test', async (t) => {
  const dbPath = 'test-db.ovn';
  try { rmSync(dbPath); } catch { }

  const db = new Database(dbPath);

  await t.test('create collection and insert', async () => {
    await db.createCollection('users');
    const users = db.collection('users');

    await users.insertOne({ name: 'Alice', role: 'admin' });
    const docs = await users.find({ name: 'Alice' });
    assert.strictEqual(docs.length, 1);
    assert.strictEqual(docs[0].name, 'Alice');
  });

  await db.close();
  try { rmSync(dbPath); } catch { }
});
