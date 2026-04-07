/**
 * Oblivinx3x TypeScript Type Declarations
 *
 * @packageDocumentation
 */

// ─────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────

/** Configuration options for opening an Oblivinx3x database. */
export interface OvnConfig {
  /** Page size in bytes. Must be a power of 2 between 512 and 65536. Default: 4096 */
  pageSize?: number;
  /** Buffer pool size string. Examples: '64MB', '256MB', '1GB'. Default: '256MB' */
  bufferPool?: string;
  /** Open the database in read-only mode. Default: false */
  readOnly?: boolean;
  /** Page compression algorithm. Default: 'none' */
  compression?: 'none' | 'lz4' | 'zstd';
  /** Enable Write-Ahead Log for durability. Default: true */
  walMode?: boolean;
}

// ─────────────────────────────────────────────────────────────────
// MQL Filter Types
// ─────────────────────────────────────────────────────────────────

/** A primitive value that can be compared in filters. */
type FilterPrimitive = string | number | boolean | null | Date;

/** Comparison operators for a single field. */
export interface ComparisonOperators<T = FilterPrimitive> {
  /** Equal to */
  $eq?: T;
  /** Not equal to */
  $ne?: T;
  /** Greater than */
  $gt?: T;
  /** Greater than or equal to */
  $gte?: T;
  /** Less than */
  $lt?: T;
  /** Less than or equal to */
  $lte?: T;
  /** Value is in the given array */
  $in?: T[];
  /** Value is NOT in the given array */
  $nin?: T[];
  /** Field exists (true) or does not exist (false) */
  $exists?: boolean;
  /** Field matches the given regex pattern */
  $regex?: string;
  /** Array contains all given values */
  $all?: T[];
  /** Array contains an element matching the given filter */
  $elemMatch?: FilterQuery<any>;
  /** Array has the given number of elements */
  $size?: number;
  /** Field has the given BSON type */
  $type?: string | number;
}

/** A filter expression for a document field. */
type FieldFilter<T> = T | ComparisonOperators<T>;

/** A MongoDB-compatible filter query. */
export type FilterQuery<T extends Document = Document> = {
  [K in keyof T]?: FieldFilter<T[K]>;
} & {
  /** Logical AND — all conditions must match */
  $and?: FilterQuery<T>[];
  /** Logical OR — at least one condition must match */
  $or?: FilterQuery<T>[];
  /** Logical NOR — no condition may match */
  $nor?: FilterQuery<T>[];
  /** Logical NOT — negates a filter expression */
  $not?: FilterQuery<T>;
  /** Expression evaluation */
  $expr?: object;
  [key: string]: any;
};

// ─────────────────────────────────────────────────────────────────
// MQL Update Types
// ─────────────────────────────────────────────────────────────────

/** MongoDB-compatible update operators. */
export interface UpdateQuery<T extends Document = Document> {
  /** Set field values */
  $set?: Partial<T> & { [key: string]: any };
  /** Remove fields */
  $unset?: { [K in keyof T]?: '' | 1 };
  /** Increment numeric fields */
  $inc?: { [K in keyof T]?: number };
  /** Multiply numeric fields */
  $mul?: { [K in keyof T]?: number };
  /** Set field to minimum of current and given value */
  $min?: { [K in keyof T]?: any };
  /** Set field to maximum of current and given value */
  $max?: { [K in keyof T]?: any };
  /** Rename a field */
  $rename?: { [K in keyof T]?: string };
  /** Set field to current date/timestamp */
  $currentDate?: { [K in keyof T]?: boolean | { $type: 'date' | 'timestamp' } };
  /** Push a value to an array */
  $push?: { [K in keyof T]?: any };
  /** Remove a value from an array */
  $pull?: { [K in keyof T]?: any };
  /** Add to array only if not already present */
  $addToSet?: { [K in keyof T]?: any };
  /** Remove first or last element from array */
  $pop?: { [K in keyof T]?: 1 | -1 };
  [key: string]: any;
}

// ─────────────────────────────────────────────────────────────────
// Find Options
// ─────────────────────────────────────────────────────────────────

/** Options for find() operations. */
export interface FindOptions<T extends Document = Document> {
  /**
   * Projection — fields to include (1) or exclude (0).
   * @example { name: 1, age: 1, _id: 0 }
   */
  projection?: { [K in keyof T]?: 0 | 1 } & { [key: string]: 0 | 1 };
  /**
   * Sort specification — field to value (1 = ascending, -1 = descending).
   * @example { age: -1, name: 1 }
   */
  sort?: { [K in keyof T]?: 1 | -1 } & { [key: string]: 1 | -1 };
  /** Maximum number of documents to return. */
  limit?: number;
  /** Number of documents to skip. Default: 0 */
  skip?: number;
}

