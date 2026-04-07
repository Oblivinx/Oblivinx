/**
 * Oblivinx3x — High-Performance Embedded Document Database
 *
 * ESM wrapper for the Rust native addon (ovn-neon).
 * Provides a Promise-based API similar to MongoDB's driver.
 *
 * @example
 * ```javascript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * const db = new Oblivinx3x('data.ovn');
 * await db.createCollection('users');
 *
 * const users = db.collection('users');
 * await users.insertOne({ name: 'Alice', age: 28 });
 *
 * const results = await users.find({ age: { $gt: 18 } });
 * console.log(results);
 *
 * await db.close();
 * ```
 */

import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the native addon
let native;
try {
  // Try release build first, then debug
  const requireFn = createRequire(import.meta.url);
  try {
    native = requireFn(join(__dirname, '..', 'target', 'release', 'ovn_neon.node'));
  } catch {
    native = requireFn(join(__dirname, '..', 'target', 'debug', 'ovn_neon.node'));
  }
} catch (err) {
  throw new Error(
    `Failed to load Oblivinx3x native addon. Run 'cargo build --release -p ovn-neon' first.\n${err.message}`
  );
}

/**
 * Collection wrapper providing a MongoDB-like document API.
 */
class Collection {
  #db;
  #name;

  constructor(db, name) {
    this.#db = db;
    this.#name = name;
  }

  /** Get collection name */
  get name() {
    return this.#name;
  }

  /**
   * Insert a single document.
   * @param {Object} doc - Document to insert
   * @returns {Promise<{ insertedId: string }>}
   */
  async insertOne(doc) {
    const id = native.insert(this.#db._handle, this.#name, JSON.stringify(doc));
    return { insertedId: id };
  }

  /**
   * Insert multiple documents.
   * @param {Object[]} docs - Documents to insert
   * @returns {Promise<{ insertedIds: string[] }>}
   */
  async insertMany(docs) {
    const idsJson = native.insertMany(this.#db._handle, this.#name, JSON.stringify(docs));
    const ids = JSON.parse(idsJson);
    return { insertedIds: ids };
  }

  /**
   * Find documents matching a filter.
   * @param {Object} [filter={}] - MQL filter expression
   * @returns {Promise<Object[]>}
   */
  async find(filter = {}) {
    const resultJson = native.find(this.#db._handle, this.#name, JSON.stringify(filter));
    return JSON.parse(resultJson);
  }

  /**
   * Find a single document matching a filter.
   * @param {Object} [filter={}] - MQL filter expression
   * @returns {Promise<Object|null>}
   */
  async findOne(filter = {}) {
    const resultJson = native.findOne(this.#db._handle, this.#name, JSON.stringify(filter));
    return JSON.parse(resultJson);
  }

  /**
   * Update the first matching document.
   * @param {Object} filter - MQL filter expression
   * @param {Object} update - MQL update expression ($set, $inc, etc.)
   * @returns {Promise<{ modifiedCount: number }>}
   */
  async updateOne(filter, update) {
    const count = native.update(
      this.#db._handle, this.#name,
      JSON.stringify(filter), JSON.stringify(update)
    );
    return { modifiedCount: count };
  }

  /**
   * Delete the first matching document.
   * @param {Object} filter - MQL filter expression
   * @returns {Promise<{ deletedCount: number }>}
   */
  async deleteOne(filter) {
    const count = native.delete(this.#db._handle, this.#name, JSON.stringify(filter));
    return { deletedCount: count };
  }

  /**
   * Count documents matching a filter.
   * @param {Object} [filter={}] - MQL filter expression
   * @returns {Promise<number>}
   */
  async countDocuments(filter = {}) {
    const docs = await this.find(filter);
    return docs.length;
  }

  /**
   * Run an aggregation pipeline.
   * @param {Object[]} pipeline - Array of aggregation stages
   * @returns {Promise<Object[]>}
   */
  async aggregate(pipeline) {
    const resultJson = native.aggregate(
      this.#db._handle, this.#name, JSON.stringify(pipeline)
    );
    return JSON.parse(resultJson);
  }

  /**
   * Create a secondary index.
   * @param {Object} fields - Index fields (e.g., { age: 1, name: -1 })
   * @returns {Promise<string>} Index name
   */
  async createIndex(fields) {
    return native.createIndex(this.#db._handle, this.#name, JSON.stringify(fields));
  }
}

/**
 * Oblivinx3x Database — main entry point.
 *
 * @example
 * ```javascript
 * const db = new Oblivinx3x('mydb.ovn', { bufferPool: '128MB' });
 * ```
 */
class Oblivinx3x {
  /** @type {number} Native handle index */
  _handle;
  #path;
  #closed = false;

  /**
   * Open or create a database.
   * @param {string} path - Path to the .ovn database file
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.pageSize=4096] - Page size in bytes
   * @param {string} [options.bufferPool='256MB'] - Buffer pool size
   * @param {boolean} [options.readOnly=false] - Open in read-only mode
   */
  constructor(path, options = {}) {
    this.#path = path;
    const opts = {
      pageSize: options.pageSize || 4096,
      bufferPool: options.bufferPool || '256MB',
      readOnly: !!options.readOnly
    };
    this._handle = native.open(path, opts);
  }

  /**
   * Get a collection reference.
   * @param {string} name - Collection name
   * @returns {Collection}
   */
  collection(name) {
    return new Collection(this, name);
  }

  /**
   * Create a new collection.
   * @param {string} name - Collection name
   */
  async createCollection(name) {
    native.createCollection(this._handle, name);
  }

  /**
   * List all collection names.
   * @returns {Promise<string[]>}
   */
  async listCollections() {
    return native.listCollections(this._handle);
  }

  /**
   * Force a checkpoint — flush all dirty pages to disk.
   */
  async checkpoint() {
    native.checkpoint(this._handle);
  }

  /**
   * Get database performance metrics.
   * @returns {Promise<Object>}
   */
  async getMetrics() {
    const json = native.getMetrics(this._handle);
    return JSON.parse(json);
  }

  /**
   * Close the database gracefully.
   */
  async close() {
    if (!this.#closed) {
      native.close(this._handle);
      this.#closed = true;
    }
  }

  /**
   * Get the database file path.
   * @returns {string}
   */
  get path() {
    return this.#path;
  }
}

export { Oblivinx3x, Collection };
export default Oblivinx3x;
