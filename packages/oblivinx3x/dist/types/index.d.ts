/**
 * @module types
 *
 * Oblivinx3x — Kumpulan semua type dan interface definitions.
 *
 * File ini berisi seluruh contract types yang digunakan
 * di seluruh library: konfigurasi database, MQL filter & update operators,
 * query options, aggregation pipeline stages, result types, dan native addon interface.
 *
 * @packageDocumentation
 */
export interface TimeSeriesOptions {
    timeField: string;
    metaField?: string;
    granularity?: 'seconds' | 'minutes' | 'hours';
}
export interface CollectionOptions {
    capped?: boolean;
    size?: number;
    max?: number;
    validator?: Record<string, unknown>;
    validationLevel?: 'off' | 'strict' | 'moderate';
    validationAction?: 'error' | 'warn';
    timeseries?: TimeSeriesOptions;
}
/**
 * Konfigurasi untuk membuka database Oblivinx3x.
 *
 * Semua property optional — jika tidak di-set, akan menggunakan default values.
 *
 * @example
 * ```typescript
 * const config: OvnConfig = {
 *   pageSize: 4096,
 *   bufferPool: '256MB',
 *   compression: 'lz4',
 * };
 * ```
 */
export interface OvnConfig {
    /**
     * Ukuran page dalam bytes.
     * Harus power of 2 antara 512 dan 65536.
     * @default 4096
     */
    pageSize?: number;
    /**
     * Ukuran buffer pool. Menerima format string seperti '64MB', '256MB', '1GB'.
     * @default '256MB'
     */
    bufferPool?: string;
    /**
     * Buka database dalam mode read-only. Tidak bisa melakukan write operations.
     * @default false
     */
    readOnly?: boolean;
    /**
     * Algoritma kompresi untuk page storage.
     * - `'none'` — tanpa kompresi (default)
     * - `'lz4'`  — kompresi cepat, rasio sedang
     * - `'zstd'` — kompresi lebih lambat, rasio lebih baik
     * @default 'none'
     */
    compression?: 'none' | 'lz4' | 'zstd';
    /**
     * Aktifkan Write-Ahead Log untuk durabilitas data.
     * Di versi saat ini, WAL selalu aktif.
     * @default true
     */
    walMode?: boolean;
}
/**
 * Tipe dasar dokumen. Semua dokumen dalam Oblivinx3x memiliki field `_id`.
 *
 * Gunakan sebagai base type atau extend dengan interface custom:
 *
 * @example
 * ```typescript
 * interface User extends Document {
 *   name: string;
 *   age: number;
 *   email: string;
 * }
 * ```
 */
export interface Document {
    /** ID unik dokumen (UUID v4 string). Di-generate otomatis jika tidak disediakan. */
    _id?: string;
    /** Field-field dokumen bersifat dynamic */
    [key: string]: unknown;
}
/** Tipe primitif yang bisa digunakan dalam filter comparisons. */
type FilterPrimitive = string | number | boolean | null | Date;
/**
 * Operator perbandingan MongoDB-compatible untuk sebuah field.
 *
 * @example
 * ```typescript
 * // Find users older than 18
 * { age: { $gt: 18 } }
 *
 * // Find users in specific cities
 * { city: { $in: ['Jakarta', 'Bandung', 'Surabaya'] } }
 * ```
 */
