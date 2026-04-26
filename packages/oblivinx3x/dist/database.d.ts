/**
 * @module database
 *
 * Oblivinx3x Database Class — Entry Point Utama.
 *
 * Class ini mengelola lifecycle file database `.ovn`,
 * menyediakan akses ke collections, transactions,
 * dan API maintenance/metrics.
 *
 * ## Architecture
 *
 * ```
 * Oblivinx3x (database.ts)
 *     ├── Collection (collection.ts) — CRUD, aggregation, indexing
 *     ├── Transaction (transaction.ts) — MVCC atomic operations
 *     └── Native Addon (loader.ts) — Rust engine via Neon FFI
 * ```
 *
 * ## Usage Pattern
 *
 * ```typescript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * // 1. Buka database
 * const db = new Oblivinx3x('data.ovn', { compression: 'lz4' });
 *
 * // 2. Gunakan collection
 * const users = db.collection<User>('users');
 * await users.insertOne({ name: 'Alice', age: 28 });
 *
 * // 3. Tutup saat selesai
 * await db.close();
 * ```
 *
 * @packageDocumentation
 */
import { EventEmitter } from 'node:events';
import { Collection } from './collection.js';
import { Transaction } from './transaction.js';
import type { OvnConfig, OvnMetrics, OvnVersion, Document } from './types/index.js';
import type { ViewInfo, RelationDefinition, RelationInfo, ReferentialIntegrityMode, TriggerEvent, TriggerInfo, PragmaName, PragmaValue, AttachedDatabaseInfo, ExplainPlan, ExplainVerbosity, PipelineStage, FilterQuery, EngineInfo, WriteConflictRetryOptions, ConcurrentTransactionOptions } from './types/index.js';
/**
 * Class utama Oblivinx3x Database.
 *
 * Mengelola lifecycle sebuah file database `.ovn`,
 * menyediakan akses ke collections, transactions,
 * dan API untuk maintenance serta observability.
 *
 * @example
 * ```typescript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * // Buka/buat database dengan konfigurasi
 * const db = new Oblivinx3x('data.ovn', {
 *   pageSize: 4096,
 *   bufferPool: '128MB',
 *   compression: 'lz4',
 * });
 *
 * // Buat collection (opsional — collection dibuat auto saat insert pertama)
 * await db.createCollection('users');
 *
 * // Akses collection dengan typed schema
 * interface User extends Document {
 *   name: string;
 *   age: number;
 *   email: string;
 * }
 * const users = db.collection<User>('users');
 * await users.insertOne({ name: 'Alice', age: 28, email: 'alice@example.com' });
 *
 * // Performance metrics
 * const metrics = await db.getMetrics();
 * console.log(`Cache hit rate: ${(metrics.cache.hitRate * 100).toFixed(1)}%`);
 *
 * // Graceful close
 * await db.close();
 * ```
 */
