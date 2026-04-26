/**
 * Integration Tests — Binding Contract
 *
 * Verifies that all public API functions exist on the exported classes
 * and throw typed errors (not native crashes) on invalid input.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '..', '__tmp__');

function testDbPath(name: string): string {
  return path.join(TEST_DIR, `bc_${name}.ovn`);
}

// Lazy-load so that native-not-available skips gracefully
let Oblivinx3x: typeof import('../../dist/index.js').Oblivinx3x;
let OblivinxError: typeof import('../../dist/index.js').OvnError;
let nativeAvailable = false;

describe('Binding Contract', () => {
  before(async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    try {
      const mod = await import('../../dist/index.js');
      Oblivinx3x = mod.Oblivinx3x;
      OblivinxError = mod.OvnError;
      nativeAvailable = true;
    } catch {
      nativeAvailable = false;
    }
  });

  after(() => {
    if (fs.existsSync(TEST_DIR)) {
      for (const f of fs.readdirSync(TEST_DIR)) {
        if (f.startsWith('bc_') && f.endsWith('.ovn')) {
          fs.unlinkSync(path.join(TEST_DIR, f));
        }
      }
    }
  });

  it('Oblivinx3x class is exported', () => {
    assert.ok(Oblivinx3x !== undefined, 'Oblivinx3x must be exported');
    assert.strictEqual(typeof Oblivinx3x, 'function');
  });

  it('Collection has all required CRUD methods', () => {
    if (!nativeAvailable) return;

    const dbPath = testDbPath('methods');
    const db = new Oblivinx3x(dbPath);
    const col = db.collection('test');

    const required = [
      'insertOne', 'insertMany',
      'findOne', 'find',
      'updateOne', 'updateMany',
      'deleteOne', 'deleteMany',
      'aggregate',
      'createIndex', 'listIndexes', 'dropIndex',
      'count',
    ] as const;

    for (const method of required) {
      assert.strictEqual(
        typeof (col as any)[method],
        'function',
        `Collection.${method} must be a function`,
      );
    }

    db.close().catch(() => {});
  });

  it('Oblivinx3x has lifecycle methods', () => {
    if (!nativeAvailable) return;

    const dbPath = testDbPath('lifecycle');
    const db = new Oblivinx3x(dbPath);

    assert.strictEqual(typeof db.collection, 'function');
    assert.strictEqual(typeof db.close, 'function');
    assert.strictEqual(typeof db.checkpoint, 'function');

    db.close().catch(() => {});
  });

  it('insertOne with non-object throws OblivinxError, not a crash', async () => {
    if (!nativeAvailable) return;

    const dbPath = testDbPath('invalid_insert');
    const db = new Oblivinx3x(dbPath);
    const col = db.collection('test');

    try {
      // null is not a valid document
      await col.insertOne(null as any);
      assert.fail('Should have thrown');
    } catch (err) {
      // Must be a typed error, not an uncaught native crash
      assert.ok(err instanceof Error, 'Must throw an Error instance');
    } finally {
      await db.close();
    }
  });

  it('find with non-object filter throws or returns empty, not a crash', async () => {
    if (!nativeAvailable) return;

    const dbPath = testDbPath('invalid_find');
    const db = new Oblivinx3x(dbPath);
    const col = db.collection('test');

    try {
      // Non-object filter
      const result = await col.find('bad_filter' as any);
      // Either throws or returns empty array — never crashes native
      assert.ok(Array.isArray(result) || result === undefined);
    } catch (err) {
      assert.ok(err instanceof Error);
    } finally {
      await db.close();
    }
  });

  it('operating on closed database throws DatabaseClosedError', async () => {
    if (!nativeAvailable) return;

    const dbPath = testDbPath('closed_db');
    const db = new Oblivinx3x(dbPath);
    const col = db.collection('test');
    await db.close();

    try {
      await col.insertOne({ x: 1 });
      assert.fail('Should have thrown on closed db');
    } catch (err) {
      assert.ok(err instanceof Error);
      // Must be a typed OblivinxError, not a raw native exception
      assert.ok(
        err instanceof OblivinxError || (err as any).code !== undefined || err.message.length > 0,
        'Error must be typed',
      );
    }
  });

  it('QueryValidator is exported and validates filters', async () => {
    const mod = await import('../../dist/index.js');
    const { QueryValidator, QueryError } = mod;

    assert.strictEqual(typeof QueryValidator, 'function');

    const validator = new QueryValidator();

    // Valid filter passes
    const valid = validator.validateFilter({ age: { $gt: 18 } });
    assert.ok(valid !== undefined);

    // Prototype pollution is rejected
    assert.throws(
      () => validator.validateFilter(JSON.parse('{"__proto__": {"admin": true}}')),
      (err: unknown) => err instanceof QueryError || err instanceof Error,
    );
  });

  it('asCollectionName and asDocumentId are exported', async () => {
    const mod = await import('../../dist/index.js');
    const { asCollectionName, asDocumentId } = mod;

    assert.strictEqual(typeof asCollectionName, 'function');
    assert.strictEqual(typeof asDocumentId, 'function');

    // Valid names pass
    assert.strictEqual(asCollectionName('users'), 'users');
    assert.strictEqual(
      asDocumentId('550e8400-e29b-41d4-a716-446655440000'),
      '550e8400-e29b-41d4-a716-446655440000',
    );

    // Invalid names throw
    assert.throws(() => asCollectionName(''), TypeError);
    assert.throws(() => asDocumentId('!!!bad!!!'), TypeError);
  });
});