export interface ComparisonOperators<T = FilterPrimitive> {
    /** Sama dengan (equal to) */
    $eq?: T;
    /** Tidak sama dengan (not equal to) */
    $ne?: T;
    /** Lebih besar dari (greater than) */
    $gt?: T;
    /** Lebih besar atau sama dengan (greater than or equal) */
    $gte?: T;
    /** Lebih kecil dari (less than) */
    $lt?: T;
    /** Lebih kecil atau sama dengan (less than or equal) */
    $lte?: T;
    /** Value ada dalam array yang diberikan */
    $in?: T[];
    /** Value TIDAK ada dalam array yang diberikan */
    $nin?: T[];
    /** Field ada (true) atau tidak ada (false) */
    $exists?: boolean;
    /** Field cocok dengan regex pattern */
    $regex?: string;
    /** Array mengandung semua value yang diberikan */
    $all?: T[];
    /** Array mengandung elemen yang cocok dengan filter tertentu */
    $elemMatch?: FilterQuery;
    /** Array memiliki jumlah elemen tertentu */
    $size?: number;
    /** Field memiliki BSON type tertentu */
    $type?: string | number;
}
/** Filter expression untuk sebuah field dokumen. */
type FieldFilter<T> = T | ComparisonOperators<T>;
/**
 * Query filter expression yang compatible dengan MongoDB Query Language (MQL).
 *
 * Mendukung:
 * - Field-level comparisons: `{ age: { $gt: 18 } }`
 * - Logical operators: `$and`, `$or`, `$nor`, `$not`
 * - Nested fields via dot notation: `{ 'address.city': 'Jakarta' }`
 *
 * @example
 * ```typescript
 * const filter: FilterQuery<User> = {
 *   $and: [
 *     { age: { $gte: 18 } },
 *     { $or: [{ city: 'Jakarta' }, { city: 'Bandung' }] },
 *   ],
 * };
 * ```
 */
export type FilterQuery<T extends Document = Document> = {
    [K in keyof T]?: FieldFilter<T[K]>;
} & {
    /** Logical AND — semua kondisi harus cocok */
    $and?: Array<FilterQuery<T>>;
    /** Logical OR — minimal satu kondisi harus cocok */
    $or?: Array<FilterQuery<T>>;
    /** Logical NOR — tidak ada kondisi yang boleh cocok */
    $nor?: Array<FilterQuery<T>>;
    /** Logical NOT — negasi sebuah filter expression */
    $not?: FilterQuery<T>;
    /** Expression evaluation */
    $expr?: Record<string, unknown>;
    [key: string]: unknown;
};
/**
 * MongoDB-compatible update operators.
 *
 * Mendukung semua operator standar untuk field mutation dan array operations.
 *
 * @example
 * ```typescript
 * const update: UpdateQuery<User> = {
 *   $set: { name: 'Alice Updated' },
 *   $inc: { loginCount: 1 },
 *   $push: { tags: 'premium' },
 * };
 * ```
 */
export interface UpdateQuery<T extends Document = Document> {
    /** Set nilai field */
    $set?: Partial<T> & Record<string, unknown>;
    /** Hapus field dari dokumen */
    $unset?: {
        [K in keyof T]?: '' | 1;
    };
    /** Tambah nilai numerik pada field */
    $inc?: {
        [K in keyof T]?: number;
    };
    /** Kalikan nilai numerik pada field */
    $mul?: {
        [K in keyof T]?: number;
    };
    /** Set field ke nilai minimum antara current dan value baru */
    $min?: {
        [K in keyof T]?: unknown;
    };
    /** Set field ke nilai maximum antara current dan value baru */
    $max?: {
        [K in keyof T]?: unknown;
    };
    /** Rename sebuah field */
    $rename?: {
        [K in keyof T]?: string;
    };
    /** Set field ke tanggal/timestamp saat ini */
    $currentDate?: {
        [K in keyof T]?: boolean | {
            $type: 'date' | 'timestamp';
        };
    };
    /** Push value ke array */
    $push?: {
        [K in keyof T]?: unknown;
    };
    /** Hapus value dari array yang cocok dengan kondisi */
    $pull?: {
        [K in keyof T]?: unknown;
    };
    /** Tambah ke array hanya jika belum ada */
    $addToSet?: {
        [K in keyof T]?: unknown;
    };
    /** Hapus elemen pertama (-1) atau terakhir (1) dari array */
    $pop?: {
        [K in keyof T]?: 1 | -1;
    };
    [key: string]: unknown;
}
/**
 * Options untuk operasi `find()`.
 *
 * @example
 * ```typescript
 * const options: FindOptions<User> = {
 *   sort: { age: -1 },          // Sort by age descending
 *   limit: 20,                   // Max 20 results
 *   skip: 10,                    // Skip 10 results (pagination)
 *   projection: { name: 1, age: 1, _id: 0 },  // Include only name & age
 * };
 * ```
 */
