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

// ─────────────────────────────────────────────────────────────────────────────
//  IMPORTS
// ─────────────────────────────────────────────────────────────────────────────

import { native } from './loader.js';
import { OvnError, wrapNative } from './errors/index.js';
import type { Document, FilterQuery, UpdateQuery } from './types/index.js';

// Forward-declare untuk menghindari circular dependency (database <→ transaction)
import type { Oblivinx3x } from './database.js';

// ─────────────────────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
//  TRANSACTION CLASS
// ─────────────────────────────────────────────────────────────────────────────

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
export class Transaction {
  // ─── Private State ─────────────────────────────────────────────────────────

  /** Referensi ke database parent — digunakan untuk mengakses native handle */
  readonly #db: Oblivinx3x;

  /**
   * Transaction ID dari native Rust engine.
   *
   * Disimpan sebagai string karena txid adalah `u64` (unsigned 64-bit integer).
   * JavaScript `Number` hanya aman sampai `2^53`, sehingga akan terjadi
   * precision loss jika disimpan sebagai number.
   */
  readonly #txid: string;

  /**
   * State lifecycle transaction saat ini.
   * Digunakan oleh `#assertActive()` sebagai guard di setiap operasi.
   */
  #state: TransactionState = 'active';

  /**
   * Set of savepoint names yang aktif dalam transaction ini.
   * Dipertahankan di JS layer untuk tracking — native layer juga mengelolanya.
   */
  readonly #savepoints = new Set<string>();

  // ─── Constructor ───────────────────────────────────────────────────────────