// ─────────────────────────────────────────────────────────────────
// Aggregation Pipeline
// ─────────────────────────────────────────────────────────────────

/** An aggregation pipeline stage. */
export type PipelineStage =
  | { $match: FilterQuery }
  | { $group: { _id: any; [accumulator: string]: any } }
  | { $project: { [field: string]: 0 | 1 | any } }
  | { $sort: { [field: string]: 1 | -1 } }
  | { $limit: number }
  | { $skip: number }
  | { $unwind: string | { path: string; includeArrayIndex?: string; preserveNullAndEmptyArrays?: boolean } }
  | { $lookup: { from: string; localField: string; foreignField: string; as: string } }
  | { $count: string }
  | { [stage: string]: any };

// ─────────────────────────────────────────────────────────────────
// Document Base Type
// ─────────────────────────────────────────────────────────────────

/** Base document type. All documents have an `_id` field. */
export interface Document {
  _id?: string;
  [key: string]: any;
}

// ─────────────────────────────────────────────────────────────────
// Result Types
// ─────────────────────────────────────────────────────────────────

/** Result of an insertOne() operation. */
export interface InsertOneResult {
  /** The ID of the inserted document (UUID v4 string). */
  insertedId: string;
}

/** Result of an insertMany() operation. */
export interface InsertManyResult {
  /** The IDs of all inserted documents, in order. */
  insertedIds: string[];
  /** Number of documents inserted. */
  insertedCount: number;
}

/** Result of an updateOne() or updateMany() operation. */
export interface UpdateResult {
  /** Number of documents that matched the filter. */
  matchedCount: number;
  /** Number of documents actually modified. */
  modifiedCount: number;
}

/** Result of a deleteOne() or deleteMany() operation. */
export interface DeleteResult {
  /** Number of documents deleted. */
  deletedCount: number;
}

// ─────────────────────────────────────────────────────────────────
// Index Types
// ─────────────────────────────────────────────────────────────────

/** Index field specification. */
export type IndexFields = {
  [field: string]: 1 | -1 | 'text';
};

/** Options for createIndex(). */
export interface IndexOptions {
  /** Enforce uniqueness on the indexed field(s). Default: false */
  unique?: boolean;
}

/** Index descriptor returned by listIndexes(). */
export interface IndexInfo {
  /** Index name (auto-generated from field names, e.g., 'age_1_name_1') */
  name: string;
  /** Field specifications */
  fields: { [field: string]: number };
  /** Whether this is a unique index */
  unique: boolean;
}

// ─────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────

/** Database performance and usage metrics. */
export interface OvnMetrics {
  io: {
    /** Total pages read from disk */
    pagesRead: number;
    /** Total pages written to disk */
    pagesWritten: number;
  };
  cache: {
    /** Buffer pool hit rate (0.0 to 1.0) */
    hitRate: number;
    /** Current buffer pool size in bytes */
    size: number;
  };
  txn: {
    /** Number of currently active transactions */
    activeCount: number;
  };
  storage: {
    /** Total entries in the B+ tree */
    btreeEntries: number;
    /** Current MemTable memory usage in bytes */
    memtableSize: number;
    /** Number of unflushed L0 SSTables */
    sstableCount: number;
  };
  /** Number of open collections */
  collections: number;
}

/** Version information returned by getVersion(). */
export interface OvnVersion {
  engine: string;
  version: string;
  format: string;
  neon: string;
  features: string[];
}

// ─────────────────────────────────────────────────────────────────
// Error Classes
// ─────────────────────────────────────────────────────────────────

/** Base error class for all Oblivinx3x errors. */
export declare class OvnError extends Error {
  /** Machine-readable error code */
  readonly code: string;
  /** Collection name, if applicable */
  readonly collection?: string;
  constructor(message: string, code?: string, collection?: string);
}

/** Thrown when a collection is not found. */
export declare class CollectionNotFoundError extends OvnError {
  constructor(name: string);
}

/** Thrown when a collection already exists. */
export declare class CollectionExistsError extends OvnError {
  constructor(name: string);
}

/** Thrown when a write-write conflict is detected under MVCC. */
export declare class WriteConflictError extends OvnError {
  constructor(message: string);
}

/** Thrown when a document fails JSON Schema validation. */
export declare class ValidationError extends OvnError {
  constructor(message: string);
}

// ─────────────────────────────────────────────────────────────────
// Transaction
// ─────────────────────────────────────────────────────────────────

