/**
 * @module security/validation
 *
 * MQL input validation and prototype pollution prevention.
 * All data entering the native layer must pass through this gate.
 *
 * @packageDocumentation
 */

import type { FilterQuery, UpdateQuery, Document } from '../types/index.js';

// ── MQL Operator Allowlist ────────────────────────────────────────────────────

/** Comparison operators allowed in filter queries (Appendix C). */
const ALLOWED_COMPARISON_OPS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
  '$in', '$nin',
]);

/** Logical operators allowed at the top level or nested. */
const ALLOWED_LOGICAL_OPS = new Set([
  '$and', '$or', '$nor', '$not',
]);

/** Element operators. */
const ALLOWED_ELEMENT_OPS = new Set([
  '$exists', '$type',
]);

/** Array operators (filter side). */
const ALLOWED_ARRAY_FILTER_OPS = new Set([
  '$all', '$elemMatch', '$size',
]);

/** Update operators allowed in $set/$push/etc context. */
const ALLOWED_UPDATE_TOP_OPS = new Set([
  '$set', '$unset', '$inc', '$mul', '$min', '$max', '$rename',
  '$push', '$pull', '$addToSet', '$pop', '$currentDate',
  '$setOnInsert', '$bit',
]);

/** All allowed filter-side operators. */
const ALLOWED_FILTER_OPS: Set<string> = new Set([
  ...ALLOWED_COMPARISON_OPS,
  ...ALLOWED_LOGICAL_OPS,
  ...ALLOWED_ELEMENT_OPS,
  ...ALLOWED_ARRAY_FILTER_OPS,
]);

/** Prototype-poisoning keys that must never appear as field names. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Maximum ReDoS complexity threshold (number of quantifiers in regex). */
const MAX_REGEX_QUANTIFIERS = 8;

// ── QueryError ────────────────────────────────────────────────────────────────

export class QueryError extends Error {
  readonly code: 'ERR_QUERY_INJECTION' | 'ERR_UNKNOWN_OPERATOR' | 'ERR_PROTOTYPE_POLLUTION';

  constructor(
    code: 'ERR_QUERY_INJECTION' | 'ERR_UNKNOWN_OPERATOR' | 'ERR_PROTOTYPE_POLLUTION',
    message: string,
  ) {
    super(message);
    this.name = 'QueryError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Deep-clone `input` to strip prototype chain and prevent pollution.
 * Uses `structuredClone` when available (Node 17+), falls back to JSON roundtrip.
 */
function safeClone<T>(input: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(input);
  }
  return JSON.parse(JSON.stringify(input)) as T;
}

/** Check that `value` is a plain object (not Array, not null, not class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Throw if `key` is a forbidden prototype-polluting property name. */
function assertSafeKey(key: string): void {
  if (FORBIDDEN_KEYS.has(key)) {
    throw new QueryError(
      'ERR_PROTOTYPE_POLLUTION',
      `Forbidden field name detected: "${key}" — prototype pollution attempt rejected`,
    );
  }
}

/**
 * Check a regex pattern for ReDoS risk by counting quantifier occurrences.
 * Throws if the pattern exceeds `MAX_REGEX_QUANTIFIERS`.
 */
function assertSafeRegex(pattern: string): void {
  const quantifierCount = (pattern.match(/[+*?{]/g) ?? []).length;
  if (quantifierCount > MAX_REGEX_QUANTIFIERS) {
    throw new QueryError(
      'ERR_QUERY_INJECTION',
      `Regex pattern has ${quantifierCount} quantifiers (max ${MAX_REGEX_QUANTIFIERS}) — ReDoS risk`,
    );
  }
}

// ── QueryValidator ────────────────────────────────────────────────────────────

/**
 * Validates and sanitizes MQL filter, update, and document inputs.
 *
 * All public methods:
 * 1. Deep-clone the input to strip prototype chain.
 * 2. Verify no forbidden keys (`__proto__`, `constructor`, `prototype`).
 * 3. Validate all operators against the allowlist.
 * 4. Reject `$where` unless `allowWhere` is enabled.
 * 5. Validate regex values for ReDoS risk.
 */
export class QueryValidator {
  readonly #allowWhere: boolean;

  constructor(options: { allowWhere?: boolean } = {}) {
    this.#allowWhere = options.allowWhere ?? false;
  }

  /**
   * Validate and sanitize a filter query.
   * Returns a safe clone on success; throws `QueryError` on violation.
   */
  validateFilter(filter: unknown): FilterQuery<Document> {
    if (!isPlainObject(filter)) {
      throw new QueryError('ERR_QUERY_INJECTION', 'Filter must be a plain object');
    }
    const clone = safeClone(filter) as Record<string, unknown>;
    this.#validateFilterObject(clone);
    return clone as FilterQuery<Document>;
  }

  /**
   * Validate and sanitize an update document.
   * Returns a safe clone on success; throws `QueryError` on violation.
   */
  validateUpdate(update: unknown): UpdateQuery<Document> {
    if (!isPlainObject(update)) {
      throw new QueryError('ERR_QUERY_INJECTION', 'Update must be a plain object');
    }
    const clone = safeClone(update) as Record<string, unknown>;
    for (const key of Object.keys(clone)) {
      assertSafeKey(key);
      if (key.startsWith('$')) {
        if (!ALLOWED_UPDATE_TOP_OPS.has(key)) {
          throw new QueryError(
            'ERR_UNKNOWN_OPERATOR',
            `Unknown update operator "${key}" — not in allowlist`,
          );
        }
      }
    }
    return clone as UpdateQuery<Document>;
  }

  /**
   * Validate and sanitize a document before insert/replace.
   * Returns a safe clone on success; throws `QueryError` on violation.
   */
  validateDocument(doc: unknown): Document {
    if (!isPlainObject(doc)) {
      throw new QueryError('ERR_QUERY_INJECTION', 'Document must be a plain object');
    }
    const clone = safeClone(doc) as Record<string, unknown>;
    this.#validateDocumentObject(clone);
    return clone as Document;
  }

  // ── Private validation helpers ───────────────────────────────────────────

  #validateFilterObject(obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      assertSafeKey(key);

      if (key === '$where') {
        if (!this.#allowWhere) {
          throw new QueryError(
            'ERR_QUERY_INJECTION',
            '$where operator is disabled — enable via allow_where pragma',
          );
        }
        continue;
      }

      if (key.startsWith('$')) {
        if (!ALLOWED_FILTER_OPS.has(key)) {
          throw new QueryError(
            'ERR_UNKNOWN_OPERATOR',
            `Unknown filter operator "${key}" — not in allowlist`,
          );
        }
      }

      // Recurse into nested objects
      if (isPlainObject(value)) {
        this.#validateFilterObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isPlainObject(item)) {
            this.#validateFilterObject(item as Record<string, unknown>);
          }
        }
      } else if (value instanceof RegExp) {
        assertSafeRegex(value.source);
      } else if (typeof value === 'string' && key === '$regex') {
        assertSafeRegex(value);
      }
    }
  }

  #validateDocumentObject(obj: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(obj)) {
      assertSafeKey(key);
      if (key.startsWith('$')) {
        throw new QueryError(
          'ERR_QUERY_INJECTION',
          `Document field names cannot start with "$" (found "${key}")`,
        );
      }
      if (isPlainObject(value)) {
        this.#validateDocumentObject(value as Record<string, unknown>);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isPlainObject(item)) {
            this.#validateDocumentObject(item as Record<string, unknown>);
          }
        }
      }
    }
  }
}

/** Singleton validator with default options (no $where, strict allowlist). */
export const defaultQueryValidator = new QueryValidator();
