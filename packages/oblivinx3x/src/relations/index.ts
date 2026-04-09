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

import type { Document, FilterQuery } from '../types/index.js';
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
export class RelationManager {
  readonly #db: OblivinxDB;
  #relations = new Map<string, RelationDefinition>();

  constructor(db: OblivinxDB) {
    this.#db = db;
  }

  /**
   * Define a relation between two collections.
   * 
   * @param definition - Relation metadata
   */
  async defineRelation(definition: RelationDefinition): Promise<void> {
    this.#relations.set(definition.name, definition);
  }

  /**
   * Remove a relation definition.
   * 
   * @param name - Relation name
   */
  removeRelation(name: string): void {
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
  getRelation(name: string): RelationDefinition | undefined {
    return this.#relations.get(name);
  }

  /**
   * List all defined relations.
   */
  listRelations(): RelationDefinition[] {
    return Array.from(this.#relations.values());
  }

  /**
   * Validate a foreign key value against the target collection.
   * 
   * @param relation - Relation name
   * @param value - Value to validate
   * @throws If validation fails in strict mode
   */
  async validateForeignKey<T extends Document>(
    relation: string,
    value: unknown
  ): Promise<boolean> {
    const def = this.#relations.get(relation);
    if (!def) {
      throw new Error(`Relation not found: ${relation}`);
    }

    if (def.fkValidation === 'off') {
      return true;
    }

    const targetCol = this.#db.collection<T>(def.to);
    const filter = { [def.foreignField]: value } as FilterQuery<T>;
    const exists = await targetCol.findOne(filter);

    if (!exists) {
      if (def.fkValidation === 'strict') {
        throw new Error(
          `Foreign key violation: ${def.localField}=${value} not found in ${def.to}.${def.foreignField}`
        );
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
  async lookup(
    _fromCollection: string,
    relationName: string,
    asField: string,
    pipeline?: Record<string, unknown>[]
  ): Promise<Document[]> {
    const def = this.#relations.get(relationName);
    if (!def) {
      throw new Error(`Relation not found: ${relationName}`);
    }

    const sourceCol = this.#db.collection<Document>(def.from);
    const targetCol = this.#db.collection<Document>(def.to);

    const sourceDocs = await sourceCol.find({});
    const results: Document[] = [];

    for (const doc of sourceDocs) {
      const localValue = doc[def.localField];
      
      // Build lookup filter
      const filter = { [def.foreignField]: localValue } as FilterQuery<Document>;
      
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
  async cascadeDelete(relation: string, localValue: unknown): Promise<void> {
    const def = this.#relations.get(relation);
    if (!def) {
      throw new Error(`Relation not found: ${relation}`);
    }

    if (def.onDelete === 'none' || def.onDelete === 'restrict') {
      return;
    }

    const targetCol = this.#db.collection<Document>(def.to);
    const filter = { [def.foreignField]: localValue } as FilterQuery<Document>;

    if (def.onDelete === 'cascade') {
      await targetCol.deleteMany(filter);
    } else if (def.onDelete === 'set-null') {
      await targetCol.updateMany(filter, {
        $set: { [def.foreignField]: null } as Record<string, unknown>,
      } as any);
    }
  }

  /**
   * Execute cascade update on related documents.
   * 
   * @param relation - Relation name
   * @param oldValue - Old value of the local field
   * @param newValue - New value of the local field
   */
  async cascadeUpdate(
    relation: string,
    oldValue: unknown,
    newValue: unknown
  ): Promise<void> {
    const def = this.#relations.get(relation);
    if (!def) {
      throw new Error(`Relation not found: ${relation}`);
    }

    if (def.onUpdate === 'none' || def.onUpdate === 'restrict') {
      return;
    }

    const targetCol = this.#db.collection<Document>(def.to);
    const filter = { [def.foreignField]: oldValue } as FilterQuery<Document>;

    if (def.onUpdate === 'cascade') {
      await targetCol.updateMany(filter, {
        $set: { [def.foreignField]: newValue } as Record<string, unknown>,
      } as any);
    } else if (def.onUpdate === 'set-null') {
      await targetCol.updateMany(filter, {
        $set: { [def.foreignField]: null } as Record<string, unknown>,
      } as any);
    }
  }
}
