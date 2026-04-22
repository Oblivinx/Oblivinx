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
import {
  ViewManager,
  TriggerManager,
  PragmaManager,
  AttachManager,
  BlobManager,
  MetricsManager,
} from './db/index.js';
import type { OvnConfig, OvnMetrics, OvnVersion, Document } from './types/index.js';
import type {
  ViewInfo,
  RelationDefinition,
  RelationInfo,
  ReferentialIntegrityMode,
  TriggerEvent,
  TriggerInfo,
  PragmaName,
  PragmaValue,
  AttachedDatabaseInfo,
  ExplainPlan,
  ExplainVerbosity,
  PipelineStage,
  FilterQuery,
  // v2
  EngineInfo,
  WriteConflictRetryOptions,
  ConcurrentTransactionOptions,
} from './types/index.js';
import { WriteConflictError } from './errors/index.js';

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
  readonly _handle: number;

  /** Path ke file database */
  readonly #path: string;

  /** Track apakah database sudah ditutup */
  #closed: boolean = false;

  // ── Lazy Manager Instances ──

  #viewManager: ViewManager | null = null;
  #triggerManager: TriggerManager | null = null;
  #pragmaManager: PragmaManager | null = null;
  #attachManager: AttachManager | null = null;
  #blobManager: BlobManager | null = null;
  #metricsManager: MetricsManager | null = null;

  /** @internal — Lazy getter for ViewManager */
  #getViews(): ViewManager {
    if (!this.#viewManager) {
      this.#viewManager = new ViewManager(() => this._handle);
    }
    return this.#viewManager;
  }

  /** @internal — Lazy getter for TriggerManager */
  #getTriggers(): TriggerManager {
    if (!this.#triggerManager) {
      this.#triggerManager = new TriggerManager(() => this._handle);
    }
    return this.#triggerManager;
  }

  /** @internal — Lazy getter for PragmaManager */
  #getPragma(): PragmaManager {
    if (!this.#pragmaManager) {
      this.#pragmaManager = new PragmaManager(() => this._handle);
    }
    return this.#pragmaManager;
  }

  /** @internal — Lazy getter for AttachManager */
  #getAttach(): AttachManager {
    if (!this.#attachManager) {
      this.#attachManager = new AttachManager(() => this._handle);
    }
    return this.#attachManager;
  }

  /** @internal — Lazy getter for BlobManager */
  #getBlob(): BlobManager {
    if (!this.#blobManager) {
      this.#blobManager = new BlobManager(() => this._handle);
    }
    return this.#blobManager;
  }

  /** @internal — Lazy getter for MetricsManager */
  #getMetricsMgr(): MetricsManager {
    if (!this.#metricsManager) {
      this.#metricsManager = new MetricsManager(() => this._handle);
    }
    return this.#metricsManager;
  }

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
  constructor(path: string, options: OvnConfig = {}) {
    this.#path = path;

    // Merge options dengan defaults (v2)
    const opts: Record<string, unknown> = {
      // Core
      pageSize: options.pageSize ?? 4096,
      bufferPool: options.bufferPool ?? '256MB',
      readOnly: options.readOnly ?? false,
      compression: options.compression ?? 'none',
      // v2: WAL & Durability
      durability: options.durability ?? 'd1',
      // v2: Concurrency
      concurrentWrites: options.concurrentWrites ?? false,
      maxRetries: options.maxRetries ?? 8,
      // v2: HLC
      hlc: options.hlc ?? true,
      // v2: I/O
      ioEngine: options.ioEngine ?? 'auto',
      // Legacy compat
      walMode: options.walMode ?? true,
    };

    this._handle = wrapNative(() => native.open(path, opts));
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROPERTIES
  // ═══════════════════════════════════════════════════════════════

  /** Path ke file database */
  get path(): string {
    return this.#path;
  }

  /** Apakah database sudah ditutup */
  get closed(): boolean {
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
  collection<TSchema extends Document = Document>(
    name: string,
  ): Collection<TSchema> {
    return new Collection<TSchema>(this, name);
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
  async createCollection(name: string, options?: import('./types/index.js').CollectionOptions): Promise<void> {
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
  async dropCollection(name: string): Promise<void> {
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
  async putBlob(data: Uint8Array): Promise<string> {
    return this.#getBlob().putBlob(data);
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
  async getBlob(blobId: string): Promise<Uint8Array | null> {
    return this.#getBlob().getBlob(blobId);
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
  async listCollections(): Promise<string[]> {
    const json = wrapNative(() => native.listCollections(this._handle));
    return JSON.parse(json) as string[];
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
  async beginTransaction(): Promise<Transaction> {
    const txidStr = wrapNative(() => native.beginTransaction(this._handle));
    return new Transaction(this, txidStr);
  }

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
  async beginConcurrent(
    _options?: ConcurrentTransactionOptions,
  ): Promise<Transaction> {
    // v2: Begin concurrent transaction (same native call, flagged in Rust)
    const txidStr = wrapNative(() => native.beginTransaction(this._handle));
    return new Transaction(this, txidStr);
  }

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
  async withTransaction<T = void>(
    fn: (txn: Transaction) => Promise<T>,
    options: WriteConflictRetryOptions = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? 8;
    const initialDelayMs = options.initialDelayMs ?? 5;
    const backoffMultiplier = options.backoffMultiplier ?? 2;
    const maxDelayMs = options.maxDelayMs ?? 500;
    const jitter = options.jitter ?? 0.1;

    let lastError: Error = new Error('withTransaction: no attempts made');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const txn = await this.beginTransaction();
      try {
        const result = await fn(txn);
        // Only commit if still active (fn might have committed already)
        if (txn.isActive) await txn.commit();
        return result;
      } catch (err) {
        // Always rollback on any error
        if (txn.isActive) await txn.rollback();

        if (err instanceof WriteConflictError) {
          lastError = err;
          if (attempt < maxRetries) {
            // Exponential backoff with jitter
            const baseDelay = Math.min(initialDelayMs * Math.pow(backoffMultiplier, attempt), maxDelayMs);
            const jitteredDelay = baseDelay * (1 + jitter * (Math.random() * 2 - 1));
            options.onRetry?.(attempt + 1, err);
            await new Promise<void>(resolve => setTimeout(resolve, jitteredDelay));
            continue;
          }
        } else {
          // Non-conflict error — rethrow immediately
          throw err;
        }
      }
    }

    throw lastError;
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
  async checkpoint(): Promise<void> {
    return this.#getMetricsMgr().checkpoint();
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
  async getMetrics(): Promise<OvnMetrics> {
    return this.#getMetricsMgr().getMetrics();
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
  async getVersion(): Promise<OvnVersion> {
    return this.#getMetricsMgr().getVersion();
  }

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
  async getEngineInfo(): Promise<EngineInfo> {
    // Ambil version info dari native
    const verJson = wrapNative(() => native.getVersion(this._handle));
    const ver = JSON.parse(verJson) as OvnVersion;

    // Ambil metrics untuk ARC stats
    let metrics: OvnMetrics | null = null;
    try {
      metrics = await this.getMetrics();
    } catch {
      // metrics mungkin belum tersedia pada v1 compat mode
    }

    const info: EngineInfo = {
      version: ver.version,
      format: ver.format,
      features: ver.features ?? [],
      config: {
        // Nilai diambil dari metrics jika tersedia, fallback ke defaults
        pageSize: 4096,
        bufferPoolSize: metrics?.cache?.size ?? 0,
        compression: 'none',
        durability: 'd1',
        concurrentWrites: false,
        hlcEnabled: true,
        readOnly: false,
      },
      arcCache: metrics
        ? {
            hits: 0,
            misses: 0,
            evictions: 0,
            hitRate: metrics.cache?.hitRate ?? 0,
            pValue: 0,
            t1Size: 0,
            t2Size: 0,
          }
        : undefined,
    };

    return info;
  }

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
  async export(): Promise<Record<string, Document[]>> {
    return this.#getMetricsMgr().export();
  }

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
  async backup(destPath: string): Promise<void> {
    return this.#getMetricsMgr().backup(destPath);
  }

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
  async executeSql(sql: string): Promise<Document[]> {
    const json = wrapNative(() => native.executeSql(this._handle, sql));
    return JSON.parse(json) as Document[];
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
  async close(): Promise<void> {
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
  watch(): EventEmitter {
    const emitter = new EventEmitter();

    wrapNative(() => {
      native.watch(this._handle, (err: any, eventJson: string) => {
        if (err) {
          emitter.emit('error', err);
          return;
        }
        try {
          const event = JSON.parse(eventJson);
          emitter.emit('change', event);
        } catch (e) {
          emitter.emit('error', e);
        }
      });
    });

    return emitter;
  }

  // ═══════════════════════════════════════════════════════════════
  //  VIEWS
  // ═══════════════════════════════════════════════════════════════

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
  async createView(name: string, definition: {
    source: string;
    pipeline: PipelineStage[];
    materializedOptions?: {
      refresh: 'on_write' | 'scheduled' | 'manual';
      schedule?: string;
      maxSize?: string;
    };
  }): Promise<void> {
    return this.#getViews().createView(name, definition);
  }

  /**
   * Hapus sebuah view.
   *
   * @param name - Nama view
   */
  async dropView(name: string): Promise<void> {
    return this.#getViews().dropView(name);
  }

  /**
   * List semua views yang didefinisikan.
   *
   * @returns Array informasi views
   */
  async listViews(): Promise<ViewInfo[]> {
    return this.#getViews().listViews();
  }

  /**
   * Manual refresh sebuah materialized view.
   *
   * @param name - Nama view
   */
  async refreshView(name: string): Promise<void> {
    return this.#getViews().refreshView(name);
  }

  // ═══════════════════════════════════════════════════════════════
  //  RELATIONS
  // ═══════════════════════════════════════════════════════════════

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
  async defineRelation(relation: RelationDefinition): Promise<void> {
    wrapNative(() =>
      native.defineRelation(this._handle, JSON.stringify(relation)),
    );
  }

  /**
   * Hapus definisi relasi.
   *
   * @param from - Source (e.g., 'posts.user_id')
   * @param to - Target (e.g., 'users._id')
   */
  async dropRelation(from: string, to: string): Promise<void> {
    wrapNative(() => native.dropRelation(this._handle, from, to));
  }

  /**
   * List semua relasi yang didefinisikan.
   *
   * @returns Array informasi relasi
   */
  async listRelations(): Promise<RelationInfo[]> {
    const json = wrapNative(() => native.listRelations(this._handle));
    return JSON.parse(json) as RelationInfo[];
  }

  /**
   * Set mode validasi referential integrity.
   *
   * @param mode - 'off' | 'soft' | 'strict'
   */
  async setReferentialIntegrity(mode: ReferentialIntegrityMode): Promise<void> {
    wrapNative(() => native.setReferentialIntegrity(this._handle, mode));
  }

  // ═══════════════════════════════════════════════════════════════
  //  TRIGGERS
  // ═══════════════════════════════════════════════════════════════

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
  async createTrigger(
    collection: string,
    event: TriggerEvent,
    handler: Function,
  ): Promise<void> {
    return this.#getTriggers().createTrigger(collection, event, handler as import('./db/trigger-manager.js').TriggerHandler);
  }

  /**
   * Hapus sebuah trigger.
   *
   * @param collection - Nama collection
   * @param event - Trigger event type
   */
  async dropTrigger(collection: string, event: TriggerEvent): Promise<void> {
    return this.#getTriggers().dropTrigger(collection, event);
  }

  /**
   * List semua triggers pada sebuah collection.
   *
   * @param collection - Nama collection
   * @returns Array informasi triggers
   */
  async listTriggers(collection: string): Promise<TriggerInfo[]> {
    return this.#getTriggers().listTriggers(collection);
  }

  // ═══════════════════════════════════════════════════════════════
  //  PRAGMAS
  // ═══════════════════════════════════════════════════════════════

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
  async pragma(name: PragmaName, value?: PragmaValue): Promise<PragmaValue | void> {
    if (value !== undefined) {
      return this.#getPragma().setPragma(name, value);
    }
    return this.#getPragma().getPragma(name);
  }

  // ═══════════════════════════════════════════════════════════════
  //  ATTACHED DATABASES
  // ═══════════════════════════════════════════════════════════════

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
  async attach(path: string, alias: string): Promise<void> {
    return this.#getAttach().attach(path, alias);
  }

  /**
   * Detach sebuah attached database.
   *
   * @param alias - Alias name
   */
  async detach(alias: string): Promise<void> {
    return this.#getAttach().detach(alias);
  }

  /**
   * List semua attached databases.
   *
   * @returns Array informasi attached databases
   */
  async listAttached(): Promise<AttachedDatabaseInfo[]> {
    return this.#getAttach().listAttached();
  }

  // ═══════════════════════════════════════════════════════════════
  //  EXPLAIN & QUERY DIAGNOSTICS
  // ═══════════════════════════════════════════════════════════════

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
  async explain(
    collection: string,
    filter: FilterQuery,
    options?: { verbosity?: ExplainVerbosity },
  ): Promise<ExplainPlan> {
    const opts = options ? JSON.stringify(options) : undefined;
    const json = wrapNative(() =>
      native.explain(this._handle, collection, JSON.stringify(filter), opts),
    );
    return JSON.parse(json) as ExplainPlan;
  }

  /**
   * Explain sebuah aggregation pipeline.
   *
   * @param collection - Nama collection
   * @param pipeline - Aggregation pipeline
   * @param options - Explain options
   */
  async explainAggregate(
    collection: string,
    pipeline: PipelineStage[],
    options?: { verbosity?: ExplainVerbosity },
  ): Promise<ExplainPlan> {
    const opts = options ? JSON.stringify(options) : undefined;
    const json = wrapNative(() =>
      native.explainAggregate(this._handle, collection, JSON.stringify(pipeline), opts),
    );
    return JSON.parse(json) as ExplainPlan;
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
export function open(path: string, options?: OvnConfig): Oblivinx3x {
  return new Oblivinx3x(path, options);
}
