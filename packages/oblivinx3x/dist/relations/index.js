/**
 * @module relations
 *
 * Relation management for Oblivinx3x.
 *
 * Provides MongoDB $lookup-style joins with foreign key validation
 * and cascade behaviors at the SDK layer.
 *
 * @packageDocumentation
 */
/**
 * RelationManager — manages relations between collections.
 *
 * Provides $lookup-style joins and FK validation.
 *
 * @example
 * ```typescript
 * const db = new OblivinxDB('data.ovn');
 *
 * // Define a relation
 * await db.relations.defineRelation({
 *   name: 'user_orders',
 *   from: 'users',
 *   to: 'orders',
 *   localField: '_id',
 *   foreignField: 'userId',
 *   type: 'one-to-many',
 *   fkValidation: 'soft',
 *   onDelete: 'cascade',
 *   onUpdate: 'cascade',
 * });
 *
 * // Use the relation
 * const usersWithOrders = await db.collection('users')
 *   .join('orders', { as: 'orders' })
 *   .toArray();
 * ```
 */
export class RelationManager {
    #db;
    #relations = new Map();
    constructor(db) {
        this.#db = db;
    }
    /**
     * Define a relation between two collections.
     *
     * @param definition - Relation metadata
     */
    async defineRelation(definition) {
        this.#relations.set(definition.name, definition);
    }
    /**
     * Remove a relation definition.
     *
     * @param name - Relation name
     */
    removeRelation(name) {
        if (!this.#relations.has(name)) {
            throw new Error(`Relation not found: ${name}`);
        }
        this.#relations.delete(name);
    }
    /**
     * Get a relation definition.
     *
     * @param name - Relation name
     * @returns Relation definition
     */
    getRelation(name) {
        return this.#relations.get(name);
    }
    /**
     * List all defined relations.
     */
    listRelations() {
        return Array.from(this.#relations.values());
    }
    /**
     * Validate a foreign key value against the target collection.
     *
     * @param relation - Relation name
     * @param value - Value to validate
     * @throws If validation fails in strict mode
     */
    async validateForeignKey(relation, value) {
        const def = this.#relations.get(relation);
        if (!def) {
            throw new Error(`Relation not found: ${relation}`);
        }
        if (def.fkValidation === 'off') {
            return true;
        }
        const targetCol = this.#db.collection(def.to);
        const filter = { [def.foreignField]: value };
        const exists = await targetCol.findOne(filter);
        if (!exists) {
            if (def.fkValidation === 'strict') {
                throw new Error(`Foreign key violation: ${def.localField}=${value} not found in ${def.to}.${def.foreignField}`);
            }
            return false;
        }
        return true;
    }
    /**
     * Execute a join ($lookup) between two collections.
     *
     * @param fromCollection - Source collection name
     * @param relationName - Relation to use
     * @param asField - Field name for joined documents
     * @param pipeline - Optional aggregation pipeline to apply to joined docs
     * @returns Array of source documents with joined data
     */
    async lookup(_fromCollection, relationName, asField, pipeline) {
        const def = this.#relations.get(relationName);
        if (!def) {
            throw new Error(`Relation not found: ${relationName}`);
        }
        const sourceCol = this.#db.collection(def.from);
        const targetCol = this.#db.collection(def.to);
        const sourceDocs = await sourceCol.find({});
        const results = [];
        for (const doc of sourceDocs) {
            const localValue = doc[def.localField];
            // Build lookup filter
            const filter = { [def.foreignField]: localValue };
            // Apply optional pipeline
            let targetDocs = await targetCol.find(filter);
            if (pipeline && pipeline.length > 0) {
                targetDocs = await targetCol.aggregate(pipeline);
            }
            results.push({
                ...doc,
                [asField]: def.type === 'one-to-one'
                    ? (targetDocs[0] ?? null)
                    : targetDocs,
            });
        }
        return results;
    }
    /**
     * Execute cascade delete on related documents.
     *
     * @param relation - Relation name
     * @param localValue - Value of the local field being deleted
     */
    async cascadeDelete(relation, localValue) {
        const def = this.#relations.get(relation);
        if (!def) {
            throw new Error(`Relation not found: ${relation}`);
        }
        if (def.onDelete === 'none' || def.onDelete === 'restrict') {
            return;
        }
        const targetCol = this.#db.collection(def.to);
        const filter = { [def.foreignField]: localValue };
        if (def.onDelete === 'cascade') {
            await targetCol.deleteMany(filter);
        }
        else if (def.onDelete === 'set-null') {
            await targetCol.updateMany(filter, {
                $set: { [def.foreignField]: null },
            });
        }
    }
    /**
     * Execute cascade update on related documents.
     *
     * @param relation - Relation name
     * @param oldValue - Old value of the local field
     * @param newValue - New value of the local field
     */
    async cascadeUpdate(relation, oldValue, newValue) {
        const def = this.#relations.get(relation);
        if (!def) {
            throw new Error(`Relation not found: ${relation}`);
        }
        if (def.onUpdate === 'none' || def.onUpdate === 'restrict') {
            return;
        }
        const targetCol = this.#db.collection(def.to);
        const filter = { [def.foreignField]: oldValue };
        if (def.onUpdate === 'cascade') {
            await targetCol.updateMany(filter, {
                $set: { [def.foreignField]: newValue },
            });
        }
        else if (def.onUpdate === 'set-null') {
            await targetCol.updateMany(filter, {
                $set: { [def.foreignField]: null },
            });
        }
    }
}
//# sourceMappingURL=index.js.map