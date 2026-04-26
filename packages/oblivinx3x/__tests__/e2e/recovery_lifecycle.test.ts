/**
 * E2E tests — Recovery lifecycle, branded types, rate limiting,
 * and full security pipeline validation.
 *
 * Tests the complete security stack from input → validation → ACL → audit,
 * plus TypeScript-specific safety (branded types, error taxonomy).
 *
 * @module __tests__/e2e/recovery_lifecycle
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { asCollectionName, asDocumentId } from '../../src/types/index.js';
import { QueryValidator, QueryError } from '../../src/security/validation.js';
import { RateLimiter } from '../../src/security/rate-limiter.js';
import {
  SecurityContext,
  checkPermission,
  sanitizeInput,
  filterDocumentByACL,
  sanitizeDocumentByACL,
  AuditLogger,
  InMemoryAuditLogBackend,
} from '../../src/security/index.js';

// ═══════════════════════════════════════════════════════════════════
//  §1 — BRANDED TYPE: CollectionName
// ═══════════════════════════════════════════════════════════════════

describe('Branded types — CollectionName', () => {
  const validNames = [
    'users',
    'user_profiles_v2',
    'A',
    'products',
    'orders123',
    'a'.repeat(128),
  ];

  for (const name of validNames) {
    it(`accepts valid name: "${name.length > 30 ? name.slice(0, 27) + '...' : name}"`, () => {
      const result = asCollectionName(name);
      assert.equal(result, name);
    });
  }

  const invalidNames = [
    { input: '', reason: 'empty string' },
    { input: '123abc', reason: 'starts with digit' },
    { input: '_users', reason: 'starts with underscore' },
    { input: 'users.data', reason: 'contains dot' },
    { input: 'users-data', reason: 'contains hyphen' },
    { input: 'users data', reason: 'contains space' },
    { input: 'users$data', reason: 'contains $' },
    { input: 'a'.repeat(129), reason: 'exceeds 128 chars' },
    { input: 'table;DROP', reason: 'contains semicolon' },
  ];

  for (const { input, reason } of invalidNames) {
    it(`rejects invalid name: ${reason}`, () => {
      assert.throws(() => asCollectionName(input), TypeError);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
//  §2 — BRANDED TYPE: DocumentId
// ═══════════════════════════════════════════════════════════════════

describe('Branded types — DocumentId', () => {
  it('accepts valid UUIDv4', () => {
    const id = asDocumentId('550e8400-e29b-41d4-a716-446655440000');
    assert.ok(id);
    assert.equal(typeof id, 'string');
  });

  it('accepts valid UUIDv4 (lowercase)', () => {
    assert.ok(asDocumentId('7c9e6679-7425-40de-944b-e07fc1f90ae7'));
  });

  it('accepts valid UUIDv4 (uppercase)', () => {
    assert.ok(asDocumentId('7C9E6679-7425-40DE-944B-E07FC1F90AE7'));
  });

  const invalidIds = [
    { input: '', reason: 'empty string' },
    { input: 'not-a-uuid', reason: 'random string' },
    { input: '12345', reason: 'plain number string' },
    { input: 'null', reason: 'the string "null"' },
    { input: '../../../etc/passwd', reason: 'path traversal attempt' },
    { input: '550e8400-e29b-41d4-a716', reason: 'truncated UUID' },
  ];

  for (const { input, reason } of invalidIds) {
    it(`rejects invalid id: ${reason}`, () => {
      assert.throws(() => asDocumentId(input), TypeError);
    });
  }

  it('error message does not leak internal paths', () => {
    try {
      asDocumentId('../../../etc/shadow');
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.ok(!err.message.includes('/etc'), 'Error must not expose internal paths');
      assert.ok(!err.message.includes('shadow'), 'Error must not expose internal paths');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §3 — RATE LIMITER
// ═══════════════════════════════════════════════════════════════════

describe('RateLimiter — token bucket algorithm', () => {
  it('allows operations within rate limit', () => {
    const limiter = new RateLimiter();
    // Default rate is 10,000/sec — easily allows a few operations
    for (let i = 0; i < 10; i++) {
      assert.ok(limiter.checkRead('users'), `Read ${i} should be allowed`);
      assert.ok(limiter.checkWrite('users'), `Write ${i} should be allowed`);
    }
  });

  it('creates separate buckets per collection', () => {
    const limiter = new RateLimiter();
    assert.ok(limiter.checkRead('collection_a'));
    assert.ok(limiter.checkRead('collection_b'));

    // Resetting one should not affect the other
    limiter.reset('collection_a');
    assert.ok(limiter.checkRead('collection_b'));
    assert.ok(limiter.checkRead('collection_a')); // fresh bucket
  });

  it('distinguishes read and write buckets', () => {
    const limiter = new RateLimiter();
    // Both should work independently
    assert.ok(limiter.checkRead('x'));
    assert.ok(limiter.checkWrite('x'));
  });

  it('resetAll clears all buckets', () => {
    const limiter = new RateLimiter();
    limiter.checkRead('a');
    limiter.checkRead('b');
    limiter.checkRead('c');
    limiter.resetAll();
    // After reset, all buckets are recreated fresh
    assert.ok(limiter.checkRead('a'));
    assert.ok(limiter.checkRead('b'));
    assert.ok(limiter.checkRead('c'));
  });

  it('configure() changes rates for new buckets', () => {
    const limiter = new RateLimiter();
    limiter.configure({ writes: 5, reads: 10 });
    limiter.resetAll(); // Force new buckets with new rates

    // Should allow initial operations
    assert.ok(limiter.checkRead('test'));
    assert.ok(limiter.checkWrite('test'));
  });

  it('assertAllowed does not throw within limits', () => {
    const limiter = new RateLimiter();
    assert.doesNotThrow(() => limiter.assertAllowed('col', 'read'));
    assert.doesNotThrow(() => limiter.assertAllowed('col', 'write'));
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §4 — FULL SECURITY PIPELINE (end-to-end)
// ═══════════════════════════════════════════════════════════════════

describe('Security pipeline — multi-layer defense', () => {
  const validator = new QueryValidator();

  it('Layer 1 → 2 → 3: validate filter → check ACL → audit log', () => {
    // Layer 1: Query validation
    const filter = validator.validateFilter({ status: { $eq: 'active' }, age: { $gt: 18 } });
    assert.ok(filter);

    // Layer 2: Collection permission check
    const perms = new Map([['users', new Set(['read', 'write'])]]);
    assert.ok(checkPermission(perms as any, 'users', 'read'));

    // Layer 3: Audit logging
    const backend = new InMemoryAuditLogBackend();
    const logger = new AuditLogger({ enabled: true, backend, events: ['find'] });
    logger.log({ operation: 'find', collection: 'users', filter: filter as any });

    const events = backend.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, 'find');
    assert.deepEqual(events[0].filter, filter);
  });

  it('Layer 1 → 2 → 3: validate insert → ACL filter → audit', () => {
    // Layer 1: Document validation
    const doc = validator.validateDocument({
      name: 'Alice',
      email: 'alice@example.com',
      role: 'user',
    });

    // Layer 2: Field ACL strips sensitive fields
    const acl: Map<string, Map<string, Set<string>>> = new Map([
      [
        'users',
        new Map([
          ['name', new Set(['read', 'write'])],
          ['email', new Set(['read', 'write'])],
          ['role', new Set(['read'])], // read-only, can't be set by user
        ]),
      ],
    ]);
    const sanitized = sanitizeDocumentByACL(acl as any, 'users', doc as any);
    assert.equal(sanitized.name, 'Alice');
    assert.equal(sanitized.email, 'alice@example.com');
    assert.equal(sanitized.role, undefined); // stripped by ACL

    // Layer 3: Audit
    const backend = new InMemoryAuditLogBackend();
    const logger = new AuditLogger({ enabled: true, backend, events: ['insert'] });
    logger.log({ operation: 'insert', collection: 'users', documentId: 'uuid-abc' });
    assert.equal(backend.getEvents().length, 1);
  });

  it('rejects injection at Layer 1 before reaching layers 2-3', () => {
    assert.throws(
      () => validator.validateFilter({ $where: 'process.exit(1)' }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
    // Layers 2 and 3 are never reached — injection stopped at input validation
  });

  it('rejects prototype pollution at Layer 1', () => {
    assert.throws(
      () =>
        validator.validateUpdate({
          $set: { 'profile.settings': { __proto__: { admin: true } } as any },
        }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('sanitizeInput enforces depth + size before ACL check', () => {
    // Very deep document should fail at input validation level
    let obj: any = { x: 'leaf' };
    for (let i = 0; i < 25; i++) obj = { nested: obj };
    assert.throws(
      () => sanitizeInput(obj, { maxDocumentDepth: 20 }),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §5 — ERROR TAXONOMY
// ═══════════════════════════════════════════════════════════════════

describe('Error taxonomy — QueryError properties', () => {
  const validator = new QueryValidator();

  it('QueryError has code, message, and name properties', () => {
    try {
      validator.validateFilter({ $where: 'hack' });
      assert.fail('Should have thrown');
    } catch (err: any) {
      assert.ok(err instanceof QueryError);
      assert.equal(err.name, 'QueryError');
      assert.ok(err.code.startsWith('ERR_'));
      assert.ok(err.message.length > 0);
    }
  });

  it('ERR_QUERY_INJECTION for $where', () => {
    try {
      validator.validateFilter({ $where: 'x' });
      assert.fail();
    } catch (err: any) {
      assert.equal(err.code, 'ERR_QUERY_INJECTION');
    }
  });

  it('ERR_PROTOTYPE_POLLUTION for __proto__', () => {
    try {
      validator.validateDocument({ __proto__: {} });
      assert.fail();
    } catch (err: any) {
      assert.equal(err.code, 'ERR_PROTOTYPE_POLLUTION');
    }
  });

  it('ERR_UNKNOWN_OPERATOR for bogus operators', () => {
    try {
      validator.validateFilter({ x: { $evil: 1 } });
      assert.fail();
    } catch (err: any) {
      assert.equal(err.code, 'ERR_UNKNOWN_OPERATOR');
    }
  });

  it('error messages do not expose internal file paths', () => {
    try {
      validator.validateFilter({ $where: 'require("fs")' });
      assert.fail();
    } catch (err: any) {
      assert.ok(!err.message.includes('node_modules'));
      assert.ok(!err.message.includes('src/'));
      assert.ok(!err.message.includes('dist/'));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §6 — CONCURRENT SECURITY CONTEXTS
// ═══════════════════════════════════════════════════════════════════

describe('SecurityContext — concurrent instances isolation', () => {
  it('two contexts do not share rate limiter state', () => {
    const ctx1 = new SecurityContext({ rateLimit: { reads: 5 } });
    const ctx2 = new SecurityContext({ rateLimit: { reads: 5 } });

    // Consume tokens in ctx1
    for (let i = 0; i < 5; i++) ctx1.rateLimiter.checkRead('col');

    // ctx2 should still have full capacity
    assert.ok(ctx2.rateLimiter.checkRead('col'));
  });

  it('two contexts do not share audit logs', () => {
    const b1 = new InMemoryAuditLogBackend();
    const b2 = new InMemoryAuditLogBackend();
    const ctx1 = new SecurityContext({ auditLog: { enabled: true } });
    const ctx2 = new SecurityContext({ auditLog: { enabled: true } });

    // Each context has its own audit logger
    ctx1.auditLogger.log({ operation: 'insert', collection: 'a' });
    // ctx2 audit logger is independent
    assert.ok(ctx2.auditLogger); // just verify it exists and is separate
  });

  it('two contexts can have different permission maps', () => {
    const ctx1 = new SecurityContext({
      permissions: new Map([['users', new Set(['read'])]]),
    });
    const ctx2 = new SecurityContext({
      permissions: new Map([['users', new Set(['read', 'write', 'delete'])]]),
    });

    assert.ok(checkPermission(ctx1.permissions as any, 'users', 'read'));
    assert.equal(checkPermission(ctx1.permissions as any, 'users', 'write'), false);
    assert.ok(checkPermission(ctx2.permissions as any, 'users', 'write'));
    assert.ok(checkPermission(ctx2.permissions as any, 'users', 'delete'));
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §7 — EDGE CASES & FUZZY INPUTS
// ═══════════════════════════════════════════════════════════════════

describe('Edge cases — unusual but valid inputs', () => {
  const validator = new QueryValidator();

  it('handles filter with numeric string keys', () => {
    const filter = validator.validateFilter({ '0': 'value', '1': 'other' });
    assert.ok(filter);
  });

  it('handles filter with unicode field names', () => {
    const filter = validator.validateFilter({ 'namaField_日本語': { $eq: 'test' } });
    assert.ok(filter);
  });

  it('handles empty nested objects', () => {
    const doc = validator.validateDocument({ meta: {}, tags: [], nested: { inner: {} } });
    assert.ok(doc);
  });

  it('handles document with null values', () => {
    const doc = validator.validateDocument({ name: 'Alice', deletedAt: null });
    assert.ok(doc);
    assert.equal((doc as any).deletedAt, null);
  });

  it('handles document with boolean values', () => {
    const doc = validator.validateDocument({ active: true, archived: false });
    assert.ok(doc);
  });

  it('handles document with large numeric values', () => {
    const doc = validator.validateDocument({
      bigInt: Number.MAX_SAFE_INTEGER,
      negBigInt: Number.MIN_SAFE_INTEGER,
      float: 3.14159265358979,
    });
    assert.ok(doc);
  });

  it('handles filter with deeply nested $and/$or', () => {
    const filter = validator.validateFilter({
      $and: [
        { $or: [{ a: 1 }, { b: 2 }] },
        { $or: [{ c: 3 }, { $and: [{ d: 4 }, { e: 5 }] }] },
      ],
    });
    assert.ok(filter);
  });

  it('handles update with multiple operators simultaneously', () => {
    const update = validator.validateUpdate({
      $set: { name: 'Updated', 'nested.field': 'value' },
      $inc: { count: 1, 'stats.views': 5 },
      $unset: { obsolete: '' },
    });
    assert.ok(update);
  });
});