/**
 * An active MVCC transaction.
 *
 * @example
 * ```typescript
 * const txn = await db.beginTransaction();
 * try {
 *   await txn.update('accounts', { userId: 'u1' }, { $inc: { balance: -200 } });
 *   await txn.update('accounts', { userId: 'u2' }, { $inc: { balance: 200 } });
 *   await txn.commit();
 * } catch (err) {
 *   await txn.rollback();
 *   throw err;
 * }
 * ```
 */
export declare class Transaction {
  /** Transaction ID (string representation of u64) */
  readonly id: string;
  /** Whether the transaction has been committed */
  readonly committed: boolean;
  /** Whether the transaction has been aborted */
  readonly aborted: boolean;

  /** Insert a document within this transaction. */
  insert(collection: string, doc: Document): Promise<string>;
  /** Update documents within this transaction. */
  update<T extends Document>(collection: string, filter: FilterQuery<T>, update: UpdateQuery<T>): Promise<number>;
  /** Delete documents within this transaction. */
  delete<T extends Document>(collection: string, filter: FilterQuery<T>): Promise<number>;
  /** Commit the transaction. */
  commit(): Promise<void>;
  /** Rollback (abort) the transaction. */
  rollback(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// Collection
// ─────────────────────────────────────────────────────────────────

/**
 * A document collection with MongoDB-like CRUD, aggregation, and index APIs.
 */
export declare class Collection<TSchema extends Document = Document> {
  /** Collection name */
  readonly name: string;

  // Insert
  insertOne(doc: TSchema): Promise<InsertOneResult>;
  insertMany(docs: TSchema[]): Promise<InsertManyResult>;

  // Query
  find(filter?: FilterQuery<TSchema>, options?: FindOptions<TSchema>): Promise<TSchema[]>;
  findOne(filter?: FilterQuery<TSchema>): Promise<TSchema | null>;
  countDocuments(filter?: FilterQuery<TSchema>): Promise<number>;

  // Update
  updateOne(filter: FilterQuery<TSchema>, update: UpdateQuery<TSchema>): Promise<UpdateResult>;
  updateMany(filter: FilterQuery<TSchema>, update: UpdateQuery<TSchema>): Promise<UpdateResult>;

  // Delete
  deleteOne(filter: FilterQuery<TSchema>): Promise<DeleteResult>;
  deleteMany(filter: FilterQuery<TSchema>): Promise<DeleteResult>;

  // Aggregation
  aggregate(pipeline: PipelineStage[]): Promise<Document[]>;

  // Indexes
  createIndex(fields: IndexFields, options?: IndexOptions): Promise<string>;
  dropIndex(indexName: string): Promise<void>;
  listIndexes(): Promise<IndexInfo[]>;

  // Collection management
  drop(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────

/**
 * The main Oblivinx3x database class.
 *
 * @example
 * ```typescript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * const db = new Oblivinx3x('mydb.ovn', { compression: 'lz4' });
 *
 * interface User {
 *   _id?: string;
 *   name: string;
 *   age: number;
 *   email: string;
 * }
 *
 * const users = db.collection<User>('users');
 *
 * const { insertedId } = await users.insertOne({ name: 'Alice', age: 28, email: 'alice@example.com' });
 * const alice = await users.findOne({ email: 'alice@example.com' });
 *
 * await db.close();
 * ```
 */
export declare class Oblivinx3x {
  /** @internal */
  _handle: number;
  /** Path to the database file */
  readonly path: string;
  /** Whether the database has been closed */
  readonly closed: boolean;

  /**
   * Open or create a database.
   * @param path Path to the `.ovn` file
   * @param options Configuration options
   */
  constructor(path: string, options?: OvnConfig);

  /**
   * Get a typed collection reference.
   * @param name Collection name
   */
  collection<TSchema extends Document = Document>(name: string): Collection<TSchema>;

  /** Explicitly create a collection. */
  createCollection(name: string): Promise<void>;
  /** Drop a collection and all its data. */
  dropCollection(name: string): Promise<void>;
  /** List all collection names. */
  listCollections(): Promise<string[]>;

  /** Begin a new MVCC transaction. */
  beginTransaction(): Promise<Transaction>;

  /** Force a checkpoint — flush to disk. */
  checkpoint(): Promise<void>;
  /** Get database metrics. */
  getMetrics(): Promise<OvnMetrics>;
  /** Get engine version and feature information. */
  getVersion(): Promise<OvnVersion>;
  /** Close the database gracefully. */
  close(): Promise<void>;
}

/** Alias for Oblivinx3x */
export declare class Database extends Oblivinx3x {}

/**
 * Functional API: Open or create a database.
 *
 * @example
 * ```typescript
 * import { open } from 'oblivinx3x';
 * const db = open('data.ovn', { compression: 'lz4' });
 * ```
 */
export declare function open(path: string, options?: OvnConfig): Oblivinx3x;

export default Oblivinx3x;