  /**
   * @internal — Jangan panggil constructor langsung.
   * Gunakan `db.beginTransaction()`.
   *
   * @param db   - Database parent (diperlukan untuk native handle)
   * @param txid - Transaction ID dari native engine (string)
   */
  constructor(db: Oblivinx3x, txid: string) {
    this.#db = db;
    this.#txid = txid;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PUBLIC PROPERTIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Transaction ID unik dari native engine.
   *
   * Berguna untuk logging, debugging, dan observability.
   * Format: string representation dari `u64`.
   */
  get id(): string {
    return this.#txid;
  }

  /**
   * State lifecycle transaction saat ini.
   *
   * @returns `'active'` | `'committed'` | `'aborted'`
   */
  get state(): TransactionState {
    return this.#state;
  }

  /**
   * `true` jika transaction masih aktif dan bisa menerima operasi.
   * Shorthand untuk `txn.state === 'active'`.
   */
  get isActive(): boolean {
    return this.#state === 'active';
  }

  /**
   * `true` jika transaction sudah di-commit.
   * Setelah ini, tidak ada operasi yang bisa dilakukan.
   */
  get committed(): boolean {
    return this.#state === 'committed';
  }

  /**
   * `true` jika transaction sudah di-abort/rollback.
   * Setelah ini, tidak ada operasi yang bisa dilakukan.
   */
  get aborted(): boolean {
    return this.#state === 'aborted';
  }

  /**
   * Snapshot informasi transaction — berguna untuk debugging.
   *
   * @example
   * ```typescript
   * console.log(txn.info);
   * // { txid: '42', state: 'active', savepointCount: 1 }
   * ```
   */
  get info(): TransactionInfo {
    return {
      txid: this.#txid,
      state: this.#state,
      savepointCount: this.#savepoints.size,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  INSERT OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

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
  async insert(collection: string, doc: Document): Promise<string> {
    this.#assertActive();
    return wrapNative(() =>
      native.insert(this.#db._handle, collection, JSON.stringify(doc)),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  READ OPERATIONS (Snapshot Read)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Query dokumen dalam konteks snapshot transaction ini.
   *
   * Reads dalam transaction melihat **snapshot konsisten** yang diambil
   * saat `beginTransaction()` dipanggil — tidak ada dirty read dari
   * transaction lain. Writes dari transaction ini sendiri langsung visible.
   *
   * @param collection - Nama collection
   * @param filter     - MQL filter expression
   * @returns Array dokumen yang cocok dengan filter
   *
   * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
   *
   * @example
   * ```typescript
   * const txn = await db.beginTransaction();
   * // Read + write dalam satu snapshot
   * const [account] = await txn.find('accounts', { _id: 'alice' });
   * if (account && (account.balance as number) >= 100) {
   *   await txn.update('accounts', { _id: 'alice' }, { $inc: { balance: -100 } });
   *   await txn.commit();
   * } else {
   *   await txn.rollback();
   * }
   * ```
   */
  async find<T extends Document = Document>(
    collection: string,
    filter: FilterQuery<T> = {},
  ): Promise<T[]> {
    this.#assertActive();
    const json = wrapNative(() =>
      native.find(this.#db._handle, collection, JSON.stringify(filter)),
    );
    return JSON.parse(json) as T[];
  }

  /**
   * Temukan satu dokumen dalam konteks snapshot transaction ini.
   *
   * @param collection - Nama collection
   * @param filter     - MQL filter expression
   * @returns Dokumen pertama yang cocok, atau `null` jika tidak ada
   *
   * @throws {OvnError} `ERR_INVALID_OPERATION` — jika transaction tidak aktif
   *
   * @example
   * ```typescript
   * const user = await txn.findOne('users', { email: 'alice@example.com' });
   * if (user) {
   *   await txn.update('users', { _id: user._id }, { $inc: { loginCount: 1 } });
   * }
   * ```
   */
  async findOne<T extends Document = Document>(
    collection: string,
    filter: FilterQuery<T> = {},
  ): Promise<T | null> {
    this.#assertActive();
    const json = wrapNative(() =>
      native.findOne(this.#db._handle, collection, JSON.stringify(filter)),
    );
    const result = JSON.parse(json) as T | null;
    return result;
  }

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
  async insertMany(collection: string, docs: Document[]): Promise<string[]> {
    this.#assertActive();
    const idsJson = wrapNative(() =>
      native.insertMany(this.#db._handle, collection, JSON.stringify(docs)),
    );
    return JSON.parse(idsJson) as string[];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UPDATE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

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
  async update(
    collection: string,
    filter: FilterQuery,
    update: UpdateQuery,
  ): Promise<number> {
    this.#assertActive();
    return wrapNative(() =>
      native.update(
        this.#db._handle,
        collection,
        JSON.stringify(filter),
        JSON.stringify(update),
      ),
    );
  }

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
  async updateMany(
    collection: string,
    filter: FilterQuery,
    update: UpdateQuery,
  ): Promise<number> {
    this.#assertActive();
    return wrapNative(() =>
      native.updateMany(
        this.#db._handle,
        collection,
        JSON.stringify(filter),
        JSON.stringify(update),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DELETE OPERATIONS
  // ═══════════════════════════════════════════════════════════════════════════

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
  async delete(collection: string, filter: FilterQuery): Promise<number> {
    this.#assertActive();
    return wrapNative(() =>
      native.delete(
        this.#db._handle,
        collection,
        JSON.stringify(filter),
      ),
    );
  }

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
  async deleteMany(collection: string, filter: FilterQuery): Promise<number> {
    this.#assertActive();
    return wrapNative(() =>
      native.deleteMany(
        this.#db._handle,
        collection,
        JSON.stringify(filter),
      ),
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SAVEPOINT MANAGEMENT
  //
  //  Savepoint memungkinkan partial rollback di dalam transaction yang sama.
  //  Berguna untuk operasi batch yang mungkin sebagian gagal, tanpa harus
  //  meng-abort seluruh transaction.
  //
  //  Stack semantics:
  //    savepoint('sp1') → savepoint('sp2') → rollbackToSavepoint('sp2')
  //    → kembali ke state saat 'sp2' dibuat (sp1 masih ada)
  // ═══════════════════════════════════════════════════════════════════════════

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
  async savepoint(name: string): Promise<void> {
    this.#assertActive();

    // Guard: nama savepoint harus unik dalam scope transaction ini
    if (this.#savepoints.has(name)) {
      throw new OvnError(
        'ERR_INVALID_OPERATION',
        `Savepoint sudah ada: '${name}'. Gunakan nama yang berbeda.`,
      );
    }

    wrapNative(() =>
      native.savepoint(this.#db._handle, this.#txid, name),
    );

    // Catat di JS layer untuk tracking tanpa harus ke native
    this.#savepoints.add(name);
  }

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
  async rollbackToSavepoint(name: string): Promise<void> {
    this.#assertActive();

    // Guard: savepoint harus ada sebelum bisa di-rollback
    if (!this.#savepoints.has(name)) {
      throw new OvnError(
        'ERR_SAVEPOINT_NOT_FOUND' as any,
        `Savepoint tidak ditemukan: '${name}'`,
      );
    }

    wrapNative(() =>
      native.rollbackToSavepoint(this.#db._handle, this.#txid, name),
    );

    // Hapus semua savepoint yang dibuat SETELAH savepoint ini
    // (karena mereka sudah di-undo oleh rollback)
    let found = false;
    for (const sp of this.#savepoints) {
      if (found) this.#savepoints.delete(sp);
      if (sp === name) found = true;
    }
  }

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
  async releaseSavepoint(name: string): Promise<void> {
    this.#assertActive();

    if (!this.#savepoints.has(name)) {
      throw new OvnError(
        'ERR_SAVEPOINT_NOT_FOUND' as any,
        `Savepoint tidak ditemukan: '${name}'`,
      );
    }

    wrapNative(() =>
      native.releaseSavepoint(this.#db._handle, this.#txid, name),
    );

    this.#savepoints.delete(name);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE — COMMIT & ROLLBACK
  // ═══════════════════════════════════════════════════════════════════════════

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
  async commit(): Promise<void> {
    this.#assertActive();

    wrapNative(() =>
      native.commitTransaction(this.#db._handle, this.#txid),
    );

    // Update state dan bersihkan savepoints
    this.#state = 'committed';
    this.#savepoints.clear();
  }

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
  async rollback(): Promise<void> {
    // Idempotent: jika sudah selesai (committed/aborted), langsung return
    if (this.#state !== 'active') return;

    wrapNative(() =>
      native.abortTransaction(this.#db._handle, this.#txid),
    );

    // Update state dan bersihkan savepoints
    this.#state = 'aborted';
    this.#savepoints.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Guard: pastikan transaction masih dalam state `active`.
   *
   * Dipanggil di awal setiap operasi mutasi dan savepoint.
   * Melempar `OvnError('ERR_INVALID_OPERATION')` jika transaction
   * sudah committed atau aborted.
   *
   * @internal
   */
  #assertActive(): void {
    if (this.#state === 'committed') {
      throw new OvnError(
        'ERR_INVALID_OPERATION',
        `Transaction '${this.#txid}' sudah di-commit. Buat transaction baru via db.beginTransaction().`,
      );
    }
    if (this.#state === 'aborted') {
      throw new OvnError(
        'ERR_INVALID_OPERATION',
        `Transaction '${this.#txid}' sudah di-rollback. Buat transaction baru via db.beginTransaction().`,
      );
    }
  }
}
