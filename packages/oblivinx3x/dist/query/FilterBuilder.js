/**
 * @file FilterBuilder.ts
 * @module oblivinx3x/query
 * @description
 *   Standalone MQL filter construction helper.
 *   Provides a convenient API for building complex filters outside
 *   of the QueryBuilder context. Useful for reusable filter fragments.
 *
 * @example
 * ```typescript
 * import { FilterBuilder } from 'oblivinx3x';
 *
 * const adminFilter = FilterBuilder.create<User>()
 *   .eq('role', 'admin')
 *   .gte('loginCount', 10)
 *   .build();
 *
 * // Use with Collection directly
 * const admins = await users.find(adminFilter);
 * ```
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */
var _a;
// ═══════════════════════════════════════════════════════════════════════
// FILTER BUILDER
// ═══════════════════════════════════════════════════════════════════════
/**
 * Lightweight, immutable MQL filter construction helper.
 *
 * Useful for building reusable filter fragments that can be composed
 * with QueryBuilder or used directly with `Collection.find()`.
 *
 * @template T - Document type
 *
 * @example
 * ```typescript
 * // Build a reusable filter
 * const activeUser = FilterBuilder.create<User>()
 *   .eq('isActive', true)
 *   .gte('age', 18)
 *   .build();
 *
 * // Compose with other filters via and/or
 * const premiumActive = FilterBuilder.create<User>()
 *   .and(
 *     activeUser,
 *     FilterBuilder.create<User>().eq('tier', 'premium').build(),
 *   )
 *   .build();
 * ```
 */
export class FilterBuilder {
    /** Internal filter accumulator @internal */
    #filter;
    /**
     * Private constructor — use `FilterBuilder.create()`.
     * @internal
     */
    constructor(base = {}) {
        this.#filter = { ...base };
    }
    /**
     * Create a new FilterBuilder instance.
     * @returns New empty FilterBuilder
     */
    static create() {
        return new _a();
    }
    /**
     * Create from an existing MQL filter object.
     * @param filter - Existing filter
     * @returns FilterBuilder pre-populated with the filter
     */
    static from(filter) {
        return new _a(filter);
    }
    // ─── Comparison Operators ──────────────────────────────────────────────
    /** Equal: `{ field: { $eq: value } }` */
    eq(field, value) {
        return this.#addCondition(String(field), '$eq', value);
    }
    /** Not equal: `{ field: { $ne: value } }` */
    ne(field, value) {
        return this.#addCondition(String(field), '$ne', value);
    }
    /** Greater than: `{ field: { $gt: value } }` */
    gt(field, value) {
        return this.#addCondition(String(field), '$gt', value);
    }
    /** Greater than or equal: `{ field: { $gte: value } }` */
    gte(field, value) {
        return this.#addCondition(String(field), '$gte', value);
    }
    /** Less than: `{ field: { $lt: value } }` */
    lt(field, value) {
        return this.#addCondition(String(field), '$lt', value);
    }
    /** Less than or equal: `{ field: { $lte: value } }` */
    lte(field, value) {
        return this.#addCondition(String(field), '$lte', value);
    }
    /** In array: `{ field: { $in: values } }` */
    in(field, values) {
        return this.#addCondition(String(field), '$in', values);
    }
    /** Not in array: `{ field: { $nin: values } }` */
    nin(field, values) {
        return this.#addCondition(String(field), '$nin', values);
    }
    // ─── Element Operators ────────────────────────────────────────────────
    /** Field exists: `{ field: { $exists: true/false } }` */
    exists(field, value = true) {
        return this.#addCondition(String(field), '$exists', value);
    }
    /** Field type check: `{ field: { $type: typeStr } }` */
    type(field, typeStr) {
        return this.#addCondition(String(field), '$type', typeStr);
    }
    // ─── String Operators ─────────────────────────────────────────────────
    /** Regex match: `{ field: { $regex: pattern } }` */
    regex(field, pattern) {
        const patternStr = pattern instanceof RegExp ? pattern.source : pattern;
        return this.#addCondition(String(field), '$regex', patternStr);
    }
    // ─── Array Operators ──────────────────────────────────────────────────
    /** Array contains ALL: `{ field: { $all: values } }` */
    all(field, values) {
        return this.#addCondition(String(field), '$all', values);
    }
    /** Array size: `{ field: { $size: n } }` */
    size(field, n) {
        return this.#addCondition(String(field), '$size', n);
    }
    /** Array elemMatch: `{ field: { $elemMatch: filter } }` */
    elemMatch(field, filter) {
        return this.#addCondition(String(field), '$elemMatch', filter);
    }
    // ─── Logical Combinators ──────────────────────────────────────────────
    /** AND multiple filters */
    and(...filters) {
        const clauses = [this.build(), ...filters].filter(f => Object.keys(f).length > 0);
        return new _a(clauses.length > 1 ? { $and: clauses } : clauses[0] ?? {});
    }
    /** OR multiple filters */
    or(...filters) {
        return new _a({ $or: [this.build(), ...filters] });
    }
    /** NOR — none should match */
    nor(...filters) {
        return new _a({ $nor: [this.build(), ...filters] });
    }
    // ─── Build ────────────────────────────────────────────────────────────
    /**
     * Build and return the final MQL filter object.
     * @returns FilterQuery
     */
    build() {
        return { ...this.#filter };
    }
    // ─── Internal ─────────────────────────────────────────────────────────
    /** Add a condition to a field, merging with existing conditions @internal */
    #addCondition(field, op, value) {
        const existing = this.#filter[field];
        const merged = typeof existing === 'object' && existing !== null
            ? { ...existing, [op]: value }
            : { [op]: value };
        return new _a({ ...this.#filter, [field]: merged });
    }
}
_a = FilterBuilder;
//# sourceMappingURL=FilterBuilder.js.map