export declare class Oblivinx3x {
    #private;
    /**
     * Native engine handle (integer index ke internal DATABASES vec).
     *
     * Digunakan oleh Collection dan Transaction untuk mengakses engine.
     * Jangan diubah secara manual.
     *
     * @internal
     */
    readonly _handle: number;
    /**
     * Buka atau buat database Oblivinx3x.
     *
     * Jika file belum ada, akan dibuat otomatis beserta parent directories.
     * Jika file sudah ada, akan dibuka dan di-recover dari WAL jika perlu.
     *
     * @param path - Path ke file database `.ovn`.
     *   File dan parent directories akan dibuat jika belum ada.
     * @param options - Konfigurasi database (semua optional)
     *
     * @throws {OvnError} Jika database gagal dibuka:
     *   - File corrupt
     *   - Permission denied
     *   - Konfigurasi tidak valid (misal pageSize bukan power of 2)
     *
     * @example
     * ```typescript
     * // Dengan default config (v2)
     * const db = new Oblivinx3x('data.ovn2');
     *
     * // Dengan custom config v2
     * const db = new Oblivinx3x('data.ovn2', {
     *   compression: 'lz4',
     *   bufferPool: '512MB',
     *   durability: 'd1',          // Group commit (default)
     *   concurrentWrites: false,   // Single-writer mode (safe default)
     *   hlc: true,                 // HLC TxIDs
     * });
     *
     * // Open v1 file (read-only compat mode)
     * const db = new Oblivinx3x('legacy.ovn');
     * // db.closed === false, but all writes will throw OvnReadOnlyError
     * ```
     */
    constructor(path: string, options?: OvnConfig);
    /** Path ke file database */
    get path(): string;
    /** Apakah database sudah ditutup */
    get closed(): boolean;
    /**
     * Dapatkan referensi ke sebuah collection.
     *
     * Collection dibuat otomatis saat dokumen pertama di-insert.
     * Untuk membuat collection secara eksplisit (misal untuk set validator),
     * gunakan `createCollection()`.
     *
     * @template TSchema - Type schema dokumen dalam collection.
     *   Harus extend `Document`. Default: `Document`.
     * @param name - Nama collection
     * @returns Instance Collection yang siap digunakan
     *
     * @example
     * ```typescript
     * // Collection tanpa schema (dynamic)
     * const logs = db.collection('logs');
     *
     * // Collection dengan typed schema
     * interface User extends Document {
     *   name: string;
     *   age: number;
     * }
     * const users = db.collection<User>('users');
     * ```
     */
    collection<TSchema extends Document = Document>(name: string): Collection<TSchema>;
    /**
     * Buat collection secara eksplisit.
     *
     * Secara default, collection dibuat otomatis saat insert pertama.
     * Method ini berguna jika ingin membuat collection kosong terlebih dahulu.
     *
     * @param name - Nama collection
     *
     * @throws {CollectionExistsError} Jika collection sudah ada
     *
     * @example
     * ```typescript
     * await db.createCollection('users');
     * await db.createCollection('orders');
     * ```
     */
    createCollection(name: string, options?: import('./types/index.js').CollectionOptions): Promise<void>;
    /**
     * Hapus collection beserta semua data dan index-nya.
     *
     * ⚠️ Operasi ini tidak bisa di-undo!
     *
     * @param name - Nama collection yang akan dihapus
     *
     * @throws {CollectionNotFoundError} Jika collection tidak ada
     *
     * @example
     * ```typescript
     * await db.dropCollection('temp_data');
     * ```
     */
    dropCollection(name: string): Promise<void>;
    /**
     * Simpan data binary (Blob/GridFS Equivalent) langsung ke storage engine.
     * Data akan dipisah ke dalam chunk secara efisien oleh Storage Engine.
     *
     * @param data - Buffer atau Uint8Array data yang akan disimpan.
     * @returns String UUID dari Blob yang disimpan.
     *
     * @example
     * ```typescript
     * const fs = require('fs');
     * const buffer = fs.readFileSync('video.mp4');
     * const blobId = await db.putBlob(buffer);
     * console.log('Saved blob:', blobId);
     * ```
     */
    putBlob(data: Uint8Array): Promise<string>;
    /**
     * Ambil data binary (Blob) dari storage engine berdasarkan UUID nya.
     *
     * @param blobId - UUID string dari Blob.
     * @returns Uint8Array data dari blob, atau null jika tidak ditemukan.
     *
     * @example
     * ```typescript
     * const blobData = await db.getBlob('123e4567-e89b-12d3-a456-426614174000');
     * if (blobData) {
     *   fs.writeFileSync('output.mp4', blobData);
     * }
     * ```
     */
    getBlob(blobId: string): Promise<Uint8Array | null>;
    /**
     * List semua nama collection yang ada di database.
     *
     * @returns Array nama-nama collection
     *
     * @example
     * ```typescript
     * const collections = await db.listCollections();
     * console.log('Collections:', collections);
     * // Output: ['users', 'orders', 'products']
     * ```
     */
    listCollections(): Promise<string[]>;
    /**
     * Mulai MVCC transaction baru.
     *
     * Semua reads dalam transaction melihat snapshot konsisten
     * yang diambil pada saat ini. Gunakan `commit()` untuk menerapkan
     * writes atau `rollback()` untuk membatalkannya.
     *
     * @returns Instance Transaction yang siap digunakan
     *
     * @example
     * ```typescript
     * const txn = await db.beginTransaction();
     * try {
     *   // Operasi atomik
     *   await txn.update('accounts', { id: 'a' }, { $inc: { balance: -100 } });
     *   await txn.update('accounts', { id: 'b' }, { $inc: { balance: 100 } });
     *   await txn.commit();
     * } catch (err) {
     *   await txn.rollback();
     *   throw err;
     * }
     * ```
     */
    beginTransaction(): Promise<Transaction>;
    /**
     * BEGIN CONCURRENT — mulai MVCC transaction dengan optimistic concurrency (v2).
     *
     * Sama seperti `beginTransaction()` namun menandai transaction sebagai
     * "concurrent writer" — engine akan mencoba resolve write conflicts
     * secara optimistic menggunakan HLC snapshot ordering.
     *
     * ⚠️ Membutuhkan `concurrentWrites: true` di OvnConfig saat buka database.
     *    Jika tidak diaktifkan, akan fallback ke beginTransaction() biasa.
     *
     * @param options - Optional: label dan autoRetry settings
     * @returns Instance Transaction
     *
     * @example
     * ```typescript
     * // Buka dengan concurrentWrites diaktifkan
     * const db = new Oblivinx3x('data.ovn2', { concurrentWrites: true });
     *
     * // Dua writer berjalan bersamaan
     * const [txn1, txn2] = await Promise.all([
     *   db.beginConcurrent({ label: 'writer-1' }),
     *   db.beginConcurrent({ label: 'writer-2' }),
     * ]);
     * ```
     */
    beginConcurrent(_options?: ConcurrentTransactionOptions): Promise<Transaction>;
    /**
     * Execute operasi dalam satu ACID transaction dengan auto-retry on WriteConflict.
     *
     * Pattern yang direkomendasikan untuk operasi transaksional yang mungkin
     * mengalami write conflict (terutama saat `concurrentWrites: true`).
     *
     * ## Retry Behavior
     * - Jika `fn` melempar `WriteConflictError`, transaction di-rollback dan dicoba ulang
     * - Retry dengan exponential backoff + jitter untuk mencegah thundering herd
     * - Maksimum retry default: 8 (sesuai `max_retries` di OvnConfig)
     *
     * @param fn - Async function yang menerima Transaction dan menjalankan operasi
     * @param options - Retry options (maxRetries, backoff, dll)
     * @returns Return value dari `fn`
     *
     * @throws {WriteConflictError} Jika masih conflict setelah maxRetries
     * @throws Jika `fn` melempar error selain WriteConflict
     *
     * @example
     * ```typescript
     * // Transfer atomik dengan auto-retry
     * await db.withTransaction(async (txn) => {
     *   const [from] = await txn.find('accounts', { _id: 'alice' });
     *   const [to] = await txn.find('accounts', { _id: 'bob' });
     *   if ((from.balance as number) < 100) throw new Error('Insufficient funds');
     *   await txn.update('accounts', { _id: 'alice' }, { $inc: { balance: -100 } });
     *   await txn.update('accounts', { _id: 'bob' },   { $inc: { balance: +100 } });
     * });
     * ```
     */
    withTransaction<T = void>(fn: (txn: Transaction) => Promise<T>, options?: WriteConflictRetryOptions): Promise<T>;
    /**
     * Force checkpoint — flush semua dirty MemTable pages ke disk dan clear WAL.
     *
     * Dipanggil otomatis saat `close()`. Berguna untuk long-running applications
     * yang ingin memastikan durabilitas secara periodik.
     *
     * @example
     * ```typescript
     * // Periodik checkpoint setiap 5 menit
     * setInterval(async () => {
     *   await db.checkpoint();
     *   console.log('Checkpoint completed');
     * }, 5 * 60 * 1000);
     * ```
     */
    checkpoint(): Promise<void>;
    /**
     * Dapatkan database performance and storage metrics.
     *
     * Metrics meliputi:
     * - **I/O**: Pages read/written
     * - **Cache**: Buffer pool hit rate dan size
     * - **Transactions**: Active count
     * - **Storage**: B+ tree entries, MemTable size, SSTable count
     *
     * @returns Object metrics yang komprehensif
     *
     * @example
     * ```typescript
     * const metrics = await db.getMetrics();
     *
     * console.log(`Cache hit rate: ${(metrics.cache.hitRate * 100).toFixed(1)}%`);
     * console.log(`B+ tree entries: ${metrics.storage.btreeEntries}`);
     * console.log(`MemTable: ${(metrics.storage.memtableSize / 1024).toFixed(0)} KB`);
     * ```
     */
    getMetrics(): Promise<OvnMetrics>;
    /**
     * Dapatkan informasi versi engine dan library.
     *
     * @returns Object berisi engine name, version, format, dan supported features
     *
     * @example
     * ```typescript
     * const ver = await db.getVersion();
     * console.log(`${ver.engine} v${ver.version} (${ver.format})`);
     * console.log(`Features: ${ver.features.join(', ')}`);
     * ```
     */
    getVersion(): Promise<OvnVersion>;
    /**
     * Dapatkan info lengkap engine v2 — versi + konfigurasi aktif + statistik.
     *
     * Berbeda dengan `getVersion()` yang hanya mengembalikan versi dasar,
     * method ini mengembalikan informasi komprehensif tentang:
     * - Versi dan format file aktif
     * - Konfigurasi yang digunakan (durability, concurrentWrites, HLC, dll)
     * - Statistik WAL group commit
     * - Statistik ARC buffer pool cache
     * - HLC timestamp terakhir
     *
     * @returns EngineInfo — informasi lengkap engine v2
     *
     * @example
     * ```typescript
     * const info = await db.getEngineInfo();
     * console.log(`Engine: ${info.version} (${info.format})`);
     * console.log(`Durability: ${info.config.durability}`);
     * console.log(`ARC hit rate: ${(info.arcCache?.hitRate ?? 0) * 100}%`);
     * console.log(`WAL group commits: ${info.wal?.groupCommits ?? 0}`);
     * ```
     */
    getEngineInfo(): Promise<EngineInfo>;
    /**
     * Export seluruh database sebagai JSON object.
     *
     * Mengembalikan object dengan collection names sebagai keys dan
     * arrays of documents sebagai values.
     *
     * @returns Object berisi semua collections dan documents
     *
     * @example
     * ```typescript
     * const data = await db.export();
     * console.log(data.users); // Array of user documents
     * console.log(data.orders); // Array of order documents
     * ```
     */
    export(): Promise<Record<string, Document[]>>;
    /**
     * Backup database ke file JSON.
     *
     * Melakukan checkpoint terlebih dahulu, kemudian export
     * semua data ke file JSON di path yang ditentukan.
     *
     * @param destPath - Path ke file backup destination
     *
     * @example
     * ```typescript
     * await db.backup('backup-2024-01-01.json');
     * ```
     */
    backup(destPath: string): Promise<void>;
    /**
     * Execute a SQL-like query and return results.
     *
     * Supports: SELECT, INSERT, UPDATE, DELETE with WHERE, ORDER BY, LIMIT, SKIP.
     *
     * @param sql - SQL query string
     * @returns Query results as array of documents
     *
     * @example
     * ```typescript
     * const users = await db.executeSql('SELECT name, age FROM users WHERE age > 18 ORDER BY name DESC LIMIT 10');
     * ```
     */
    executeSql(sql: string): Promise<Document[]>;
    /**
     * Tutup database dengan graceful.
     *
     * Melakukan:
     * 1. Flush semua dirty pages
     * 2. Write final checkpoint
     * 3. Clear WAL active flag
     *
     * Setelah close, database instance tidak boleh digunakan lagi.
     * Idempotent: aman dipanggil berkali-kali.
     *
     * @example
     * ```typescript
     * const db = new Oblivinx3x('data.ovn');
     * try {
     *   // ... operasi database ...
     * } finally {
     *   await db.close();
     * }
     * ```
     */
    close(): Promise<void>;
    /**
     * Watch for real-time change stream events across the database.
     *
     * @returns Node.js EventEmitter emitting 'change' and 'error' events
     *
     * @example
     * ```typescript
     * const changeStream = db.watch();
     * changeStream.on('change', (event) => {
     *   console.log('DB Change:', event.opType, event.namespace);
     * });
     * ```
     */
    watch(): EventEmitter;
    /**
     * Buat logical view — stored query yang selalu live data.
     *
     * @param name - Nama view
     * @param definition - View definition (source + pipeline)
     *
     * @example
     * ```typescript
     * await db.createView('active_users', {
     *   source: 'users',
     *   pipeline: [
     *     { $match: { active: true } },
     *     { $project: { name: 1, email: 1 } }
     *   ]
     * });
     * ```
     */
    createView(name: string, definition: {
        source: string;
        pipeline: PipelineStage[];
        materializedOptions?: {
            refresh: 'on_write' | 'scheduled' | 'manual';
            schedule?: string;
            maxSize?: string;
        };
    }): Promise<void>;
    /**
     * Hapus sebuah view.
     *
     * @param name - Nama view
     */
    dropView(name: string): Promise<void>;
    /**
     * List semua views yang didefinisikan.
     *
     * @returns Array informasi views
     */
    listViews(): Promise<ViewInfo[]>;
    /**
     * Manual refresh sebuah materialized view.
     *
     * @param name - Nama view
     */
    refreshView(name: string): Promise<void>;
    /**
     * Definisikan relasi foreign-key-like antar collections.
     *
     * @param relation - Relation definition
     *
     * @example
     * ```typescript
     * await db.defineRelation({
     *   from: 'posts.user_id',
     *   to: 'users._id',
     *   type: 'many-to-one',
     *   onDelete: 'cascade',
     *   onUpdate: 'restrict',
     *   indexed: true
     * });
     * ```
     */
    defineRelation(relation: RelationDefinition): Promise<void>;
    /**
     * Hapus definisi relasi.
     *
     * @param from - Source (e.g., 'posts.user_id')
     * @param to - Target (e.g., 'users._id')
     */
    dropRelation(from: string, to: string): Promise<void>;
    /**
     * List semua relasi yang didefinisikan.
     *
     * @returns Array informasi relasi
     */
    listRelations(): Promise<RelationInfo[]>;
    /**
     * Set mode validasi referential integrity.
     *
     * @param mode - 'off' | 'soft' | 'strict'
     */
    setReferentialIntegrity(mode: ReferentialIntegrityMode): Promise<void>;
    /**
     * Register sebuah trigger pada collection.
     *
     * @param collection - Nama collection
     * @param event - Trigger event type
     * @param handler - Trigger function (akan dipanggil saat event terjadi)
     *
     * @example
     * ```typescript
     * await db.createTrigger('users', 'beforeInsert', async (doc, ctx) => {
     *   if (!doc.email) throw new Error('email is required');
     *   doc.createdAt = Date.now();
     *   return doc;
     * });
     * ```
     */
    createTrigger(collection: string, event: TriggerEvent, handler: Function): Promise<void>;
    /**
     * Hapus sebuah trigger.
     *
     * @param collection - Nama collection
     * @param event - Trigger event type
     */
    dropTrigger(collection: string, event: TriggerEvent): Promise<void>;
    /**
     * List semua triggers pada sebuah collection.
     *
     * @param collection - Nama collection
     * @returns Array informasi triggers
     */
    listTriggers(collection: string): Promise<TriggerInfo[]>;
    /**
     * Set atau read sebuah pragma (engine directive).
     *
     * Pragmas persist across sessions di Metadata Segment.
     *
     * @param name - Pragma name
     * @param value - Value to set (omit untuk read)
     *
     * @example
     * ```typescript
     * await db.pragma('foreign_keys', true);
     * await db.pragma('synchronous', 'full');
     * const mode = await db.pragma('synchronous'); // read
     * ```
     */
    pragma(name: PragmaName, value?: PragmaValue): Promise<PragmaValue | void>;
    /**
     * Attach sebuah .ovn file dengan alias.
     *
     * @param path - Path ke file .ovn
     * @param alias - Alias name (tidak boleh konflik dengan collection names)
     *
     * @example
     * ```typescript
     * await db.attach('analytics.ovn', 'analytics');
     * const events = await db.find('analytics.events', { type: 'purchase' });
     * ```
     */
    attach(path: string, alias: string): Promise<void>;
    /**
     * Detach sebuah attached database.
     *
     * @param alias - Alias name
     */
    detach(alias: string): Promise<void>;
    /**
     * List semua attached databases.
     *
     * @returns Array informasi attached databases
     */
    listAttached(): Promise<AttachedDatabaseInfo[]>;
    /**
     * Explain sebuah find query — return execution plan tanpa execute query.
     *
     * @param collection - Nama collection
     * @param filter - Filter expression
     * @param options - Explain options
     *
     * @example
     * ```typescript
     * const plan = await db.explain('users', { age: { $gt: 18 } });
     * console.log(plan.chosenIndex); // 'age_1' or null
     * console.log(plan.scanType);    // 'indexScan' | 'collectionScan'
     * ```
     */
    explain(collection: string, filter: FilterQuery, options?: {
        verbosity?: ExplainVerbosity;
    }): Promise<ExplainPlan>;
    /**
     * Explain sebuah aggregation pipeline.
     *
     * @param collection - Nama collection
     * @param pipeline - Aggregation pipeline
     * @param options - Explain options
     */
    explainAggregate(collection: string, pipeline: PipelineStage[], options?: {
        verbosity?: ExplainVerbosity;
    }): Promise<ExplainPlan>;
}
/**
 * Alias untuk class `Oblivinx3x`.
 *
 * Disediakan untuk kenyamanan bagi developer yang lebih familiar
 * dengan penamaan generik.
 *
 * @example
 * ```typescript
 * import { Database } from 'oblivinx3x';
 * const db = new Database('data.ovn');
 * ```
 */
export { Oblivinx3x as Database };
/**
 * Buka database (functional API).
 *
 * Shorthand untuk `new Oblivinx3x(path, options)`.
 *
 * @param path - Path ke file database `.ovn`
 * @param options - Konfigurasi database (opsional)
 * @returns Instance Oblivinx3x yang sudah terbuka
 *
 * @example
 * ```typescript
 * import { open } from 'oblivinx3x';
 *
 * const db = open('data.ovn', { compression: 'lz4' });
 * const users = db.collection('users');
 * await users.insertOne({ name: 'Alice' });
 * await db.close();
 * ```
 */
export declare function open(path: string, options?: OvnConfig): Oblivinx3x;
//# sourceMappingURL=database.d.ts.map