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
var _a;
// ═══════════════════════════════════════════════════════════════════════
// UPDATE BUILDER
// ═══════════════════════════════════════════════════════════════════════
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
export class UpdateBuilder {
    /** Accumulated update operators @internal */
    #ops;
    /**
     * Private constructor — use `UpdateBuilder.create()`.
     * @internal
     */
    constructor(ops = {}) {
        this.#ops = ops;
    }
    /**
     * Create a new empty UpdateBuilder.
     * @returns Fresh UpdateBuilder instance
     */
    static create() {
        return new _a();
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  FIELD UPDATE OPERATORS
    // ═══════════════════════════════════════════════════════════════════════
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
    set(field, value) {
        return this.#addOp('$set', String(field), value);
    }
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
    setMany(fields) {
        let builder = this;
        for (const [key, val] of Object.entries(fields)) {
            builder = builder.set(key, val);
        }
        return builder;
    }
    /**
     * $unset — remove a field from the document.
     *
     * @param field - Field to remove
     * @returns New UpdateBuilder
     */
    unset(field) {
        return this.#addOp('$unset', String(field), '');
    }
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
    inc(field, amount) {
        return this.#addOp('$inc', String(field), amount);
    }
    /**
     * $mul — multiply a numeric field by a value.
     *
     * @param field - Numeric field
     * @param factor - Multiplication factor
     * @returns New UpdateBuilder
     */
    mul(field, factor) {
        return this.#addOp('$mul', String(field), factor);
    }
    /**
     * $min — update field only if value is less than current.
     *
     * @param field - Field name
     * @param value - New minimum boundary
     * @returns New UpdateBuilder
     */
    min(field, value) {
        return this.#addOp('$min', String(field), value);
    }
    /**
     * $max — update field only if value is greater than current.
     *
     * @param field - Field name
     * @param value - New maximum boundary
     * @returns New UpdateBuilder
     */
    max(field, value) {
        return this.#addOp('$max', String(field), value);
    }
    /**
     * $rename — rename a field.
     *
     * @param oldField - Current field name
     * @param newField - New field name
     * @returns New UpdateBuilder
     */
    rename(oldField, newField) {
        return this.#addOp('$rename', String(oldField), newField);
    }
    /**
     * $currentDate — set field to current date/time.
     *
     * @param field - Field to set to current date
     * @returns New UpdateBuilder
     */
    currentDate(field) {
        return this.#addOp('$currentDate', String(field), true);
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  ARRAY UPDATE OPERATORS
    // ═══════════════════════════════════════════════════════════════════════
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
    push(field, value) {
        return this.#addOp('$push', String(field), value);
    }
    /**
     * $push with $each — append multiple values to an array field.
     *
     * @param field - Array field name
     * @param values - Values to push
     * @returns New UpdateBuilder
     */
    pushAll(field, values) {
        return this.#addOp('$push', String(field), { $each: values });
    }
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
    pull(field, condition) {
        return this.#addOp('$pull', String(field), condition);
    }
    /**
     * $addToSet — add to array only if not already present (set semantics).
     *
     * @param field - Array field name
     * @param value - Value to add
     * @returns New UpdateBuilder
     */
    addToSet(field, value) {
        return this.#addOp('$addToSet', String(field), value);
    }
    /**
     * $pop — remove the first (-1) or last (1) element from an array.
     *
     * @param field - Array field name
     * @param direction - -1 for first, 1 for last
     * @returns New UpdateBuilder
     */
    pop(field, direction = 1) {
        return this.#addOp('$pop', String(field), direction);
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  BUILD
    // ═══════════════════════════════════════════════════════════════════════
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
    build() {
        // Deep clone to prevent mutation
        const result = {};
        for (const [op, fields] of Object.entries(this.#ops)) {
            result[op] = { ...fields };
        }
        return result;
    }
    // ═══════════════════════════════════════════════════════════════════════
    //  INTERNAL
    // ═══════════════════════════════════════════════════════════════════════
    /**
     * Add an operator to the accumulator (immutable).
     * @internal
     */
    #addOp(operator, field, value) {
        const existingOp = this.#ops[operator] ?? {};
        const newOps = {
            ...this.#ops,
            [operator]: { ...existingOp, [field]: value },
        };
        return new _a(newOps);
    }
}
_a = UpdateBuilder;
//# sourceMappingURL=UpdateBuilder.js.map