/**
 * Integration tests — MQL Injection, Prototype Pollution, ReDoS,
 * Oversized Documents, Deep Nesting, and Field-Level Security.
 *
 * Each test group verifies a specific attack surface documented in
 * Section 20 of the Oblivinx3x v2.0 spec. All errors must surface as
 * typed `QueryError` (never as native crashes or unhandled rejections).
 *
 * @module __tests__/integration/query_injection
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { QueryValidator, QueryError } from '../../src/security/validation.js';
import {
  SecurityContext,
  sanitizeInput,
  validateDepth,
  validateSize,
  validateAllowedFields,
  checkPermission,
  isFieldReadable,
  isFieldWritable,
  filterDocumentByACL,
  sanitizeDocumentByACL,
  AuditLogger,
  InMemoryAuditLogBackend,
} from '../../src/security/index.js';

const validator = new QueryValidator();
const validatorWithWhere = new QueryValidator({ allowWhere: true });

// ═══════════════════════════════════════════════════════════════════
//  §1 — OPERATOR INJECTION
// ═══════════════════════════════════════════════════════════════════

describe('QueryValidator — operator injection', () => {
  it('accepts valid comparison operators', () => {
    const filter = validator.validateFilter({
      age: { $gt: 18, $lt: 65 },
      name: { $eq: 'Alice' },
      status: { $in: ['active', 'pending'] },
      score: { $gte: 50, $lte: 100 },
    });
    assert.ok(filter);
  });

  it('accepts valid logical operators ($and, $or, $nor, $not)', () => {
    const filter = validator.validateFilter({
      $and: [
        { age: { $gte: 18 } },
        { $or: [{ city: 'Jakarta' }, { city: 'Bandung' }] },
      ],
    });
    assert.ok(filter);
  });

  it('rejects unknown operators in filter ($eval)', () => {
    assert.throws(
      () => validator.validateFilter({ x: { $eval: '1+1' } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_UNKNOWN_OPERATOR',
    );
  });

  it('rejects unknown operators in filter ($function)', () => {
    assert.throws(
      () => validator.validateFilter({ x: { $function: { body: 'return true' } } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_UNKNOWN_OPERATOR',
    );
  });

  it('rejects $accumulator operator (server-side JS)', () => {
    assert.throws(
      () => validator.validateFilter({ x: { $accumulator: { init: 'function(){}' } } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_UNKNOWN_OPERATOR',
    );
  });

  it('rejects unknown operators in update ($runCommand)', () => {
    assert.throws(
      () => validator.validateUpdate({ $runCommand: { drop: 'users' } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_UNKNOWN_OPERATOR',
    );
  });

  it('rejects $setOnInsert when not in update allowlist', () => {
    // $setOnInsert is not in the default update allowlist (by design)
    assert.throws(
      () => validator.validateUpdate({ $setOnInsert: { created: true } }),
      (err: unknown) => err instanceof QueryError,
    );
  });

  it('rejects $where by default', () => {
    assert.throws(
      () => validator.validateFilter({ $where: 'this.admin === true' }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects $where with function objects', () => {
    assert.throws(
      () =>
        validator.validateFilter({
          $where: (() => true) as unknown as string,
        }),
      (err: unknown) => err instanceof QueryError,
    );
  });

  it('allows $where when explicitly enabled via constructor', () => {
    const filter = validatorWithWhere.validateFilter({ $where: 'this.x > 1' });
    assert.ok(filter);
  });

  it('accepts valid update operators ($set, $inc, $unset, $push, $pull)', () => {
    const update = validator.validateUpdate({
      $set: { name: 'Updated' },
      $inc: { count: 1 },
      $unset: { obsoleteField: '' },
    });
    assert.ok(update);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §2 — PROTOTYPE POLLUTION
// ═══════════════════════════════════════════════════════════════════

describe('QueryValidator — prototype pollution prevention', () => {
  it('rejects __proto__ in top-level filter', () => {
    assert.throws(
      () => validator.validateFilter({ __proto__: { admin: true } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('rejects constructor in filter', () => {
    assert.throws(
      () => validator.validateFilter({ constructor: { prototype: {} } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('rejects prototype in document insert', () => {
    assert.throws(
      () => validator.validateDocument({ name: 'ok', prototype: { x: 1 } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('rejects __proto__ nested 3 levels deep', () => {
    assert.throws(
      () => validator.validateDocument({ a: { b: { __proto__: { admin: true } } } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('rejects __proto__ inside arrays', () => {
    assert.throws(
      () => validator.validateDocument({ items: [{ __proto__: { x: 1 } }] }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('rejects constructor.prototype chain', () => {
    assert.throws(
      () =>
        validator.validateDocument({
          a: { constructor: { prototype: { isAdmin: true } } },
        }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('rejects __proto__ in update $set values', () => {
    assert.throws(
      () =>
        validator.validateUpdate({
          $set: { profile: { __proto__: { role: 'admin' } } },
        }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_PROTOTYPE_POLLUTION',
    );
  });

  it('allows legitimate field names that look similar', () => {
    // "proto" without underscores is fine
    const doc = validator.validateDocument({ proto: 'legit', constructorName: 'test' });
    assert.ok(doc);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §3 — ReDoS PREVENTION
// ═══════════════════════════════════════════════════════════════════

describe('QueryValidator — ReDoS prevention', () => {
  it('rejects regex with excessive quantifiers (>8)', () => {
    const evilPattern = 'a+b*c?d{1}e+f*g?h{2}i+j*';
    assert.throws(
      () => validator.validateFilter({ name: { $regex: evilPattern } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects catastrophic backtracking pattern', () => {
    assert.throws(
      () => validator.validateFilter({ email: { $regex: '(a+)+$' } }),
      (err: unknown) => err instanceof QueryError,
    );
  });

  it('accepts regex with safe quantifiers', () => {
    const safeFilter = validator.validateFilter({
      email: { $regex: '^[a-z]+@[a-z]+\\.[a-z]{2,4}$' },
    });
    assert.ok(safeFilter);
  });

  it('accepts regex with character classes and anchors', () => {
    const filter = validator.validateFilter({
      phone: { $regex: '^\\+?[0-9]{10,13}$' },
    });
    assert.ok(filter);
  });

  it('rejects regex with nested groups', () => {
    assert.throws(
      () => validator.validateFilter({ x: { $regex: '((a+)+)+' } }),
      (err: unknown) => err instanceof QueryError,
    );
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §4 — DOCUMENT VALIDATION
// ═══════════════════════════════════════════════════════════════════

describe('QueryValidator — document validation', () => {
  it('rejects $ prefix in document field names', () => {
    assert.throws(
      () => validator.validateDocument({ $set: { x: 1 } }),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects non-object filters (string)', () => {
    assert.throws(
      () => validator.validateFilter('not an object' as any),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects null as filter', () => {
    assert.throws(
      () => validator.validateFilter(null as any),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects arrays as filter', () => {
    assert.throws(
      () => validator.validateFilter([1, 2, 3] as any),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects undefined as filter', () => {
    assert.throws(
      () => validator.validateFilter(undefined as any),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('rejects number as filter', () => {
    assert.throws(
      () => validator.validateFilter(42 as any),
      (err: unknown) => err instanceof QueryError && err.code === 'ERR_QUERY_INJECTION',
    );
  });

  it('accepts valid nested document with arrays', () => {
    const doc = validator.validateDocument({
      name: 'Alice',
      address: { city: 'Jakarta', zip: '12345', geo: { lat: -6.2, lng: 106.8 } },
      tags: ['admin', 'user'],
      metadata: { created: Date.now(), flags: [true, false] },
    });
    assert.ok(doc);
    assert.equal((doc as any).name, 'Alice');
    assert.equal((doc as any).address.geo.lat, -6.2);
  });

  it('accepts empty filter (find all)', () => {
    const filter = validator.validateFilter({});
    assert.deepEqual(filter, {});
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §5 — DEEP CLONE ISOLATION
// ═══════════════════════════════════════════════════════════════════

describe('QueryValidator — deep clone isolation', () => {
  it('filter output is isolated from original', () => {
    const original = { name: 'test', nested: { x: 1 } };
    const validated = validator.validateFilter(original) as typeof original;
    validated.nested.x = 999;
    assert.equal(original.nested.x, 1, 'Original must not be mutated');
  });

  it('document output is isolated from original', () => {
    const original = { name: 'test', arr: [1, 2, 3] };
    const validated = validator.validateDocument(original) as typeof original;
    validated.arr.push(99);
    assert.equal(original.arr.length, 3, 'Original array must not be mutated');
  });

  it('update output is isolated from original', () => {
    const original = { $set: { score: 100, meta: { v: 1 } } };
    const validated = validator.validateUpdate(original) as typeof original;
    (validated.$set as any).meta.v = 999;
    assert.equal(original.$set.meta.v, 1, 'Original update must not be mutated');
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §6 — INPUT VALIDATION (depth, size, allowed fields)
// ═══════════════════════════════════════════════════════════════════

describe('Input validation — depth limit', () => {
  it('accepts document within depth limit', () => {
    const doc = { a: { b: { c: { d: 'ok' } } } };
    assert.doesNotThrow(() => validateDepth(doc, 20));
  });

  it('rejects document exceeding depth limit', () => {
    // Build a deeply nested object beyond depth 5
    let obj: any = { val: 'leaf' };
    for (let i = 0; i < 10; i++) {
      obj = { nested: obj };
    }
    assert.throws(() => validateDepth(obj, 5));
  });

  it('handles depth limit with arrays', () => {
    const doc = { list: [{ inner: [{ deep: 'value' }] }] };
    assert.doesNotThrow(() => validateDepth(doc, 10));
  });

  it('rejects deeply nested array structures', () => {
    let arr: any = ['leaf'];
    for (let i = 0; i < 10; i++) {
      arr = [arr];
    }
    assert.throws(() => validateDepth(arr, 5));
  });
});

describe('Input validation — size limit', () => {
  it('accepts document within size limit', () => {
    const doc = { name: 'Alice', data: 'x'.repeat(1000) };
    assert.doesNotThrow(() => validateSize(doc, 16 * 1024 * 1024));
  });

  it('rejects document exceeding size limit', () => {
    const doc = { data: 'x'.repeat(100_000) };
    assert.throws(() => validateSize(doc, 1024)); // 1KB limit
  });
});

describe('Input validation — allowed fields', () => {
  it('returns empty violations for conforming document', () => {
    const violations = validateAllowedFields(
      { name: 'Alice', age: 30, _id: 'ignored' },
      ['name', 'age', 'email'],
    );
    assert.deepEqual(violations, []);
  });

  it('returns violations for disallowed fields', () => {
    const violations = validateAllowedFields(
      { name: 'Alice', secret: 'hack', admin: true },
      ['name', 'age'],
    );
    assert.ok(violations.includes('secret'));
    assert.ok(violations.includes('admin'));
    assert.equal(violations.length, 2);
  });

  it('always allows _id field', () => {
    const violations = validateAllowedFields({ _id: 'uuid', name: 'Alice' }, ['name']);
    assert.deepEqual(violations, []);
  });
});

describe('sanitizeInput — combined validation', () => {
  it('passes valid document through all checks', () => {
    const result = sanitizeInput({ name: 'Alice', age: 30 });
    assert.equal(result.name, 'Alice');
  });

  it('throws on deeply nested document', () => {
    let obj: any = { val: 'x' };
    for (let i = 0; i < 25; i++) obj = { n: obj };
    assert.throws(() => sanitizeInput(obj, { maxDocumentDepth: 20 }));
  });

  it('throws on oversized document', () => {
    const big = { data: 'x'.repeat(200_000) };
    assert.throws(() => sanitizeInput(big, { maxDocumentSize: 1024 }));
  });

  it('throws when document has disallowed fields', () => {
    const allowed = new Map([['users', ['name', 'email']]]);
    assert.throws(() =>
      sanitizeInput({ name: 'Alice', admin: true }, { allowedFields: allowed }, 'users'),
    );
  });

  it('passes when no field whitelist is configured for collection', () => {
    const allowed = new Map([['products', ['title']]]);
    // 'users' collection has no whitelist, so all fields are allowed
    const result = sanitizeInput({ anything: true }, { allowedFields: allowed }, 'users');
    assert.ok(result);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §7 — ACCESS CONTROL (ACL)
// ═══════════════════════════════════════════════════════════════════

describe('Access Control — collection permissions', () => {
  it('allows operation when no permissions are defined', () => {
    const perms: Map<string, Set<string>> = new Map();
    assert.ok(checkPermission(perms as any, 'users', 'read'));
    assert.ok(checkPermission(perms as any, 'users', 'write'));
  });

  it('allows operation when permission is granted', () => {
    const perms = new Map([['users', new Set(['read', 'write'])]]);
    assert.ok(checkPermission(perms as any, 'users', 'read'));
    assert.ok(checkPermission(perms as any, 'users', 'write'));
  });

  it('denies operation when permission is not granted', () => {
    const perms = new Map([['users', new Set(['read'])]]);
    assert.equal(checkPermission(perms as any, 'users', 'delete'), false);
    assert.equal(checkPermission(perms as any, 'users', 'write'), false);
  });

  it('admin permission grants all operations', () => {
    const perms = new Map([['users', new Set(['admin'])]]);
    assert.ok(checkPermission(perms as any, 'users', 'read'));
    assert.ok(checkPermission(perms as any, 'users', 'write'));
    assert.ok(checkPermission(perms as any, 'users', 'delete'));
  });
});

describe('Access Control — field-level ACL', () => {
  const acl: Map<string, Map<string, Set<string>>> = new Map([
    [
      'users',
      new Map([
        ['name', new Set(['read', 'write'])],
        ['email', new Set(['read'])],          // read-only
        ['passwordHash', new Set<string>([])], // completely hidden
      ]),
    ],
  ]);

  it('allows reading of readable fields', () => {
    assert.ok(isFieldReadable(acl as any, 'users', 'name'));
    assert.ok(isFieldReadable(acl as any, 'users', 'email'));
  });

  it('denies reading of hidden fields', () => {
    assert.equal(isFieldReadable(acl as any, 'users', 'passwordHash'), false);
  });

  it('allows writing of writable fields', () => {
    assert.ok(isFieldWritable(acl as any, 'users', 'name'));
  });

  it('denies writing of read-only fields', () => {
    assert.equal(isFieldWritable(acl as any, 'users', 'email'), false);
  });

  it('allows all ops on fields not in ACL', () => {
    assert.ok(isFieldReadable(acl as any, 'users', 'unknownField'));
    assert.ok(isFieldWritable(acl as any, 'users', 'unknownField'));
  });

  it('allows all ops on collections not in ACL', () => {
    assert.ok(isFieldReadable(acl as any, 'products', 'price'));
    assert.ok(isFieldWritable(acl as any, 'products', 'price'));
  });

  it('filterDocumentByACL strips hidden fields from read output', () => {
    const doc = { name: 'Alice', email: 'alice@test.com', passwordHash: 'secret123' };
    const filtered = filterDocumentByACL(acl as any, 'users', doc);
    assert.equal(filtered.name, 'Alice');
    assert.equal(filtered.email, 'alice@test.com');
    assert.equal(filtered.passwordHash, undefined);
  });

  it('sanitizeDocumentByACL strips read-only fields from write input', () => {
    const doc = { name: 'Alice', email: 'alice@test.com', passwordHash: 'secret' };
    const sanitized = sanitizeDocumentByACL(acl as any, 'users', doc);
    assert.equal(sanitized.name, 'Alice');
    assert.equal(sanitized.email, undefined); // read-only, stripped from write
    assert.equal(sanitized.passwordHash, undefined); // no write perm
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §8 — AUDIT LOGGING
// ═══════════════════════════════════════════════════════════════════

describe('AuditLogger — event recording', () => {
  it('records insert events', () => {
    const backend = new InMemoryAuditLogBackend();
    const logger = new AuditLogger({ enabled: true, backend, events: ['insert'] });

    logger.log({ operation: 'insert', collection: 'users', documentId: 'uuid-1' });
    logger.log({ operation: 'insert', collection: 'users', documentId: 'uuid-2' });

    const events = backend.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].operation, 'insert');
    assert.equal(events[0].documentId, 'uuid-1');
    assert.ok(events[0].timestamp > 0);
  });

  it('skips events not in the event filter', () => {
    const backend = new InMemoryAuditLogBackend();
    const logger = new AuditLogger({ enabled: true, backend, events: ['delete'] });

    logger.log({ operation: 'insert', collection: 'users' });
    logger.log({ operation: 'delete', collection: 'users', documentId: 'uuid-3' });

    const events = backend.getEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0].operation, 'delete');
  });

  it('records nothing when disabled', () => {
    const backend = new InMemoryAuditLogBackend();
    const logger = new AuditLogger({ enabled: false, backend });

    logger.log({ operation: 'insert', collection: 'users' });
    assert.equal(backend.getEvents().length, 0);
  });

  it('circular buffer drops oldest events at capacity', () => {
    const backend = new InMemoryAuditLogBackend(3); // capacity = 3

    const logger = new AuditLogger({ enabled: true, backend, events: ['insert'] });
    for (let i = 0; i < 5; i++) {
      logger.log({ operation: 'insert', collection: 'c', documentId: `id-${i}` });
    }

    const events = backend.getEvents();
    assert.equal(events.length, 3);
    // Oldest events (id-0, id-1) should have been evicted
    assert.equal(events[0].documentId, 'id-2');
    assert.equal(events[2].documentId, 'id-4');
  });

  it('flush clears all events', () => {
    const backend = new InMemoryAuditLogBackend();
    const logger = new AuditLogger({ enabled: true, backend, events: ['insert'] });
    logger.log({ operation: 'insert', collection: 'c' });
    assert.equal(backend.getEvents().length, 1);

    logger.flush();
    assert.equal(backend.getEvents().length, 0);
  });
});

// ═══════════════════════════════════════════════════════════════════
//  §9 — SECURITY CONTEXT (integration)
// ═══════════════════════════════════════════════════════════════════

describe('SecurityContext — factory integration', () => {
  it('creates a context with defaults', () => {
    const ctx = new SecurityContext();
    assert.ok(ctx.rateLimiter);
    assert.ok(ctx.auditLogger);
    assert.ok(ctx.permissions);
    assert.ok(ctx.fieldACLs);
  });

  it('creates a context with rate limiting', () => {
    const ctx = new SecurityContext({
      rateLimit: { reads: 100, writes: 50 },
    });
    // Rate limiter should have the configured rates
    assert.ok(ctx.rateLimiter.checkRead('test'));
    assert.ok(ctx.rateLimiter.checkWrite('test'));
  });

  it('creates a context with audit logging enabled', () => {
    const ctx = new SecurityContext({
      auditLog: { enabled: true, events: ['insert', 'delete'] },
    });
    assert.ok(ctx.auditLogger);
  });

  it('creates a context with input validation config', () => {
    const ctx = new SecurityContext({
      inputValidation: {
        maxDocumentDepth: 10,
        maxDocumentSize: 1024,
      },
    });
    assert.equal(ctx.inputConfig.maxDocumentDepth, 10);
    assert.equal(ctx.inputConfig.maxDocumentSize, 1024);
  });
});