export interface FindOptions<T extends Document = Document> {
    /**
     * Projection — field yang di-include (1) atau di-exclude (0).
     * Tidak bisa mencampur include & exclude kecuali untuk `_id`.
     */
    projection?: {
        [K in keyof T]?: 0 | 1;
    } & Record<string, 0 | 1>;
    /**
     * Sort specification — field ke direction (1 = ascending, -1 = descending).
     */
    sort?: {
        [K in keyof T]?: 1 | -1;
    } & Record<string, 1 | -1>;
    /** Jumlah maksimum dokumen yang dikembalikan */
    limit?: number;
    /**
     * Jumlah dokumen yang di-skip (untuk pagination).
     * @default 0
     */
    skip?: number;
}
/**
 * Sebuah stage dalam aggregation pipeline.
 *
 * Stages yang didukung:
 * - `$match` — Filter dokumen
 * - `$group` — Grouping dengan accumulators ($sum, $avg, $min, $max, $first, $last, $push, $addToSet)
 * - `$project` — Projection/reshaping dokumen
 * - `$sort` — Sorting
 * - `$limit` — Batasi jumlah output
 * - `$skip` — Skip dokumen
 * - `$unwind` — Flatten array field
 * - `$lookup` — Join dengan collection lain
 * - `$count` — Hitung jumlah dokumen
 */
export type PipelineStage = {
    $match: FilterQuery;
} | {
    $group: {
        _id: unknown;
        [accumulator: string]: unknown;
    };
} | {
    $project: Record<string, 0 | 1 | unknown>;
} | {
    $sort: Record<string, 1 | -1>;
} | {
    $limit: number;
} | {
    $skip: number;
} | {
    $unwind: string | {
        path: string;
        includeArrayIndex?: string;
        preserveNullAndEmptyArrays?: boolean;
    };
} | {
    $lookup: {
        from: string;
        localField: string;
        foreignField: string;
        as: string;
    };
} | {
    $count: string;
} | Record<string, unknown>;
/** Hasil operasi `insertOne()` */
export interface InsertOneResult {
    /** ID dokumen yang di-insert (UUID v4 string) */
    insertedId: string;
}
/** Hasil operasi `insertMany()` */
export interface InsertManyResult {
    /** Array ID dari semua dokumen yang di-insert, berurutan */
    insertedIds: string[];
    /** Jumlah dokumen yang berhasil di-insert */
    insertedCount: number;
}
/** Hasil operasi `updateOne()` atau `updateMany()` */
export interface UpdateResult {
    /** Jumlah dokumen yang cocok dengan filter */
    matchedCount: number;
    /** Jumlah dokumen yang benar-benar diubah */
    modifiedCount: number;
}
/** Hasil operasi `deleteOne()` atau `deleteMany()` */
export interface DeleteResult {
    /** Jumlah dokumen yang dihapus */
    deletedCount: number;
}
/**
 * Spesifikasi field untuk index.
 *
 * @example
 * ```typescript
 * // Single ascending index
 * { age: 1 }
 *
 * // Compound index
 * { 'address.city': 1, age: -1 }
 *
 * // Full-text index
 * { title: 'text', content: 'text' }
 * ```
 */
export type IndexFields = Record<string, 1 | -1 | 'text'>;
/** Options untuk `createIndex()` */
export interface IndexOptions {
    /**
     * Enforce uniqueness pada indexed field(s).
     * @default false
     */
    unique?: boolean;
}
/** Informasi index yang dikembalikan oleh `listIndexes()` */
export interface IndexInfo {
    /** Nama index (auto-generated dari field names, misal 'age_1_name_1') */
    name: string;
    /** Spesifikasi field-field yang di-index */
    fields: Record<string, number>;
    /** Apakah ini unique index */
    unique: boolean;
}
/** Database performance dan usage metrics */
export interface OvnMetrics {
    io: {
        /** Total pages yang dibaca dari disk */
        pagesRead: number;
        /** Total pages yang ditulis ke disk */
        pagesWritten: number;
    };
    cache: {
        /** Buffer pool hit rate (0.0 sampai 1.0) */
        hitRate: number;
        /** Ukuran buffer pool saat ini dalam bytes */
        size: number;
    };
    txn: {
        /** Jumlah transaksi yang sedang aktif */
        activeCount: number;
    };
    storage: {
        /** Total entries dalam B+ tree */
        btreeEntries: number;
        /** Memory usage MemTable saat ini dalam bytes */
        memtableSize: number;
        /** Jumlah unflushed L0 SSTables */
        sstableCount: number;
    };
    /** Jumlah collections yang dibuka */
    collections: number;
}
/** Informasi versi engine */
export interface OvnVersion {
    engine: string;
    version: string;
    format: string;
    neon: string;
    features: string[];
}
/**
 * Interface yang mendefinisikan semua fungsi yang di-expose oleh
 * native Neon addon (ovn_neon.node).
 *
 * Setiap fungsi menerima `handle` (integer index) sebagai argumen pertama.
 * String JSON digunakan sebagai format transfer data antara JS dan Rust.
 *
 * @internal — Tidak di-export ke public API consumer library.
 */
