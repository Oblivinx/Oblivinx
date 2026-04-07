/**
 * @module oblivinx3x
 *
 * Oblivinx3x — High-Performance Embedded Document Database
 *
 * A MongoDB-compatible embedded document database engine built on a hybrid
 * B+/LSM storage architecture with MVCC concurrency control and ACID transactions.
 *
 * ## Quick Start
 *
 * ```javascript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * const db = new Oblivinx3x('mydb.ovn');
 *
 * // Use a collection
 * const users = db.collection('users');
 *
 * await users.insertOne({ name: 'Alice', age: 28, email: 'alice@example.com' });
 *
 * const results = await users.find({ age: { $gt: 18 } });
 * console.log(results);
 *
 * await db.close();
 * ```
 *
 * ## Supported MQL Operators
 *
 * Filter: $eq, $ne, $gt, $gte, $lt, $lte, $in, $nin, $and, $or, $not, $exists, $type, $regex, $all, $elemMatch, $size
 * Update: $set, $unset, $inc, $mul, $min, $max, $push, $pull, $addToSet, $pop, $rename, $currentDate
 * Aggregation: $match, $group, $project, $sort, $limit, $skip, $unwind, $lookup, $count
 * Accumulators: $sum, $avg, $min, $max, $first, $last, $push, $addToSet
 */

import { native } from './loader.js';

// ─────────────────────────────────────────────────────────────────
// Error Types
// ─────────────────────────────────────────────────────────────────

/**
 * Base class for all Oblivinx3x errors.
 * Provides structured error information with error codes.
 */
export class OvnError extends Error {
  /** @type {string} Machine-readable error code */
  code;
  /** @type {string} Collection name, if applicable */
  collection;

  /**
   * @param {string} message - Human-readable error message
   * @param {string} [code='OVN_ERROR'] - Error code
   * @param {string} [collection] - Collection name if applicable
   */
  constructor(message, code = 'OVN_ERROR', collection) {
    super(message);
    this.name = 'OvnError';
    this.code = code;
    this.collection = collection;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, OvnError);
    }
  }
}

/** Thrown when a collection doesn't exist (and auto-create is disabled). */
export class CollectionNotFoundError extends OvnError {
  constructor(name) {
    super(`Collection '${name}' not found`, 'COLLECTION_NOT_FOUND', name);
    this.name = 'CollectionNotFoundError';
  }
}

/** Thrown when attempting to create a collection that already exists. */
export class CollectionExistsError extends OvnError {
  constructor(name) {
    super(`Collection '${name}' already exists`, 'COLLECTION_EXISTS', name);
    this.name = 'CollectionExistsError';
  }
}

/** Thrown when a write-write conflict is detected. */
export class WriteConflictError extends OvnError {
  constructor(message) {
    super(message, 'WRITE_CONFLICT');
    this.name = 'WriteConflictError';
  }
}

/** Thrown when a document fails JSON Schema validation. */
export class ValidationError extends OvnError {
  constructor(message) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

// ─────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────

/**
 * Wrap a native call in error handling to convert Rust errors to OvnError instances.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function wrapNative(fn) {
  try {
    return fn();
  } catch (err) {
    const msg = err?.message ?? String(err);

    // Map known error prefixes to typed errors
    if (msg.includes("Collection '") && msg.includes("not found")) {
      const match = msg.match(/Collection '([^']+)'/);
      throw new CollectionNotFoundError(match?.[1] ?? 'unknown');
    }
    if (msg.includes("already exists")) {
      const match = msg.match(/Collection '([^']+)'/);
      throw new CollectionExistsError(match?.[1] ?? 'unknown');
    }
    if (msg.includes('Write conflict') || msg.includes('WRITE_CONFLICT')) {
      throw new WriteConflictError(msg);
    }
    if (msg.includes('validation') || msg.includes('Validation')) {
      throw new ValidationError(msg);
    }

    throw new OvnError(msg);
  }
}

// ─────────────────────────────────────────────────────────────────
// Transaction
// ─────────────────────────────────────────────────────────────────

/**
 * An active MVCC transaction.
 *
 * Transactions provide ACID guarantees with Snapshot Isolation by default.
 * All operations within a transaction see a consistent snapshot of the database.
 *
 * @example
 * ```javascript
 * const txn = await db.beginTransaction();
 * try {
 *   await txn.insert('accounts', { userId: 'u1', balance: 1000 });
 *   await txn.update('accounts', { userId: 'u1' }, { $inc: { balance: -200 } });
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
  #committed = false;
  #aborted = false;

  /** @internal */
  constructor(db, txid) {
    this.#db = db;
    this.#txid = txid;
  }

