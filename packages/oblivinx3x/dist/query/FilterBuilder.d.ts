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
import type { Document, FilterQuery } from '../types/index.js';
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
export declare class FilterBuilder<T extends Document = Document> {
    #private;
    /**
     * Private constructor — use `FilterBuilder.create()`.
     * @internal
     */
    private constructor();
    /**
     * Create a new FilterBuilder instance.
     * @returns New empty FilterBuilder
     */
    static create<U extends Document = Document>(): FilterBuilder<U>;
    /**
     * Create from an existing MQL filter object.
     * @param filter - Existing filter
     * @returns FilterBuilder pre-populated with the filter
     */
    static from<U extends Document = Document>(filter: FilterQuery<U>): FilterBuilder<U>;
    /** Equal: `{ field: { $eq: value } }` */
    eq(field: keyof T | string, value: unknown): FilterBuilder<T>;
    /** Not equal: `{ field: { $ne: value } }` */
    ne(field: keyof T | string, value: unknown): FilterBuilder<T>;
    /** Greater than: `{ field: { $gt: value } }` */
    gt(field: keyof T | string, value: unknown): FilterBuilder<T>;
    /** Greater than or equal: `{ field: { $gte: value } }` */
    gte(field: keyof T | string, value: unknown): FilterBuilder<T>;
    /** Less than: `{ field: { $lt: value } }` */
    lt(field: keyof T | string, value: unknown): FilterBuilder<T>;
    /** Less than or equal: `{ field: { $lte: value } }` */
    lte(field: keyof T | string, value: unknown): FilterBuilder<T>;
    /** In array: `{ field: { $in: values } }` */
    in(field: keyof T | string, values: unknown[]): FilterBuilder<T>;
    /** Not in array: `{ field: { $nin: values } }` */
    nin(field: keyof T | string, values: unknown[]): FilterBuilder<T>;
    /** Field exists: `{ field: { $exists: true/false } }` */
    exists(field: keyof T | string, value?: boolean): FilterBuilder<T>;
    /** Field type check: `{ field: { $type: typeStr } }` */
    type(field: keyof T | string, typeStr: string): FilterBuilder<T>;
    /** Regex match: `{ field: { $regex: pattern } }` */
    regex(field: keyof T | string, pattern: string | RegExp): FilterBuilder<T>;
    /** Array contains ALL: `{ field: { $all: values } }` */
    all(field: keyof T | string, values: unknown[]): FilterBuilder<T>;
    /** Array size: `{ field: { $size: n } }` */
    size(field: keyof T | string, n: number): FilterBuilder<T>;
    /** Array elemMatch: `{ field: { $elemMatch: filter } }` */
    elemMatch(field: keyof T | string, filter: Record<string, unknown>): FilterBuilder<T>;
    /** AND multiple filters */
    and(...filters: FilterQuery[]): FilterBuilder<T>;
    /** OR multiple filters */
    or(...filters: FilterQuery[]): FilterBuilder<T>;
    /** NOR — none should match */
    nor(...filters: FilterQuery[]): FilterBuilder<T>;
    /**
     * Build and return the final MQL filter object.
     * @returns FilterQuery
     */
    build(): FilterQuery<T>;
}
//# sourceMappingURL=FilterBuilder.d.ts.map