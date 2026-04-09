/**
 * @module core/transaction
 *
 * Transaction management with savepoints.
 *
 * Provides ACID transaction semantics with nested savepoint support.
 *
 * @packageDocumentation
 */
import type { OblivinxDB } from './database.js';
/**
 * Transaction with savepoint support.
 *
 * @example
 * ```typescript
 * const txn = await db.transaction();
 * try {
 *   await txn.insert('users', { name: 'Alice' });
 *   await txn.savepoint('before_orders');
 *   await txn.insert('orders', { userId: '...', total: 100 });
 *   await txn.commit();
 * } catch (err) {
 *   await txn.rollback();
 *   throw err;
 * }
 * ```
 */
export declare class Transaction {
    #private;
    /**
     * @internal — Created via db.transaction()
     */
    constructor(db: OblivinxDB, txid: string);
    /** Transaction ID */
    get txid(): string;
    /** Whether this transaction is still active */
    get isActive(): boolean;
    /**
     * Insert a document within this transaction.
     *
     * @param collection - Collection name
     * @param doc - Document to insert
     * @returns Inserted document ID
     */
    insert<T extends Record<string, unknown>>(collection: string, doc: T): Promise<string>;
    /**
     * Update documents within this transaction.
     *
     * @param collection - Collection name
     * @param filter - Filter expression
     * @param update - Update operators
     * @returns Number of modified documents
     */
    update(collection: string, filter: Record<string, unknown>, update: Record<string, unknown>): Promise<number>;
    /**
     * Delete documents within this transaction.
     *
     * @param collection - Collection name
     * @param filter - Filter expression
     * @returns Number of deleted documents
     */
    delete(collection: string, filter: Record<string, unknown>): Promise<number>;
    /**
     * Create a savepoint — a named checkpoint within the transaction.
     *
     * @param name - Savepoint name (must be unique within this transaction)
     */
    savepoint(name: string): Promise<void>;
    /**
     * Rollback to a savepoint — undo all operations since the savepoint.
     *
     * @param name - Savepoint name
     */
    rollbackTo(name: string): Promise<void>;
    /**
     * Release a savepoint — remove it without rolling back.
     *
     * @param name - Savepoint name
     */
    releaseSavepoint(name: string): void;
    /**
     * Commit the transaction — make all changes permanent.
     */
    commit(): Promise<void>;
    /**
     * Rollback the transaction — undo all changes.
     */
    rollback(): Promise<void>;
}
//# sourceMappingURL=transaction.d.ts.map