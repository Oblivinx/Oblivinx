/**
 * @module errors
 *
 * Structured error hierarchy for Oblivinx3x.
 *
 * All native errors are mapped to typed TypeScript error classes
 * with error codes, messages, and optional metadata.
 *
 * @packageDocumentation
 */
/** Base error code for all Oblivinx3x errors */
export type OblivinxErrorCode = 'ERR_DATABASE_CLOSED' | 'ERR_COLLECTION_NOT_FOUND' | 'ERR_COLLECTION_EXISTS' | 'ERR_DUPLICATE_KEY' | 'ERR_TRANSACTION_ABORTED' | 'ERR_TRANSACTION_CONFLICT' | 'ERR_INVALID_SCHEMA' | 'ERR_QUERY_TIMEOUT' | 'ERR_INDEX_NOT_FOUND' | 'ERR_INDEX_EXISTS' | 'ERR_NATIVE_LOAD_FAILED' | 'ERR_NATIVE_EXECUTION' | 'ERR_SERIALIZATION' | 'ERR_INVALID_OPERATION' | 'ERR_NOT_IMPLEMENTED' | 'ERR_CORRUPT_DATA' | 'ERR_SAVEPOINT_NOT_FOUND';
/** Base error class for all Oblivinx3x errors */
export declare class OblivinxError extends Error {
    /** Error code for programmatic handling */
    readonly code: OblivinxErrorCode;
    /** Additional metadata about the error */
    readonly metadata?: Record<string, unknown>;
    constructor(code: OblivinxErrorCode, message: string, metadata?: Record<string, unknown>);
}
/** Thrown when attempting operations on a closed database */
export declare class DatabaseClosedError extends OblivinxError {
    constructor(path: string);
}
/** Thrown when a collection does not exist */
export declare class CollectionNotFoundError extends OblivinxError {
    constructor(name: string);
}
/** Thrown when attempting to create a collection that already exists */
export declare class CollectionExistsError extends OblivinxError {
    constructor(name: string);
}
/** Thrown when a unique constraint is violated */
export declare class DuplicateKeyError extends OblivinxError {
    readonly keyValue: Record<string, unknown>;
    constructor(keyValue: Record<string, unknown>);
}
/** Thrown when a transaction is aborted */
export declare class TransactionAbortedError extends OblivinxError {
    constructor(txid?: string);
}
/** Thrown when a transaction conflict is detected */
export declare class TransactionConflictError extends OblivinxError {
    constructor(message?: string);
}
/** Thrown when a savepoint does not exist */
export declare class SavepointNotFoundError extends OblivinxError {
    constructor(savepoint: string);
}
/** Thrown when document validation fails */
export declare class ValidationError extends OblivinxError {
    readonly document?: Record<string, unknown>;
    readonly violations?: string[];
    constructor(message: string, document?: Record<string, unknown>, violations?: string[]);
}
/** Thrown when a query exceeds the timeout */
export declare class QueryTimeoutError extends OblivinxError {
    readonly timeoutMs: number;
    constructor(timeoutMs: number);
}
/** Thrown when an index is not found */
export declare class IndexNotFoundError extends OblivinxError {
    constructor(index: string, collection: string);
}
/** Thrown when attempting to create an index that already exists */
export declare class IndexExistsError extends OblivinxError {
    constructor(index: string, collection: string);
}
/** Thrown when native module fails to load */
export declare class NativeLoadError extends OblivinxError {
    constructor(message: string, originalError?: unknown);
}
/** Thrown when native operation fails */
export declare class NativeExecutionError extends OblivinxError {
    readonly originalMessage: string;
    constructor(originalMessage: string);
}
/** Thrown when serialization fails */
export declare class SerializationError extends OblivinxError {
    constructor(message: string);
}
/** Thrown when an operation is not supported */
export declare class InvalidOperationError extends OblivinxError {
    constructor(message: string);
}
/** Thrown when a feature is not yet implemented */
export declare class NotImplementedError extends OblivinxError {
    constructor(feature: string);
}
/** Thrown when data corruption is detected */
export declare class CorruptDataError extends OblivinxError {
    constructor(location: string);
}
/**
 * Map native error strings to appropriate TypeScript error classes.
 * @internal
 */
export declare function mapNativeError(message: string): OblivinxError;
/**
 * Alias for OblivinxError — kept for backward-compatibility.
 * @deprecated Use OblivinxError instead.
 */
export { OblivinxError as OvnError };
/**
 * Alias for TransactionConflictError — kept for backward-compatibility.
 * @deprecated Use TransactionConflictError instead.
 */
export { TransactionConflictError as WriteConflictError };
export { wrapNative, wrapNativeAsync } from './wrap.js';
//# sourceMappingURL=index.d.ts.map