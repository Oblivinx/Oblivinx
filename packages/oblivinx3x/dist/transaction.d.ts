/**
 * @module transaction
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Oblivinx3x — MVCC Transaction Manager
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Menyediakan ACID transaction dengan jaminan Snapshot Isolation.
 * Semua operasi dalam satu transaction melihat *snapshot konsisten* dari
 * database pada saat `beginTransaction()` dipanggil — tidak ada dirty read
 * dari transaction lain yang belum commit.
 *
 * ## Lifecycle
 *
 * ```
 * db.beginTransaction()
 *       │
 *       ▼
 *   Transaction (state: active)
 *       │
 *   insert / update / delete / savepoint / rollbackToSavepoint
 *       │
 *       ├──commit()──► state: committed  (writes visible)
 *       │
 *       └──rollback()─► state: aborted   (writes discarded)
 * ```
 *
 * Setelah `commit()` atau `rollback()`, semua method akan melempar
 * `OvnError('ERR_INVALID_OPERATION')`.
 *
 * ## Quick Start
 *
 * ```typescript
 * import { Oblivinx3x } from 'oblivinx3x';
 *
 * const db = new Oblivinx3x('data.ovn');
 * const txn = await db.beginTransaction();
 *
 * try {
 *   // Semua operasi bersifat atomik (berhasil semua atau gagal semua)
 *   await txn.update('accounts', { _id: 'alice' }, { $inc: { balance: -500 } });
 *   await txn.update('accounts', { _id: 'bob' },   { $inc: { balance:  500 } });
 *   await txn.commit();
 * } catch (err) {
 *   await txn.rollback(); // Idempotent — aman dipanggil berkali-kali
 *   throw err;
 * }
 *
 * await db.close();
 * ```
 *
 * ## Savepoint (Partial Rollback)
 *
 * ```typescript
 * const txn = await db.beginTransaction();
 *
 * await txn.savepoint('sp1');        // Tandai titik checkpoint
 * // ... operasi berisiko ...
 * await txn.rollbackToSavepoint('sp1'); // Undo hanya sejak savepoint
 * await txn.commit();                // Commit sisa operasi
 * ```
 *
 * @packageDocumentation
 */
import type { Document, FilterQuery, UpdateQuery } from './types/index.js';
import type { Oblivinx3x } from './database.js';
/**
 * Status lifecycle sebuah transaction.
 *
 * - `active`    — Transaction sedang berjalan, bisa menerima operasi
 * - `committed` — Transaction berhasil di-commit, seluruh write sudah visible
 * - `aborted`   — Transaction di-rollback, seluruh write dibuang
 */
export type TransactionState = 'active' | 'committed' | 'aborted';
/**
 * Snapshot informasi state transaction.
 * Berguna untuk debugging dan observability.
 */
export interface TransactionInfo {
    /** ID unik transaction dari native engine (string u64) */
    txid: string;
    /** Status saat ini */
    state: TransactionState;
    /** Jumlah savepoint aktif dalam transaction ini */
    savepointCount: number;
}
/**
 * MVCC Transaction — unit atomik operasi database.
 *
 * Memberikan jaminan ACID penuh:
 * - **Atomicity** : Semua operasi berhasil, atau seluruhnya di-rollback
 * - **Consistency**: Database tetap dalam state valid setelah commit
 * - **Isolation** : Snapshot Isolation — tidak ada dirty/phantom read
 * - **Durability** : Setelah commit, data persisten di WAL + storage
 *
 * ⚠️ Jangan buat instance ini langsung.
 *    Gunakan `db.beginTransaction()` sebagai entry point.
 *
 * @example
 * ```typescript
 * // Transfer atomik — keduanya berhasil atau keduanya di-rollback
 * const txn = await db.beginTransaction();
 * try {
 *   await txn.update('accounts', { _id: 'src' }, { $inc: { balance: -100 } });
 *   await txn.update('accounts', { _id: 'dst' }, { $inc: { balance:  100 } });
 *   await txn.commit();
 * } catch {
 *   await txn.rollback();
 * }
 * ```
 */
