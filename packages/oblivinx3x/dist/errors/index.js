/**
 * @module errors
 *
 * Oblivinx3x Error Hierarchy.
 *
 * Menyediakan class-class error terstruktur yang memetakan
 * error codes dari Rust engine ke typed JavaScript exceptions.
 *
 * Hierarki:
 * ```
 * Error
 * └── OvnError (base — semua error Oblivinx3x)
 *     ├── CollectionNotFoundError
 *     ├── CollectionExistsError
 *     ├── WriteConflictError
 *     └── ValidationError
 * ```
 *
 * Setiap error memiliki:
 * - `code` — machine-readable error code (string)
 * - `collection` — nama collection terkait (jika relevan)
 * - Stack trace yang benar (menunjuk ke caller, bukan ke constructor error)
 *
 * @packageDocumentation
 */
// ═══════════════════════════════════════════════════════════════════
//  BASE ERROR
// ═══════════════════════════════════════════════════════════════════
/**
 * Base class untuk semua error Oblivinx3x.
 *
 * Menyediakan informasi terstruktur berupa error code
 * dan optional collection name untuk debugging yang lebih mudah.
 *
 * @example
 * ```typescript
 * try {
 *   await db.collection('users').insertOne({ name: 'Alice' });
 * } catch (err) {
 *   if (err instanceof OvnError) {
 *     console.error(`[${err.code}] ${err.message}`);
 *     // Output: [COLLECTION_NOT_FOUND] Collection 'users' not found
 *   }
 * }
 * ```
 */
export class OvnError extends Error {
    /** Machine-readable error code untuk programmatic error handling */
    code;
    /** Nama collection yang terkait dengan error (jika ada) */
    collection;
    /**
     * Buat instance OvnError baru.
     *
     * @param message - Pesan error yang human-readable
     * @param code - Error code (default: 'OVN_ERROR')
     * @param collection - Nama collection (opsional)
     */
    constructor(message, code = 'OVN_ERROR', collection) {
        super(message);
        this.name = 'OvnError';
        this.code = code;
        this.collection = collection;
        // Pastikan stack trace menunjuk ke caller, bukan ke constructor ini
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, OvnError);
        }
    }
}
// ═══════════════════════════════════════════════════════════════════
//  SPECIFIC ERROR CLASSES
// ═══════════════════════════════════════════════════════════════════
/**
 * Dilempar ketika collection tidak ditemukan (dan auto-create tidak aktif).
 *
 * @example
 * ```typescript
 * try {
 *   await db.dropCollection('nonexistent');
 * } catch (err) {
 *   if (err instanceof CollectionNotFoundError) {
 *     console.log(`Collection "${err.collection}" tidak ada`);
 *   }
 * }
 * ```
 */
export class CollectionNotFoundError extends OvnError {
    constructor(name) {
        super(`Collection '${name}' not found`, 'COLLECTION_NOT_FOUND', name);
        this.name = 'CollectionNotFoundError';
    }
}
/**
 * Dilempar ketika mencoba membuat collection yang sudah ada.
 *
 * @example
 * ```typescript
 * try {
 *   await db.createCollection('users'); // sudah ada
 * } catch (err) {
 *   if (err instanceof CollectionExistsError) {
 *     console.log('Collection sudah ada, skip...');
 *   }
 * }
 * ```
 */
export class CollectionExistsError extends OvnError {
    constructor(name) {
        super(`Collection '${name}' already exists`, 'COLLECTION_EXISTS', name);
        this.name = 'CollectionExistsError';
    }
}
/**
 * Dilempar ketika terjadi write-write conflict dalam MVCC transaction.
 *
 * Biasanya terjadi ketika dua transaction mencoba mengubah dokumen yang sama
 * secara bersamaan. Solusi: retry transaction.
 *
 * @example
 * ```typescript
 * try {
 *   await txn.commit();
 * } catch (err) {
 *   if (err instanceof WriteConflictError) {
 *     // Retry logic
 *     console.log('Write conflict, retrying...');
 *   }
 * }
 * ```
 */
export class WriteConflictError extends OvnError {
    constructor(message) {
        super(message, 'WRITE_CONFLICT');
        this.name = 'WriteConflictError';
    }
}
/**
 * Dilempar ketika dokumen gagal validasi JSON Schema.
 *
 * @example
 * ```typescript
 * try {
 *   await users.insertOne({ age: 'bukan_angka' });
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     console.log('Dokumen tidak valid:', err.message);
 *   }
 * }
 * ```
 */
export class ValidationError extends OvnError {
    constructor(message) {
        super(message, 'VALIDATION_ERROR');
        this.name = 'ValidationError';
    }
}
// ═══════════════════════════════════════════════════════════════════
//  NATIVE ERROR WRAPPER
// ═══════════════════════════════════════════════════════════════════
/**
 * Wrap pemanggilan native addon dalam error handling.
 *
 * Fungsi ini menangkap error dari Rust engine dan mengonversinya
 * menjadi typed OvnError instances berdasarkan pola pesan error.
 *
 * Mapping error:
 * - "Collection '...' not found"  → CollectionNotFoundError
 * - "... already exists"          → CollectionExistsError
 * - "Write conflict" / "WRITE_CONFLICT" → WriteConflictError
 * - "validation" / "Validation"   → ValidationError
 * - Lainnya                      → OvnError (generic)
 *
 * @template T — Tipe return value dari fungsi native
 * @param fn — Fungsi yang memanggil native addon
 * @returns Hasil dari fungsi native
 * @throws {OvnError} atau subclass-nya jika terjadi error
 *
 * @internal — Helper ini tidak di-export ke public API.
 *
 * @example
 * ```typescript
 * const result = wrapNative(() => native.insert(handle, 'users', jsonStr));
 * ```
 */
export function wrapNative(fn) {
    try {
        return fn();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Deteksi pattern: Collection not found
        if (msg.includes("Collection '") && msg.includes('not found')) {
            const match = msg.match(/Collection '([^']+)'/);
            throw new CollectionNotFoundError(match?.[1] ?? 'unknown');
        }
        // Deteksi pattern: Collection already exists
        if (msg.includes('already exists')) {
            const match = msg.match(/Collection '([^']+)'/);
            throw new CollectionExistsError(match?.[1] ?? 'unknown');
        }
        // Deteksi pattern: Write conflict
        if (msg.includes('Write conflict') || msg.includes('WRITE_CONFLICT')) {
            throw new WriteConflictError(msg);
        }
        // Deteksi pattern: Validation error
        if (msg.includes('validation') || msg.includes('Validation')) {
            throw new ValidationError(msg);
        }
        // Fallback: generic OvnError
        throw new OvnError(msg);
    }
}
//# sourceMappingURL=index.js.map