/**
 * @file builder.ts
 * @module oblivinx3x/query
 * @description
 *   Fluent, immutable, type-safe query builder for Oblivinx3x.
 *   Every chaining method returns a **new** QueryBuilder instance (immutable pattern).
 *   Builder compiles to internal MQL filter/options objects, then delegates
 *   execution to the Collection's native bridge.
 *
 * @architecture
 *   Pattern: Builder + Method Chaining + Strategy (per operator)
 *   Ref: Section 13.3 (CRUD), Section 4.6 (Query Engine), Appendix C (MQL Operators)
 *
 * @example
 *   const users = await db.collection<User>('users')
 *     .query()
 *     .where('age', '$gte', 18)
 *     .where('address.city', '$eq', 'Jakarta')
 *     .sort('name', 'asc')
 *     .limit(10)
 *     .execute();
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */

import type {
  Document,
  FilterQuery,
  FindOptions,
  UpdateQuery,
  UpdateResult,
  DeleteResult,
  ExplainPlan,
  PipelineStage,
} from '../types/index.js';

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — VALID OPERATORS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Valid MQL comparison operators for `where()`.
 * Using a Set for O(1) lookup during validation.
 * @internal
 */
const VALID_COMPARISON_OPS = new Set<string>([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
  '$in', '$nin', '$exists', '$regex', '$type',
]);

// ═══════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════

/** Comparison operators for the where() method */
export type ComparisonOp =
  | '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte'
  | '$in' | '$nin' | '$exists' | '$regex' | '$type';

/** Projection spec — 1 to include, 0 to exclude */
export type ProjectionSpec<T extends Document> =
  { [K in keyof T]?: 0 | 1 } & Record<string, 0 | 1>;

/** Sort spec map */
export type SortSpec<T extends Document> =
  { [K in keyof T]?: 1 | -1 } & Record<string, 1 | -1>;

/** Cursor options for streaming */
export interface CursorOptions {
  batchSize?: number;
  timeoutMs?: number;
}

/**
 * Internal snapshot of QueryBuilder state — used for immutable cloning.
 * @internal
 */
interface QueryState<T extends Document> {
  readonly filter: FilterQuery<T>;
  readonly projection: ProjectionSpec<T> | null;
  readonly sort: SortSpec<T> | null;
  readonly limitVal: number | null;
  readonly skipVal: number | null;
  readonly hintVal: string | null;
  readonly timeoutMs: number | null;
  readonly explainMode: boolean;
}

/**
 * Executor function signature — bridges QueryBuilder to Collection's native calls.
 * @internal
 */
export type QueryExecutor<T extends Document> = {
  find: (filter: FilterQuery<T>, options: FindOptions<T>) => Promise<T[]>;
  count: (filter: FilterQuery<T>) => Promise<number>;
  explain: (filter: FilterQuery<T>, options: FindOptions<T>) => Promise<ExplainPlan>;
  updateMany: (filter: FilterQuery<T>, update: UpdateQuery<T>) => Promise<UpdateResult>;
  deleteMany: (filter: FilterQuery<T>) => Promise<DeleteResult>;
  aggregate: (pipeline: PipelineStage[]) => Promise<Document[]>;
};

// ═══════════════════════════════════════════════════════════════════════
// QUERY BUILDER CLASS
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fluent, immutable, type-safe query builder for Oblivinx3x.
 *
 * Every method that modifies query state returns a **new** QueryBuilder instance,
 * preserving the original unchanged (immutable pattern, like Immutable.js or Immer).
 *
 * @template T - Document type in the target collection
 *
 * @example
 * ```typescript
 * // Basic fluent query
 * const results = await db.collection<User>('users')
 *   .query()
 *   .where('age', '$gte', 18)
 *   .where('address.city', '$eq', 'Jakarta')
 *   .sort('name', 'asc')
 *   .limit(20)
 *   .project({ name: 1, email: 1, age: 1 })
 *   .execute();
 *
 * // Immutability: q1 is unchanged after chaining
 * const q1 = db.collection('users').query();
 * const q2 = q1.where('age', '$gt', 18);
 * q1.toMQL(); // {} — still empty
 * q2.toMQL(); // { age: { $gt: 18 } }
 * ```
 */
export class QueryBuilder<T extends Document> {
  // ─── INTERNAL STATE (immutable per instance) ───────────────────────────

