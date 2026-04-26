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
/** UUID v4 pattern. */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** UUID v7 pattern (time-ordered). */
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Custom ID: alphanumeric + hyphens/underscores, 1–128 chars. */
const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
/**
 * Cast a raw string to `CollectionName` after validating it is non-empty,
 * starts with a letter, and contains only alphanumeric/underscore chars.
 * Throws `TypeError` if invalid.
 */
export function asCollectionName(name) {
    if (typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(name)) {
        throw new TypeError(`Invalid collection name "${name}": must start with a letter and contain only [a-zA-Z0-9_] (max 128 chars)`);
    }
    return name;
}
/**
 * Cast a raw string to `DocumentId` after validating it is a UUIDv4, UUIDv7,
 * or a custom alphanumeric ID up to 128 chars.
 * Throws `TypeError` if invalid. Error messages do NOT expose internal paths.
 */
export function asDocumentId(id) {
    if (typeof id === 'string' &&
        (UUID_V4_RE.test(id) || UUID_V7_RE.test(id) || CUSTOM_ID_RE.test(id))) {
        return id;
    }
    throw new TypeError('Invalid document ID format');
}
//# sourceMappingURL=index.js.map