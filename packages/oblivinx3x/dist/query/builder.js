/**
 * @module query/builder
 *
 * Fluent Query Builder for Oblivinx3x.
 *
 * Chainable, type-safe query construction with MongoDB-like syntax.
 *
 * @packageDocumentation
 */
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
export class QueryBuilder {
    #collectionName;
    #execute;
    #filter = {};
    #options = {};
    #mode = 'find';
    /**
     * @internal — Created via Collection.find()
     */
    constructor(collectionName, executeFn) {
        this.#collectionName = collectionName;
        this.#execute = executeFn;
    }
    /**
     * Add filter conditions (equivalent to MongoDB .find(filter)).
     *
     * @param filter - MongoDB-compatible query filter
     * @returns This builder for chaining
     */
    where(filter) {
        this.#filter = { ...this.#filter, ...filter };
        return this;
    }
    /**
     * Set projection — include or exclude fields.
     *
     * @param projection - Field inclusion/exclusion map
     * @returns This builder for chaining
     */
    project(projection) {
        this.#options.projection = projection;
        return this;
    }
    /**
     * Set sort order.
     *
     * @param sort - Field to direction map (1 = asc, -1 = desc)
     * @returns This builder for chaining
     */
    sort(sort) {
        this.#options.sort = sort;
        return this;
    }
    /**
     * Limit the number of returned documents.
     *
     * @param n - Maximum documents to return
     * @returns This builder for chaining
     */
    limit(n) {
        this.#options.limit = n;
        return this;
    }
    /**
     * Skip N documents (for pagination).
     *
     * @param n - Number of documents to skip
     * @returns This builder for chaining
     */
    skip(n) {
        this.#options.skip = n;
        return this;
    }
    /**
     * Hint the query planner to use a specific index.
     *
     * @param indexName - Name of the index to use
     * @returns This builder for chaining
     */
    hint(indexName) {
        // Store hint for future planner integration
        this.#options.hint = indexName;
        return this;
    }
    /**
     * Set query mode to return execution plan instead of results.
     *
     * @returns This builder for chaining
     */
    explain() {
        this.#mode = 'explain';
        return this;
    }
    /**
     * Execute the query and return results as an array.
     *
     * @returns Array of matching documents
     */
    async toArray() {
        const result = await this.#execute(this.#filter, this.#options, this.#mode);
        return result;
    }
    /**
     * Execute the query and return the first document.
     *
     * @returns First matching document, or null
     */
    async one() {
        this.#options.limit = 1;
        const results = await this.toArray();
        return results[0] ?? null;
    }
    /**
     * Count matching documents.
     *
     * @returns Number of matching documents
     */
    async count() {
        const result = await this.#execute(this.#filter, undefined, 'count');
        return result;
    }
    /**
     * Return a cursor for streaming large result sets.
     *
     * @param options - Cursor configuration
     * @returns Async cursor for iteration
     */
    cursor(options) {
        return new Cursor(this.#collectionName, this.#filter, this.#options, this.#execute, options);
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
export class Cursor {
    #filter;
    #options;
    #execute;
    #batchSize;
    #buffer = [];
    #index = 0;
    #skip = 0;
    #done = false;
    constructor(_collectionName, filter, options, executeFn, cursorOptions) {
        this.#filter = filter;
        this.#options = options;
        this.#execute = executeFn;
        this.#batchSize = cursorOptions?.batchSize ?? 100;
    }
    /**
     * Fetch the next batch of results.
     */
    async #nextBatch() {
        if (this.#done)
            return false;
        const batchOptions = this.#options
            ? { ...this.#options, limit: this.#batchSize, skip: this.#skip }
            : { limit: this.#batchSize, skip: this.#skip };
        const results = await this.#execute(this.#filter, batchOptions);
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
    async *[Symbol.asyncIterator]() {
        while (true) {
            if (this.#index >= this.#buffer.length) {
                const hasMore = await this.#nextBatch();
                if (!hasMore)
                    return;
            }
            yield this.#buffer[this.#index++];
        }
    }
    /**
     * Convert all results to an array (loads everything into memory).
     * Use with caution for large datasets.
     */
    async toArray() {
        const results = [];
        for await (const doc of this) {
            results.push(doc);
        }
        return results;
    }
    /**
     * Count total matching documents.
     */
    async count() {
        const results = await this.#execute(this.#filter, undefined);
        return results.length;
    }
}
//# sourceMappingURL=builder.js.map