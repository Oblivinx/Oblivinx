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
import type { Document, FilterQuery, UpdateQuery, FindOptions, PipelineStage, IndexFields, IndexOptions, IndexInfo, InsertOneResult, InsertManyResult, UpdateResult, DeleteResult } from './types/index.js';
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
export declare class Collection<TSchema extends Document = Document> {
    #private;
    /**
     * Buat instance Collection baru.
     *
     * @param db - Instance database parent
     * @param name - Nama collection
     *
     * @internal — Jangan panggil constructor langsung.
     * Gunakan `db.collection('name')` sebagai gantinya.
     */
    constructor(db: Oblivinx3x, name: string);
    /** Nama collection ini */
    get name(): string;
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
    insertOne(doc: TSchema): Promise<InsertOneResult>;
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
    insertMany(docs: TSchema[]): Promise<InsertManyResult>;
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
    find(filter?: FilterQuery<TSchema>, options?: FindOptions<TSchema>): Promise<TSchema[]>;
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
    findOne(filter?: FilterQuery<TSchema>): Promise<TSchema | null>;
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
    countDocuments(filter?: FilterQuery<TSchema>): Promise<number>;
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
    exists(filter?: FilterQuery<TSchema>): Promise<boolean>;
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
    findOneAndUpdate(filter: FilterQuery<TSchema>, update: UpdateQuery<TSchema>): Promise<TSchema | null>;
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
    findOneAndDelete(filter: FilterQuery<TSchema>): Promise<TSchema | null>;
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
    updateOne(filter: FilterQuery<TSchema>, update: UpdateQuery<TSchema>): Promise<UpdateResult>;
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
    updateMany(filter: FilterQuery<TSchema>, update: UpdateQuery<TSchema>): Promise<UpdateResult>;
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
    deleteOne(filter: FilterQuery<TSchema>): Promise<DeleteResult>;
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
    deleteMany(filter: FilterQuery<TSchema>): Promise<DeleteResult>;
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
    aggregate(pipeline: PipelineStage[]): Promise<Document[]>;
    /**
     * Execute aggregation with cursor for large result sets.
     *
     * @param pipeline - Array pipeline stage objects
     * @param _options - Cursor options (batchSize)
     * @returns AsyncCursor for streaming results
     */
    aggregateWithCursor(pipeline: PipelineStage[], _options?: {
        batchSize?: number;
    }): Promise<Cursor<Document>>;
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
    createIndex(fields: IndexFields, options?: IndexOptions): Promise<string>;
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
    dropIndex(indexName: string): Promise<void>;
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
    listIndexes(): Promise<IndexInfo[]>;
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
    createVectorIndex(field: string, options?: {
        dimensions?: number;
        metric?: 'euclidean' | 'cosine' | 'inner_product';
    }): Promise<void>;
    /**
     * Perform an approximate/exact nearest neighbor search.
     *
     * @param queryVector - Vector to search for
     * @param limit - Maximum documents to return (default 10)
     * @param filter - Optional filter to pre-filter documents
     * @returns Array of closest documents
     */
    vectorSearch(queryVector: number[], limit?: number, filter?: FilterQuery<TSchema>): Promise<TSchema[]>;
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
    createGeoIndex(field: string, options?: {
        type?: '2dsphere' | '2d';
        min?: number;
        max?: number;
    }): Promise<void>;
    /**
     * Hide an index — index tetap maintained tapi tidak akan dipilih query planner.
     *
     * Berguna untuk test impact dari dropping index tanpa benar-benar drop.
     *
     * @param indexName - Nama index
     */
    hideIndex(indexName: string): Promise<void>;
    /**
     * Unhide an index — kembalikan ke query planner.
     *
     * @param indexName - Nama index
     */
    unhideIndex(indexName: string): Promise<void>;
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
    autocomplete(field: string, prefix: string, limit?: number): Promise<TSchema[]>;
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
    watch(): EventEmitter;
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
    drop(): Promise<void>;
}
//# sourceMappingURL=collection.d.ts.map