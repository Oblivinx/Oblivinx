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
import type { Document } from '../types/index.js';
import type { OblivinxDB } from '../core/database.js';
/** Relation type definition */
export type RelationType = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';
/** Foreign key validation mode */
export type FKValidationMode = 'off' | 'soft' | 'strict';
/** Cascade behavior for delete/update operations */
export type CascadeBehavior = 'none' | 'cascade' | 'restrict' | 'set-null';
/** Relation metadata */
export interface RelationDefinition {
    /** Relation name for lookup */
    name: string;
    /** Source collection */
    from: string;
    /** Target collection */
    to: string;
    /** Field in source collection (foreign key) */
    localField: string;
    /** Field in target collection (referenced key) */
    foreignField: string;
    /** Type of relation */
    type: RelationType;
    /** Foreign key validation mode */
    fkValidation: FKValidationMode;
    /** Behavior on delete */
    onDelete: CascadeBehavior;
    /** Behavior on update */
    onUpdate: CascadeBehavior;
}
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
export declare class RelationManager {
    #private;
    constructor(db: OblivinxDB);
    /**
     * Define a relation between two collections.
     *
     * @param definition - Relation metadata
     */
    defineRelation(definition: RelationDefinition): Promise<void>;
    /**
     * Remove a relation definition.
     *
     * @param name - Relation name
     */
    removeRelation(name: string): void;
    /**
     * Get a relation definition.
     *
     * @param name - Relation name
     * @returns Relation definition
     */
    getRelation(name: string): RelationDefinition | undefined;
    /**
     * List all defined relations.
     */
    listRelations(): RelationDefinition[];
    /**
     * Validate a foreign key value against the target collection.
     *
     * @param relation - Relation name
     * @param value - Value to validate
     * @throws If validation fails in strict mode
     */
    validateForeignKey<T extends Document>(relation: string, value: unknown): Promise<boolean>;
    /**
     * Execute a join ($lookup) between two collections.
     *
     * @param fromCollection - Source collection name
     * @param relationName - Relation to use
     * @param asField - Field name for joined documents
     * @param pipeline - Optional aggregation pipeline to apply to joined docs
     * @returns Array of source documents with joined data
     */
    lookup(_fromCollection: string, relationName: string, asField: string, pipeline?: Record<string, unknown>[]): Promise<Document[]>;
    /**
     * Execute cascade delete on related documents.
     *
     * @param relation - Relation name
     * @param localValue - Value of the local field being deleted
     */
    cascadeDelete(relation: string, localValue: unknown): Promise<void>;
    /**
     * Execute cascade update on related documents.
     *
     * @param relation - Relation name
     * @param oldValue - Old value of the local field
     * @param newValue - New value of the local field
     */
    cascadeUpdate(relation: string, oldValue: unknown, newValue: unknown): Promise<void>;
}
//# sourceMappingURL=index.d.ts.map