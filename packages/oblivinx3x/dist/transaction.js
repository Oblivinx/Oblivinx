/**
 * @module transaction
 *
 * Oblivinx3x Transaction Class.
 *
 * Transaction menyediakan ACID guarantees dengan Snapshot Isolation.
 * Semua operasi dalam satu transaction melihat snapshot konsisten
 * dari database pada saat transaction dimulai.
 *
 * Lifecycle:
 * ```
 * beginTransaction() → insert/update/delete → commit() atau rollback()
 * ```
 *
 * Setelah `commit()` atau `rollback()`, transaction tidak bisa digunakan lagi.
 *
 * @example
 * ```typescript
 * const txn = await db.beginTransaction();
 * try {
 *   // Transfer saldo antar akun (atomik)
 *   await txn.update('accounts', { id: 'src' }, { $inc: { balance: -500 } });
 *   await txn.update('accounts', { id: 'dst' }, { $inc: { balance: 500 } });
 *   await txn.commit();
 *   console.log('Transfer berhasil');
 * } catch (err) {
 *   await txn.rollback();
 *   console.error('Transfer gagal, di-rollback:', err);
 *   throw err;
 * }
 * ```
 *
 * @packageDocumentation
 */
import { native } from './loader.js';
import { OvnError, wrapNative } from './errors/index.js';
/**
 * Sebuah MVCC transaction yang sedang aktif.
 *
 * Transaction memberikan jaminan ACID:
 * - **Atomicity**: Semua operasi dalam transaction berhasil seluruhnya atau gagal seluruhnya
 * - **Consistency**: Database selalu dalam state yang valid
 * - **Isolation**: Snapshot Isolation — transaction tidak melihat perubahan dari transaction lain
 * - **Durability**: Setelah commit, data tersimpan permanen
 *
 * @example
 * ```typescript
 * const txn = await db.beginTransaction();
 *
 * // Semua operasi ini bersifat atomik
 * await txn.insert('audit_log', { action: 'transfer', timestamp: Date.now() });
 * await txn.update('accounts', { id: 'a' }, { $inc: { balance: -100 } });
 * await txn.update('accounts', { id: 'b' }, { $inc: { balance: 100 } });
 *
 * await txn.commit(); // Semua operasi diterapkan sekaligus
 * ```
 */
