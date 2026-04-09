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
import type { Document, FilterQuery, UpdateQuery } from './types/index.js';
import type { Oblivinx3x } from './database.js';
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
export declare class Transaction {
    #private;
    /**
     * Buat instance Transaction baru.
     *
     * @param db - Instance database parent
     * @param txid - Transaction ID dari native engine (string)
     *
     * @internal — Jangan panggil constructor langsung.
     * Gunakan `db.beginTransaction()` sebagai gantinya.
     */
    constructor(db: Oblivinx3x, txid: string);
    /**
     * Transaction ID.
     *
     * Disimpan sebagai string untuk menghindari precision loss
     * (JavaScript Number hanya aman sampai 2^53, tapi txid adalah u64).
     */
    get id(): string;
    /** Apakah transaction sudah di-commit */
    get committed(): boolean;
    /** Apakah transaction sudah di-abort/rollback */
    get aborted(): boolean;
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
    insert(collection: string, doc: Document): Promise<string>;
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
    update(collection: string, filter: FilterQuery, update: UpdateQuery): Promise<number>;
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
    delete(collection: string, filter: FilterQuery): Promise<number>;
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
    commit(): Promise<void>;
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
    rollback(): Promise<void>;
}
//# sourceMappingURL=transaction.d.ts.map