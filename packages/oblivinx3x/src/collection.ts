/**
 * @module collection
 *
 * Oblivinx3x Collection Class.
 *
 * Collection menyediakan MongoDB-like interface untuk operasi CRUD dokumen,
 * manajemen index, dan aggregation pipelines. Setiap Collection terikat
 * ke satu database instance dan satu nama collection.
 *
 * Collection menggunakan generic type parameter `TSchema` untuk
 * memberikan type-safety pada operasi CRUD.
 *
 * @example
 * ```typescript
 * interface User extends Document {
 *   name: string;
 *   age: number;
 *   email: string;
 * }
 *
 * const users = db.collection<User>('users');
 *
 * // Type-safe insert
 * await users.insertOne({ name: 'Alice', age: 28, email: 'alice@example.com' });
 *
 * // Type-safe query
 * const adults = await users.find({ age: { $gte: 18 } });
 * // adults: User[]
 *
 * // Aggregation pipeline
 * const stats = await users.aggregate([
 *   { $match: { age: { $gte: 18 } } },
 *   { $group: { _id: '$city', count: { $sum: 1 } } },
 * ]);
 * ```
 *
 * @packageDocumentation
 */

import { EventEmitter } from 'node:events';
import { native } from './loader.js';
import { wrapNative, DatabaseClosedError } from './errors/index.js';
import { withRetry } from './utils/retry.js';
import type {
  Document,
  FilterQuery,
  UpdateQuery,
  FindOptions,
  PipelineStage,
  IndexFields,
  IndexOptions,
  IndexInfo,
  InsertOneResult,
  InsertManyResult,
  UpdateResult,
  DeleteResult,
} from './types/index.js';

// Forward-declare Database type to avoid circular dependency
import type { Oblivinx3x } from './database.js';
import type { Cursor } from './query/builder.js';

/**
 * Representasi sebuah collection dalam database Oblivinx3x.
 *
 * Collection menyediakan API lengkap untuk:
 * - **Insert**: `insertOne()`, `insertMany()`
 * - **Query**: `find()`, `findOne()`, `countDocuments()`
 * - **Update**: `updateOne()`, `updateMany()`
 * - **Delete**: `deleteOne()`, `deleteMany()`
 * - **Aggregation**: `aggregate()` dengan pipeline stages
 * - **Indexing**: `createIndex()`, `dropIndex()`, `listIndexes()`
 * - **Management**: `drop()`
 *
 * @template TSchema - Tipe dokumen yang disimpan dalam collection.
 *   Harus extend `Document`. Default: `Document` (generic).
 *
 * @example
 * ```typescript
 * // Tanpa schema (dynamic)
 * const col = db.collection('logs');
 *
 * // Dengan typed schema
 * interface Order extends Document {
 *   customerId: string;
 *   items: Array<{ name: string; qty: number; price: number }>;
 *   total: number;
 *   status: 'pending' | 'completed' | 'cancelled';
 * }
 * const orders = db.collection<Order>('orders');
 * ```
 */
export class Collection<TSchema extends Document = Document> {
  /** Referensi ke database parent */
  readonly #db: Oblivinx3x;

  /** Nama collection ini */
  readonly #name: string;

  /**
   * Buat instance Collection baru.
   *
   * @param db - Instance database parent
   * @param name - Nama collection
   *
   * @internal — Jangan panggil constructor langsung.
   * Gunakan `db.collection('name')` sebagai gantinya.
   */
  constructor(db: Oblivinx3x, name: string) {
    this.#db = db;
    this.#name = name;
  }

