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

import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { native } from './loader.js';
import { wrapNative } from './errors/index.js';
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
    const lsid = crypto.randomUUID();
    const txnNumber = 1;
    let attempts = 0;

    while (attempts < 2) {
      try {
        const id = wrapNative(() =>
          native.insert(this.#db._handle, this.#name, JSON.stringify(doc), lsid, txnNumber),
        );
        return { insertedId: id };
      } catch (error: any) {
        attempts++;
        if (attempts >= 2 || error.name === 'ValidationError') {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    throw new Error('unreachable');
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
    const lsid = crypto.randomUUID();
    const txnNumber = 1;
    let attempts = 0;

    while (attempts < 2) {
      try {
        const count = wrapNative(() =>
          native.update(
            this.#db._handle,
            this.#name,
            JSON.stringify(filter),
            JSON.stringify(update),
            lsid,
            txnNumber,
          ),
        );
        return { matchedCount: count, modifiedCount: count };
      } catch (error: any) {
        attempts++;
        if (attempts >= 2 || error.name === 'ValidationError') {
          throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    throw new Error('unreachable');
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

  // ═══════════════════════════════════════════════════════════════
  //  INDEX MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Buat secondary index pada satu atau lebih field.
   *
   * @param fields - Spesifikasi index: `{ fieldName: 1 }` (ascending) atau `{ fieldName: -1 }` (descending)
   * @param _options - Options index (reserved untuk unique index di versi mendatang)
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
   * ```
   */
  async createIndex(
    fields: IndexFields,
    _options: IndexOptions = {},
  ): Promise<string> {
    return wrapNative(() =>
      native.createIndex(
        this.#db._handle,
        this.#name,
        JSON.stringify(fields),
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
   */
  async createVectorIndex(field: string): Promise<void> {
    wrapNative(() => native.createVectorIndex(this.#db._handle, this.#name, field));
  }

  /**
   * Perform an approximate/exact nearest neighbor search.
   *
   * @param queryVector - Vector to search for
   * @param limit - Maximum documents to return (default 10)
   * @returns Array of closest documents
   */
  async vectorSearch(queryVector: number[], limit: number = 10): Promise<TSchema[]> {
    const json = wrapNative(() =>
      native.vectorSearch(this.#db._handle, this.#name, JSON.stringify(queryVector), limit)
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
