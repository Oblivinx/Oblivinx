/**
 * @file UpdateBuilder.ts
 * @module oblivinx3x/query
 * @description
 *   Fluent, immutable builder for constructing MQL update expressions.
 *   Supports all MQL update operators: field ($set, $unset, $inc, $mul, $min, $max,
 *   $rename, $currentDate) and array ($push, $pull, $addToSet, $pop).
 *
 * @example
 * ```typescript
 * import { UpdateBuilder } from 'oblivinx3x';
 *
 * const update = UpdateBuilder.create<User>()
 *   .set('name', 'Alice Updated')
 *   .inc('loginCount', 1)
 *   .push('tags', 'premium')
 *   .build();
 *
 * await users.updateOne({ _id: 'abc' }, update);
 * ```
 *
 * @author Oblivinx3x Team
 * @version 1.2.0
 * @since 1.0.0
 */
import type { Document, UpdateQuery } from '../types/index.js';
/**
 * Fluent, immutable builder for MQL update expressions.
 *
 * Every method returns a new UpdateBuilder instance (immutable pattern).
 * Call `build()` to get the final UpdateQuery object.
 *
 * @template T - Document type
 *
 * @example
 * ```typescript
 * // Chained updates
 * const update = UpdateBuilder.create<Product>()
 *   .set('price', 99.99)
 *   .inc('stock', -1)
 *   .push('reviews', { user: 'alice', rating: 5 })
 *   .currentDate('updatedAt')
 *   .build();
 *
 * await products.updateOne({ _id: 'prod-1' }, update);
 *
 * // Batch field updates
 * const bulkSet = UpdateBuilder.create<User>()
 *   .setMany({ verified: true, tier: 'premium', updatedAt: Date.now() })
 *   .build();
 * ```
 */
export declare class UpdateBuilder<T extends Document = Document> {
    #private;
    /**
     * Private constructor — use `UpdateBuilder.create()`.
     * @internal
     */
    private constructor();
    /**
     * Create a new empty UpdateBuilder.
     * @returns Fresh UpdateBuilder instance
     */
    static create<U extends Document = Document>(): UpdateBuilder<U>;
    /**
     * $set — set a field to a value.
     *
     * @param field - Field to set
     * @param value - New value
     * @returns New UpdateBuilder
     *
     * @example
     * ```typescript
     * builder.set('name', 'Alice').set('age', 30);
     * ```
     */
    set(field: keyof T | string, value: unknown): UpdateBuilder<T>;
    /**
     * $set — set multiple fields at once.
     *
     * @param fields - Object of field-value pairs
     * @returns New UpdateBuilder
     *
     * @example
     * ```typescript
     * builder.setMany({ name: 'Alice', age: 30, active: true });
     * ```
     */
    setMany(fields: Partial<Record<keyof T | string, unknown>>): UpdateBuilder<T>;
    /**
     * $unset — remove a field from the document.
     *
     * @param field - Field to remove
     * @returns New UpdateBuilder
     */
    unset(field: keyof T | string): UpdateBuilder<T>;
    /**
     * $inc — increment a numeric field by a value.
     *
     * @param field - Numeric field
     * @param amount - Increment amount (negative for decrement)
     * @returns New UpdateBuilder
     *
     * @example
     * ```typescript
     * builder.inc('balance', -100).inc('transactions', 1);
     * ```
     */
    inc(field: keyof T | string, amount: number): UpdateBuilder<T>;
    /**
     * $mul — multiply a numeric field by a value.
     *
     * @param field - Numeric field
     * @param factor - Multiplication factor
     * @returns New UpdateBuilder
     */
    mul(field: keyof T | string, factor: number): UpdateBuilder<T>;
    /**
     * $min — update field only if value is less than current.
     *
     * @param field - Field name
     * @param value - New minimum boundary
     * @returns New UpdateBuilder
     */
    min(field: keyof T | string, value: unknown): UpdateBuilder<T>;
    /**
     * $max — update field only if value is greater than current.
     *
     * @param field - Field name
     * @param value - New maximum boundary
     * @returns New UpdateBuilder
     */
    max(field: keyof T | string, value: unknown): UpdateBuilder<T>;
    /**
     * $rename — rename a field.
     *
     * @param oldField - Current field name
     * @param newField - New field name
     * @returns New UpdateBuilder
     */
    rename(oldField: keyof T | string, newField: string): UpdateBuilder<T>;
    /**
     * $currentDate — set field to current date/time.
     *
     * @param field - Field to set to current date
     * @returns New UpdateBuilder
     */
    currentDate(field: keyof T | string): UpdateBuilder<T>;
    /**
     * $push — append a value to an array field.
     *
     * @param field - Array field name
     * @param value - Value to push
     * @returns New UpdateBuilder
     *
     * @example
     * ```typescript
     * builder.push('tags', 'vip');
     * ```
     */
    push(field: keyof T | string, value: unknown): UpdateBuilder<T>;
    /**
     * $push with $each — append multiple values to an array field.
     *
     * @param field - Array field name
     * @param values - Values to push
     * @returns New UpdateBuilder
     */
    pushAll(field: keyof T | string, values: unknown[]): UpdateBuilder<T>;
    /**
     * $pull — remove values matching a condition from an array field.
     *
     * @param field - Array field name
     * @param condition - Value or filter to match for removal
     * @returns New UpdateBuilder
     *
     * @example
     * ```typescript
     * builder.pull('tags', 'deprecated');
     * builder.pull('items', { qty: { $lte: 0 } });
     * ```
     */
    pull(field: keyof T | string, condition: unknown): UpdateBuilder<T>;
    /**
     * $addToSet — add to array only if not already present (set semantics).
     *
     * @param field - Array field name
     * @param value - Value to add
     * @returns New UpdateBuilder
     */
    addToSet(field: keyof T | string, value: unknown): UpdateBuilder<T>;
    /**
     * $pop — remove the first (-1) or last (1) element from an array.
     *
     * @param field - Array field name
     * @param direction - -1 for first, 1 for last
     * @returns New UpdateBuilder
     */
    pop(field: keyof T | string, direction?: -1 | 1): UpdateBuilder<T>;
    /**
     * Build and return the final UpdateQuery object.
     *
     * @returns MQL UpdateQuery ready for use with Collection.updateOne/updateMany
     *
     * @example
     * ```typescript
     * const update = builder.set('name', 'Alice').inc('count', 1).build();
     * // { $set: { name: 'Alice' }, $inc: { count: 1 } }
     * ```
     */
    build(): UpdateQuery<T>;
}
//# sourceMappingURL=UpdateBuilder.d.ts.map