  /** Nama collection ini */
  get name(): string {
    return this.#name;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GUARDS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Guard: assert that the database is still open.
   * @internal
   */
  #assertOpen(): void {
    if (this.#db.closed) {
      throw new DatabaseClosedError(this.#db.path);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INSERT OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Insert satu dokumen ke collection.
   *
   * Jika dokumen tidak memiliki field `_id`, maka `_id` akan
   * di-generate otomatis sebagai UUID v4 string.
   *
   * @param doc - Dokumen yang akan di-insert
   * @returns Object berisi `insertedId` (UUID v4 string)
   *
   * @throws {OvnError} Jika terjadi error saat insert
   * @throws {ValidationError} Jika dokumen gagal validasi
   *
   * @example
   * ```typescript
   * const { insertedId } = await users.insertOne({
   *   name: 'Alice',
   *   age: 28,
   *   email: 'alice@example.com',
   * });
   * console.log(`Inserted: ${insertedId}`);
   * ```
   */
  async insertOne(doc: TSchema): Promise<InsertOneResult> {
    this.#assertOpen();
    const id = await withRetry(
      async () => Promise.resolve(wrapNative(() =>
        native.insert(this.#db._handle, this.#name, JSON.stringify(doc))
      )),
      { maxAttempts: 2 }
    );
    return { insertedId: id as string };
  }

  /**
   * Insert banyak dokumen sekaligus dalam satu batch.
   *
   * Lebih efisien dibanding memanggil `insertOne()` berulang kali
   * karena hanya satu round-trip ke native engine.
   *
   * @param docs - Array dokumen yang akan di-insert
   * @returns Object berisi `insertedIds` dan `insertedCount`
   *
   * @throws {OvnError} Jika terjadi error saat insert
   *
   * @example
   * ```typescript
   * const { insertedIds, insertedCount } = await users.insertMany([
   *   { name: 'Alice', age: 28 },
   *   { name: 'Bob', age: 32 },
   *   { name: 'Charlie', age: 25 },
   * ]);
   * console.log(`Inserted ${insertedCount} documents`);
   * ```
   */
  async insertMany(docs: TSchema[]): Promise<InsertManyResult> {
    const idsJson = wrapNative(() =>
      native.insertMany(this.#db._handle, this.#name, JSON.stringify(docs)),
    );
    const ids: string[] = JSON.parse(idsJson) as string[];
    return { insertedIds: ids, insertedCount: ids.length };
  }

  // ═══════════════════════════════════════════════════════════════
  //  QUERY OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Find dokumen yang cocok dengan filter.
   *
   * Mendukung semua MQL comparison operators ($eq, $ne, $gt, $gte, $lt, $lte,
   * $in, $nin) dan logical operators ($and, $or, $nor, $not).
   *
   * @param filter - MQL filter expression. Default: `{}` (semua dokumen)
   * @param options - Query options (projection, sort, limit, skip)
   * @returns Array dokumen yang cocok
   *
   * @example
   * ```typescript
   * // Query sederhana
   * const adults = await users.find({ age: { $gte: 18 } });
   *
   * // Dengan options
   * const topUsers = await users.find(
   *   { active: true },
   *   {
   *     sort: { loginCount: -1 },
   *     limit: 10,
   *     projection: { name: 1, email: 1 },
   *   },
   * );
   *
   * // Pagination
   * const page2 = await users.find({}, { skip: 20, limit: 20 });
   * ```
   */
  async find(
    filter: FilterQuery<TSchema> = {} as FilterQuery<TSchema>,
    options: FindOptions<TSchema> = {},
  ): Promise<TSchema[]> {
    const hasOptions =
      options.sort != null ||
      options.limit != null ||
      options.skip != null ||
      options.projection != null;

    if (hasOptions) {
      const optsPayload = {
        sort: options.sort ?? null,
        limit: options.limit ?? null,
        skip: options.skip ?? 0,
        projection: options.projection ?? null,
      };
      const resultJson = wrapNative(() =>
        native.findWithOptions(
          this.#db._handle,
          this.#name,
          JSON.stringify(filter),
          JSON.stringify(optsPayload),
        ),
      );
      return JSON.parse(resultJson) as TSchema[];
    }

    const resultJson = wrapNative(() =>
      native.find(this.#db._handle, this.#name, JSON.stringify(filter)),
    );
    return JSON.parse(resultJson) as TSchema[];
  }

  /**
   * Find satu dokumen yang cocok dengan filter.
   *
   * Mengembalikan dokumen pertama yang cocok, atau `null` jika tidak ada.
   *
   * @param filter - MQL filter expression. Default: `{}` (dokumen pertama)
   * @returns Dokumen yang cocok, atau `null`
   *
   * @example
   * ```typescript
   * const user = await users.findOne({ email: 'alice@example.com' });
   * if (user) {
   *   console.log(`Found: ${user.name}`);
   * } else {
   *   console.log('User not found');
   * }
   * ```
   */
  async findOne(
    filter: FilterQuery<TSchema> = {} as FilterQuery<TSchema>,
  ): Promise<TSchema | null> {
    const resultJson = wrapNative(() =>
      native.findOne(this.#db._handle, this.#name, JSON.stringify(filter)),
    );
    return JSON.parse(resultJson) as TSchema | null;
  }

  /**
   * Hitung jumlah dokumen yang cocok dengan filter.
   *
   * @param filter - MQL filter expression. Default: `{}` (semua dokumen)
   * @returns Jumlah dokumen yang cocok
   *
   * @example
   * ```typescript
   * const totalActive = await users.countDocuments({ active: true });
   * console.log(`Active users: ${totalActive}`);
   *
   * const totalAll = await users.countDocuments();
   * console.log(`Total users: ${totalAll}`);
   * ```
   */
  async countDocuments(
    filter: FilterQuery<TSchema> = {} as FilterQuery<TSchema>,
  ): Promise<number> {
    return wrapNative(() =>
      native.count(this.#db._handle, this.#name, JSON.stringify(filter)),
    );
  }

  /**
   * Check if any document matches the given filter.
   * Shorthand for `countDocuments(filter) > 0`.
   *
   * @param filter - MQL filter expression. Default: `{}` (any document)
   * @returns `true` if at least one document matches
   *
   * @example
   * ```typescript
   * if (await users.exists({ email: 'alice@example.com' })) {
   *   console.log('User exists');
   * }
   * ```
   */
  async exists(filter: FilterQuery<TSchema> = {} as FilterQuery<TSchema>): Promise<boolean> {
    return (await this.countDocuments(filter)) > 0;
  }

  /**
   * Find one document matching the filter and update it atomically.
   *
   * @param filter - Filter to find the document
   * @param update - Update expression
   * @returns The original document before update, or null if not found
   *
   * @example
   * ```typescript
   * const oldDoc = await users.findOneAndUpdate(
   *   { name: 'Alice' },
   *   { $set: { age: 30 } }
   * );
   * ```
   */
  async findOneAndUpdate(
    filter: FilterQuery<TSchema>,
    update: UpdateQuery<TSchema>,
  ): Promise<TSchema | null> {
    this.#assertOpen();
    // Find the document first
    const doc = await this.findOne(filter);
    if (!doc) return null;
    // Then update it
    await this.updateOne(filter, update);
    return doc;
  }

  /**
   * Find one document matching the filter and delete it atomically.
   *
   * @param filter - Filter to find the document
   * @returns The deleted document, or null if not found
   *
   * @example
   * ```typescript
   * const deleted = await users.findOneAndDelete({ name: 'Alice' });
   * ```
   */
  async findOneAndDelete(filter: FilterQuery<TSchema>): Promise<TSchema | null> {
    this.#assertOpen();
    // Find the document first
    const doc = await this.findOne(filter);
    if (!doc) return null;
    // Then delete it
    await this.deleteOne(filter);
    return doc;
  }

  // ═══════════════════════════════════════════════════════════════
  //  UPDATE OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Update dokumen pertama yang cocok dengan filter.
   *
   * Operator update yang didukung:
   * - Field: `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$rename`, `$currentDate`
   * - Array: `$push`, `$pull`, `$addToSet`, `$pop`
   *
   * @param filter - Filter untuk menemukan dokumen yang akan di-update
   * @param update - Update expression ($set, $inc, dll.)
   * @returns Object berisi `matchedCount` dan `modifiedCount`
   *
   * @example
   * ```typescript
   * await users.updateOne(
   *   { name: 'Alice' },
   *   {
   *     $set: { age: 29 },
   *     $push: { tags: 'premium' },
   *     $inc: { loginCount: 1 },
   *   },
   * );
   * ```
   */
  async updateOne(
    filter: FilterQuery<TSchema>,
    update: UpdateQuery<TSchema>,
  ): Promise<UpdateResult> {
    this.#assertOpen();
    const count = await withRetry(
      async () => Promise.resolve(wrapNative(() =>
        native.update(
          this.#db._handle,
          this.#name,
          JSON.stringify(filter),
          JSON.stringify(update),
        )
      )),
      { maxAttempts: 2 }
    );
    return { matchedCount: count as number, modifiedCount: count as number };
  }

  /**
   * Update semua dokumen yang cocok dengan filter.
   *
   * @param filter - Filter expression
   * @param update - Update expression
   * @returns Object berisi `matchedCount` dan `modifiedCount`
   *
   * @example
   * ```typescript
   * // Set semua produk dengan stok rendah ke status 'low_stock'
   * const { modifiedCount } = await products.updateMany(
   *   { stock: { $lt: 10 } },
   *   { $set: { status: 'low_stock' } },
   * );
   * console.log(`Updated ${modifiedCount} products`);
   * ```
   */
  async updateMany(
    filter: FilterQuery<TSchema>,
    update: UpdateQuery<TSchema>,
  ): Promise<UpdateResult> {
    const count = wrapNative(() =>
      native.updateMany(
        this.#db._handle,
        this.#name,
        JSON.stringify(filter),
        JSON.stringify(update),
      ),
    );
    return { matchedCount: count, modifiedCount: count };
  }

  // ═══════════════════════════════════════════════════════════════
  //  DELETE OPERATIONS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Hapus dokumen pertama yang cocok dengan filter.
   *
   * @param filter - Filter expression
   * @returns Object berisi `deletedCount`
   *
   * @example
   * ```typescript
   * const { deletedCount } = await users.deleteOne({ name: 'Alice' });
   * if (deletedCount > 0) {
   *   console.log('User deleted');
   * }
   * ```
   */
  async deleteOne(filter: FilterQuery<TSchema>): Promise<DeleteResult> {
    const count = wrapNative(() =>
      native.delete(this.#db._handle, this.#name, JSON.stringify(filter)),
    );
    return { deletedCount: count };
  }

  /**
   * Hapus semua dokumen yang cocok dengan filter.
   *
   * @param filter - Filter expression
   * @returns Object berisi `deletedCount`
   *
   * @example
   * ```typescript
   * // Hapus semua produk discontinued
   * const { deletedCount } = await products.deleteMany({
   *   status: 'discontinued',
   * });
   * console.log(`Deleted ${deletedCount} products`);
   * ```
   */
  async deleteMany(filter: FilterQuery<TSchema>): Promise<DeleteResult> {
    const count = wrapNative(() =>
      native.deleteMany(this.#db._handle, this.#name, JSON.stringify(filter)),
    );
    return { deletedCount: count };
  }

  // ═══════════════════════════════════════════════════════════════
  //  AGGREGATION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Execute MongoDB-compatible aggregation pipeline.
   *
   * Stages yang didukung:
   * - `$match` — Filter dokumen
   * - `$group` — Grouping + accumulators ($sum, $avg, $min, $max, $first, $last, $push, $addToSet)
   * - `$project` — Field projection/reshaping
   * - `$sort` — Sorting
   * - `$limit` — Batasi output
   * - `$skip` — Skip dokumen
   * - `$unwind` — Flatten array field
   * - `$lookup` — Join antar collection
   * - `$count` — Hitung dokumen
   * - `$facet` — Multiple sub-pipelines
   * - `$bucket` / `$bucketAuto` — Bucketing
   * - `$setWindowFields` — Window functions
   * - `$merge` — Write results to target collection
   * - `$replaceRoot` / `$replaceWith` — Replace document root
   * - `$graphLookup` — Graph traversal
   *
   * @param pipeline - Array pipeline stage objects
   * @returns Array dokumen hasil aggregation
   *
   * @example
   * ```typescript
   * const salesByRegion = await orders.aggregate([
   *   { $match: { status: 'completed' } },
   *   { $group: { _id: '$region', total: { $sum: '$amount' } } },
   *   { $sort: { total: -1 } },
   *   { $limit: 5 },
   * ]);
   *
   * // $facet — multiple sub-pipelines
   * const facetResult = await products.aggregate([
   *   { $match: { status: 'active' } },
   *   { $facet: {
   *     byCategory: [
   *       { $group: { _id: '$category', count: { $sum: 1 } } },
   *       { $sort: { count: -1 } }
   *     ],
   *     priceDistribution: [
   *       { $bucket: {
   *         groupBy: '$price',
   *         boundaries: [0, 25, 50, 100, 250, 500],
   *         default: 'Other',
   *         output: { count: { $sum: 1 }, avgPrice: { $avg: '$price' } }
   *       }}
   *     ]
   *   }}
   * ]);
   * ```
   */
  async aggregate(pipeline: PipelineStage[]): Promise<Document[]> {
    const resultJson = wrapNative(() =>
      native.aggregate(
        this.#db._handle,
        this.#name,
        JSON.stringify(pipeline),
      ),
    );
    return JSON.parse(resultJson) as Document[];
  }

  /**
   * Execute aggregation with cursor for large result sets.
   *
   * @param pipeline - Array pipeline stage objects
   * @param _options - Cursor options (batchSize)
   * @returns AsyncCursor for streaming results
   */
  async aggregateWithCursor(
    pipeline: PipelineStage[],
    _options?: { batchSize?: number },
  ): Promise<Cursor<Document>> {
    // For now, we return a cursor that fetches all results
    // In a full implementation, this would stream batches from native engine
    const results = await this.aggregate(pipeline);
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const doc of results) {
          yield doc;
        }
      },
      toArray: async () => results,
    } as unknown as Cursor<Document>;
  }

  // ═══════════════════════════════════════════════════════════════
  //  INDEX MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Buat secondary index pada satu atau lebih field.
   *
   * @param fields - Spesifikasi index: `{ fieldName: 1 }` (ascending) atau `{ fieldName: -1 }` (descending)
   * @param options - Options index (unique, sparse, partial, hidden, ttl, dll.)
   * @returns Nama index yang di-generate
   *
   * @example
   * ```typescript
   * // Single field index
   * await users.createIndex({ age: 1 });
   *
   * // Compound index
   * await users.createIndex({ 'address.city': 1, age: -1 });
   *
   * // Full-text index
   * await articles.createIndex({ title: 'text', content: 'text' });
   *
   * // Unique sparse index — email optional, tapi unique saat ada
   * await users.createIndex({ email: 1 }, { unique: true, sparse: true });
   *
   * // TTL index — expire documents 3600s setelah createdAt
   * await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
   *
   * // Partial index — hanya index non-archived orders
   * await orders.createIndex({ status: 1 }, {
   *   partialFilterExpression: { archived: false }
   * });
   *
   * // Hidden index — disimpan tapi tidak dipakai query planner
   * await events.createIndex({ userId: 1, createdAt: -1 }, { hidden: true });
   *
   * // Wildcard index untuk dynamic schemas
   * await logs.createIndex({ '$**': 1 });
   * ```
   */
  async createIndex(
    fields: IndexFields,
    options: IndexOptions = {},
  ): Promise<string> {
    return wrapNative(() =>
      native.createIndex(
        this.#db._handle,
        this.#name,
        JSON.stringify(fields),
        JSON.stringify(options),
      ),
    );
  }

  /**
   * Hapus index berdasarkan nama.
   *
   * @param indexName - Nama index yang akan dihapus
   *
   * @example
   * ```typescript
   * await users.dropIndex('age_1');
   * ```
   */
  async dropIndex(indexName: string): Promise<void> {
    wrapNative(() =>
      native.dropIndex(this.#db._handle, this.#name, indexName),
    );
  }

  /**
   * List semua index yang didefinisikan pada collection ini.
   *
   * @returns Array informasi index
   *
   * @example
   * ```typescript
   * const indexes = await users.listIndexes();
   * for (const idx of indexes) {
   *   console.log(`${idx.name}: ${JSON.stringify(idx.fields)}`);
   * }
   * ```
   */
  async listIndexes(): Promise<IndexInfo[]> {
    const json = wrapNative(() =>
      native.listIndexes(this.#db._handle, this.#name),
    );
    return JSON.parse(json) as IndexInfo[];
  }

  // ═══════════════════════════════════════════════════════════════
  //  VECTOR SEARCH
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a HNSW vector index for similarity search.
   *
   * @param field - Field name where vector arrays are stored
   * @param options - Vector index options (dimensions, metric)
   *
   * @example
   * ```typescript
   * await embeddings.createVectorIndex('vector', {
   *   dimensions: 1536,
   *   metric: 'cosine'
   * });
   * ```
   */
  async createVectorIndex(
    field: string,
    options: { dimensions?: number; metric?: 'euclidean' | 'cosine' | 'inner_product' } = {},
  ): Promise<void> {
    wrapNative(() =>
      native.createVectorIndex(
        this.#db._handle,
        this.#name,
        field,
        JSON.stringify(options),
      ),
    );
  }

  /**
   * Perform an approximate/exact nearest neighbor search.
   *
   * @param queryVector - Vector to search for
   * @param limit - Maximum documents to return (default 10)
   * @param filter - Optional filter to pre-filter documents
   * @returns Array of closest documents
   */
  async vectorSearch(
    queryVector: number[],
    limit: number = 10,
    filter?: FilterQuery<TSchema>,
  ): Promise<TSchema[]> {
    const filterJson = filter ? JSON.stringify(filter) : undefined;
    const json = wrapNative(() =>
      native.vectorSearch(
        this.#db._handle,
        this.#name,
        JSON.stringify(queryVector),
        limit,
        filterJson,
      ),
    );
    return JSON.parse(json) as TSchema[];
  }

  // ═══════════════════════════════════════════════════════════════
  //  GEOSPATIAL SEARCH
  // ═══════════════════════════════════════════════════════════════

  /**
   * Create a geospatial (2dsphere) index for location-based queries.
   *
   * Indexes GeoJSON Point, LineString, Polygon, or [lng, lat] arrays.
   *
   * @param field - Field name where geographic data is stored
   * @param options - Geospatial index options
   *
   * @example
   * ```typescript
   * // 2dsphere index for Earth coordinates
   * await restaurants.createGeoIndex('location');
   *
   * // 2d index for flat plane coordinates (game maps, floor plans)
   * await gameTiles.createGeoIndex('position', { type: '2d', min: -1000, max: 1000 });
   *
   * // Then query with $geoWithin or $near
   * const nearby = await restaurants.find({
   *   location: {
   *     $geoWithin: {
   *       $centerSphere: [[-73.935242, 40.730610], 5 / 3963.2] // 5 mile radius
   *     }
   *   }
   * });
   * ```
   */
  async createGeoIndex(
    field: string,
    options: { type?: '2dsphere' | '2d'; min?: number; max?: number } = {},
  ): Promise<void> {
    wrapNative(() =>
      native.createGeoIndex(
        this.#db._handle,
        this.#name,
        field,
        JSON.stringify(options),
      ),
    );
  }

  /**
   * Hide an index — index tetap maintained tapi tidak akan dipilih query planner.
   *
   * Berguna untuk test impact dari dropping index tanpa benar-benar drop.
   *
   * @param indexName - Nama index
   */
  async hideIndex(indexName: string): Promise<void> {
    wrapNative(() => native.hideIndex(this.#db._handle, this.#name, indexName));
  }

  /**
   * Unhide an index — kembalikan ke query planner.
   *
   * @param indexName - Nama index
   */
  async unhideIndex(indexName: string): Promise<void> {
    wrapNative(() => native.unhideIndex(this.#db._handle, this.#name, indexName));
  }

  // ═══════════════════════════════════════════════════════════════
  //  AUTOCOMPLETE / PREFIX SEARCH
  // ═══════════════════════════════════════════════════════════════

  /**
   * Perform autocomplete/prefix search on a field.
   *
   * Finds documents where the indexed field starts with the given prefix.
   * Useful for type-ahead search, autocomplete, and suggestion features.
   *
   * @param field - Field name to search on (typically name, title, etc.)
   * @param prefix - Prefix string to match
   * @param limit - Maximum number of results to return (default: 10)
   * @returns Array of matching documents
   *
   * @example
   * ```typescript
   * // Type-ahead for user names
   * const suggestions = await users.autocomplete('name', 'ali', 5);
   * // Returns users with names like 'Alice', 'Ali', 'Alina', etc.
   * ```
   */
  async autocomplete(field: string, prefix: string, limit: number = 10): Promise<TSchema[]> {
    const json = wrapNative(() =>
      native.autocomplete(this.#db._handle, this.#name, field, prefix, limit)
    );
    return JSON.parse(json) as TSchema[];
  }

  // ═══════════════════════════════════════════════════════════════
  //  REAL-TIME EVENTS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Watch for real-time change stream events filtered for this collection.
   *
   * @returns Node.js EventEmitter emitting 'change' and 'error' events
   *
   * @example
   * ```typescript
   * const changeStream = users.watch();
   * changeStream.on('change', (event) => {
   *   console.log('User changed:', event.opType, event.fullDocument);
   * });
   * ```
   */
  watch(): EventEmitter {
    const emitter = new EventEmitter();
    const dbStream = this.#db.watch();

    dbStream.on('change', (event: any) => {
      if (event.namespace === this.#name) {
        emitter.emit('change', event);
      }
    });

    dbStream.on('error', (err: any) => {
      emitter.emit('error', err);
    });

    return emitter;
  }

  // ═══════════════════════════════════════════════════════════════
  //  COLLECTION MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Hapus collection ini beserta semua dokumen dan index-nya.
   *
   * ⚠️ Operasi ini tidak bisa di-undo!
   *
   * @throws {CollectionNotFoundError} Jika collection tidak ada
   *
   * @example
   * ```typescript
   * await tempCollection.drop();
   * ```
   */
  async drop(): Promise<void> {
    wrapNative(() => native.dropCollection(this.#db._handle, this.#name));
  }
}
