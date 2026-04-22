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
var _a;
// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS — VALID OPERATORS
// ═══════════════════════════════════════════════════════════════════════
/**
 * Valid MQL comparison operators for `where()`.
 * Using a Set for O(1) lookup during validation.
 * @internal
 */
const VALID_COMPARISON_OPS = new Set([
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
    '$in', '$nin', '$exists', '$regex', '$type',
]);
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
export class QueryBuilder {
    // ─── INTERNAL STATE (immutable per instance) ───────────────────────────
    /** Collection name — used for logging/debugging */
    #collection;
    /** Executor bridge to native engine via Collection */
    #executor;
    /** Fully frozen query state snapshot */
    #state;
    // ─── CONSTRUCTOR ──────────────────────────────────────────────────────
    /**
     * @internal — Create via `Collection.query()`, not directly.
     *
     * @param collection - Collection name
     * @param executor - Execution bridge functions
     * @param state - Initial or cloned query state
     */
    constructor(collection, executor, state) {
        this.#collection = collection;
        this.#executor = executor;
        this.#state = {
            filter: state?.filter ?? {},
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
    #clone(overrides) {
        return new _a(this.#collection, this.#executor, {
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
    where(field, operator, value) {
        // Validate operator with O(1) Set lookup
        if (!VALID_COMPARISON_OPS.has(operator)) {
            throw new Error(`Invalid comparison operator: '${String(operator)}'. ` +
                `Valid: ${[...VALID_COMPARISON_OPS].join(', ')}`);
        }
        const fieldStr = String(field);
        // Merge with existing filter on same field (e.g. $gte + $lte on 'age')
        const existingFieldFilter = this.#state.filter[fieldStr];
        const mergedField = typeof existingFieldFilter === 'object' && existingFieldFilter !== null
            ? { ...existingFieldFilter, [operator]: value }
            : { [operator]: value };
        const newFilter = {
            ...this.#state.filter,
            [fieldStr]: mergedField,
        };
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
    whereIn(field, values) {
        return this.where(field, '$in', values);
    }
    /**
     * Filter where field value is NOT in the given array.
     *
     * @param field - Field name
     * @param values - Array of excluded values
     * @returns New QueryBuilder
     */
    whereNotIn(field, values) {
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
    whereExists(field, exists = true) {
        return this.where(field, '$exists', exists);
    }
    /**
     * Filter where field value is null.
     * Equivalent to `where(field, '$eq', null)`.
     *
     * @param field - Field name
     * @returns New QueryBuilder
     */
    whereNull(field) {
        return this.where(field, '$eq', null);
    }
    /**
     * Filter where field value is NOT null.
     * Equivalent to `where(field, '$ne', null)`.
     *
     * @param field - Field name
     * @returns New QueryBuilder
     */
    whereNotNull(field) {
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
    whereRegex(field, pattern) {
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
    whereBetween(field, min, max) {
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
    and(...builders) {
        const clauses = [
            this.#state.filter,
            ...builders.map(b => b.toMQL()),
        ].filter(f => Object.keys(f).length > 0);
        if (clauses.length === 0)
            return this.#clone({});
        if (clauses.length === 1)
            return this.#clone({ filter: clauses[0] });
        return this.#clone({
            filter: { $and: clauses },
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
    or(...builders) {
        const clauses = builders.map(b => b.toMQL());
        if (this.#hasFilter())
            clauses.unshift(this.#state.filter);
        return this.#clone({
            filter: { $or: clauses },
        });
    }
    /**
     * Negate a builder's filter via $not.
     *
     * @param builder - QueryBuilder whose filter to negate
     * @returns New QueryBuilder
     */
    not(builder) {
        return this.#clone({
            filter: {
                ...this.#state.filter,
                $not: builder.toMQL(),
            },
        });
    }
    /**
     * Combine filters via $nor — none of the conditions should match.
     *
     * @param builders - Other QueryBuilder instances
     * @returns New QueryBuilder
     */
    nor(...builders) {
        const clauses = builders.map(b => b.toMQL());
        return this.#clone({
            filter: {
                ...this.#state.filter,
                $nor: clauses,
            },
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
    whereAll(field, values) {
        const newFilter = {
            ...this.#state.filter,
            [field]: { $all: values },
        };
        return this.#clone({ filter: newFilter });
    }
    /**
     * Filter where array field has exactly N elements.
     *
     * @param field - Array field name
     * @param size - Expected array length
     * @returns New QueryBuilder
     */
    whereSize(field, size) {
        const newFilter = {
            ...this.#state.filter,
            [field]: { $size: size },
        };
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
    whereElemMatch(field, filter) {
        const newFilter = {
            ...this.#state.filter,
            [field]: { $elemMatch: filter },
        };
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
    project(spec) {
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
    select(...fields) {
        const spec = {};
        for (const f of fields)
            spec[String(f)] = 1;
        return this.#clone({ projection: spec });
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
    exclude(...fields) {
        const spec = {};
        for (const f of fields)
            spec[String(f)] = 0;
        return this.#clone({ projection: spec });
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
    sort(field, direction = 'asc') {
        const dir = direction === 'desc' ? -1 : 1;
        const newSort = {
            ...(this.#state.sort ?? {}),
            [field]: dir,
        };
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
    sortBy(spec) {
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
    limit(n) {
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
    skip(n) {
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
    page(pageNumber, pageSize) {
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
    hint(indexName) {
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
    timeout(ms) {
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
    explainMode() {
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
    async execute() {
        if (this.#state.explainMode) {
            // In explain mode, execute returns the plan as-is cast to T[]
            // Callers should use explain() instead for proper typing
            const plan = await this.#executor.explain(this.#state.filter, this.#buildOptions());
            return [plan];
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
    async first() {
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
    async count() {
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
    async exists() {
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
    stream() {
        return new Cursor(this.#collection, this.#state.filter, this.#buildOptions(), this.#executor.find);
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
    async explain() {
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
    toMQL() {
        return { ...this.#state.filter };
    }
    /**
     * Export the current query as a SQL-like string (for logging/debugging).
     *
     * @returns SQL-like representation string
     */
    toSQL() {
        const parts = ['SELECT'];
        // Projection
        if (this.#state.projection) {
            const fields = Object.entries(this.#state.projection)
                .filter(([, v]) => v === 1)
                .map(([k]) => k);
            parts.push(fields.length > 0 ? fields.join(', ') : '*');
        }
        else {
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
        if (this.#state.limitVal !== null)
            parts.push('LIMIT', String(this.#state.limitVal));
        if (this.#state.skipVal !== null)
            parts.push('SKIP', String(this.#state.skipVal));
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
    match(filter = {}) {
        const mergedFilter = { ...this.#state.filter, ...filter };
        const agg = new AggregateBuilder(this.#collection, this.#executor.aggregate);
        return agg.match(mergedFilter);
    }
    /**
     * Transition to aggregation mode with a $group stage.
     *
     * @param spec - Group specification
     * @returns AggregateBuilder
     */
    group(spec) {
        const agg = new AggregateBuilder(this.#collection, this.#executor.aggregate);
        if (this.#hasFilter())
            agg.match(this.#state.filter);
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
    async updateAll(update) {
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
    async deleteAll() {
        return this.#executor.deleteMany(this.#state.filter);
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL HELPERS
    // ═══════════════════════════════════════════════════════════════════════
    /** Build FindOptions from current state @internal */
    #buildOptions() {
        const opts = {};
        if (this.#state.projection)
            opts.projection = this.#state.projection;
        if (this.#state.sort)
            opts.sort = this.#state.sort;
        if (this.#state.limitVal !== null)
            opts.limit = this.#state.limitVal;
        if (this.#state.skipVal !== null)
            opts.skip = this.#state.skipVal;
        if (this.#state.hintVal !== null)
            opts.hint = this.#state.hintVal;
        return opts;
    }
    /** Check if the current filter has any conditions @internal */
    #hasFilter() {
        return Object.keys(this.#state.filter).length > 0;
    }
}
_a = QueryBuilder;
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
export class AggregateBuilder {
    /** Pipeline stages @internal */
    #stages = [];
    /** Collection name (for diagnostics) @internal */
    #_collection;
    /** Aggregate execution function @internal */
    #execute;
    /**
     * @internal — Create via QueryBuilder.match() or QueryBuilder.group()
     *
     * @param collection - Collection name
     * @param executeFn - Aggregation executor
     */
    constructor(collection, executeFn) {
        this.#_collection = collection;
        this.#execute = executeFn;
    }
    /**
     * Name of the collection this aggregate builder targets.
     * Useful for logging/debugging.
     */
    get collectionName() {
        return this.#_collection;
    }
    /**
     * Add a $match stage to filter documents.
     *
     * @param filter - MQL filter
     * @returns This builder for chaining
     */
    match(filter) {
        this.#stages.push({ $match: filter });
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
    group(spec) {
        this.#stages.push({ $group: spec });
        return this;
    }
    /**
     * Add a $project stage.
     *
     * @param spec - Projection specification
     * @returns This builder
     */
    project(spec) {
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
    sort(field, direction) {
        if (typeof field === 'string') {
            const dir = direction === 'desc' ? -1 : 1;
            this.#stages.push({ $sort: { [field]: dir } });
        }
        else {
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
    limit(n) {
        this.#stages.push({ $limit: n });
        return this;
    }
    /**
     * Add a $skip stage.
     *
     * @param n - Documents to skip
     * @returns This builder
     */
    skip(n) {
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
    unwind(path, options) {
        if (options) {
            this.#stages.push({ $unwind: { path, ...options } });
        }
        else {
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
    lookup(from, localField, foreignField, as) {
        this.#stages.push({ $lookup: { from, localField, foreignField, as } });
        return this;
    }
    /**
     * Add a $count stage.
     *
     * @param field - Output field name for the count
     * @returns This builder
     */
    count(field) {
        this.#stages.push({ $count: field });
        return this;
    }
    /**
     * Add a raw pipeline stage (for stages not covered by named methods).
     *
     * @param stage - Raw pipeline stage object
     * @returns This builder
     */
    addStage(stage) {
        this.#stages.push(stage);
        return this;
    }
    /**
     * Get the built pipeline as an array of stages.
     *
     * @returns Pipeline stage array
     */
    toPipeline() {
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
    async toArray() {
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
export class Cursor {
    /** Filter to apply @internal */
    #filter;
    /** Base query options @internal */
    #options;
    /** Find execution function @internal */
    #findFn;
    /** Batch size for fetching @internal */
    #batchSize;
    /** Current buffer of fetched documents @internal */
    #buffer = [];
    /** Current index within buffer @internal */
    #index = 0;
    /** Running skip offset @internal */
    #skip;
    /** True when no more batches available @internal */
    #done = false;
    /**
     * @param _collectionName - Collection name (for diagnostics)
     * @param filter - MQL filter to apply
     * @param options - FindOptions (projection, sort, etc.)
     * @param findFn - Function that executes the find
     * @param cursorOptions - Batching options
     */
    constructor(_collectionName, filter, options, findFn, cursorOptions) {
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
    async #nextBatch() {
        if (this.#done)
            return false;
        const batchOptions = {
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
    async *[Symbol.asyncIterator]() {
        while (true) {
            if (this.#index >= this.#buffer.length) {
                const hasMore = await this.#nextBatch();
                if (!hasMore)
                    return;
            }
            const doc = this.#buffer[this.#index++];
            if (doc !== undefined)
                yield doc;
        }
    }
    /**
     * Collect all results into an in-memory array.
     * Use with caution for large result sets.
     *
     * @returns Array of all matching documents
     */
    async toArray() {
        const results = [];
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
    async *batch(size) {
        let currentBatch = [];
        for await (const doc of this) {
            currentBatch.push(doc);
            if (currentBatch.length >= size) {
                yield currentBatch;
                currentBatch = [];
            }
        }
        if (currentBatch.length > 0)
            yield currentBatch;
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
export function createCursor(results) {
    // Return a specialized cursor pre-loaded with results (no native fetching)
    return new PreloadedCursor(results);
}
/**
 * Cursor that wraps pre-loaded results (no native fetching).
 * @internal
 */
class PreloadedCursor extends Cursor {
    #results;
    constructor(results) {
        // Parent constructor with noop find
        super('__preloaded__', {}, {}, async () => []);
        this.#results = results;
    }
    async *[Symbol.asyncIterator]() {
        for (const doc of this.#results) {
            yield doc;
        }
    }
    async toArray() {
        return [...this.#results];
    }
}
//# sourceMappingURL=builder.js.map