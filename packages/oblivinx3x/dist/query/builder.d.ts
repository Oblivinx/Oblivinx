/**
 * @module query/builder
 *
 * Fluent Query Builder for Oblivinx3x.
 *
 * Chainable, type-safe query construction with MongoDB-like syntax.
 *
 * @packageDocumentation
 */
import type { Document, FilterQuery, FindOptions } from '../types/index.js';
/** Query execution mode */
type QueryMode = 'find' | 'count' | 'explain';
/** Cursor options for streaming */
export interface CursorOptions {
    batchSize?: number;
    timeoutMs?: number;
}
/**
 * Fluent Query Builder — chainable query construction.
 *
 * @example
 * ```typescript
 * const users = db.collection<User>('users');
 *
 * const results = await users.find()
 *   .where({ age: { $gte: 18 } })
 *   .project({ name: 1, email: 1 })
 *   .sort({ name: 1 })
 *   .limit(20)
 *   .skip(10)
 *   .toArray();
 * ```
 */
export declare class QueryBuilder<T extends Document> {
    #private;
    /**
     * @internal — Created via Collection.find()
     */
    constructor(collectionName: string, executeFn: (filter: FilterQuery<T>, options?: FindOptions<T>, mode?: QueryMode) => Promise<unknown>);
    /**
     * Add filter conditions (equivalent to MongoDB .find(filter)).
     *
     * @param filter - MongoDB-compatible query filter
     * @returns This builder for chaining
     */
    where(filter: FilterQuery<T>): this;
    /**
     * Set projection — include or exclude fields.
     *
     * @param projection - Field inclusion/exclusion map
     * @returns This builder for chaining
     */
    project(projection: {
        [K in keyof T]?: 0 | 1;
    } & Record<string, 0 | 1>): this;
    /**
     * Set sort order.
     *
     * @param sort - Field to direction map (1 = asc, -1 = desc)
     * @returns This builder for chaining
     */
    sort(sort: {
        [K in keyof T]?: 1 | -1;
    } & Record<string, 1 | -1>): this;
    /**
     * Limit the number of returned documents.
     *
     * @param n - Maximum documents to return
     * @returns This builder for chaining
     */
    limit(n: number): this;
    /**
     * Skip N documents (for pagination).
     *
     * @param n - Number of documents to skip
     * @returns This builder for chaining
     */
    skip(n: number): this;
    /**
     * Hint the query planner to use a specific index.
     *
     * @param indexName - Name of the index to use
     * @returns This builder for chaining
     */
    hint(indexName: string): this;
    /**
     * Set query mode to return execution plan instead of results.
     *
     * @returns This builder for chaining
     */
    explain(): this;
    /**
     * Execute the query and return results as an array.
     *
     * @returns Array of matching documents
     */
    toArray(): Promise<T[]>;
    /**
     * Execute the query and return the first document.
     *
     * @returns First matching document, or null
     */
    one(): Promise<T | null>;
    /**
     * Count matching documents.
     *
     * @returns Number of matching documents
     */
    count(): Promise<number>;
    /**
     * Return a cursor for streaming large result sets.
     *
     * @param options - Cursor configuration
     * @returns Async cursor for iteration
     */
    cursor(options?: CursorOptions): Cursor<T>;
}
/**
 * Async Cursor for streaming query results.
 *
 * Implements AsyncIterable for `for await...of` iteration.
 *
 * @example
 * ```typescript
 * const cursor = users.find().where({ active: true }).cursor({ batchSize: 100 });
 *
 * for await (const user of cursor) {
 *   console.log(user.name);
 * }
 * ```
 */
export declare class Cursor<T extends Document> implements AsyncIterable<T> {
    #private;
    constructor(_collectionName: string, filter: FilterQuery<T>, options: FindOptions<T> | undefined, executeFn: (filter: FilterQuery<T>, options?: FindOptions<T>) => Promise<unknown>, cursorOptions?: CursorOptions);
    /**
     * Async iterator implementation.
     */
    [Symbol.asyncIterator](): AsyncIterator<T>;
    /**
     * Convert all results to an array (loads everything into memory).
     * Use with caution for large datasets.
     */
    toArray(): Promise<T[]>;
    /**
     * Count total matching documents.
     */
    count(): Promise<number>;
}
export {};
//# sourceMappingURL=builder.d.ts.map