  /** Collection name — used for logging/debugging */
  readonly #collection: string;

  /** Executor bridge to native engine via Collection */
  readonly #executor: QueryExecutor<T>;

  /** Fully frozen query state snapshot */
  readonly #state: Readonly<QueryState<T>>;

  // ─── CONSTRUCTOR ──────────────────────────────────────────────────────

  /**
   * @internal — Create via `Collection.query()`, not directly.
   *
   * @param collection - Collection name
   * @param executor - Execution bridge functions
   * @param state - Initial or cloned query state
   */
  constructor(
    collection: string,
    executor: QueryExecutor<T>,
    state?: Partial<QueryState<T>>,
  ) {
    this.#collection = collection;
    this.#executor = executor;
    this.#state = {
      filter: state?.filter ?? ({} as FilterQuery<T>),
      projection: state?.projection ?? null,
      sort: state?.sort ?? null,
      limitVal: state?.limitVal ?? null,
      skipVal: state?.skipVal ?? null,
      hintVal: state?.hintVal ?? null,
      timeoutMs: state?.timeoutMs ?? null,
      explainMode: state?.explainMode ?? false,
    };
  }

  /**
   * Create a clone with partial state overrides (immutable builder pattern).
   * @internal
   */
  #clone(overrides: Partial<QueryState<T>>): QueryBuilder<T> {
    return new QueryBuilder<T>(this.#collection, this.#executor, {
      ...this.#state,
      ...overrides,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  FILTER OPERATORS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Filter documents by a field using a MQL comparison operator.
   * This method is IMMUTABLE — always returns a new QueryBuilder instance.
   *
   * @param field - Field name (supports dot notation, e.g. "address.city")
   * @param operator - MQL operator: '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' etc.
   * @param value - Value to compare against
   * @returns New QueryBuilder with the filter appended
   *
   * @throws {Error} If operator is invalid
   *
   * @example
   * ```typescript
   * builder.where('age', '$gte', 18).where('age', '$lte', 60);
   * builder.where('address.city', '$eq', 'Jakarta');
   * ```
   */
  where(field: keyof T | string, operator: ComparisonOp, value: unknown): QueryBuilder<T> {
    // Validate operator with O(1) Set lookup
    if (!VALID_COMPARISON_OPS.has(operator)) {
      throw new Error(
        `Invalid comparison operator: '${String(operator)}'. ` +
        `Valid: ${[...VALID_COMPARISON_OPS].join(', ')}`,
      );
    }

    const fieldStr = String(field);

    // Merge with existing filter on same field (e.g. $gte + $lte on 'age')
    const existingFieldFilter = (this.#state.filter as Record<string, unknown>)[fieldStr];
    const mergedField = typeof existingFieldFilter === 'object' && existingFieldFilter !== null
      ? { ...existingFieldFilter as Record<string, unknown>, [operator]: value }
      : { [operator]: value };

    const newFilter = {
      ...this.#state.filter,
      [fieldStr]: mergedField,
    } as FilterQuery<T>;

    return this.#clone({ filter: newFilter });
  }

  /**
   * Filter where field value is in the given array.
   *
   * @param field - Field name
   * @param values - Array of acceptable values
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.whereIn('status', ['active', 'pending']);
   * ```
   */
  whereIn(field: string, values: unknown[]): QueryBuilder<T> {
    return this.where(field, '$in', values);
  }

  /**
   * Filter where field value is NOT in the given array.
   *
   * @param field - Field name
   * @param values - Array of excluded values
   * @returns New QueryBuilder
   */
  whereNotIn(field: string, values: unknown[]): QueryBuilder<T> {
    return this.where(field, '$nin', values);
  }

  /**
   * Filter where field exists (or does not exist).
   *
   * @param field - Field name
   * @param exists - true = field must exist, false = must not exist. Default: true
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.whereExists('email');        // email must exist
   * builder.whereExists('phone', false); // phone must NOT exist
   * ```
   */
  whereExists(field: string, exists: boolean = true): QueryBuilder<T> {
    return this.where(field, '$exists', exists);
  }

  /**
   * Filter where field value is null.
   * Equivalent to `where(field, '$eq', null)`.
   *
   * @param field - Field name
   * @returns New QueryBuilder
   */
  whereNull(field: string): QueryBuilder<T> {
    return this.where(field, '$eq', null);
  }

  /**
   * Filter where field value is NOT null.
   * Equivalent to `where(field, '$ne', null)`.
   *
   * @param field - Field name
   * @returns New QueryBuilder
   */
  whereNotNull(field: string): QueryBuilder<T> {
    return this.where(field, '$ne', null);
  }

  /**
   * Filter where field matches a regex pattern.
   *
   * @param field - Field name
   * @param pattern - Regex pattern string or RegExp
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.whereRegex('email', '^admin@');
   * builder.whereRegex('name', /^ali/i);
   * ```
   */
  whereRegex(field: string, pattern: RegExp | string): QueryBuilder<T> {
    const patternStr = pattern instanceof RegExp ? pattern.source : pattern;
    return this.where(field, '$regex', patternStr);
  }

  /**
   * Filter where field value is between min and max (inclusive).
   * Compiles to: `{ field: { $gte: min, $lte: max } }`.
   *
   * @param field - Field name
   * @param min - Minimum value (inclusive)
   * @param max - Maximum value (inclusive)
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.whereBetween('age', 18, 65);
   * ```
   */
  whereBetween(field: string, min: unknown, max: unknown): QueryBuilder<T> {
    return this.where(field, '$gte', min).where(field, '$lte', max);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  LOGICAL OPERATORS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Combine current filter with additional builders via $and.
   *
   * @param builders - Other QueryBuilder instances whose filters to AND
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * const q1 = col.query().where('age', '$gte', 18);
   * const q2 = col.query().where('active', '$eq', true);
   * const combined = col.query().and(q1, q2);
   * ```
   */
  and(...builders: QueryBuilder<T>[]): QueryBuilder<T> {
    const clauses: FilterQuery<T>[] = [
      this.#state.filter,
      ...builders.map(b => b.toMQL()),
    ].filter(f => Object.keys(f).length > 0);

    if (clauses.length === 0) return this.#clone({});
    if (clauses.length === 1) return this.#clone({ filter: clauses[0] as FilterQuery<T> });

    return this.#clone({
      filter: { $and: clauses } as FilterQuery<T>,
    });
  }

  /**
   * Combine filters via $or.
   *
   * @param builders - Other QueryBuilder instances
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * const q1 = col.query().where('city', '$eq', 'Jakarta');
   * const q2 = col.query().where('city', '$eq', 'Bandung');
   * const result = col.query().or(q1, q2);
   * ```
   */
  or(...builders: QueryBuilder<T>[]): QueryBuilder<T> {
    const clauses = builders.map(b => b.toMQL());
    if (this.#hasFilter()) clauses.unshift(this.#state.filter);

    return this.#clone({
      filter: { $or: clauses } as FilterQuery<T>,
    });
  }

  /**
   * Negate a builder's filter via $not.
   *
   * @param builder - QueryBuilder whose filter to negate
   * @returns New QueryBuilder
   */
  not(builder: QueryBuilder<T>): QueryBuilder<T> {
    return this.#clone({
      filter: {
        ...this.#state.filter,
        $not: builder.toMQL(),
      } as FilterQuery<T>,
    });
  }

  /**
   * Combine filters via $nor — none of the conditions should match.
   *
   * @param builders - Other QueryBuilder instances
   * @returns New QueryBuilder
   */
  nor(...builders: QueryBuilder<T>[]): QueryBuilder<T> {
    const clauses = builders.map(b => b.toMQL());
    return this.#clone({
      filter: {
        ...this.#state.filter,
        $nor: clauses,
      } as FilterQuery<T>,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  ARRAY OPERATORS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Filter where array field contains ALL given values.
   *
   * @param field - Array field name
   * @param values - Values that must all be present
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.whereAll('tags', ['admin', 'active']);
   * ```
   */
  whereAll(field: string, values: unknown[]): QueryBuilder<T> {
    const newFilter = {
      ...this.#state.filter,
      [field]: { $all: values },
    } as FilterQuery<T>;
    return this.#clone({ filter: newFilter });
  }

  /**
   * Filter where array field has exactly N elements.
   *
   * @param field - Array field name
   * @param size - Expected array length
   * @returns New QueryBuilder
   */
  whereSize(field: string, size: number): QueryBuilder<T> {
    const newFilter = {
      ...this.#state.filter,
      [field]: { $size: size },
    } as FilterQuery<T>;
    return this.#clone({ filter: newFilter });
  }

  /**
   * Filter where array contains element matching a sub-filter.
   *
   * @param field - Array field name
   * @param filter - MQL filter for array elements
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.whereElemMatch('items', { qty: { $gte: 5 }, price: { $lt: 100 } });
   * ```
   */
  whereElemMatch(field: string, filter: FilterQuery): QueryBuilder<T> {
    const newFilter = {
      ...this.#state.filter,
      [field]: { $elemMatch: filter },
    } as FilterQuery<T>;
    return this.#clone({ filter: newFilter });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PROJECTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Set projection — include or exclude fields from results.
   *
   * @param spec - Projection map { field: 1 } or { field: 0 }
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.project({ name: 1, email: 1, _id: 0 });
   * ```
   */
  project(spec: ProjectionSpec<T>): QueryBuilder<T> {
    return this.#clone({ projection: spec });
  }

  /**
   * Shorthand: include only the specified fields.
   *
   * @param fields - Field names to include
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.select('name', 'email', 'age');
   * ```
   */
  select(...fields: Array<keyof T | string>): QueryBuilder<T> {
    const spec: Record<string, 1> = {};
    for (const f of fields) spec[String(f)] = 1;
    return this.#clone({ projection: spec as ProjectionSpec<T> });
  }

  /**
   * Shorthand: exclude the specified fields from results.
   *
   * @param fields - Field names to exclude
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.exclude('password', 'token', 'internalNotes');
   * ```
   */
  exclude(...fields: Array<keyof T | string>): QueryBuilder<T> {
    const spec: Record<string, 0> = {};
    for (const f of fields) spec[String(f)] = 0;
    return this.#clone({ projection: spec as ProjectionSpec<T> });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  SORTING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add a sort field. Chainable — multiple calls accumulate sort keys.
   *
   * @param field - Field to sort by
   * @param direction - 'asc' (1) or 'desc' (-1). Default: 'asc'
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.sort('age', 'desc').sort('name', 'asc');
   * ```
   */
  sort(field: string, direction: 'asc' | 'desc' = 'asc'): QueryBuilder<T> {
    const dir: 1 | -1 = direction === 'desc' ? -1 : 1;
    const newSort = {
      ...(this.#state.sort ?? {}),
      [field]: dir,
    } as SortSpec<T>;
    return this.#clone({ sort: newSort });
  }

  /**
   * Set sort from a spec object (replaces any previous sort).
   *
   * @param spec - Sort specification: { field: 1 | -1 }
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.sortBy({ age: -1, name: 1 });
   * ```
   */
  sortBy(spec: SortSpec<T>): QueryBuilder<T> {
    return this.#clone({ sort: spec });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PAGINATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Limit the maximum number of returned documents.
   *
   * @param n - Max documents to return
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.limit(20);
   * ```
   */
  limit(n: number): QueryBuilder<T> {
    return this.#clone({ limitVal: n });
  }

  /**
   * Skip N documents (for offset-based pagination).
   *
   * @param n - Number of documents to skip
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.skip(40); // Skip first 40
   * ```
   */
  skip(n: number): QueryBuilder<T> {
    return this.#clone({ skipVal: n });
  }

  /**
   * Page-based pagination — auto-computes skip from page number.
   *
   * @param pageNumber - 1-based page number
   * @param pageSize - Documents per page
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.page(3, 20); // Page 3 of 20 items = skip 40, limit 20
   * ```
   */
  page(pageNumber: number, pageSize: number): QueryBuilder<T> {
    const skipVal = (pageNumber - 1) * pageSize;
    return this.#clone({ skipVal, limitVal: pageSize });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PERFORMANCE HINTS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Force the query planner to use a specific index.
   *
   * @param indexName - Name of the index (e.g. 'age_1')
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.hint('age_1');
   * ```
   */
  hint(indexName: string): QueryBuilder<T> {
    return this.#clone({ hintVal: indexName });
  }

  /**
   * Set a timeout for query execution.
   *
   * @param ms - Timeout in milliseconds
   * @returns New QueryBuilder
   *
   * @example
   * ```typescript
   * builder.timeout(5000); // 5 second timeout
   * ```
   */
  timeout(ms: number): QueryBuilder<T> {
    return this.#clone({ timeoutMs: ms });
  }

  /**
   * Switch to explain mode — returns query plan instead of results.
   *
   * @returns New QueryBuilder in explain mode
   *
   * @example
   * ```typescript
   * const plan = await builder.where('age', '$gt', 18).explain().execute();
   * ```
   */
  explainMode(): QueryBuilder<T> {
    return this.#clone({ explainMode: true });
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  EXECUTION METHODS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute the query and return all matching documents.
   *
   * @returns Array of matching documents
   *
   * @example
   * ```typescript
   * const users = await builder.where('active', '$eq', true).execute();
   * ```
   */
  async execute(): Promise<T[]> {
    if (this.#state.explainMode) {
      // In explain mode, execute returns the plan as-is cast to T[]
      // Callers should use explain() instead for proper typing
      const plan = await this.#executor.explain(this.#state.filter, this.#buildOptions());
      return [plan as unknown as T];
    }

    return this.#executor.find(this.#state.filter, this.#buildOptions());
  }

  /**
   * Execute the query and return only the first matching document.
   *
   * @returns First matching document, or null
   *
   * @example
   * ```typescript
   * const user = await builder.where('email', '$eq', 'alice@x.com').first();
   * ```
   */
  async first(): Promise<T | null> {
    const results = await this.limit(1).execute();
    return results[0] ?? null;
  }

  /**
   * Count matching documents without returning them.
   *
   * @returns Number of matching documents
   *
   * @example
   * ```typescript
   * const total = await builder.where('active', '$eq', true).count();
   * ```
   */
  async count(): Promise<number> {
    return this.#executor.count(this.#state.filter);
  }

  /**
   * Check if at least one document matches.
   *
   * @returns true if at least one match exists
   *
   * @example
   * ```typescript
   * if (await builder.where('email', '$eq', email).exists()) {
   *   throw new Error('Email taken');
   * }
   * ```
   */
  async exists(): Promise<boolean> {
    return (await this.count()) > 0;
  }

  /**
   * Return an async iterable for streaming results one-by-one.
   *
   * @returns AsyncIterable of documents
   *
   * @example
   * ```typescript
   * for await (const user of builder.where('active', '$eq', true).stream()) {
   *   await processUser(user);
   * }
   * ```
   */
  stream(): AsyncIterable<T> {
    return new Cursor<T>(
      this.#collection,
      this.#state.filter,
      this.#buildOptions(),
      this.#executor.find,
    );
  }

  /**
   * Get the query execution plan (explain output).
   *
   * @returns ExplainPlan with index choice, scan type, cost estimates
   *
   * @example
   * ```typescript
   * const plan = await builder.where('age', '$gt', 18).explain();
   * console.log(plan.scanType); // 'indexScan' or 'collectionScan'
   * ```
   */
  async explain(): Promise<ExplainPlan> {
    return this.#executor.explain(this.#state.filter, this.#buildOptions());
  }

  /**
   * Export the current filter as a raw MQL object (for debugging/logging).
   *
   * @returns MQL filter object
   *
   * @example
   * ```typescript
   * const mql = builder.where('age', '$gte', 18).toMQL();
   * // { age: { $gte: 18 } }
   * ```
   */
  toMQL(): FilterQuery<T> {
    return { ...this.#state.filter };
  }

  /**
   * Export the current query as a SQL-like string (for logging/debugging).
   *
   * @returns SQL-like representation string
   */
  toSQL(): string {
    const parts: string[] = ['SELECT'];

    // Projection
    if (this.#state.projection) {
      const fields = Object.entries(this.#state.projection)
        .filter(([, v]) => v === 1)
        .map(([k]) => k);
      parts.push(fields.length > 0 ? fields.join(', ') : '*');
    } else {
      parts.push('*');
    }

    parts.push('FROM', this.#collection);

    // WHERE
    const filterKeys = Object.keys(this.#state.filter);
    if (filterKeys.length > 0) {
      parts.push('WHERE', JSON.stringify(this.#state.filter));
    }

    // ORDER BY
    if (this.#state.sort) {
      const sortParts = Object.entries(this.#state.sort)
        .map(([k, v]) => `${k} ${v === 1 ? 'ASC' : 'DESC'}`);
      parts.push('ORDER BY', sortParts.join(', '));
    }

    // LIMIT / SKIP
    if (this.#state.limitVal !== null) parts.push('LIMIT', String(this.#state.limitVal));
    if (this.#state.skipVal !== null) parts.push('SKIP', String(this.#state.skipVal));

    return parts.join(' ');
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  AGGREGATION TRANSITION (seamless bridge)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Transition to aggregation mode with a $match stage.
   * Returns an AggregateBuilder that continues from the current filter.
   *
   * @param filter - Additional match filter (merged with current)
   * @returns AggregateBuilder for pipeline construction
   */
  match(filter: FilterQuery<T> = {} as FilterQuery<T>): AggregateBuilder<T> {
    const mergedFilter = { ...this.#state.filter, ...filter } as FilterQuery<T>;
    const agg = new AggregateBuilder<T>(this.#collection, this.#executor.aggregate);
    return agg.match(mergedFilter);
  }

  /**
   * Transition to aggregation mode with a $group stage.
   *
   * @param spec - Group specification
   * @returns AggregateBuilder
   */
  group(spec: { _id: unknown;[key: string]: unknown }): AggregateBuilder<T> {
    const agg = new AggregateBuilder<T>(this.#collection, this.#executor.aggregate);
    if (this.#hasFilter()) agg.match(this.#state.filter);
    return agg.group(spec);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  UPDATE / DELETE SHORTCUTS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Update all documents matching the current filter.
   *
   * @param update - Update expression
   * @returns UpdateResult
   *
   * @example
   * ```typescript
   * await builder.where('active', '$eq', false).updateAll({ $set: { archived: true } });
   * ```
   */
  async updateAll(update: UpdateQuery<T>): Promise<UpdateResult> {
    return this.#executor.updateMany(this.#state.filter, update);
  }

  /**
   * Delete all documents matching the current filter.
   *
   * @returns DeleteResult
   *
   * @example
   * ```typescript
   * await builder.where('expired', '$eq', true).deleteAll();
   * ```
   */
  async deleteAll(): Promise<DeleteResult> {
    return this.#executor.deleteMany(this.#state.filter);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  INTERNAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /** Build FindOptions from current state @internal */
  #buildOptions(): FindOptions<T> {
    const opts: FindOptions<T> = {};
    if (this.#state.projection) opts.projection = this.#state.projection as FindOptions<T>['projection'];
    if (this.#state.sort) opts.sort = this.#state.sort as FindOptions<T>['sort'];
    if (this.#state.limitVal !== null) opts.limit = this.#state.limitVal;
    if (this.#state.skipVal !== null) opts.skip = this.#state.skipVal;
    if (this.#state.hintVal !== null) opts.hint = this.#state.hintVal;
    return opts;
  }

  /** Check if the current filter has any conditions @internal */
  #hasFilter(): boolean {
    return Object.keys(this.#state.filter).length > 0;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// AGGREGATE BUILDER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Fluent builder for MongoDB-compatible aggregation pipelines.
 *
 * Chainable — every method appends a stage and returns `this`.
 *
 * @template T - Base document type
 *
 * @example
 * ```typescript
 * const report = await db.collection('orders')
 *   .query()
 *   .match({ status: 'completed' })
 *   .group({ _id: '$region', total: { $sum: '$amount' } })
 *   .sort('total', 'desc')
 *   .limit(10)
 *   .toArray();
 * ```
 */
export class AggregateBuilder<T extends Document> {
  /** Pipeline stages @internal */
  readonly #stages: PipelineStage[] = [];

  /** Collection name (for diagnostics) @internal */
  readonly #_collection: string;

  /** Aggregate execution function @internal */
  readonly #execute: (pipeline: PipelineStage[]) => Promise<Document[]>;

  /**
   * @internal — Create via QueryBuilder.match() or QueryBuilder.group()
   *
   * @param collection - Collection name
   * @param executeFn - Aggregation executor
   */
  constructor(
    collection: string,
    executeFn: (pipeline: PipelineStage[]) => Promise<Document[]>,
  ) {
    this.#_collection = collection;
    this.#execute = executeFn;
  }

  /**
   * Name of the collection this aggregate builder targets.
   * Useful for logging/debugging.
   */
  get collectionName(): string {
    return this.#_collection;
  }

  /**
   * Add a $match stage to filter documents.
   *
   * @param filter - MQL filter
   * @returns This builder for chaining
   */
  match(filter: FilterQuery<T> | FilterQuery): this {
    this.#stages.push({ $match: filter as FilterQuery });
    return this;
  }

  /**
   * Add a $group stage.
   *
   * @param spec - Group spec with _id and accumulators
   * @returns This builder
   *
   * @example
   * ```typescript
   * .group({ _id: '$city', total: { $sum: '$amount' }, avg: { $avg: '$price' } })
   * ```
   */
  group(spec: { _id: unknown;[key: string]: unknown }): this {
    this.#stages.push({ $group: spec });
    return this;
  }

  /**
   * Add a $project stage.
   *
   * @param spec - Projection specification
   * @returns This builder
   */
  project(spec: Record<string, 0 | 1 | unknown>): this {
    this.#stages.push({ $project: spec });
    return this;
  }

  /**
   * Add a $sort stage.
   *
   * @param field - Field to sort by (or a full sort spec)
   * @param direction - 'asc' or 'desc'
   * @returns This builder
   */
  sort(field: string | Record<string, 1 | -1>, direction?: 'asc' | 'desc'): this {
    if (typeof field === 'string') {
      const dir: 1 | -1 = direction === 'desc' ? -1 : 1;
      this.#stages.push({ $sort: { [field]: dir } });
    } else {
      this.#stages.push({ $sort: field });
    }
    return this;
  }

  /**
   * Add a $limit stage.
   *
   * @param n - Max documents
   * @returns This builder
   */
  limit(n: number): this {
    this.#stages.push({ $limit: n });
    return this;
  }

  /**
   * Add a $skip stage.
   *
   * @param n - Documents to skip
   * @returns This builder
   */
  skip(n: number): this {
    this.#stages.push({ $skip: n });
    return this;
  }

  /**
   * Add a $unwind stage to flatten an array field.
   *
   * @param path - Array field path (e.g. '$items')
   * @param options - Unwind options
   * @returns This builder
   */
  unwind(
    path: string,
    options?: { includeArrayIndex?: string; preserveNullAndEmptyArrays?: boolean },
  ): this {
    if (options) {
      this.#stages.push({ $unwind: { path, ...options } });
    } else {
      this.#stages.push({ $unwind: path });
    }
    return this;
  }

  /**
   * Add a $lookup stage for join operations.
   *
   * @param from - External collection name
   * @param localField - Field in current collection
   * @param foreignField - Field in external collection
   * @param as - Output array field name
   * @returns This builder
   *
   * @example
   * ```typescript
   * .lookup('users', 'userId', '_id', 'user')
   * ```
   */
  lookup(from: string, localField: string, foreignField: string, as: string): this {
    this.#stages.push({ $lookup: { from, localField, foreignField, as } });
    return this;
  }

  /**
   * Add a $count stage.
   *
   * @param field - Output field name for the count
   * @returns This builder
   */
  count(field: string): this {
    this.#stages.push({ $count: field });
    return this;
  }

  /**
   * Add a raw pipeline stage (for stages not covered by named methods).
   *
   * @param stage - Raw pipeline stage object
   * @returns This builder
   */
  addStage(stage: PipelineStage): this {
    this.#stages.push(stage);
    return this;
  }

  /**
   * Get the built pipeline as an array of stages.
   *
   * @returns Pipeline stage array
   */
  toPipeline(): PipelineStage[] {
    return [...this.#stages];
  }

  /**
   * Execute the aggregation pipeline.
   *
   * @returns Array of result documents
   *
   * @example
   * ```typescript
   * const results = await agg
   *   .match({ status: 'active' })
   *   .group({ _id: '$region', total: { $sum: 1 } })
   *   .toArray();
   * ```
   */
  async toArray(): Promise<Document[]> {
    return this.#execute(this.#stages);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CURSOR — ASYNC ITERABLE FOR STREAMING
// ═══════════════════════════════════════════════════════════════════════

/**
 * Async Cursor for streaming query results.
 *
 * Implements AsyncIterable for `for await...of` iteration.
 * Fetches results in batches to avoid loading everything into memory.
 *
 * @template T - Document type
 *
 * @example
 * ```typescript
 * const cursor = users.query()
 *   .where('active', '$eq', true)
 *   .stream();
 *
 * for await (const user of cursor) {
 *   console.log(user.name);
 * }
 * ```
 */
export class Cursor<T extends Document> implements AsyncIterable<T> {
  /** Filter to apply @internal */
  readonly #filter: FilterQuery<T>;

  /** Base query options @internal */
  readonly #options: FindOptions<T>;

  /** Find execution function @internal */
  readonly #findFn: (filter: FilterQuery<T>, options: FindOptions<T>) => Promise<T[]>;

  /** Batch size for fetching @internal */
  readonly #batchSize: number;

  /** Current buffer of fetched documents @internal */
  #buffer: T[] = [];

  /** Current index within buffer @internal */
  #index = 0;

  /** Running skip offset @internal */
  #skip: number;

  /** True when no more batches available @internal */
  #done = false;

  /**
   * @param _collectionName - Collection name (for diagnostics)
   * @param filter - MQL filter to apply
   * @param options - FindOptions (projection, sort, etc.)
   * @param findFn - Function that executes the find
   * @param cursorOptions - Batching options
   */
  constructor(
    _collectionName: string,
    filter: FilterQuery<T>,
    options: FindOptions<T>,
    findFn: (filter: FilterQuery<T>, options: FindOptions<T>) => Promise<T[]>,
    cursorOptions?: CursorOptions,
  ) {
    this.#filter = filter;
    this.#options = options;
    this.#findFn = findFn;
    this.#batchSize = cursorOptions?.batchSize ?? 100;
    this.#skip = options.skip ?? 0;
  }

  /**
   * Fetch the next batch of results from native engine.
   * @internal
   */
  async #nextBatch(): Promise<boolean> {
    if (this.#done) return false;

    const batchOptions: FindOptions<T> = {
      ...this.#options,
      limit: this.#batchSize,
      skip: this.#skip,
    };

    const results = await this.#findFn(this.#filter, batchOptions);

    if (results.length === 0) {
      this.#done = true;
      return false;
    }

    this.#buffer = results;
    this.#index = 0;
    this.#skip += results.length;

    // If we got fewer than batchSize, this is the last batch
    if (results.length < this.#batchSize) {
      this.#done = true;
    }

    return true;
  }

  /**
   * Async iterator implementation.
   */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.#index >= this.#buffer.length) {
        const hasMore = await this.#nextBatch();
        if (!hasMore) return;
      }

      const doc = this.#buffer[this.#index++];
      if (doc !== undefined) yield doc;
    }
  }

  /**
   * Collect all results into an in-memory array.
   * Use with caution for large result sets.
   *
   * @returns Array of all matching documents
   */
  async toArray(): Promise<T[]> {
    const results: T[] = [];
    for await (const doc of this) {
      results.push(doc);
    }
    return results;
  }

  /**
   * Process documents in batches.
   *
   * @param size - Batch size
   * @returns async iterable of document arrays
   *
   * @example
   * ```typescript
   * for await (const batch of cursor.batch(100)) {
   *   await processBatch(batch);
   * }
   * ```
   */
  async *batch(size: number): AsyncIterable<T[]> {
    let currentBatch: T[] = [];
    for await (const doc of this) {
      currentBatch.push(doc);
      if (currentBatch.length >= size) {
        yield currentBatch;
        currentBatch = [];
      }
    }
    if (currentBatch.length > 0) yield currentBatch;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// HELPER FACTORY — for backward compatibility with Collection
// ═══════════════════════════════════════════════════════════════════════

/**
 * Create a Cursor pre-loaded with results (used by aggregateWithCursor).
 *
 * @param results - Pre-fetched result array
 * @returns Cursor wrapping the results
 * @internal
 */
export function createCursor<T extends Document>(results: T[]): Cursor<T> {
  // Return a specialized cursor pre-loaded with results (no native fetching)
  return new PreloadedCursor<T>(results);
}

/**
 * Cursor that wraps pre-loaded results (no native fetching).
 * @internal
 */
class PreloadedCursor<T extends Document> extends Cursor<T> {
  readonly #results: T[];

  constructor(results: T[]) {
    // Parent constructor with noop find
    super('__preloaded__', {} as FilterQuery<T>, {}, async () => []);
    this.#results = results;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (const doc of this.#results) {
      yield doc;
    }
  }

  async toArray(): Promise<T[]> {
    return [...this.#results];
  }
}
