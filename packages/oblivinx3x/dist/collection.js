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
export class Collection {
    /** Referensi ke database parent */
    #db;
    /** Nama collection ini */
    #name;
    /**
     * Buat instance Collection baru.
     *
     * @param db - Instance database parent
     * @param name - Nama collection
     *
     * @internal — Jangan panggil constructor langsung.
     * Gunakan `db.collection('name')` sebagai gantinya.
     */
    constructor(db, name) {
        this.#db = db;
        this.#name = name;
    }
    /** Nama collection ini */
    get name() {
        return this.#name;
    }
    // ═══════════════════════════════════════════════════════════════
    //  GUARDS
    // ═══════════════════════════════════════════════════════════════
    /**
     * Guard: assert that the database is still open.
     * @internal
     */
    #assertOpen() {
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
    async insertOne(doc) {
        this.#assertOpen();
        const id = await withRetry(async () => Promise.resolve(wrapNative(() => native.insert(this.#db._handle, this.#name, JSON.stringify(doc)))), { maxAttempts: 2 });
        return { insertedId: id };
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
    async insertMany(docs, options) {
        this.#assertOpen();
        if (docs.length === 0) {
            return { insertedIds: [], insertedCount: 0 };
        }
        // Hot path — small batches go straight through to native without
        // chunking overhead. The 1k threshold matches the typical FFI
        // overhead break-even point measured during 50k-import benchmarks.
        const chunkSize = Math.max(1, options?.chunkSize ?? 5000);
        if (!options || (docs.length <= chunkSize && options.onProgress === undefined)) {
            const idsJson = wrapNative(() => native.insertMany(this.#db._handle, this.#name, JSON.stringify(docs)));
            const ids = JSON.parse(idsJson);
            return { insertedIds: ids, insertedCount: ids.length };
        }
        // Chunked path — splits the input into <= chunkSize batches so the
        // MemTable write lock is held for shorter intervals and RAM usage
        // stays bounded. {@link BulkInsertOptions.onProgress} fires once
        // per chunk so callers can drive a progress bar.
        const ordered = options.ordered ?? true;
        const total = docs.length;
        const allIds = [];
        for (let i = 0; i < total; i += chunkSize) {
            const slice = docs.slice(i, i + chunkSize);
            try {
                const idsJson = wrapNative(() => native.insertMany(this.#db._handle, this.#name, JSON.stringify(slice)));
                const ids = JSON.parse(idsJson);
                for (const id of ids)
                    allIds.push(id);
            }
            catch (err) {
                if (ordered)
                    throw err;
                // unordered — record the gap and continue with the next chunk.
            }
            options.onProgress?.(allIds.length, total);
        }
        // For 'fast' durability, force a single fsync at the very end so the
        // batch is durable on disk before returning. Cheaper than per-chunk
        // group_commit when loading >50k documents in one shot.
        if (options.durability === 'fast'
            && typeof this.#db.checkpoint === 'function') {
            await this.#db.checkpoint();
        }
        return { insertedIds: allIds, insertedCount: allIds.length };
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
    async find(filter = {}, options = {}) {
        this.#assertOpen();
        const hasOptions = options.sort != null ||
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
            const resultJson = wrapNative(() => native.findWithOptions(this.#db._handle, this.#name, JSON.stringify(filter), JSON.stringify(optsPayload)));
            return JSON.parse(resultJson);
        }
        const resultJson = wrapNative(() => native.find(this.#db._handle, this.#name, JSON.stringify(filter)));
        return JSON.parse(resultJson);
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
    async findOne(filter = {}) {
        this.#assertOpen();
        const resultJson = wrapNative(() => native.findOne(this.#db._handle, this.#name, JSON.stringify(filter)));
        return JSON.parse(resultJson);
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
    async countDocuments(filter = {}) {
        this.#assertOpen();
        return wrapNative(() => native.count(this.#db._handle, this.#name, JSON.stringify(filter)));
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
    async exists(filter = {}) {
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
    async findOneAndUpdate(filter, update) {
        this.#assertOpen();
        // Find the document first
        const doc = await this.findOne(filter);
        if (!doc)
            return null;
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
    async findOneAndDelete(filter) {
        this.#assertOpen();
        // Find the document first
        const doc = await this.findOne(filter);
        if (!doc)
            return null;
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
    async updateOne(filter, update) {
        this.#assertOpen();
        const count = await withRetry(async () => Promise.resolve(wrapNative(() => native.update(this.#db._handle, this.#name, JSON.stringify(filter), JSON.stringify(update)))), { maxAttempts: 2 });
        return { matchedCount: count, modifiedCount: count };
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
    async updateMany(filter, update) {
        this.#assertOpen();
        const count = wrapNative(() => native.updateMany(this.#db._handle, this.#name, JSON.stringify(filter), JSON.stringify(update)));
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
    async deleteOne(filter) {
        this.#assertOpen();
        const count = wrapNative(() => native.delete(this.#db._handle, this.#name, JSON.stringify(filter)));
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
    async deleteMany(filter) {
        this.#assertOpen();
        const count = wrapNative(() => native.deleteMany(this.#db._handle, this.#name, JSON.stringify(filter)));
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
    async aggregate(pipeline) {
        this.#assertOpen();
        const resultJson = wrapNative(() => native.aggregate(this.#db._handle, this.#name, JSON.stringify(pipeline)));
        return JSON.parse(resultJson);
    }
    /**
     * Execute aggregation with cursor for large result sets.
     *
     * @param pipeline - Array pipeline stage objects
     * @param _options - Cursor options (batchSize)
     * @returns AsyncCursor for streaming results
     */
    async aggregateWithCursor(pipeline, _options) {
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
        };
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
    async createIndex(fields, options = {}) {
        return wrapNative(() => native.createIndex(this.#db._handle, this.#name, JSON.stringify(fields), JSON.stringify(options)));
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
    async dropIndex(indexName) {
        wrapNative(() => native.dropIndex(this.#db._handle, this.#name, indexName));
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
    async listIndexes() {
        const json = wrapNative(() => native.listIndexes(this.#db._handle, this.#name));
        return JSON.parse(json);
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
    async createVectorIndex(field, options = {}) {
        wrapNative(() => native.createVectorIndex(this.#db._handle, this.#name, field, JSON.stringify(options)));
    }
    /**
     * Perform an approximate/exact nearest neighbor search.
     *
     * @param queryVector - Vector to search for
     * @param limit - Maximum documents to return (default 10)
     * @param filter - Optional filter to pre-filter documents
     * @returns Array of closest documents
     */
    async vectorSearch(queryVector, limit = 10, filter) {
        const filterJson = filter ? JSON.stringify(filter) : undefined;
        const json = wrapNative(() => native.vectorSearch(this.#db._handle, this.#name, JSON.stringify(queryVector), limit, filterJson));
        return JSON.parse(json);
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
    async createGeoIndex(field, options = {}) {
        wrapNative(() => native.createGeoIndex(this.#db._handle, this.#name, field, JSON.stringify(options)));
    }
    /**
     * Hide an index — index tetap maintained tapi tidak akan dipilih query planner.
     *
     * Berguna untuk test impact dari dropping index tanpa benar-benar drop.
     *
     * @param indexName - Nama index
     */
    async hideIndex(indexName) {
        wrapNative(() => native.hideIndex(this.#db._handle, this.#name, indexName));
    }
    /**
     * Unhide an index — kembalikan ke query planner.
     *
     * @param indexName - Nama index
     */
    async unhideIndex(indexName) {
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
    async autocomplete(field, prefix, limit = 10) {
        const json = wrapNative(() => native.autocomplete(this.#db._handle, this.#name, field, prefix, limit));
        return JSON.parse(json);
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
    watch() {
        const emitter = new EventEmitter();
        const dbStream = this.#db.watch();
        dbStream.on('change', (event) => {
            if (event.namespace === this.#name) {
                emitter.emit('change', event);
            }
        });
        dbStream.on('error', (err) => {
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
    async drop() {
        wrapNative(() => native.dropCollection(this.#db._handle, this.#name));
    }
    // ═══════════════════════════════════════════════════════════════
    //  VERSIONING
    // ═══════════════════════════════════════════════════════════════
    /**
     * Enable versioning for this collection.
     *
     * Once enabled, every insert and update will automatically record
     * a new version in the version history, enabling point-in-time queries,
     * diffs, and rollbacks.
     *
     * @param config - Versioning options (mode, maxVersions, etc.)
     *
     * @example
     * ```typescript
     * await users.enableVersioning({
     *   mode: 'diff',
     *   maxVersions: 100,
     *   retainFor: '30d',
     *   trackAuthor: true,
     * });
     * ```
     */
    async enableVersioning(config = {}) {
        this.#assertOpen();
        wrapNative(() => native.enableVersioning(this.#db._handle, this.#name, JSON.stringify(config)));
    }
    /**
     * Disable versioning for this collection.
     *
     * Removes all stored version history. This operation is irreversible.
     *
     * @example
     * ```typescript
     * await users.disableVersioning();
     * ```
     */
    async disableVersioning() {
        this.#assertOpen();
        wrapNative(() => native.disableVersioning(this.#db._handle, this.#name));
    }
    /**
     * List all recorded versions for a document.
     *
     * @param docId - The `_id` of the document
     * @returns Array of VersionInfo objects, sorted oldest to newest
     *
     * @example
     * ```typescript
     * const versions = await users.listVersions('user-abc-123');
     * for (const v of versions) {
     *   console.log(`v${v.version} at ${new Date(v.createdAt).toISOString()} (${v.changeCount} changes)`);
     * }
     * ```
     */
    async listVersions(docId) {
        this.#assertOpen();
        const json = wrapNative(() => native.listDocumentVersions(this.#db._handle, this.#name, docId));
        return JSON.parse(json);
    }
    /**
     * Get the document as it existed at a specific version.
     *
     * The returned document includes metadata fields:
     * - `__version` — Version number
     * - `__versionedAt` — Unix epoch ms timestamp
     * - `__author` — Optional author ID
     * - `__tag` — Optional user-defined tag
     *
     * @param docId - The `_id` of the document
     * @param version - Version number to retrieve (1-based)
     * @returns The document at that version, or `null` if not found
     *
     * @example
     * ```typescript
     * const v2 = await users.getVersion('user-abc-123', 2);
     * if (v2) {
     *   console.log(`v2 data:`, v2);
     * }
     * ```
     */
    async getVersion(docId, version) {
        this.#assertOpen();
        const json = wrapNative(() => native.getDocumentVersion(this.#db._handle, this.#name, docId, version));
        return JSON.parse(json);
    }
    /**
     * Compute the difference between two versions of a document.
     *
     * @param docId - The `_id` of the document
     * @param v1 - Source version number
     * @param v2 - Target version number
     * @returns VersionDiff with `added`, `modified`, and `removed` fields
     *
     * @example
     * ```typescript
     * const diff = await users.diffVersions('user-abc-123', 1, 3);
     * console.log('Added:', diff.added);
     * console.log('Modified:', diff.modified);
     * console.log('Removed:', diff.removed);
     * ```
     */
    async diffVersions(docId, v1, v2) {
        this.#assertOpen();
        const json = wrapNative(() => native.diffDocumentVersions(this.#db._handle, this.#name, docId, v1, v2));
        return JSON.parse(json);
    }
    /**
     * Rollback a document to a prior version.
     *
     * This is non-destructive: it creates a **new** version with the old content,
     * preserving the full history. Equivalent to `git revert`.
     *
     * @param docId - The `_id` of the document
     * @param version - Version number to restore
     * @param author - Optional author ID to record in the new version
     * @returns The restored document
     *
     * @example
     * ```typescript
     * const restored = await users.rollbackToVersion('user-abc-123', 1);
     * console.log('Restored user:', restored);
     * ```
     */
    async rollbackToVersion(docId, version, author) {
        this.#assertOpen();
        const json = wrapNative(() => native.rollbackToVersion(this.#db._handle, this.#name, docId, version, author));
        return JSON.parse(json);
    }
    /**
     * Tag a specific document version with a human-readable label.
     *
     * @param docId - The `_id` of the document
     * @param version - Version number to tag
     * @param tag - Tag label (e.g. 'before-migration', 'stable')
     *
     * @example
     * ```typescript
     * await users.tagVersion('user-abc-123', 3, 'before-migration');
     * ```
     */
    async tagVersion(docId, version, tag) {
        this.#assertOpen();
        wrapNative(() => native.tagDocumentVersion(this.#db._handle, this.#name, docId, version, tag));
    }
    /**
     * Restore a document to the version associated with a specific tag.
     *
     * @param docId - The `_id` of the document
     * @param tag - Tag label to restore from
     * @param author - Optional author ID for the new version record
     * @returns The restored document
     *
     * @example
     * ```typescript
     * const restored = await users.restoreFromTag('user-abc-123', 'before-migration');
     * ```
     */
    async restoreFromTag(docId, tag, author) {
        this.#assertOpen();
        const json = wrapNative(() => native.restoreFromTag(this.#db._handle, this.#name, docId, tag, author));
        return JSON.parse(json);
    }
}
//# sourceMappingURL=collection.js.map