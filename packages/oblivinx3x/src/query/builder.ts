/**
 * @module query/builder
 * 
 * Fluent Query Builder for Oblivinx3x.
 * 
 * Chainable, type-safe query construction with MongoDB-like syntax.
 * 
 * @packageDocumentation
 */

import type { Document, FilterQuery, FindOptions, ExplainPlan } from '../types/index.js';

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
export class QueryBuilder<T extends Document> {
  readonly #collectionName: string;
  readonly #execute: (
    filter: FilterQuery<T>,
    options?: FindOptions<T>,
    mode?: QueryMode
  ) => Promise<unknown>;

  #filter: FilterQuery<T> = {};
  #options: Partial<FindOptions<T>> = {};
  #mode: QueryMode = 'find';

  /**
   * @internal — Created via Collection.find()
   */
  constructor(
    collectionName: string,
    executeFn: (
      filter: FilterQuery<T>,
      options?: FindOptions<T>,
      mode?: QueryMode
    ) => Promise<unknown>
  ) {
    this.#collectionName = collectionName;
    this.#execute = executeFn;
  }

  /**
   * Add filter conditions (equivalent to MongoDB .find(filter)).
   *
   * @param filter - MongoDB-compatible query filter
   * @returns This builder for chaining
   */
  where(filter: FilterQuery<T>): this {
    this.#filter = { ...this.#filter, ...filter };
    return this;
  }

  /**
   * Set projection — include or exclude fields.
   *
   * @param projection - Field inclusion/exclusion map
   * @returns This builder for chaining
   */
  project(projection: { [K in keyof T]?: 0 | 1 } & Record<string, 0 | 1>): this {
    this.#options.projection = projection;
    return this;
  }

  /**
   * Set sort order.
   *
   * @param sort - Field to direction map (1 = asc, -1 = desc)
   * @returns This builder for chaining
   */
  sort(sort: { [K in keyof T]?: 1 | -1 } & Record<string, 1 | -1>): this {
    this.#options.sort = sort;
    return this;
  }

  /**
   * Limit the number of returned documents.
   *
   * @param n - Maximum documents to return
   * @returns This builder for chaining
   */
  limit(n: number): this {
    this.#options.limit = n;
    return this;
  }

  /**
   * Skip N documents (for pagination).
   *
   * @param n - Number of documents to skip
   * @returns This builder for chaining
   */
  skip(n: number): this {
    this.#options.skip = n;
    return this;
  }

  /**
   * Hint the query planner to use a specific index.
   *
   * @param indexName - Name of the index to use
   * @returns This builder for chaining
   */
  hint(indexName: string): this {
    // Store hint for planner integration
    (this.#options as Record<string, unknown>).hint = indexName;
    return this;
  }

  /**
   * Set query mode to return execution plan instead of results.
   *
   * @returns This builder for chaining
   */
  explain(): this {
    this.#mode = 'explain';
    return this;
  }

  /**
   * Execute the query and return results as an array.
   *
   * @returns Array of matching documents, or ExplainPlan if explain() was called
   */
  async toArray(): Promise<T[] | ExplainPlan> {
    const result = await this.#execute(
      this.#filter,
      this.#options as FindOptions<T>,
      this.#mode
    );
    return result as T[] | ExplainPlan;
  }

  /**
   * Execute the query and return the first document.
   *
   * @returns First matching document, or null
   */
  async one(): Promise<T | null> {
    this.#options.limit = 1;
    const results = await this.toArray();
    return (results as T[])?.[0] ?? null;
  }

  /**
   * Count matching documents.
   *
   * @param options - Count options (limit, skip)
   * @returns Number of matching documents
   */
  async count(options?: { limit?: number; skip?: number }): Promise<number> {
    const countOptions = {
      ...this.#options,
      limit: options?.limit ?? this.#options.limit,
      skip: options?.skip ?? this.#options.skip,
    };

    const result = await this.#execute(
      this.#filter,
      countOptions,
      'count'
    );
    return result as number;
  }

  /**
   * Return a cursor for streaming large result sets.
   *
   * @param options - Cursor configuration
   * @returns Async cursor for iteration
   */
  cursor(options?: CursorOptions): Cursor<T> {
    return new Cursor<T>(
      this.#collectionName,
      this.#filter,
      this.#options as FindOptions<T>,
      this.#execute,
      options
    );
  }
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
export class Cursor<T extends Document> implements AsyncIterable<T> {
  readonly #filter: FilterQuery<T>;
  readonly #options?: FindOptions<T>;
  readonly #execute: (
    filter: FilterQuery<T>,
    options?: FindOptions<T>
  ) => Promise<unknown>;
  readonly #batchSize: number;

  #buffer: T[] = [];
  #index = 0;
  #skip = 0;
  #done = false;

  constructor(
    _collectionName: string,
    filter: FilterQuery<T>,
    options: FindOptions<T> | undefined,
    executeFn: (
      filter: FilterQuery<T>,
      options?: FindOptions<T>
    ) => Promise<unknown>,
    cursorOptions?: CursorOptions
  ) {
    this.#filter = filter;
    this.#options = options;
    this.#execute = executeFn;
    this.#batchSize = cursorOptions?.batchSize ?? 100;
  }

  /**
   * Fetch the next batch of results.
   */
  async #nextBatch(): Promise<boolean> {
    if (this.#done) return false;

    const batchOptions = this.#options
      ? { ...this.#options, limit: this.#batchSize, skip: this.#skip }
      : { limit: this.#batchSize, skip: this.#skip };

    const results = await this.#execute(
      this.#filter,
      batchOptions
    ) as T[];

    if (results.length === 0) {
      this.#done = true;
      return false;
    }

    this.#buffer = results;
    this.#index = 0;
    this.#skip += results.length;
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

      yield this.#buffer[this.#index++] as T;
    }
  }

  /**
   * Convert all results to an array (loads everything into memory).
   * Use with caution for large datasets.
   */
  async toArray(): Promise<T[]> {
    const results: T[] = [];
    for await (const doc of this) {
      results.push(doc);
    }
    return results;
  }

  /**
   * Count total matching documents.
   */
  async count(): Promise<number> {
    const results = await this.#execute(this.#filter, undefined) as T[];
    return results.length;
  }
}