export interface NativeAddon {
    /** Buka/buat database, return handle index */
    open(path: string, options: Record<string, unknown>): number;
    /** Tutup database dan free handle */
    close(handle: number): void;
    /** Force checkpoint — flush dirty pages ke disk */
    checkpoint(handle: number): void;
    /** Get version info sebagai JSON string */
    getVersion(handle: number): string;
    /** Buat collection baru */
    createCollection(handle: number, name: string, optionsJson?: string): void;
    /** Hapus collection beserta data dan index */
    dropCollection(handle: number, name: string): void;
    /** List semua collection names sebagai JSON string[] */
    listCollections(handle: number): string;
    /** Insert satu dokumen, return ID. Mendukung Session Idempotency. */
    insert(handle: number, collection: string, docJson: string, lsid?: string, txnNumber?: number): string;
    /** Insert banyak dokumen, return JSON string[] of IDs. */
    insertMany(handle: number, collection: string, docsJson: string): string;
    /** Find dokumen, return JSON doc[] */
    find(handle: number, collection: string, filterJson: string): string;
    /** Find dengan options (sort/limit/skip/projection), return JSON doc[] */
    findWithOptions(handle: number, collection: string, filterJson: string, optionsJson: string): string;
    /** Find satu dokumen, return JSON doc | null */
    findOne(handle: number, collection: string, filterJson: string): string;
    /** Count dokumen, return number */
    count(handle: number, collection: string, filterJson: string): number;
    /** Update satu dokumen, return modified count. Mendukung Session Idempotency. */
    update(handle: number, collection: string, filterJson: string, updateJson: string, lsid?: string, txnNumber?: number): number;
    /** Update semua dokumen yang cocok, return modified count */
    updateMany(handle: number, collection: string, filterJson: string, updateJson: string): number;
    /** Delete satu dokumen, return deleted count */
    delete(handle: number, collection: string, filterJson: string): number;
    /** Delete semua dokumen yang cocok, return deleted count */
    deleteMany(handle: number, collection: string, filterJson: string): number;
    /** Execute aggregation pipeline, return JSON doc[] */
    aggregate(handle: number, collection: string, pipelineJson: string): string;
    /** Buat secondary index, return index name */
    createIndex(handle: number, collection: string, specJson: string): string;
    /** Hapus index berdasarkan nama */
    dropIndex(handle: number, collection: string, indexName: string): void;
    /** List semua indexes, return JSON IndexInfo[] */
    listIndexes(handle: number, collection: string): string;
    createVectorIndex(handle: number, collection: string, field: string): void;
    vectorSearch(handle: number, collection: string, queryVectorJson: string, limit: number): string;
    /** Begin transaction, return txid sebagai string */
    beginTransaction(handle: number): string;
    /** Commit transaction */
    commitTransaction(handle: number, txidStr: string): void;
    /** Abort/rollback transaction */
    abortTransaction(handle: number, txidStr: string): void;
    /** Get comprehensive metrics, return JSON object */
    getMetrics(handle: number): string;
    watch(handle: number, callback: (err: any, eventJson: string) => void): void;
    /** Store binary blob data natively, returns UUID string */
    putBlob(handle: number, data: Uint8Array): string;
    /** Retrieve binary blob natively, returns buffer or null */
    getBlob(handle: number, blobId: string): Uint8Array | null;
}
export {};
//# sourceMappingURL=index.d.ts.map