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
import type { Document, FilterQuery, FindOptions, UpdateQuery, UpdateResult, DeleteResult, ExplainPlan, PipelineStage } from '../types/index.js';
/** Comparison operators for the where() method */
export type ComparisonOp = '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in' | '$nin' | '$exists' | '$regex' | '$type';
/** Projection spec — 1 to include, 0 to exclude */
export type ProjectionSpec<T extends Document> = {
    [K in keyof T]?: 0 | 1;
} & Record<string, 0 | 1>;
/** Sort spec map */
export type SortSpec<T extends Document> = {
    [K in keyof T]?: 1 | -1;
} & Record<string, 1 | -1>;
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
export declare class QueryBuilder<T extends Document> {
    #private;
    /**
     * @internal — Create via `Collection.query()`, not directly.
     *
     * @param collection - Collection name
     * @param executor - Execution bridge functions
     * @param state - Initial or cloned query state
     */
    constructor(collection: string, executor: QueryExecutor<T>, state?: Partial<QueryState<T>>);
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
    where(field: keyof T | string, operator: ComparisonOp, value: unknown): QueryBuilder<T>;
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
    whereIn(field: string, values: unknown[]): QueryBuilder<T>;
    /**
     * Filter where field value is NOT in the given array.
     *
     * @param field - Field name
     * @param values - Array of excluded values
     * @returns New QueryBuilder
     */
    whereNotIn(field: string, values: unknown[]): QueryBuilder<T>;
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
    whereExists(field: string, exists?: boolean): QueryBuilder<T>;
    /**
     * Filter where field value is null.
     * Equivalent to `where(field, '$eq', null)`.
     *
     * @param field - Field name
     * @returns New QueryBuilder
     */
    whereNull(field: string): QueryBuilder<T>;
    /**
     * Filter where field value is NOT null.
     * Equivalent to `where(field, '$ne', null)`.
     *
     * @param field - Field name
     * @returns New QueryBuilder
     */
    whereNotNull(field: string): QueryBuilder<T>;
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
    whereRegex(field: string, pattern: RegExp | string): QueryBuilder<T>;
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
    whereBetween(field: string, min: unknown, max: unknown): QueryBuilder<T>;
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
    and(...builders: QueryBuilder<T>[]): QueryBuilder<T>;
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
    or(...builders: QueryBuilder<T>[]): QueryBuilder<T>;
    /**
     * Negate a builder's filter via $not.
     *
     * @param builder - QueryBuilder whose filter to negate
     * @returns New QueryBuilder
     */
    not(builder: QueryBuilder<T>): QueryBuilder<T>;
    /**
     * Combine filters via $nor — none of the conditions should match.
     *
     * @param builders - Other QueryBuilder instances
     * @returns New QueryBuilder
     */
    nor(...builders: QueryBuilder<T>[]): QueryBuilder<T>;
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
    whereAll(field: string, values: unknown[]): QueryBuilder<T>;
    /**
     * Filter where array field has exactly N elements.
     *
     * @param field - Array field name
     * @param size - Expected array length
     * @returns New QueryBuilder
     */
    whereSize(field: string, size: number): QueryBuilder<T>;
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
    whereElemMatch(field: string, filter: FilterQuery): QueryBuilder<T>;
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
    project(spec: ProjectionSpec<T>): QueryBuilder<T>;
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
    select(...fields: Array<keyof T | string>): QueryBuilder<T>;
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
    exclude(...fields: Array<keyof T | string>): QueryBuilder<T>;
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
    sort(field: string, direction?: 'asc' | 'desc'): QueryBuilder<T>;
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
    sortBy(spec: SortSpec<T>): QueryBuilder<T>;
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
    limit(n: number): QueryBuilder<T>;
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
    skip(n: number): QueryBuilder<T>;
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
    page(pageNumber: number, pageSize: number): QueryBuilder<T>;
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
    hint(indexName: string): QueryBuilder<T>;
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
    timeout(ms: number): QueryBuilder<T>;
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
    explainMode(): QueryBuilder<T>;
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
    execute(): Promise<T[]>;
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
    first(): Promise<T | null>;
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
    count(): Promise<number>;
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
    exists(): Promise<boolean>;
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
    stream(): AsyncIterable<T>;
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
    explain(): Promise<ExplainPlan>;
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
    toMQL(): FilterQuery<T>;
    /**
     * Export the current query as a SQL-like string (for logging/debugging).
     *
     * @returns SQL-like representation string
     */
    toSQL(): string;
    /**
     * Transition to aggregation mode with a $match stage.
     * Returns an AggregateBuilder that continues from the current filter.
     *
     * @param filter - Additional match filter (merged with current)
     * @returns AggregateBuilder for pipeline construction
     */
    match(filter?: FilterQuery<T>): AggregateBuilder<T>;
    /**
     * Transition to aggregation mode with a $group stage.
     *
     * @param spec - Group specification
     * @returns AggregateBuilder
     */
    group(spec: {
        _id: unknown;
        [key: string]: unknown;
    }): AggregateBuilder<T>;
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
    updateAll(update: UpdateQuery<T>): Promise<UpdateResult>;
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
    deleteAll(): Promise<DeleteResult>;
}
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
export declare class AggregateBuilder<T extends Document> {
    #private;
    /**
     * @internal — Create via QueryBuilder.match() or QueryBuilder.group()
     *
     * @param collection - Collection name
     * @param executeFn - Aggregation executor
     */
    constructor(collection: string, executeFn: (pipeline: PipelineStage[]) => Promise<Document[]>);
    /**
     * Name of the collection this aggregate builder targets.
     * Useful for logging/debugging.
     */
    get collectionName(): string;
    /**
     * Add a $match stage to filter documents.
     *
     * @param filter - MQL filter
     * @returns This builder for chaining
     */
    match(filter: FilterQuery<T> | FilterQuery): this;
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
    group(spec: {
        _id: unknown;
        [key: string]: unknown;
    }): this;
    /**
     * Add a $project stage.
     *
     * @param spec - Projection specification
     * @returns This builder
     */
    project(spec: Record<string, 0 | 1 | unknown>): this;
    /**
     * Add a $sort stage.
     *
     * @param field - Field to sort by (or a full sort spec)
     * @param direction - 'asc' or 'desc'
     * @returns This builder
     */
    sort(field: string | Record<string, 1 | -1>, direction?: 'asc' | 'desc'): this;
    /**
     * Add a $limit stage.
     *
     * @param n - Max documents
     * @returns This builder
     */
    limit(n: number): this;
    /**
     * Add a $skip stage.
     *
     * @param n - Documents to skip
     * @returns This builder
     */
    skip(n: number): this;
    /**
     * Add a $unwind stage to flatten an array field.
     *
     * @param path - Array field path (e.g. '$items')
     * @param options - Unwind options
     * @returns This builder
     */
    unwind(path: string, options?: {
        includeArrayIndex?: string;
        preserveNullAndEmptyArrays?: boolean;
    }): this;
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
    lookup(from: string, localField: string, foreignField: string, as: string): this;
    /**
     * Add a $count stage.
     *
     * @param field - Output field name for the count
     * @returns This builder
     */
    count(field: string): this;
    /**
     * Add a raw pipeline stage (for stages not covered by named methods).
     *
     * @param stage - Raw pipeline stage object
     * @returns This builder
     */
    addStage(stage: PipelineStage): this;
    /**
     * Get the built pipeline as an array of stages.
     *
     * @returns Pipeline stage array
     */
    toPipeline(): PipelineStage[];
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
    toArray(): Promise<Document[]>;
}
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
export declare class Cursor<T extends Document> implements AsyncIterable<T> {
    #private;
    /**
     * @param _collectionName - Collection name (for diagnostics)
     * @param filter - MQL filter to apply
     * @param options - FindOptions (projection, sort, etc.)
     * @param findFn - Function that executes the find
     * @param cursorOptions - Batching options
     */
    constructor(_collectionName: string, filter: FilterQuery<T>, options: FindOptions<T>, findFn: (filter: FilterQuery<T>, options: FindOptions<T>) => Promise<T[]>, cursorOptions?: CursorOptions);
    /**
     * Async iterator implementation.
     */
    [Symbol.asyncIterator](): AsyncIterator<T>;
    /**
     * Collect all results into an in-memory array.
     * Use with caution for large result sets.
     *
     * @returns Array of all matching documents
     */
    toArray(): Promise<T[]>;
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
    batch(size: number): AsyncIterable<T[]>;
}
/**
 * Create a Cursor pre-loaded with results (used by aggregateWithCursor).
 *
 * @param results - Pre-fetched result array
 * @returns Cursor wrapping the results
 * @internal
 */
export declare function createCursor<T extends Document>(results: T[]): Cursor<T>;
export {};
//# sourceMappingURL=builder.d.ts.map