  /** Transaction ID (as string to avoid JS number precision loss) */
  get id() { return this.#txid; }

  /** Whether the transaction has been committed */
  get committed() { return this.#committed; }

  /** Whether the transaction has been aborted */
  get aborted() { return this.#aborted; }

  /**
   * Insert a document within this transaction.
   * @param {string} collection
   * @param {object} doc
   * @returns {Promise<string>} Inserted document ID
   */
  async insert(collection, doc) {
    this.#assertActive();
    return wrapNative(() => native.insert(
      this.#db._handle, collection, JSON.stringify(doc)
    ));
  }

  /**
   * Update documents within this transaction.
   * @param {string} collection
   * @param {object} filter
   * @param {object} update
   * @returns {Promise<number>} Modified count
   */
  async update(collection, filter, update) {
    this.#assertActive();
    return wrapNative(() => native.update(
      this.#db._handle, collection,
      JSON.stringify(filter), JSON.stringify(update)
    ));
  }

  /**
   * Delete documents within this transaction.
   * @param {string} collection
   * @param {object} filter
   * @returns {Promise<number>} Deleted count
   */
  async delete(collection, filter) {
    this.#assertActive();
    return wrapNative(() => native.delete(
      this.#db._handle, collection, JSON.stringify(filter)
    ));
  }

  /**
   * Commit the transaction. All writes become visible to subsequent readers.
   * @returns {Promise<void>}
   */
  async commit() {
    this.#assertActive();
    wrapNative(() => native.commitTransaction(this.#db._handle, this.#txid));
    this.#committed = true;
  }

  /**
   * Rollback (abort) the transaction. All writes are discarded.
   * @returns {Promise<void>}
   */
  async rollback() {
    if (this.#committed || this.#aborted) return;
    wrapNative(() => native.abortTransaction(this.#db._handle, this.#txid));
    this.#aborted = true;
  }

  #assertActive() {
    if (this.#committed) throw new OvnError('Transaction already committed', 'TXN_COMMITTED');
    if (this.#aborted) throw new OvnError('Transaction already aborted', 'TXN_ABORTED');
  }
}

// ─────────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────────

/**
 * A Collection provides a MongoDB-like interface for document CRUD operations,
 * index management, and aggregation pipelines.
 *
 * Obtain a Collection via `db.collection('name')`.
 *
 * @example
 * ```javascript
 * const users = db.collection('users');
 *
 * // Insert
 * const { insertedId } = await users.insertOne({ name: 'Alice', age: 28 });
 *
 * // Query
 * const docs = await users.find({ age: { $gte: 18 } }, { sort: { age: 1 }, limit: 10 });
 *
 * // Update
 * await users.updateOne({ name: 'Alice' }, { $set: { age: 29 } });
 *
 * // Delete
 * await users.deleteOne({ name: 'Alice' });
 *
 * // Aggregate
 * const stats = await users.aggregate([
 *   { $match: { active: true } },
 *   { $group: { _id: '$country', count: { $sum: 1 } } },
 *   { $sort: { count: -1 } },
 * ]);
 * ```
 */
export class Collection {
  /** @type {Oblivinx3x} */ #db;
  /** @type {string} */ #name;

  /** @internal */
  constructor(db, name) {
    this.#db = db;
    this.#name = name;
  }

  /** Collection name */
  get name() { return this.#name; }

  // ── Insert ──────────────────────────────────────────────────────

  /**
   * Insert a single document.
   *
   * @param {object} doc - Document to insert. `_id` is auto-generated if not provided.
   * @returns {Promise<{ insertedId: string }>}
   *
   * @example
   * const { insertedId } = await users.insertOne({ name: 'Alice', age: 28 });
   */
  async insertOne(doc) {
    const id = wrapNative(() => native.insert(
      this.#db._handle, this.#name, JSON.stringify(doc)
    ));
    return { insertedId: id };
  }

  /**
   * Insert multiple documents in a single batch.
   *
   * @param {object[]} docs - Array of documents to insert.
   * @returns {Promise<{ insertedIds: string[], insertedCount: number }>}
   *
   * @example
   * const { insertedIds } = await users.insertMany([
   *   { name: 'Alice', age: 28 },
   *   { name: 'Bob', age: 32 },
   * ]);
   */
  async insertMany(docs) {
    const idsJson = wrapNative(() => native.insertMany(
      this.#db._handle, this.#name, JSON.stringify(docs)
    ));
    const ids = JSON.parse(idsJson);
    return { insertedIds: ids, insertedCount: ids.length };
  }

  // ── Query ───────────────────────────────────────────────────────

  /**
   * Find documents matching a filter.
   *
   * @param {object} [filter={}] - MQL filter expression
   * @param {object} [options={}] - Query options
   * @param {object} [options.projection] - Fields to include/exclude (e.g., `{ name: 1, age: 1 }`)
   * @param {object} [options.sort] - Sort specification (e.g., `{ age: -1 }`)
   * @param {number} [options.limit] - Maximum documents to return
   * @param {number} [options.skip=0] - Documents to skip
   * @returns {Promise<object[]>}
   *
   * @example
   * const users = await col.find(
   *   { age: { $gt: 18 }, active: true },
   *   { sort: { name: 1 }, limit: 20, projection: { name: 1, email: 1 } }
   * );
   */
  async find(filter = {}, options = {}) {
    const hasOptions = options.sort || options.limit != null || options.skip != null || options.projection;

    if (hasOptions) {
      const optsPayload = {
        sort: options.sort ?? null,
        limit: options.limit ?? null,
        skip: options.skip ?? 0,
        projection: options.projection ?? null,
      };
      const resultJson = wrapNative(() => native.findWithOptions(
        this.#db._handle, this.#name,
        JSON.stringify(filter), JSON.stringify(optsPayload)
      ));
      return JSON.parse(resultJson);
    }

    const resultJson = wrapNative(() => native.find(
      this.#db._handle, this.#name, JSON.stringify(filter)
    ));
    return JSON.parse(resultJson);
  }

  /**
   * Find a single document matching a filter.
   *
   * @param {object} [filter={}] - MQL filter expression
   * @returns {Promise<object|null>}
   *
   * @example
   * const user = await users.findOne({ email: 'alice@example.com' });
   */
  async findOne(filter = {}) {
    const resultJson = wrapNative(() => native.findOne(
      this.#db._handle, this.#name, JSON.stringify(filter)
    ));
    return JSON.parse(resultJson);
  }

  /**
   * Count documents matching a filter.
   *
   * @param {object} [filter={}] - MQL filter expression
   * @returns {Promise<number>}
   *
   * @example
   * const total = await users.countDocuments({ active: true });
   */
  async countDocuments(filter = {}) {
    return wrapNative(() => native.count(
      this.#db._handle, this.#name, JSON.stringify(filter)
    ));
  }

  // ── Update ──────────────────────────────────────────────────────

  /**
   * Update the first document matching the filter.
   *
   * Supported update operators: $set, $unset, $inc, $mul, $min, $max,
   * $push, $pull, $addToSet, $pop, $rename, $currentDate
   *
   * @param {object} filter - Filter to find the document to update
   * @param {object} update - Update expression ($set, $inc, etc.)
   * @returns {Promise<{ matchedCount: number, modifiedCount: number }>}
   *
   * @example
   * await users.updateOne({ name: 'Alice' }, { $set: { age: 29 }, $push: { tags: 'senior' } });
   */
  async updateOne(filter, update) {
    const count = wrapNative(() => native.update(
      this.#db._handle, this.#name,
      JSON.stringify(filter), JSON.stringify(update)
    ));
    return { matchedCount: count, modifiedCount: count };
  }

  /**
   * Update all documents matching the filter.
   *
   * @param {object} filter - Filter expression
   * @param {object} update - Update expression
   * @returns {Promise<{ matchedCount: number, modifiedCount: number }>}
   *
   * @example
   * await products.updateMany({ stock: { $lt: 10 } }, { $set: { status: 'low_stock' } });
   */
  async updateMany(filter, update) {
    const count = wrapNative(() => native.updateMany(
      this.#db._handle, this.#name,
      JSON.stringify(filter), JSON.stringify(update)
    ));
    return { matchedCount: count, modifiedCount: count };
  }

  // ── Delete ──────────────────────────────────────────────────────

  /**
   * Delete the first document matching the filter.
   *
   * @param {object} filter - Filter expression
   * @returns {Promise<{ deletedCount: number }>}
   *
   * @example
   * await users.deleteOne({ name: 'Alice' });
   */
  async deleteOne(filter) {
    const count = wrapNative(() => native.delete(
      this.#db._handle, this.#name, JSON.stringify(filter)
    ));
    return { deletedCount: count };
  }

  /**
   * Delete all documents matching the filter.
   *
   * @param {object} filter - Filter expression
   * @returns {Promise<{ deletedCount: number }>}
   *
   * @example
   * await products.deleteMany({ status: 'discontinued' });
   */
  async deleteMany(filter) {
    const count = wrapNative(() => native.deleteMany(
      this.#db._handle, this.#name, JSON.stringify(filter)
    ));
    return { deletedCount: count };
  }

  // ── Aggregation ─────────────────────────────────────────────────

  /**
   * Execute a MongoDB-compatible aggregation pipeline.
   *
   * Supported stages: $match, $group, $project, $sort, $limit, $skip, $unwind, $lookup, $count
   * Accumulators: $sum, $avg, $min, $max, $first, $last, $push, $addToSet
   *
   * @param {object[]} pipeline - Array of pipeline stage objects
   * @returns {Promise<object[]>}
   *
   * @example
   * const result = await orders.aggregate([
   *   { $match: { status: 'completed' } },
   *   { $group: { _id: '$customerId', total: { $sum: '$amount' } } },
   *   { $sort: { total: -1 } },
   *   { $limit: 10 },
   * ]);
   */
  async aggregate(pipeline) {
    const resultJson = wrapNative(() => native.aggregate(
      this.#db._handle, this.#name, JSON.stringify(pipeline)
    ));
    return JSON.parse(resultJson);
  }

  // ── Indexes ─────────────────────────────────────────────────────

  /**
   * Create a secondary index on one or more fields.
   *
   * @param {object} fields - Index fields: `{ fieldName: 1 }` (ascending) or `{ fieldName: -1 }` (descending)
   * @param {object} [options={}] - Index options
   * @param {boolean} [options.unique=false] - Whether the index enforces uniqueness
   * @returns {Promise<string>} The generated index name
   *
   * @example
   * // Single field
   * await users.createIndex({ age: 1 });
   *
   * // Compound
   * await users.createIndex({ 'address.city': 1, age: -1 });
   *
   * // Full-text
   * await articles.createIndex({ content: 'text', title: 'text' });
   */
  async createIndex(fields, _options = {}) {
    return wrapNative(() => native.createIndex(
      this.#db._handle, this.#name, JSON.stringify(fields)
    ));
  }

  /**
   * Drop an index by name.
   *
   * @param {string} indexName - Name of the index to drop
   * @returns {Promise<void>}
   *
   * @example
   * await users.dropIndex('age_1');
   */
  async dropIndex(indexName) {
    wrapNative(() => native.dropIndex(this.#db._handle, this.#name, indexName));
  }

  /**
   * List all indexes defined on this collection.
   *
   * @returns {Promise<Array<{ name: string, fields: object, unique: boolean }>>}
   */
  async listIndexes() {
    const json = wrapNative(() => native.listIndexes(this.#db._handle, this.#name));
    return JSON.parse(json);
  }

  /**
   * Drop this collection and all its documents and indexes.
   *
   * @returns {Promise<void>}
   */
  async drop() {
    wrapNative(() => native.dropCollection(this.#db._handle, this.#name));
  }
}

// ─────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────

/**
 * The main Oblivinx3x database class.
 *
 * Manages the lifecycle of a `.ovn` database file, provides collection access,
 * and exposes transaction, metrics, and maintenance APIs.
 *
 * @example
 * ```javascript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * const db = new Oblivinx3x('data.ovn', {
 *   pageSize: 4096,
 *   bufferPool: '128MB',
 *   compression: 'lz4',
 * });
 *
 * // Explicit collection create (optional — collections are auto-created on first insert)
 * await db.createCollection('users');
 *
 * const users = db.collection('users');
 * await users.insertOne({ name: 'Alice', age: 28 });
 *
 * await db.close();
 * ```
 */
export class Oblivinx3x {
  /**
   * Native engine handle (integer index).
   * @type {number}
   * @internal
   */
  _handle;

  #path;
  #closed = false;

  /**
   * Open or create a database.
   *
   * @param {string} path - Path to the `.ovn` database file.
   *   The file and parent directories are created if they don't exist.
   * @param {object} [options={}] - Configuration options
   * @param {number} [options.pageSize=4096] - Page size in bytes (512–65536)
   * @param {string} [options.bufferPool='256MB'] - Buffer pool size ('64MB', '256MB', '1GB')
   * @param {boolean} [options.readOnly=false] - Open in read-only mode
   * @param {string} [options.compression='none'] - Compression: 'none' | 'lz4' | 'zstd'
   * @param {boolean} [options.walMode=true] - Enable WAL (always true in this version)
   *
   * @throws {OvnError} If the database cannot be opened (corrupt file, permission denied, etc.)
   *
   * @example
   * const db = new Oblivinx3x('data.ovn', { compression: 'lz4', bufferPool: '128MB' });
   */
  constructor(path, options = {}) {
    this.#path = path;
    const opts = {
      pageSize:    options.pageSize    ?? 4096,
      bufferPool:  options.bufferPool  ?? '256MB',
      readOnly:    options.readOnly    ?? false,
      compression: options.compression ?? 'none',
      walMode:     options.walMode     ?? true,
    };
    this._handle = wrapNative(() => native.open(path, opts));
  }

  /** Path to the database file */
  get path() { return this.#path; }

  /** Whether the database has been closed */
  get closed() { return this.#closed; }

  // ── Collection Access ──────────────────────────────────────────

  /**
   * Get a reference to a collection.
   *
   * Collections are created automatically on first document insert.
   * To explicitly create a collection (e.g., to set validators), use `createCollection()`.
   *
   * @param {string} name - Collection name
   * @returns {Collection}
   *
   * @example
   * const users = db.collection('users');
   * const orders = db.collection('orders');
   */
  collection(name) {
    return new Collection(this, name);
  }

  /**
   * Explicitly create a collection.
   *
   * @param {string} name - Collection name
   * @returns {Promise<void>}
   * @throws {CollectionExistsError} If the collection already exists
   */
  async createCollection(name) {
    wrapNative(() => native.createCollection(this._handle, name));
  }

  /**
   * Drop a collection and all its data and indexes.
   *
   * @param {string} name - Collection name
   * @returns {Promise<void>}
   * @throws {CollectionNotFoundError} If the collection does not exist
   */
  async dropCollection(name) {
    wrapNative(() => native.dropCollection(this._handle, name));
  }

  /**
   * List all collection names.
   *
   * @returns {Promise<string[]>}
   */
  async listCollections() {
    const json = wrapNative(() => native.listCollections(this._handle));
    return JSON.parse(json);
  }

  // ── Transactions ───────────────────────────────────────────────

  /**
   * Begin a new MVCC transaction.
   *
   * All reads within the transaction see a consistent snapshot taken at this point.
   * Use `commit()` to make writes permanent or `rollback()` to discard them.
   *
   * @returns {Promise<Transaction>}
   *
   * @example
   * const txn = await db.beginTransaction();
   * try {
   *   await txn.update('accounts', { id: 'a' }, { $inc: { balance: -100 } });
   *   await txn.update('accounts', { id: 'b' }, { $inc: { balance: 100 } });
   *   await txn.commit();
   * } catch (err) {
   *   await txn.rollback();
   * }
   */
  async beginTransaction() {
    const txidStr = wrapNative(() => native.beginTransaction(this._handle));
    return new Transaction(this, txidStr);
  }

  // ── Maintenance ────────────────────────────────────────────────

  /**
   * Force a checkpoint — flush all dirty MemTable pages to disk and clear the WAL.
   *
   * This is called automatically on `close()`. Useful for long-running applications
   * to periodically ensure durability.
   *
   * @returns {Promise<void>}
   */
  async checkpoint() {
    wrapNative(() => native.checkpoint(this._handle));
  }

  /**
   * Get database performance and storage metrics.
   *
   * @returns {Promise<OvnMetrics>}
   *
   * @example
   * const metrics = await db.getMetrics();
   * console.log(metrics.cache.hitRate);
   * console.log(metrics.storage.btreeEntries);
   */
  async getMetrics() {
    const json = wrapNative(() => native.getMetrics(this._handle));
    return JSON.parse(json);
  }

  /**
   * Get library and engine version information.
   *
   * @returns {Promise<{ engine: string, version: string, format: string, features: string[] }>}
   */
  async getVersion() {
    const json = wrapNative(() => native.getVersion(this._handle));
    return JSON.parse(json);
  }

  /**
   * Close the database gracefully.
   *
   * Flushes all dirty pages, writes a final checkpoint, and clears the WAL active flag.
   * After calling close(), the database instance should not be used again.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.#closed) {
      wrapNative(() => native.close(this._handle));
      this.#closed = true;
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────

export default Oblivinx3x;

export {
  Oblivinx3x as Database,
};

/**
 * Open a database (functional API).
 *
 * @param {string} path
 * @param {object} [options]
 * @returns {Oblivinx3x}
 *
 * @example
 * import { open } from 'oblivinx3x';
 * const db = open('data.ovn', { compression: 'lz4' });
 */
export function open(path, options) {
  return new Oblivinx3x(path, options);
}