export class Transaction {
    /** Referensi ke database parent */
    #db;
    /** Transaction ID (string representation of u64, menghindari precision loss JS) */
    #txid;
    /** Track apakah transaction sudah di-commit */
    #committed = false;
    /** Track apakah transaction sudah di-abort/rollback */
    #aborted = false;
    /**
     * Buat instance Transaction baru.
     *
     * @param db - Instance database parent
     * @param txid - Transaction ID dari native engine (string)
     *
     * @internal — Jangan panggil constructor langsung.
     * Gunakan `db.beginTransaction()` sebagai gantinya.
     */
    constructor(db, txid) {
        this.#db = db;
        this.#txid = txid;
    }
    // ═══════════════════════════════════════════════════════════════
    //  PROPERTIES
    // ═══════════════════════════════════════════════════════════════
    /**
     * Transaction ID.
     *
     * Disimpan sebagai string untuk menghindari precision loss
     * (JavaScript Number hanya aman sampai 2^53, tapi txid adalah u64).
     */
    get id() {
        return this.#txid;
    }
    /** Apakah transaction sudah di-commit */
    get committed() {
        return this.#committed;
    }
    /** Apakah transaction sudah di-abort/rollback */
    get aborted() {
        return this.#aborted;
    }
    // ═══════════════════════════════════════════════════════════════
    //  OPERATIONS
    // ═══════════════════════════════════════════════════════════════
    /**
     * Insert dokumen dalam konteks transaction ini.
     *
     * Dokumen yang di-insert hanya terlihat setelah `commit()`.
     *
     * @param collection - Nama collection
     * @param doc - Dokumen yang akan di-insert
     * @returns ID dokumen yang di-insert
     *
     * @throws {OvnError} Jika transaction sudah selesai
     *
     * @example
     * ```typescript
     * const id = await txn.insert('users', { name: 'Alice', age: 28 });
     * ```
     */
    async insert(collection, doc) {
        this.#assertActive();
        return wrapNative(() => native.insert(this.#db._handle, collection, JSON.stringify(doc)));
    }
    /**
     * Update dokumen dalam konteks transaction ini.
     *
     * Perubahan hanya terlihat setelah `commit()`.
     *
     * @param collection - Nama collection
     * @param filter - Filter untuk menemukan dokumen
     * @param update - Update expression
     * @returns Jumlah dokumen yang dimodifikasi
     *
     * @throws {OvnError} Jika transaction sudah selesai
     * @throws {WriteConflictError} Jika terjadi konflik dengan transaction lain
     *
     * @example
     * ```typescript
     * const modified = await txn.update(
     *   'accounts',
     *   { userId: 'u1' },
     *   { $inc: { balance: -200 } },
     * );
     * ```
     */
    async update(collection, filter, update) {
        this.#assertActive();
        return wrapNative(() => native.update(this.#db._handle, collection, JSON.stringify(filter), JSON.stringify(update)));
    }
    /**
     * Delete dokumen dalam konteks transaction ini.
     *
     * Penghapusan hanya berlaku setelah `commit()`.
     *
     * @param collection - Nama collection
     * @param filter - Filter untuk menemukan dokumen yang akan dihapus
     * @returns Jumlah dokumen yang dihapus
     *
     * @throws {OvnError} Jika transaction sudah selesai
     *
     * @example
     * ```typescript
     * const deleted = await txn.delete('temp_data', { expired: true });
     * ```
     */
    async delete(collection, filter) {
        this.#assertActive();
        return wrapNative(() => native.delete(this.#db._handle, collection, JSON.stringify(filter)));
    }
    // ═══════════════════════════════════════════════════════════════
    //  LIFECYCLE
    // ═══════════════════════════════════════════════════════════════
    /**
     * Commit transaction — semua write menjadi visible untuk reader berikutnya.
     *
     * Setelah commit, transaction tidak bisa digunakan lagi.
     *
     * @throws {OvnError} Jika transaction sudah selesai
     * @throws {WriteConflictError} Jika terjadi konflik saat commit
     *
     * @example
     * ```typescript
     * await txn.commit();
     * console.log('Transaction berhasil di-commit');
     * ```
     */
    async commit() {
        this.#assertActive();
        wrapNative(() => native.commitTransaction(this.#db._handle, this.#txid));
        this.#committed = true;
    }
    /**
     * Rollback (abort) transaction — semua write dibuang.
     *
     * Aman untuk dipanggil berkali-kali (idempotent).
     * Jika transaction sudah committed atau aborted, tidak melakukan apa-apa.
     *
     * @example
     * ```typescript
     * try {
     *   await txn.update('accounts', { id: 'a' }, { $inc: { balance: -100 } });
     *   await txn.commit();
     * } catch (err) {
     *   await txn.rollback(); // Selalu aman dipanggil
     *   throw err;
     * }
     * ```
     */
    async rollback() {
        // Idempotent: jika sudah selesai, skip tanpa error
        if (this.#committed || this.#aborted)
            return;
        wrapNative(() => native.abortTransaction(this.#db._handle, this.#txid));
        this.#aborted = true;
    }
    // ═══════════════════════════════════════════════════════════════
    //  PRIVATE HELPERS
    // ═══════════════════════════════════════════════════════════════
    /**
     * Guard: pastikan transaction masih aktif.
     *
     * @throws {OvnError} Jika transaction sudah committed atau aborted
     */
    #assertActive() {
        if (this.#committed) {
            throw new OvnError('Transaction sudah di-commit dan tidak bisa digunakan lagi', 'TXN_COMMITTED');
        }
        if (this.#aborted) {
            throw new OvnError('Transaction sudah di-rollback dan tidak bisa digunakan lagi', 'TXN_ABORTED');
        }
    }
}
//# sourceMappingURL=transaction.js.map