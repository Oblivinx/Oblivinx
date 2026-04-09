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
import { native } from './loader.js';
import { wrapNative } from './errors/index.js';
import { Collection } from './collection.js';
import { Transaction } from './transaction.js';
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
export class Oblivinx3x {
    /**
     * Native engine handle (integer index ke internal DATABASES vec).
     *
     * Digunakan oleh Collection dan Transaction untuk mengakses engine.
     * Jangan diubah secara manual.
     *
     * @internal
     */
    _handle;
    /** Path ke file database */
    #path;
    /** Track apakah database sudah ditutup */
    #closed = false;
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
     * // Dengan default config
     * const db = new Oblivinx3x('data.ovn');
     *
     * // Dengan custom config
     * const db = new Oblivinx3x('data.ovn', {
     *   compression: 'lz4',
     *   bufferPool: '128MB',
     *   readOnly: false,
     * });
     * ```
     */
    constructor(path, options = {}) {
        this.#path = path;
        // Merge options dengan defaults
        const opts = {
            pageSize: options.pageSize ?? 4096,
            bufferPool: options.bufferPool ?? '256MB',
            readOnly: options.readOnly ?? false,
            compression: options.compression ?? 'none',
            walMode: options.walMode ?? true,
        };
        this._handle = wrapNative(() => native.open(path, opts));
    }
    // ═══════════════════════════════════════════════════════════════
    //  PROPERTIES
    // ═══════════════════════════════════════════════════════════════
    /** Path ke file database */
    get path() {
        return this.#path;
    }
    /** Apakah database sudah ditutup */
    get closed() {
        return this.#closed;
    }
    // ═══════════════════════════════════════════════════════════════
    //  COLLECTION ACCESS
    // ═══════════════════════════════════════════════════════════════
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
    collection(name) {
        return new Collection(this, name);
    }
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
    async createCollection(name, options) {
        wrapNative(() => native.createCollection(this._handle, name, options != null ? JSON.stringify(options) : undefined));
    }
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
    async dropCollection(name) {
        wrapNative(() => native.dropCollection(this._handle, name));
    }
    // ── BLOB MANAGEMENT ──
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
    async putBlob(data) {
        return wrapNative(() => native.putBlob(this._handle, data));
    }
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
    async getBlob(blobId) {
        return wrapNative(() => native.getBlob(this._handle, blobId));
    }
    // ── TRANSACTION MANAGEMENT ──
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
    async listCollections() {
        const json = wrapNative(() => native.listCollections(this._handle));
        return JSON.parse(json);
    }
    // ═══════════════════════════════════════════════════════════════
    //  TRANSACTIONS
    // ═══════════════════════════════════════════════════════════════
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
    async beginTransaction() {
        const txidStr = wrapNative(() => native.beginTransaction(this._handle));
        return new Transaction(this, txidStr);
    }
    // ═══════════════════════════════════════════════════════════════
    //  MAINTENANCE & OBSERVABILITY
    // ═══════════════════════════════════════════════════════════════
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
    async checkpoint() {
        wrapNative(() => native.checkpoint(this._handle));
    }
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
    async getMetrics() {
        const json = wrapNative(() => native.getMetrics(this._handle));
        return JSON.parse(json);
    }
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
    async getVersion() {
        const json = wrapNative(() => native.getVersion(this._handle));
        return JSON.parse(json);
    }
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
    async close() {
        if (!this.#closed) {
            wrapNative(() => native.close(this._handle));
            this.#closed = true;
        }
    }
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
    watch() {
        const emitter = new EventEmitter();
        wrapNative(() => {
            native.watch(this._handle, (err, eventJson) => {
                if (err) {
                    emitter.emit('error', err);
                    return;
                }
                try {
                    const event = JSON.parse(eventJson);
                    emitter.emit('change', event);
                }
                catch (e) {
                    emitter.emit('error', e);
                }
            });
        });
        return emitter;
    }
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
export function open(path, options) {
    return new Oblivinx3x(path, options);
}
//# sourceMappingURL=database.js.map