export declare class Transaction {
    #private;
    /**
     * @internal — Jangan panggil constructor langsung.
     * Gunakan `db.beginTransaction()`.
     *
     * @param db   - Database parent (diperlukan untuk native handle)
     * @param txid - Transaction ID dari native engine (string)
     */
    constructor(db: Oblivinx3x, txid: string);
    /**
     * Transaction ID unik dari native engine.
     *
     * Berguna untuk logging, debugging, dan observability.
     * Format: string representation dari `u64`.
     */
    get id(): string;
    /**
     * State lifecycle transaction saat ini.
     *
     * @returns `'active'` | `'committed'` | `'aborted'`
     */
    get state(): TransactionState;
    /**
     * `true` jika transaction masih aktif dan bisa menerima operasi.
     * Shorthand untuk `txn.state === 'active'`.
     */
    get isActive(): boolean;
    /**
     * `true` jika transaction sudah di-commit.
     * Setelah ini, tidak ada operasi yang bisa dilakukan.
     */
    get committed(): boolean;
    /**
     * `true` jika transaction sudah di-abort/rollback.
     * Setelah ini, tidak ada operasi yang bisa dilakukan.
     */
    get aborted(): boolean;
    /**
     * Snapshot informasi transaction — berguna untuk debugging.
     *
     * @example
     * ```typescript
     * console.log(txn.info);
     * // { txid: '42', state: 'active', savepointCount: 1 }
     * ```
     */
    get info(): TransactionInfo;
    /**
     * Insert satu dokumen dalam konteks transaction ini.
     *
     * Dokumen yang di-insert **tidak akan terlihat** oleh reader lain
     * sampai `commit()` dipanggil. Jika transaction di-rollback,
     * dokumen ini akan hilang sepenuhnya.
     *
     * @param collection - Nama collection tujuan
     * @param doc        - Dokumen yang akan di-insert
     * @returns ID dokumen yang di-insert (UUID v4 string)
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     *
     * @example
     * ```typescript
     * const id = await txn.insert('users', { name: 'Alice', age: 28 });
     * console.log('Inserted with ID:', id);
     * ```
     */
    insert(collection: string, doc: Document): Promise<string>;
    /**
     * Insert banyak dokumen sekaligus dalam konteks transaction ini.
     *
     * Lebih efisien dibanding memanggil `insert()` berulang kali
     * karena hanya satu round-trip ke native engine.
     *
     * @param collection - Nama collection tujuan
     * @param docs       - Array dokumen yang akan di-insert
     * @returns Array ID yang di-insert, berurutan sesuai input
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     *
     * @example
     * ```typescript
     * const ids = await txn.insertMany('products', [
     *   { name: 'Laptop', price: 15000000 },
     *   { name: 'Mouse',  price:   250000 },
     * ]);
     * // ids: ['uuid-1', 'uuid-2']
     * ```
     */
    insertMany(collection: string, docs: Document[]): Promise<string[]>;
    /**
     * Update dokumen pertama yang cocok dalam konteks transaction ini.
     *
     * Perubahan **tidak akan terlihat** sampai `commit()` dipanggil.
     * Jika terdapat konflik dengan transaction lain yang commit lebih dulu,
     * akan dilempar `WriteConflictError`.
     *
     * @param collection - Nama collection
     * @param filter     - MQL filter untuk menemukan dokumen
     * @param update     - Update expression (e.g., `{ $set: { name: 'Bob' } }`)
     * @returns Jumlah dokumen yang berhasil diubah (`0` atau `1`)
     *
     * @throws {OvnError}            `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     * @throws {WriteConflictError}  Jika terjadi write conflict dengan transaction lain
     *
     * @example
     * ```typescript
     * const modified = await txn.update(
     *   'accounts',
     *   { _id: 'alice' },
     *   { $inc: { balance: -200 } },
     * );
     * ```
     */
    update(collection: string, filter: FilterQuery, update: UpdateQuery): Promise<number>;
    /**
     * Update **semua** dokumen yang cocok dalam konteks transaction ini.
     *
     * @param collection - Nama collection
     * @param filter     - MQL filter untuk menemukan dokumen
     * @param update     - Update expression
     * @returns Jumlah dokumen yang berhasil diubah
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     *
     * @example
     * ```typescript
     * const count = await txn.updateMany(
     *   'orders',
     *   { status: 'pending' },
     *   { $set: { status: 'processing' } },
     * );
     * ```
     */
    updateMany(collection: string, filter: FilterQuery, update: UpdateQuery): Promise<number>;
    /**
     * Hapus dokumen pertama yang cocok dalam konteks transaction ini.
     *
     * Penghapusan **hanya berlaku** setelah `commit()` dipanggil.
     *
     * @param collection - Nama collection
     * @param filter     - MQL filter untuk menemukan dokumen yang akan dihapus
     * @returns Jumlah dokumen yang dihapus (`0` atau `1`)
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     *
     * @example
     * ```typescript
     * const deleted = await txn.delete('temp_data', { expired: true });
     * ```
     */
    delete(collection: string, filter: FilterQuery): Promise<number>;
    /**
     * Hapus **semua** dokumen yang cocok dalam konteks transaction ini.
     *
     * @param collection - Nama collection
     * @param filter     - MQL filter untuk menemukan dokumen yang akan dihapus
     * @returns Jumlah dokumen yang dihapus
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     *
     * @example
     * ```typescript
     * const total = await txn.deleteMany('logs', { level: 'debug' });
     * ```
     */
    deleteMany(collection: string, filter: FilterQuery): Promise<number>;
    /**
     * Buat savepoint — checkpoint dalam write set transaction ini.
     *
     * Savepoint memberi kemampuan untuk rollback sebagian operasi
     * tanpa membatalkan seluruh transaction. Maksimum savepoint depth
     * dikontrol oleh pragma `max_savepoint_depth` (default: 16).
     *
     * @param name - Nama savepoint (harus unik dalam transaction ini)
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     * @throws {OvnError} `ERR_SAVEPOINT_EXISTS`  — jika nama sudah dipakai
     *
     * @example
     * ```typescript
     * await txn.savepoint('before_bulk_insert');
     * try {
     *   for (const item of items) await txn.insert('items', item);
     * } catch {
     *   await txn.rollbackToSavepoint('before_bulk_insert');
     * }
     * await txn.commit();
     * ```
     */
    savepoint(name: string): Promise<void>;
    /**
     * Rollback ke savepoint — undo semua write sejak savepoint dibuat.
     *
     * Savepoint **tidak dihapus** setelah rollback — kamu bisa rollback
     * ke savepoint yang sama berulang kali. Untuk menghapusnya, gunakan
     * `releaseSavepoint()`.
     *
     * @param name - Nama savepoint yang dituju
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION`  — jika transaction tidak aktif
     * @throws {OvnError} `ERR_SAVEPOINT_NOT_FOUND` — jika savepoint tidak ditemukan
     *
     * @example
     * ```typescript
     * await txn.rollbackToSavepoint('before_risky_op');
     * // State kembali ke titik saat savepoint dibuat
     * ```
     */
    rollbackToSavepoint(name: string): Promise<void>;
    /**
     * Release savepoint — hapus checkpoint dan merge write set ke parent scope.
     *
     * Berbeda dengan `rollbackToSavepoint`, method ini **tidak** mengundo
     * operasi yang dilakukan setelah savepoint. Berguna sebagai cleanup
     * ketika operasi dalam scope savepoint berhasil.
     *
     * @param name - Nama savepoint yang akan di-release
     *
     * @throws {OvnError} `ERR_INVALID_OPERATION`  — jika transaction tidak aktif
     * @throws {OvnError} `ERR_SAVEPOINT_NOT_FOUND` — jika savepoint tidak ditemukan
     *
     * @example
     * ```typescript
     * await txn.savepoint('batch');
     * // ... insert banyak dokumen ...
     * await txn.releaseSavepoint('batch'); // Berhasil — hapus savepoint
     * await txn.commit();                  // Commit semuanya
     * ```
     */
    releaseSavepoint(name: string): Promise<void>;
    /**
     * Commit transaction — terapkan semua write permanen ke database.
     *
     * Setelah commit berhasil:
     * - Semua write menjadi visible untuk reader berikutnya
     * - State berubah menjadi `'committed'`
     * - Seluruh savepoint dihapus
     * - Transaction tidak bisa digunakan lagi
     *
     * Jika terjadi `WriteConflictError`, transaction harus di-rollback
     * dan operasi bisa dicoba ulang.
     *
     * @throws {OvnError}           `ERR_INVALID_OPERATION` — jika transaction tidak aktif
     * @throws {WriteConflictError} Jika terjadi konflik dengan transaction lain
     *
     * @example
     * ```typescript
     * await txn.commit();
     * console.log('Transaction berhasil, state:', txn.state); // 'committed'
     * ```
     */
    commit(): Promise<void>;
    /**
     * Rollback (abort) transaction — buang semua write.
     *
     * **Idempotent** — aman dipanggil berkali-kali:
     * - Jika sudah committed atau aborted, tidak melakukan apa-apa
     * - Selalu aman diletakkan di `finally` block
     *
     * @example
     * ```typescript
     * const txn = await db.beginTransaction();
     * try {
     *   await txn.update('accounts', { _id: 'alice' }, { $inc: { balance: -100 } });
     *   await txn.commit();
     * } catch (err) {
     *   await txn.rollback(); // Buang semua perubahan
     *   throw err;
     * }
     * ```
     */
    rollback(): Promise<void>;
}
//# sourceMappingURL=transaction.d.ts.map