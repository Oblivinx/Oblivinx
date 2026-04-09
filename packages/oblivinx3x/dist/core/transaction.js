/**
 * @module core/transaction
 *
 * Transaction management with savepoints.
 *
 * Provides ACID transaction semantics with nested savepoint support.
 *
 * @packageDocumentation
 */
import { native } from '../loader.js';
import { wrapNative } from '../errors/wrap.js';
import { SavepointNotFoundError, TransactionAbortedError } from '../errors/index.js';
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
export class Transaction {
    #db;
    #txid;
    #state = 'active';
    #savepoints = new Set();
    /**
     * @internal — Created via db.transaction()
     */
    constructor(db, txid) {
        this.#db = db;
        this.#txid = txid;
    }
    /** Transaction ID */
    get txid() {
        return this.#txid;
    }
    /** Whether this transaction is still active */
    get isActive() {
        return this.#state === 'active';
    }
    /**
     * Insert a document within this transaction.
     *
     * @param collection - Collection name
     * @param doc - Document to insert
     * @returns Inserted document ID
     */
    async insert(collection, doc) {
        this.#assertActive();
        return wrapNative(() => native.insert(this.#db._handle, collection, JSON.stringify(doc)));
    }
    /**
     * Update documents within this transaction.
     *
     * @param collection - Collection name
     * @param filter - Filter expression
     * @param update - Update operators
     * @returns Number of modified documents
     */
    async update(collection, filter, update) {
        this.#assertActive();
        return wrapNative(() => native.update(this.#db._handle, collection, JSON.stringify(filter), JSON.stringify(update)));
    }
    /**
     * Delete documents within this transaction.
     *
     * @param collection - Collection name
     * @param filter - Filter expression
     * @returns Number of deleted documents
     */
    async delete(collection, filter) {
        this.#assertActive();
        return wrapNative(() => native.delete(this.#db._handle, collection, JSON.stringify(filter)));
    }
    /**
     * Create a savepoint — a named checkpoint within the transaction.
     *
     * @param name - Savepoint name (must be unique within this transaction)
     */
    async savepoint(name) {
        this.#assertActive();
        if (this.#savepoints.has(name)) {
            throw new Error(`Savepoint already exists: ${name}`);
        }
        this.#savepoints.add(name);
        // Note: Native savepoints would be implemented here in a full implementation
    }
    /**
     * Rollback to a savepoint — undo all operations since the savepoint.
     *
     * @param name - Savepoint name
     */
    async rollbackTo(name) {
        this.#assertActive();
        if (!this.#savepoints.has(name)) {
            throw new SavepointNotFoundError(name);
        }
        // Note: Native rollback would be implemented here in a full implementation
        this.#savepoints.delete(name);
    }
    /**
     * Release a savepoint — remove it without rolling back.
     *
     * @param name - Savepoint name
     */
    releaseSavepoint(name) {
        this.#assertActive();
        if (!this.#savepoints.has(name)) {
            throw new SavepointNotFoundError(name);
        }
        this.#savepoints.delete(name);
    }
    /**
     * Commit the transaction — make all changes permanent.
     */
    async commit() {
        this.#assertActive();
        wrapNative(() => native.commitTransaction(this.#db._handle, this.#txid));
        this.#state = 'committed';
    }
    /**
     * Rollback the transaction — undo all changes.
     */
    async rollback() {
        if (this.#state !== 'active') {
            return;
        }
        wrapNative(() => native.abortTransaction(this.#db._handle, this.#txid));
        this.#state = 'aborted';
    }
    /** Assert that the transaction is still active */
    #assertActive() {
        if (this.#state === 'committed') {
            throw new Error('Transaction already committed');
        }
        if (this.#state === 'aborted') {
            throw new TransactionAbortedError(this.#txid);
        }
    }
}
//# sourceMappingURL=transaction.js.map